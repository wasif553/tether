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
 * rateLimiter.ts's module doc comment).
 *
 * Security review v3: two more fixes —
 *   1. Callers must now reserve ONLY immediately before actual
 *      tokenHash verification, never before the invitation lookup — see
 *      the calling routes' own doc comments for why (storage-cardinality:
 *      invitationId is attacker-controlled URL input, so reserving
 *      earlier would let arbitrary/nonexistent ids each create a bucket
 *      row).
 *   2. `releaseCourseInvitationSlot` now requires the exact
 *      `windowStartMs` the reservation returned, so a delayed release can
 *      never accidentally decrement a newer window's count (see
 *      rateLimiter.ts's `releaseRateLimitSlot` doc comment).
 *
 * Every caller must:
 *   1. resolve every existing, non-secret-guessing outcome first
 *      (invitation absent, wrong_account, already_accepted, revoked,
 *      expired) — none of these ever reserve a slot;
 *   2. call reserveCourseInvitationSlot() ONLY once genuinely about to
 *      verify the token against a real invitation row;
 *   3. on `blocked`, return 429 immediately without verifying the token;
 *   4. on `infrastructure_error`, return a generic 503 WITHOUT verifying
 *      the token (never an existence/validity oracle);
 *   5. on `reserved`, verify the token, then call
 *      releaseCourseInvitationSlot() (with the reservation's own
 *      `windowStartMs`) only on a genuinely valid token — never for an
 *      invalid one, which leaves the reservation consumed.
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

/** Call ONLY when genuinely about to verify a real invitation's token. */
export async function reserveCourseInvitationSlot(sourceIp: string, invitationId: string): Promise<RateLimitReservation> {
  return reserveRateLimitSlot({
    scope: COURSE_INVITATION_SOURCE_SCOPE,
    identifier: identifierFor(sourceIp, invitationId),
    maxAttempts: COURSE_INVITATION_SOURCE_MAX_ATTEMPTS,
    windowSeconds: COURSE_INVITATION_SOURCE_WINDOW_SECONDS,
  });
}

/** Call only on a genuinely valid token — `windowStartMs` must be the exact value the matching reservation returned. */
export async function releaseCourseInvitationSlot(sourceIp: string, invitationId: string, windowStartMs: number): Promise<void> {
  await safeReleaseRateLimitSlot({
    scope: COURSE_INVITATION_SOURCE_SCOPE,
    identifier: identifierFor(sourceIp, invitationId),
    windowStartMs,
  });
}
