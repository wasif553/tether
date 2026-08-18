/**
 * Safe Exam Deep Link v1 — see
 * docs/course-enrolment-and-exam-assignment.md. Restricts post-login
 * redirect targets to the exam join route only, so a
 * `?callbackUrl=...` value can never be used as an open redirect to an
 * arbitrary internal or external URL.
 *
 * Only a same-origin, relative path matching exactly
 * `/student/exams/join/<examId>` (no extra path segments, no query/hash
 * tricks smuggled into the path) is accepted. Anything else — including
 * protocol-relative URLs (`//evil.com`), absolute URLs, or paths outside
 * this one route — is rejected.
 */
const JOIN_PATH_RE = /^\/student\/exams\/join\/[A-Za-z0-9_-]+$/;

export function isSafeJoinCallbackUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  // Must be a relative path starting with exactly one slash — rejects
  // "//evil.com" (protocol-relative) and "http://..."/"https://...".
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  return JOIN_PATH_RE.test(value);
}

/**
 * Standalone Exam Link v1 — see docs/standalone-exam-link-v1.md. The
 * invitation-token-bearing join URL is a distinct path shape
 * (`/student/exams/join/{examId}/invite/{token}`), not a query string —
 * deliberately, so this allowlist stays a pure path-based regex rather
 * than needing to parse/validate query parameters, and so the plain
 * `/student/exams/join/{examId}` route (matched by JOIN_PATH_RE above)
 * is untouched and still never carries standalone entitlement on its
 * own. Same character class as every other path segment here — no
 * query/hash smuggling, no traversal.
 */
const JOIN_WITH_INVITE_PATH_RE = /^\/student\/exams\/join\/[A-Za-z0-9_-]+\/invite\/[A-Za-z0-9_-]+$/;

export function isSafeJoinWithInviteCallbackUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  return JOIN_WITH_INVITE_PATH_RE.test(value);
}

/**
 * Narrow companion to isSafeJoinCallbackUrl: also allows a same-origin,
 * relative path under the authenticated lecturer area (e.g.
 * `/lecturer/exams/[id]/submissions`), so a lecturer whose session
 * expires mid-navigation is sent back to the page they wanted instead of
 * "/" after logging back in — without loosening any of the open-redirect
 * protection above. Every segment after `/lecturer` must be a plain path
 * segment (letters/digits/hyphen/underscore only) — no query/hash
 * smuggling, no `..` traversal, no encoded slashes.
 */
const LECTURER_PATH_RE = /^\/lecturer(\/[A-Za-z0-9_-]+)*$/;

/**
 * Tether launch/install flow v1 — see
 * src/app/student/exams/[id]/tether-launch/page.tsx. Same purpose as
 * JOIN_PATH_RE: when Tether Secure Browser's deep link lands on this
 * exact page while the student is unauthenticated, the existing
 * proxy.ts/login callback-URL mechanism (already proven by the join-link
 * feature — see the module doc comment above) returns them here
 * automatically after signing in, with no additional Electron-side
 * pending-launch state needed. Exactly one path segment (the examId)
 * after `/tether-launch` is never present — this is the terminal
 * segment of the path, matching JOIN_PATH_RE's shape.
 */
const TETHER_LAUNCH_PATH_RE = /^\/student\/exams\/[A-Za-z0-9_-]+\/tether-launch$/;

export function isSafeTetherLaunchCallbackUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  return TETHER_LAUNCH_PATH_RE.test(value);
}

export function isSafeAppCallbackUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  return (
    JOIN_PATH_RE.test(value) ||
    JOIN_WITH_INVITE_PATH_RE.test(value) ||
    LECTURER_PATH_RE.test(value) ||
    TETHER_LAUNCH_PATH_RE.test(value)
  );
}
