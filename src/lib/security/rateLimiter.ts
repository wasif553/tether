/**
 * Auth and Token Abuse Protection v1 - see
 * docs/auth-token-abuse-protection-v1.md.
 *
 * A generic, durable, concurrency-safe fixed-window rate limiter backed
 * by the shared PostgreSQL database (SecurityRateLimitBucket) - never an
 * in-process Map/counter, which would not be a real security boundary
 * across Tether's stateless, multi-instance Vercel serverless deployment.
 *
 * Concurrency safety follows the exact same convention already
 * established for the password-reset per-account cooldown
 * (src/lib/passwordReset.ts) and the submission-scoped runners
 * (src/lib/secureClientRunner.ts, src/lib/aiAssistanceRunner.ts,
 * src/lib/answerSaveRunner.ts): a transaction-scoped Postgres advisory
 * lock (pg_advisory_xact_lock), held for the duration of one
 * prisma.$transaction, so the check-then-increment sequence below can
 * never race across concurrent requests for the SAME (scope, identifier)
 * pair - Postgres serializes them. Uses the two-key
 * pg_advisory_xact_lock(hashtext(a), hashtext(b)) overload, the exact
 * same form already proven in src/lib/answerSaveRunner.ts (there keyed
 * on submissionId + questionId) - here keyed on scope + keyHash.
 *
 * Fixed-window semantics: a bucket tracks windowStart and count. A
 * request either falls inside the current window (count compared
 * against the caller's maxAttempts) or the window has fully elapsed
 * (treated as an entirely fresh window - count reset to 1, windowStart
 * reset to now). There is no sliding-window smoothing; this is a
 * deliberately simple, easy-to-reason-about design, matching the
 * "bounded/simple" requirement.
 */
import { prisma } from "@/lib/prisma";
import { hashRateLimitIdentifier } from "./rateLimitKey";

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };
export type RateLimitPeekResult = { blocked: false } | { blocked: true; retryAfterSeconds: number };

type RateLimitParams = {
  scope: string;
  identifier: string;
  maxAttempts: number;
  windowSeconds: number;
};

function buildKeyHash(scope: string, identifier: string): string {
  return hashRateLimitIdentifier(scope + ":" + identifier);
}

/**
 * Atomically checks the bucket for (scope, identifier) and, if under
 * maxAttempts for the current window, increments it and returns
 * {allowed: true}. If already at or over maxAttempts for a window that
 * has not yet elapsed, does NOT increment further (count stays capped,
 * never grows unboundedly) and returns {allowed: false,
 * retryAfterSeconds}. An expired window is treated as fresh (count reset
 * to 1, allowed).
 *
 * This single atomic call is what makes "concurrent requests cannot
 * bypass the limit" a provable guarantee: N simultaneous callers for the
 * same bucket serialize through the advisory lock one at a time, so the
 * bucket's final count after any burst is bounded by maxAttempts, never
 * by N.
 *
 * Throws on a genuine database/infrastructure error - this function
 * never silently reports "allowed" on failure. See safeConsumeRateLimit
 * below for the fail-open-with-logging policy used at actual call sites.
 */
export async function consumeRateLimit(params: RateLimitParams): Promise<RateLimitResult> {
  const keyHash = buildKeyHash(params.scope, params.identifier);
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${params.scope}), hashtext(${keyHash}))`;

    const bucket = await tx.securityRateLimitBucket.findUnique({
      where: { scope_keyHash: { scope: params.scope, keyHash } },
    });

    const windowExpired = !bucket || now.getTime() - bucket.windowStart.getTime() >= params.windowSeconds * 1000;

    if (windowExpired) {
      await tx.securityRateLimitBucket.upsert({
        where: { scope_keyHash: { scope: params.scope, keyHash } },
        create: { scope: params.scope, keyHash, windowStart: now, count: 1 },
        update: { windowStart: now, count: 1 },
      });
      return { allowed: true };
    }

    if (bucket.count >= params.maxAttempts) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((bucket.windowStart.getTime() + params.windowSeconds * 1000 - now.getTime()) / 1000),
      );
      return { allowed: false, retryAfterSeconds };
    }

    await tx.securityRateLimitBucket.update({
      where: { scope_keyHash: { scope: params.scope, keyHash } },
      data: { count: { increment: 1 } },
    });
    return { allowed: true };
  });
}

/**
 * Read-only fast-path check - does NOT modify the bucket. Used as a
 * cheap pre-check before expensive/sensitive work (e.g. a bcrypt
 * comparison) so an already-saturated bucket can short-circuit without
 * paying that cost. This is an optimization only, not the correctness
 * guarantee (that's consumeRateLimit's atomic check-and-increment) - a
 * TOCTOU gap between this peek and a later consumeRateLimit call is
 * expected and harmless (bounded by the size of one concurrent request
 * burst, never unbounded).
 */
export async function peekRateLimitBlocked(
  params: Omit<RateLimitParams, "identifier"> & { identifier: string },
): Promise<RateLimitPeekResult> {
  const keyHash = buildKeyHash(params.scope, params.identifier);
  const bucket = await prisma.securityRateLimitBucket.findUnique({
    where: { scope_keyHash: { scope: params.scope, keyHash } },
  });
  if (!bucket) return { blocked: false };

  const now = Date.now();
  if (now - bucket.windowStart.getTime() >= params.windowSeconds * 1000) return { blocked: false };
  if (bucket.count < params.maxAttempts) return { blocked: false };

  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((bucket.windowStart.getTime() + params.windowSeconds * 1000 - now) / 1000),
  );
  return { blocked: true, retryAfterSeconds };
}

/**
 * Clears a specific (scope, identifier) bucket - used on a confirmed
 * success (e.g. a correct password) to release the slot a pre-emptive
 * consumeRateLimit reservation took, WITHOUT touching any other bucket
 * (a different account, or a source-wide bucket, sharing the same
 * source address) - see src/lib/security/loginAttempt.ts for why only
 * the narrow source+account bucket is ever reset this way, never the
 * source-wide failure bucket.
 */
export async function resetRateLimitBucket(params: { scope: string; identifier: string }): Promise<void> {
  const keyHash = buildKeyHash(params.scope, params.identifier);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${params.scope}), hashtext(${keyHash}))`;
    await tx.securityRateLimitBucket.deleteMany({ where: { scope: params.scope, keyHash } });
  });
}

