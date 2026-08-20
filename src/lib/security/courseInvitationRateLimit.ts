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
 *
 * Security review v2: reserve/release replaced the first pass's
 * peek-then-consume-on-invalid pattern (a concurrent-burst bypass — see
 * rateLimiter.ts's module doc comment). Every caller must:
 *   1. call reserveCourseInvitationSlot() BEFORE looking up the
 *      invitation or verifying its token;
 *   2. on `blocked`, return 429 immediately without touching the DB;
 *   3. on `infrastructure_error`, return a generic 503 WITHOUT looking up
 *      the invitation or verifying the token (never an existence oracle);
 *   4. on `reserved`, proceed, then call releaseCourseInvitationSlot()
 *      for every outcome that must NOT count (valid, wrong_account,
 *      already_accepted, revoked, expired) — never for a genuinely
 *      invalid invitation/token, which leaves the reservation consumed.
 */
import { reserveRateLimitSlot, safeReleaseRateLimitSlot, type RateLimitReservation } from "./rateLimiter";
import {
  COURSE_INVITATION_SOURCE_SCOPE,
  COURSE_INVITATION_SOURCE_MAX_ATTEMPTS,
  COURSE_INVITATION_SOURCE_WINDOW_SECONDS,
} from "./rateLimitScopes";

function identifierFor(sourceIp: string, invitationId: string): string {
  return `${sourceIp}|${invitationId}`;
}

/** Call BEFORE any invitation lookup or token verification. */
export async function reserveCourseInvitationSlot(sourceIp: string, invitationId: string): Promise<RateLimitReservation> {
  return reserveRateLimitSlot({
    scope: COURSE_INVITATION_SOURCE_SCOPE,
    identifier: identifierFor(sourceIp, invitationId),
    maxAttempts: COURSE_INVITATION_SOURCE_MAX_ATTEMPTS,
    windowSeconds: COURSE_INVITATION_SOURCE_WINDOW_SECONDS,
  });
}

/** Call only for outcomes that must NOT count against the budget — never for a genuinely invalid invitation/token. */
export async function releaseCourseInvitationSlot(sourceIp: string, invitationId: string): Promise<void> {
  await safeReleaseRateLimitSlot({
    scope: COURSE_INVITATION_SOURCE_SCOPE,
    identifier: identifierFor(sourceIp, invitationId),
  });
}
