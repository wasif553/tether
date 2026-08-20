/**
 * Auth and Token Abuse Protection v1 - see
 * docs/auth-token-abuse-protection-v1.md.
 *
 * The credential-verification logic behind src/auth.ts's Credentials
 * `authorize()`, extracted into its own directly-testable module - same
 * convention as src/lib/passwordReset.ts being extracted from its route
 * handlers. NextAuth's internal request-handling pipeline is not
 * practical to exercise directly in a unit test; this function needs
 * only a source-address string, not a real Request/NextAuth context.
 *
 * Preserves the EXISTING lookup/bcrypt/anti-enumeration behavior exactly
 * - this feature adds abuse protection on top, it does not change how a
 * credential is verified or what a caller can distinguish. In
 * particular: the account lookup still uses the raw, un-normalized
 * `email` exactly as before (normalization here is used ONLY to build
 * rate-limit keys, per this feature's explicit scope); a nonexistent
 * user still short-circuits before bcrypt exactly as before (so bcrypt's
 * cost is paid only for a real account, unchanged timing characteristic
 * from before this feature).
 *
 * Security review v2 (independent review of the first pass) changed the
 * concurrency and failure-mode handling here:
 *
 * - BOTH the source-wide failure bucket and the source+account bucket
 *   are now reserved ATOMICALLY BEFORE any lookup/bcrypt work runs (the
 *   source-wide bucket used to be a cheap non-atomic "peek", which a
 *   concurrent burst across many different accounts could bypass - see
 *   rateLimiter.ts's module doc comment). A confirmed failure leaves
 *   both reservations consumed; a confirmed success releases exactly one
 *   slot from EACH (never a bulk reset - see releaseRateLimitSlot's own
 *   doc comment for why that matters when a bucket is shared by
 *   concurrent callers).
 * - If reserving EITHER bucket reports `infrastructure_error` (the
 *   limiter's own DB is unavailable/misbehaving), this function fails
 *   CLOSED: it returns `null` immediately, the exact same externally
 *   visible outcome as an ordinary wrong-password failure, and never
 *   attempts the real credential lookup/bcrypt compare. A rate-limiter
 *   outage must never silently disable login protection.
 *
 * Security review v3 fixed a partial-reservation leak: if the
 * source-wide slot was successfully reserved but the account-specific
 * reservation right after it was `blocked` or `infrastructure_error`,
 * the source-wide reservation was previously left dangling (never
 * released, since it wasn't a "confirmed failure" either - no
 * lookup/bcrypt ever ran). Repeated traffic against one already-blocked
 * account could therefore burn the campus-wide source-wide budget
 * without ever attempting real verification. Now, whenever the account
 * reservation does NOT succeed, the source-wide reservation this
 * request itself just took is released (exactly one slot, using its own
 * window identity - see releaseRateLimitSlot) before returning `null`.
 * This only ever gives back THIS request's own just-taken reservation;
 * it can never touch a genuine prior failure recorded by a different
 * request, and never bulk-resets the bucket.
 */
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { normalizeIdentityEmail } from "@/lib/identityEmail";
import { reserveRateLimitSlot, safeReleaseRateLimitSlot } from "./rateLimiter";
import {
  LOGIN_SOURCE_ACCOUNT_SCOPE,
  LOGIN_SOURCE_ACCOUNT_MAX_ATTEMPTS,
  LOGIN_SOURCE_ACCOUNT_WINDOW_SECONDS,
  LOGIN_SOURCE_FAILURES_SCOPE,
  LOGIN_SOURCE_FAILURES_MAX_ATTEMPTS,
  LOGIN_SOURCE_FAILURES_WINDOW_SECONDS,
} from "./rateLimitScopes";

export type AuthorizedLoginUser = {
  id: string;
  name: string;
  email: string;
  role: "LECTURER" | "STUDENT" | "PLATFORM_ADMIN";
  institutionId: string | null;
};

