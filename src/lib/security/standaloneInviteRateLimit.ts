/**
 * Auth and Token Abuse Protection v1 — see
 * docs/auth-token-abuse-protection-v1.md.
 *
 * Guards POST /api/exams/[id]/standalone-invite/accept with a
 * source+authenticatedStudentId bucket — deliberately NOT +examId (see
 * "Security review v4" below). The invite token itself, and the exam id,
 * are never part of the limiter key or persisted here.
 *
 * Security review v2: two changes from the first pass —
 *
 * 1. Identity now includes the AUTHENTICATED student id (always taken
 *    from the verified session — see the route — never from request
 *    JSON/query), not just source+examId. Keying on source+examId alone
 *    meant every student behind one institutional NAT accessing the SAME
 *    standalone exam shared one small bucket — one student's repeated
 *    wrong-token guesses could lock out every other student on that
 *    network for that exam. Per-student keying gives each student their
 *    own independent budget.
 * 2. Reserve/release replaced the first pass's peek-then-consume-on-
 *    invalid pattern (a concurrent-burst bypass — see rateLimiter.ts's
 *    module doc comment).
 *
 * Security review v3: `releaseStandaloneInviteSlot` requires the exact
 * `windowStartMs` the reservation returned, so a delayed release can
 * never accidentally decrement a newer window's count (see
 * rateLimiter.ts's `releaseRateLimitSlot` doc comment). (v3 also moved
 * the reservation to only after confirming the exam id was real and
 * eligible — that ordering is corrected again in v4 below.)
 *
 * Security review v4: v3's "reserve only after confirming the exam is
 * real and eligible" fixed row-cardinality but introduced an information
 * oracle — a nonexistent/ineligible exam id never rate-limited (always
 * the same invalid_invite forever), while a real eligible exam's
 * wrong-token guesses eventually surfaced 429, letting a caller learn
 * "this id is a real standalone exam" purely from whether rate limiting
 * ever activates, without needing the actual token. Fixed by dropping
 * `examId` from the key entirely and reserving BEFORE the exam lookup:
 * every request from a given student+source now draws from the exact
 * same budget and gets the identical invalid_invite response up to the
 * threshold, then the identical 429 after it, regardless of whether the
 * requested exam id was ever real. This also closes the unbounded-DB-
 * lookup gap arbitrary/nonexistent exam ids previously had (they never
 * touched the rate limiter at all under the v3 ordering).
 */
import { reserveRateLimitSlot, safeReleaseRateLimitSlot, type RateLimitReservation } from "./rateLimiter";
import {
  STANDALONE_INVITE_SOURCE_SCOPE,
  STANDALONE_INVITE_SOURCE_MAX_ATTEMPTS,
  STANDALONE_INVITE_SOURCE_WINDOW_SECONDS,
} from "./rateLimitScopes";

function identifierFor(sourceIp: string, studentId: string): string {
  return `${sourceIp}|${studentId}`;
}

/** Call BEFORE the exam lookup — reserving here must not depend on whether the requested exam id turns out to be real. */
export async function reserveStandaloneInviteSlot(sourceIp: string, studentId: string): Promise<RateLimitReservation> {
  return reserveRateLimitSlot({
    scope: STANDALONE_INVITE_SOURCE_SCOPE,
    identifier: identifierFor(sourceIp, studentId),
    maxAttempts: STANDALONE_INVITE_SOURCE_MAX_ATTEMPTS,
    windowSeconds: STANDALONE_INVITE_SOURCE_WINDOW_SECONDS,
  });
}

/** Call only on a genuine accept — `windowStartMs` must be the exact value the matching reservation returned. */
export async function releaseStandaloneInviteSlot(sourceIp: string, studentId: string, windowStartMs: number): Promise<void> {
  await safeReleaseRateLimitSlot({
    scope: STANDALONE_INVITE_SOURCE_SCOPE,
    identifier: identifierFor(sourceIp, studentId),
    windowStartMs,
  });
}