// Fail-open-with-logging wrappers - the policy call sites should use these.
//
// Failure-mode design (see docs/auth-token-abuse-protection-v1.md,
// "Limiter infrastructure failure"): a transient failure of THIS table
// (or the database generally) must never turn into a platform-wide
// authentication/reset/invitation outage layered on top of whatever
// infrastructure problem already exists - the actual security boundary
// for every surface these wrappers guard (bcrypt comparison, token-hash
// comparison, access-code comparison) is completely independent of this
// table. So enforcement failures fail OPEN. But failing open silently
// would be indistinguishable from "no attack happening" - so every
// failure is logged with a distinct, greppable message, never swallowed.
// This is a deliberate availability-over-defense-in-depth tradeoff for
// this ONE supplementary control; it does not weaken any of the
// underlying credential/token verification these surfaces still perform
// unconditionally.

/** Enforcement path - logs and fails OPEN (allowed) on an unexpected error. */
export async function safeConsumeRateLimit(params: RateLimitParams): Promise<RateLimitResult> {
  try {
    return await consumeRateLimit(params);
  } catch (err) {
    console.error(
      "Rate limit ENFORCEMENT failed for scope \"" + params.scope + "\" - failing open",
      err instanceof Error ? err.message : "unknown error",
    );
    return { allowed: true };
  }
}

/** Enforcement fast-path - logs and fails OPEN (not blocked) on an unexpected error. */
export async function safePeekRateLimitBlocked(
  params: Omit<RateLimitParams, "identifier"> & { identifier: string },
): Promise<RateLimitPeekResult> {
  try {
    return await peekRateLimitBlocked(params);
  } catch (err) {
    console.error(
      "Rate limit ENFORCEMENT peek failed for scope \"" + params.scope + "\" - failing open",
      err instanceof Error ? err.message : "unknown error",
    );
    return { blocked: false };
  }
}

/** Best-effort cleanup path - logs but never throws; a failed reset simply means the bucket expires naturally instead. */
export async function safeResetRateLimitBucket(params: { scope: string; identifier: string }): Promise<void> {
  try {
    await resetRateLimitBucket(params);
  } catch (err) {
    console.error(
      "Rate limit bucket cleanup failed for scope \"" + params.scope + "\" (best-effort, non-fatal)",
      err instanceof Error ? err.message : "unknown error",
    );
  }
}

/**
 * Opportunistic, cheap, bounded cleanup of long-expired buckets -
 * intentionally NOT a scheduled/cron job (out of scope for this pass;
 * see docs/auth-token-abuse-protection-v1.md). Deletes a small bounded
 * batch of rows whose window closed more than staleAfterSeconds ago.
 * Safe to call opportunistically (e.g. occasionally, best-effort) from
 * any request path - deleting a stale bucket can only ever make a
 * future check MORE permissive (a fresh window), never less, so this can
 * never affect authentication/verification correctness. Never awaited in
 * a way that blocks a real request's response; callers fire-and-forget
 * this with a caught promise.
 */
export async function cleanupExpiredRateLimitBuckets(staleAfterSeconds: number, batchSize = 200): Promise<number> {
  const cutoff = new Date(Date.now() - staleAfterSeconds * 1000);
  const stale = await prisma.securityRateLimitBucket.findMany({
    where: { windowStart: { lt: cutoff } },
    select: { id: true },
    take: batchSize,
  });
  if (stale.length === 0) return 0;
  const result = await prisma.securityRateLimitBucket.deleteMany({
    where: { id: { in: stale.map((row) => row.id) } },
  });
  return result.count;
}
