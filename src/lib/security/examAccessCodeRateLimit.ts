/**
 * Auth and Token Abuse Protection v1 — see
 * docs/auth-token-abuse-protection-v1.md.
 *
 * Guards the exam access-code check in POST /api/exams/[id]/start with a
 * source+examId bucket — a separate scope from the standalone-invite
 * token bucket (see prisma/schema.prisma's Exam model comment: accessCode
 * and the standalone invite token answer different questions and may
 * both be set on the same exam), even though both happen to key on the
 * same (source, examId) shape. The access code itself is never part of
 * the limiter key or persisted here.
 */
import { safeConsumeRateLimit, safePeekRateLimitBlocked } from "./rateLimiter";
import {
  EXAM_ACCESS_CODE_SOURCE_SCOPE,
  EXAM_ACCESS_CODE_SOURCE_MAX_ATTEMPTS,
  EXAM_ACCESS_CODE_SOURCE_WINDOW_SECONDS,
} from "./rateLimitScopes";

export type ExamAccessCodeRateLimitGateResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

function identifierFor(sourceIp: string, examId: string): string {
  return `${sourceIp}|${examId}`;
}

/** Read-only fast-path check — call before comparing the supplied access code. */
export async function examAccessCodeRateLimitGate(
  sourceIp: string,
  examId: string,
): Promise<ExamAccessCodeRateLimitGateResult> {
  const peek = await safePeekRateLimitBlocked({
    scope: EXAM_ACCESS_CODE_SOURCE_SCOPE,
    identifier: identifierFor(sourceIp, examId),
    maxAttempts: EXAM_ACCESS_CODE_SOURCE_MAX_ATTEMPTS,
    windowSeconds: EXAM_ACCESS_CODE_SOURCE_WINDOW_SECONDS,
  });
  if (peek.blocked) return { allowed: false, retryAfterSeconds: peek.retryAfterSeconds };
  return { allowed: true };
}

/** Call only when the supplied access code was wrong — never when accessCodeRequired is false or the code was correct. */
export async function recordExamAccessCodeInvalidGuess(sourceIp: string, examId: string): Promise<void> {
  await safeConsumeRateLimit({
    scope: EXAM_ACCESS_CODE_SOURCE_SCOPE,
    identifier: identifierFor(sourceIp, examId),
    maxAttempts: EXAM_ACCESS_CODE_SOURCE_MAX_ATTEMPTS,
    windowSeconds: EXAM_ACCESS_CODE_SOURCE_WINDOW_SECONDS,
  });
}
