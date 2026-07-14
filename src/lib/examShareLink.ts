/**
 * Client-side exam join/share link construction — see
 * docs/deployment-vercel-supabase.md.
 *
 * Always built from the CALLER-supplied origin — which must be
 * `window.location.origin` at every call site — never from
 * `process.env.NEXT_PUBLIC_APP_URL`/`APP_URL` or any other env var. The
 * browser's own current origin is definitionally correct (it's wherever
 * the lecturer is actually looking at this page right now, whether
 * that's a production domain or whichever Preview URL Vercel assigned
 * this deployment); a build-time or server-configured env var can go
 * stale after a redeploy and is not guaranteed to match what the
 * lecturer's browser is currently showing.
 */
export function buildStudentJoinLink(origin: string, examId: string): string {
  return `${origin}/student/exams/join/${examId}`;
}
