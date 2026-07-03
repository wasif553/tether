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
