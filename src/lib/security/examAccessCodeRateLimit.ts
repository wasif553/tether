/**
 * Auth and Token Abuse Protection v1 — see
 * docs/auth-token-abuse-protection-v1.md.
 *
 * Guards the exam access-code check in POST /api/exams/[id]/start with a
 * source+authenticatedStudentId+examId bucket — a separate scope from
 * the standalone-invite token bucket (see prisma/schema.prisma's Exam
 * model comment: accessCode and the standalone invite token answer
 * different questions and may both be set on the same exam). The access
 * code itself is never part of the limiter key or persisted here.
 *
 * Security review v2 — this was the most important campus-NAT fix in
 * this pass. Two changes from the first pass:
 *
 * 1. Identity now includes the AUTHENTICATED student id (always taken
 *    from the verified session — see the route — never from request
 *    JSON/query), not just source+examId. The first pass's source+examId
 *    key meant ten wrong access-code entries across DIFFERENT students
 *    behind one shared exam-room NAT could lock out the entire room,
 *    including a student about to enter the CORRECT code. Per-student
 *    keying means one student exhausting their own guesses never affects
 *    any other student's ability to start the same exam from the same
 *    network.
 * 2. Reserve/release replaced the first pass's peek-then-consume-on-
 *    invalid pattern (a concurrent-burst bypass — see rateLimiter.ts's
 *    module doc comment).
 *
 * Security review v3: `releaseExamAccessCodeSlot` now requires the exact
 * `windowStartMs` the reservation returned, so a delayed release can
 * never accidentally decrement a newer window's count (see
 * rateLimiter.ts's `releaseRateLimitSlot` doc comment). No
 * storage-cardinality restructuring was needed here — the calling route
 * (POST /api/exams/[id]/start) already looks up and confirms the exam
 * exists (returning 404 otherwise) well before reaching the
 * accessCodeRequired block this reserves around, so a reservation is
 * already only ever taken against a real, existing exam.
 */
import { reserveRateLimitSlot, safeReleaseRateLimitSlot, type RateLimitReservation } from "./rateLimiter";
import {
  EXAM_ACCESS_CODE_SOURCE_SCOPE,
  EXAM_ACCESS_CODE_SOURCE_MAX_ATTEMPTS,
  EXAM_ACCESS_CODE_SOURCE_WINDOW_SECONDS,
} from "./rateLimitScopes";

function identifierFor(sourceIp: string, studentId: string, examId: string): string {
  return `${sourceIp}|${studentId}|${examId}`;
}

/** Call BEFORE comparing the supplied access code. */
export async function reserveExamAccessCodeSlot(
  sourceIp: string,
  studentId: string,
  examId: string,
): Promise<RateLimitReservation> {
  return reserveRateLimitSlot({
    scope: EXAM_ACCESS_CODE_SOURCE_SCOPE,
    identifier: identifierFor(sourceIp, studentId, examId),
    maxAttempts: EXAM_ACCESS_CODE_SOURCE_MAX_ATTEMPTS,
    windowSeconds: EXAM_ACCESS_CODE_SOURCE_WINDOW_SECONDS,
  });
}

/** Call only when the supplied access code was CORRECT — `windowStartMs` must be the exact value the matching reservation returned. */
export async function releaseExamAccessCodeSlot(
  sourceIp: string,
  studentId: string,
  examId: string,
  windowStartMs: number,
): Promise<void> {
  await safeReleaseRateLimitSlot({
    scope: EXAM_ACCESS_CODE_SOURCE_SCOPE,
    identifier: identifierFor(sourceIp, studentId, examId),
    windowStartMs,
  });
}
