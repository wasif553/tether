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
 *
 * Security review v2 (independent review of the first pass) changed two
 * things at this layer:
 *
 * 1. A generic reserve/release-one pair replaced the old
 *    "peek-then-consume-only-on-invalid" pattern every call site used to
 *    follow. Peeking is a non-atomic read: a burst of concurrent requests
 *    can all observe "not yet blocked" before any of them commits its
 *    own later consume, letting the burst exceed the intended threshold
 *    (a TOCTOU/concurrent-burst bypass). The fix is to RESERVE atomically
 *    (consumeRateLimit already is atomic) BEFORE doing any sensitive
 *    verification, and, for outcomes that should not count against the
 *    caller's budget (a genuinely correct password, a genuinely valid
 *    token), RELEASE exactly the one reservation this request took -
 *    never a bulk reset of the whole bucket. See releaseRateLimitSlot's
 *    own doc comment for why a bulk reset is unsafe on a bucket shared by
 *    concurrent callers. `peekRateLimitBlocked` (the old read-only
 *    fast-path this pattern relied on) has been removed entirely, so the
 *    unsafe pattern cannot be reintroduced by accident at a new call
 *    site.
 *
 * 2. Enforcement failures (an unexpected DB/infrastructure error while
 *    RESERVING a slot) now fail CLOSED, not open. The first pass's
 *    fail-open wrappers (removed here) meant a broken advisory-lock
 *    query - the exact bug an earlier session in this project hit -
 *    silently turned the entire limiter into a no-op instead of
 *    surfacing anywhere. `reserveRateLimitSlot` below now returns an
 *    explicit `infrastructure_error` status, and every call site is
 *    responsible for applying its own surface-appropriate fail-closed
 *    behavior (see loginAttempt.ts, passwordReset.ts, and the
 *    course-invitation/standalone-invite/exam-access-code rate-limit
 *    helper modules for what each surface does on this status).
 *    Best-effort operations that can only ever make enforcement MORE
 *    conservative if they fail - releasing a reservation, opportunistic
 *    cleanup - remain fail-open/best-effort, since a failure there can
 *    never weaken a security boundary.
 *
 * Security review v3 fixed a window-rollover bug in release: a
 * reservation taken in one fixed window, released after that window has
 * since expired and been replaced by a brand-new one (same
 * scope+identifier, fresh windowStart, fresh count), would decrement the
 * NEW window's count instead of doing nothing - a stale, delayed release
 * could silently steal budget from unrelated, later traffic. Every
 * reservation now carries its own `windowStartMs` (the bucket row's exact
 * `windowStart` at the moment it was reserved), and `releaseRateLimitSlot`
 * only decrements when the bucket's CURRENT windowStart still matches -
 * otherwise it is a no-op. No schema change: `windowStartMs` is read
 * from the existing `windowStart` column, never stored anywhere new.
 */
import { prisma } from "@/lib/prisma";
import { hashRateLimitIdentifier } from "./rateLimitKey";
import { RATE_LIMIT_BUCKET_STALE_AFTER_SECONDS } from "./rateLimitScopes";

export type RateLimitResult =
  | { allowed: true; windowStartMs: number }
  | { allowed: false; retryAfterSeconds: number };

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
 * Every bucket-mutating transaction below serializes on one advisory
 * lock per (scope, identifier) - a large legitimate concurrent burst
 * against the SAME bucket (e.g. many students behind one shared campus
 * NAT all logging in within the same second) queues up waiting for both
 * a free pool connection and the lock, not just the lock itself.
 * Prisma's interactive-transaction defaults (2s to acquire a connection,
 * 5s transaction body budget) are too tight for that queue to fully
 * drain under a large burst, which would otherwise surface as spurious
 * "unable to start a transaction in time" errors - i.e. this feature's
 * own limiter becoming the outage it exists to prevent. Widened here,
 * not globally, since this is the one place in the codebase that
 * deliberately serializes many concurrent callers onto a single lock key.
 */
const RATE_LIMIT_TRANSACTION_OPTIONS = { maxWait: 15_000, timeout: 15_000 };

