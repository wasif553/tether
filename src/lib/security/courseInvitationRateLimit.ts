/**
 * Auth and Token Abuse Protection v1 — see
 * docs/auth-token-abuse-protection-v1.md.
 *
 * Guards the course-invitation token verification surfaces
 * (GET and POST .../accept under /api/course-invitations/[invitationId]/[token])
 * with a source+invitationId bucket — never a global per-source quota,
 * so many students behind one institutional NAT using their own,
 * different, legitimate invitations never affect each other. The token
 * itself is never part of the limiter key or persisted here.
 */
import { safeConsumeRateLimit, safePeekRateLimitBlocked } from "./rateLimiter";
import {
  COURSE_INVITATION_SOURCE_SCOPE,
  COURSE_INVITATION_SOURCE_MAX_ATTEMPTS,
  COURSE_INVITATION_SOURCE_WINDOW_SECONDS,
} from "./rateLimitScopes";

export type CourseInvitationRateLimitGateResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

function identifierFor(sourceIp: string, invitationId: string): string {
  return `${sourceIp}|${invitationId}`;
}

/** Read-only fast-path check — call before doing any invitation lookup. */
export async function courseInvitationRateLimitGate(
  sourceIp: string,
  invitationId: string,
): Promise<CourseInvitationRateLimitGateResult> {
  const peek = await safePeekRateLimitBlocked({
    scope: COURSE_INVITATION_SOURCE_SCOPE,
    identifier: identifierFor(sourceIp, invitationId),
    maxAttempts: COURSE_INVITATION_SOURCE_MAX_ATTEMPTS,
    windowSeconds: COURSE_INVITATION_SOURCE_WINDOW_SECONDS,
  });
  if (peek.blocked) return { allowed: false, retryAfterSeconds: peek.retryAfterSeconds };
  return { allowed: true };
}

/** Call only when the verification outcome was genuinely invalid (unknown invitation or bad token) — never for wrong_account/expired/revoked/already_accepted. */
export async function recordCourseInvitationInvalidGuess(sourceIp: string, invitationId: string): Promise<void> {
  await safeConsumeRateLimit({
    scope: COURSE_INVITATION_SOURCE_SCOPE,
    identifier: identifierFor(sourceIp, invitationId),
    maxAttempts: COURSE_INVITATION_SOURCE_MAX_ATTEMPTS,
    windowSeconds: COURSE_INVITATION_SOURCE_WINDOW_SECONDS,
  });
}
