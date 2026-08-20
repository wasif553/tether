/**
 * Auth and Token Abuse Protection v1 — see
 * docs/auth-token-abuse-protection-v1.md.
 *
 * Guards POST /api/exams/[id]/standalone-invite/accept with a
 * source+examId bucket — never a global per-source quota, so many
 * students behind one institutional NAT using different exams' links
 * never affect each other. The invite token itself is never part of the
 * limiter key or persisted here.
 */
import { safeConsumeRateLimit, safePeekRateLimitBlocked } from "./rateLimiter";
import {
  STANDALONE_INVITE_SOURCE_SCOPE,
  STANDALONE_INVITE_SOURCE_MAX_ATTEMPTS,
  STANDALONE_INVITE_SOURCE_WINDOW_SECONDS,
} from "./rateLimitScopes";

export type StandaloneInviteRateLimitGateResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

function identifierFor(sourceIp: string, examId: string): string {
  return `${sourceIp}|${examId}`;
}

/** Read-only fast-path check — call before doing any exam/token lookup. */
export async function standaloneInviteRateLimitGate(
  sourceIp: string,
  examId: string,
): Promise<StandaloneInviteRateLimitGateResult> {
  const peek = await safePeekRateLimitBlocked({
    scope: STANDALONE_INVITE_SOURCE_SCOPE,
    identifier: identifierFor(sourceIp, examId),
    maxAttempts: STANDALONE_INVITE_SOURCE_MAX_ATTEMPTS,
    windowSeconds: STANDALONE_INVITE_SOURCE_WINDOW_SECONDS,
  });
  if (peek.blocked) return { allowed: false, retryAfterSeconds: peek.retryAfterSeconds };
  return { allowed: true };
}

/** Call only when the invite was rejected as invalid (wrong/expired token, disabled invite, unpublished exam, etc.) — never on a genuine accept. */
export async function recordStandaloneInviteInvalidGuess(sourceIp: string, examId: string): Promise<void> {
  await safeConsumeRateLimit({
    scope: STANDALONE_INVITE_SOURCE_SCOPE,
    identifier: identifierFor(sourceIp, examId),
    maxAttempts: STANDALONE_INVITE_SOURCE_MAX_ATTEMPTS,
    windowSeconds: STANDALONE_INVITE_SOURCE_WINDOW_SECONDS,
  });
}