/**
 * Atomically checks the bucket for (scope, identifier) and, if under
 * maxAttempts for the current window, increments it and returns
 * {allowed: true} - this IS the "reserve a slot" operation; there is no
 * separate primitive for it. If already at or over maxAttempts for a
 * window that has not yet elapsed, does NOT increment further (count
 * stays capped, never grows unboundedly) and returns {allowed: false,
 * retryAfterSeconds}. An expired window is treated as fresh (count reset
 * to 1, allowed).
 *
 * This single atomic call is what makes "concurrent requests cannot
 * bypass the limit" a provable guarantee: N simultaneous callers for the
 * same bucket serialize through the advisory lock one at a time, so the
 * bucket's final count after any burst is bounded by maxAttempts, never
 * by N.
 *
 * The returned `windowStartMs` on an allowed result is the EXACT
 * `windowStart` of the bucket row this reservation landed in (a fresh
 * value for a new/expired window, the existing row's value otherwise).
 * Callers that intend to release this reservation later must carry this
 * value forward and pass it to releaseRateLimitSlot - see that
 * function's own doc comment for why (security review v3's
 * window-rollover fix).
 *
 * Throws on a genuine database/infrastructure error - this function
 * never silently reports "allowed" on failure. See reserveRateLimitSlot
 * below for the fail-closed-with-logging policy used at actual call
 * sites.
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
      return { allowed: true, windowStartMs: now.getTime() };
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
    return { allowed: true, windowStartMs: bucket.windowStart.getTime() };
  }, RATE_LIMIT_TRANSACTION_OPTIONS);
}

/**
 * Releases EXACTLY ONE reservation on (scope, identifier) - decrements
 * count by 1, floored at 0, never below. Deliberately NOT a bulk clear:
 * a bucket is shared by every concurrent caller using the same
 * (scope, identifier) pair, so unconditionally deleting/zeroing the
 * whole row (resetRateLimitBucket) on one request's success would also
 * erase every OTHER concurrent request's still-legitimate reservation -
 * e.g. an attacker's several in-flight guesses against the same account,
 * reserved a moment earlier by other requests, would be silently wiped
 * out by one coincidental concurrent success. Releasing exactly one slot
 * (guarded by the same advisory lock as consumeRateLimit, so it can
 * never race with a concurrent reserve/release on the same bucket) is
 * always safe: it can only ever return budget this ONE resolved request
 * itself reserved.
 *
 * Security review v3 (window-rollover fix): `windowStartMs` MUST be the
 * exact value returned by the consumeRateLimit/reserveRateLimitSlot call
 * this release corresponds to. Before decrementing, this function
 * re-checks that the bucket's CURRENT windowStart still equals
 * `windowStartMs` - if the window has since expired and been replaced by
 * a brand-new one (fresh windowStart, fresh count, same scope+identifier),
 * this is a no-op. Without this check, a delayed release belonging to an
 * OLD, already-expired window would incorrectly decrement a NEWER
 * window's count - silently handing budget to unrelated, later traffic
 * that never earned it.
 *
 * Never throws on a missing/already-empty bucket - releasing a
 * reservation that (for whatever reason) is no longer there is a no-op,
 * not an error.
 */
export async function releaseRateLimitSlot(params: { scope: string; identifier: string; windowStartMs: number }): Promise<void> {
  const keyHash = buildKeyHash(params.scope, params.identifier);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${params.scope}), hashtext(${keyHash}))`;
    const bucket = await tx.securityRateLimitBucket.findUnique({
      where: { scope_keyHash: { scope: params.scope, keyHash } },
    });
    if (!bucket || bucket.count <= 0) return;
    if (bucket.windowStart.getTime() !== params.windowStartMs) return; // a different (newer) window now owns this bucket - never touch it
    await tx.securityRateLimitBucket.update({
      where: { scope_keyHash: { scope: params.scope, keyHash } },
      data: { count: { decrement: 1 } },
    });
  }, RATE_LIMIT_TRANSACTION_OPTIONS);
}

/**
 * Clears an ENTIRE (scope, identifier) bucket unconditionally. Kept as a
 * generic, independently useful, already-tested primitive (e.g. for a
 * future admin "clear this block" action) - but no production call site
 * in this feature uses it as a way to release one request's reservation;
 * see releaseRateLimitSlot's doc comment for exactly why that would be
 * unsafe on a bucket shared by concurrent callers.
 */
export async function resetRateLimitBucket(params: { scope: string; identifier: string }): Promise<void> {
  const keyHash = buildKeyHash(params.scope, params.identifier);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${params.scope}), hashtext(${keyHash}))`;
    await tx.securityRateLimitBucket.deleteMany({ where: { scope: params.scope, keyHash } });
  }, RATE_LIMIT_TRANSACTION_OPTIONS);
}