/**
 * Returns the authorized user on a genuinely valid credential pair, or
 * `null` for every other case - missing input, nonexistent account,
 * wrong password, a rate-limited attempt, OR a rate-limiter
 * infrastructure failure. All of these are deliberately the SAME `null`
 * outcome: a rate-limited (or fail-closed) attempt must remain
 * externally indistinguishable from an ordinary wrong-password failure
 * (no "too many attempts" / "account locked" response, which would
 * itself become an enumeration or abuse-detection oracle).
 */
export async function attemptCredentialsLogin(params: {
  email: string | undefined;
  password: string | undefined;
  sourceIp: string;
}): Promise<AuthorizedLoginUser | null> {
  const { email, password, sourceIp } = params;
  if (!email || !password) return null;

  // Normalized ONLY for the rate-limit key - the lookup below is
  // intentionally untouched. The limiter must operate identically
  // whether the supplied email exists, doesn't exist, or differs only in
  // case/whitespace, which normalizing the KEY (not the lookup)
  // achieves without changing any existing matching behavior.
  const normalizedEmail = normalizeIdentityEmail(email);
  const accountIdentifier = `${sourceIp}|${normalizedEmail}`;

  // Reserve the source-wide safety-net slot FIRST, atomically, before any
  // lookup/bcrypt work - a source already at its spray budget is rejected
  // before this specific account's bucket is even touched. Never released
  // on a rejection here (an unreserved/blocked request never attempted
  // real verification, so there is nothing to give back); only released
  // below on a CONFIRMED success for this exact request.
  const sourceReservation = await reserveRateLimitSlot({
    scope: LOGIN_SOURCE_FAILURES_SCOPE,
    identifier: sourceIp,
    maxAttempts: LOGIN_SOURCE_FAILURES_MAX_ATTEMPTS,
    windowSeconds: LOGIN_SOURCE_FAILURES_WINDOW_SECONDS,
  });
  if (sourceReservation.status !== "reserved") return null;

  // Reserve the primary (source+account) slot - the single atomic call
  // that makes "concurrent attempts cannot bypass the limit" a provable
  // guarantee (see consumeRateLimit's own doc comment). Released below on
  // a confirmed successful login; left in place (i.e. counted as a used
  // slot) on any failure.
  const accountReservation = await reserveRateLimitSlot({
    scope: LOGIN_SOURCE_ACCOUNT_SCOPE,
    identifier: accountIdentifier,
    maxAttempts: LOGIN_SOURCE_ACCOUNT_MAX_ATTEMPTS,
    windowSeconds: LOGIN_SOURCE_ACCOUNT_WINDOW_SECONDS,
  });
  if (accountReservation.status !== "reserved") {
    // Security review v3: this request never attempted real
    // verification (blocked by the account's own budget, or the limiter
    // was unavailable) - give back the source-wide slot THIS request
    // just took, so hammering an already-blocked account cannot burn
    // the shared campus-wide budget for no reason.
    await safeReleaseRateLimitSlot({
      scope: LOGIN_SOURCE_FAILURES_SCOPE,
      identifier: sourceIp,
      windowStartMs: sourceReservation.windowStartMs,
    });
    return null;
  }

  const user = await prisma.user.findUnique({ where: { email } });
  const valid = user ? await bcrypt.compare(password, user.passwordHash) : false;

  if (!user || !valid) {
    // Confirmed failure - both reservations stay consumed. A nonexistent
    // account and a wrong password are deliberately indistinguishable
    // here (both simply "not valid"), matching this function's single
    // `null` return either way.
    return null;
  }

  // Confirmed success - release exactly one slot from EACH bucket this
  // request reserved. Never a bulk reset: releasing only this request's
  // own reservation means a successful login can never erase failures
  // recorded against OTHER accounts sharing this source (source-wide
  // bucket) or concurrent guesses in flight against this SAME account
  // from another request (account bucket).
  await safeReleaseRateLimitSlot({
    scope: LOGIN_SOURCE_ACCOUNT_SCOPE,
    identifier: accountIdentifier,
    windowStartMs: accountReservation.windowStartMs,
  });
  await safeReleaseRateLimitSlot({
    scope: LOGIN_SOURCE_FAILURES_SCOPE,
    identifier: sourceIp,
    windowStartMs: sourceReservation.windowStartMs,
  });

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    institutionId: user.institutionId,
  };
}
