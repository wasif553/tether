/**
 * Auth and Token Abuse Protection v1 — see
 * docs/auth-token-abuse-protection-v1.md.
 *
 * Guards POST /api/exams/[id]/standalone-invite/accept with a
 * source+authenticatedStudentId+examId bucket. The invite token itself
 * is never part of the limiter key or persisted here.
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
 * Security review v3: two more fixes —
 *
 * 1. The calling route now reserves ONLY once it has already confirmed
 *    the exam id is real and eligible for a standalone invite —
 *    reserving before that would let an attacker create a bucket row per
 *    arbitrary/nonexistent exam id (storage-cardinality).
 * 2. `releaseStandaloneInviteSlot` now requires the exact `windowStartMs`
 *    the reservation returned, so a delayed release can never
 *    accidentally decrement a newer window's count (see rateLimiter.ts's
 *    `releaseRateLimitSlot` doc comment).
 */
import { reserveRateLimitSlot, safeReleaseRateLimitSlot, type RateLimitReservation } from "./rateLimiter";
import {
  STANDALONE_INVITE_SOURCE_SCOPE,
  STANDALONE_INVITE_SOURCE_MAX_ATTEMPTS,
  STANDALONE_INVITE_SOURCE_WINDOW_SECONDS,
} from "./rateLimitScopes";

function identifierFor(sourceIp: string, studentId: string, examId: string): string {
  return `${sourceIp}|${studentId}|${examId}`;
}

/** Call ONLY once the exam id is confirmed real and eligible, immediately before verifying the invite token. */
export async function reserveStandaloneInviteSlot(
  sourceIp: string,
  studentId: string,
  examId: string,
): Promise<RateLimitReservation> {
  return reserveRateLimitSlot({
    scope: STANDALONE_INVITE_SOURCE_SCOPE,
    identifier: identifierFor(sourceIp, studentId, examId),
    maxAttempts: STANDALONE_INVITE_SOURCE_MAX_ATTEMPTS,
    windowSeconds: STANDALONE_INVITE_SOURCE_WINDOW_SECONDS,
  });
}

/** Call only on a genuine accept — `windowStartMs` must be the exact value the matching reservation returned. */
export async function releaseStandaloneInviteSlot(
  sourceIp: string,
  studentId: string,
  examId: string,
  windowStartMs: number,
): Promise<void> {
  await safeReleaseRateLimitSlot({
    scope: STANDALONE_INVITE_SOURCE_SCOPE,
    identifier: identifierFor(sourceIp, studentId, examId),
    windowStartMs,
  });
}