export type RateLimitReservation =
  | { status: "reserved"; windowStartMs: number }
  | { status: "blocked"; retryAfterSeconds: number }
  | { status: "infrastructure_error" };

/**
 * The enforcement entry point every call site uses. Reserves a slot
 * atomically BEFORE the caller does any sensitive verification (bcrypt
 * compare, token-hash lookup, access-code compare). On an unexpected
 * DB/infrastructure error, logs a distinct, greppable message and fails
 * CLOSED - returns `infrastructure_error` rather than silently allowing
 * the request through. Callers must treat `infrastructure_error` as "do
 * not proceed with verification" and apply their own surface-appropriate
 * safe response (see each call site for its specific choice).
 *
 * Also opportunistically (and cheaply - see maybeRunOpportunisticCleanup
 * below) reclaims long-expired buckets, since this function is the one
 * place every abuse-sensitive request path in this feature already
 * passes through.
 */
export async function reserveRateLimitSlot(params: RateLimitParams): Promise<RateLimitReservation> {
  await maybeRunOpportunisticCleanup();
  try {
    const result = await consumeRateLimit(params);
    return result.allowed
      ? { status: "reserved", windowStartMs: result.windowStartMs }
      : { status: "blocked", retryAfterSeconds: result.retryAfterSeconds };
  } catch (err) {
    console.error(
      "Rate limit ENFORCEMENT failed for scope \"" + params.scope + "\" - failing CLOSED",
      err instanceof Error ? err.message : "unknown error",
    );
    return { status: "infrastructure_error" };
  }
}

/**
 * Best-effort release - logs but never throws. A failed release simply
 * leaves the reservation consumed, which can only make enforcement MORE
 * conservative (never weaker) than intended, so this is safe to swallow.
 */
export async function safeReleaseRateLimitSlot(params: { scope: string; identifier: string; windowStartMs: number }): Promise<void> {
  try {
    await releaseRateLimitSlot(params);
  } catch (err) {
    console.error(
      "Rate limit slot release failed for scope \"" + params.scope + "\" (best-effort, non-fatal)",
      err instanceof Error ? err.message : "unknown error",
    );
  }
}

/**
 * Opportunistic, cheap, bounded cleanup of long-expired buckets -
 * intentionally NOT a scheduled/cron job (out of scope for this pass;
 * see docs/auth-token-abuse-protection-v1.md). Deletes a small bounded
 * batch of rows whose window closed more than staleAfterSeconds ago.
 *
 * Race safety (security review v2 fix): the DELETE below re-checks
 * `windowStart < cutoff` directly in its own WHERE clause, not merely
 * "id was in an earlier SELECT's result list". Postgres evaluates a
 * DELETE's WHERE clause against each row's CURRENT committed state at
 * execution time, so a row that a real concurrent request refreshed
 * (via consumeRateLimit/releaseRateLimitSlot) in the gap between the
 * SELECT above and this DELETE no longer matches `windowStart < cutoff`
 * and survives - the earlier find-by-id-list-only version could delete
 * such a row, destroying live rate-limit state.
 *
 * Deleting a stale bucket can only ever make a future check MORE
 * permissive (a fresh window), never less, so this can never affect
 * authentication/verification correctness. Safe to call opportunistically
 * from any request path.
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
    where: { id: { in: stale.map((row) => row.id) }, windowStart: { lt: cutoff } },
  });
  return result.count;
}

// Security review v2: cleanup is now actually wired into the real
// enforcement path (reserveRateLimitSlot above), not merely defined and
// tested in isolation. Deliberately low-frequency (not every request -
// unnecessary DB cost for a purely cosmetic retention concern) and
// deliberately AWAITED to completion when it does run - a serverless
// function is not guaranteed to keep running unawaited work after this
// call returns, so a fire-and-forget cleanup could simply never execute.
// Always wrapped in its own try/catch: a cleanup failure is best-effort
// and must never affect the enforcement decision it rides along with.
const OPPORTUNISTIC_CLEANUP_PROBABILITY = 1 / 500;

async function maybeRunOpportunisticCleanup(): Promise<void> {
  if (Math.random() >= OPPORTUNISTIC_CLEANUP_PROBABILITY) return;
  try {
    await cleanupExpiredRateLimitBuckets(RATE_LIMIT_BUCKET_STALE_AFTER_SECONDS);
  } catch (err) {
    console.error(
      "Rate limit bucket opportunistic cleanup failed (best-effort, non-fatal)",
      err instanceof Error ? err.message : "unknown error",
    );
  }
}
