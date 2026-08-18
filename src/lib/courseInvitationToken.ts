/**
 * Tether Course Invitation + Acceptance v1 — see
 * docs/tether-course-invitation-acceptance-v1.md.
 *
 * Deliberately a separate module from src/lib/standaloneInvite.ts (the
 * Standalone Exam Link v1 token lib) rather than a shared/generalized
 * one — Standalone Exam Link v1 is DONE/FROZEN and must not be modified
 * or have its semantics implicitly coupled to this unrelated feature.
 * The two modules happen to share the same cryptographic shape
 * (256-bit random token, SHA-256 hash, timing-safe comparison) because
 * that shape is simply the correct one for "server-generated, unguessable,
 * single-purpose secret" — not because of any code-sharing requirement.
 *
 * Same reasoning as standaloneInvite.ts for using SHA-256 instead of
 * bcrypt: bcrypt's slow cost factor defends against brute-forcing a
 * low-entropy, human-chosen secret, and adds nothing for an
 * already-unguessable 256-bit server-generated token.
 */
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

export const COURSE_INVITATION_TOKEN_BYTES = 32;

/** Commercial v1 fixed expiry — no configurable duration in this pass. */
export const COURSE_INVITATION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

export function generateCourseInvitationToken(): string {
  return randomBytes(COURSE_INVITATION_TOKEN_BYTES).toString("base64url");
}

export function hashCourseInvitationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function verifyCourseInvitationToken(token: string, hash: string): boolean {
  const candidate = Buffer.from(hashCourseInvitationToken(token), "hex");
  const stored = Buffer.from(hash, "hex");
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}

/**
 * Bound to the invitation's own id, not the course or student id — the
 * invitation row itself is what carries studentId/courseId/expiry/
 * revocation state, so the URL only needs to identify which invitation
 * row and prove knowledge of its secret. A dedicated path shape (not a
 * query string), mirroring the Standalone Exam Link v1 invite URL
 * convention and its src/lib/safeCallbackUrl.ts allowlist approach.
 */
export function buildCourseInvitationUrl(invitationId: string, token: string): string {
  return `/student/course-invitations/${invitationId}/${token}`;
}
