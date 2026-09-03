# Fix Student Completed-Submission Results Flow

## The bug

A student who finished an exam (SUBMITTED or GRADED) and clicked "View
submission" on the dashboard was routed into the exam-taking page
(`/student/exams/[id]`, where `[id]` is the submission id), which — for
a Tether-required exam — tried to re-establish a live native-lockdown
session for an attempt that no longer had one, redirected to
`tether-launch`, and eventually failed there with the backend's
(correct) "No attempts remaining for this exam." rejection. The
backend's repeat-attempt protection was never the problem; a completed
submission was being pushed through machinery meant only for a live
attempt.

## Root cause

1. `student/page.tsx`'s "View submission" link used a raw
   `href={`/student/exams/${submission.id}`}` — the exam-taking route —
   instead of a dedicated read-only route.
2. `GET /api/submissions/[id]/secure-client/status` reported
   `deliveryMode` from the attempt's frozen policy snapshot with no
   awareness of `Submission.status`, so a finished Tether-required
   submission still read as "still needs Tether right now." The exam
   page's pre-load gate (which runs *before* it is safe to fetch full
   submission data) used that to decide whether to detour through
   native-lockdown reactivation — and did, for a submission that no
   longer had anything to reactivate.
3. The exam-taking page's own read-only branch (for a non-IN_PROGRESS
   submission) existed, but was unreachable behind (2) for Tether exams,
   and even when reached, duplicated result-rendering logic that
   belonged in its own place.

## The fix

- **New route**: `src/app/student/submissions/[id]/page.tsx` — the one
  read-only destination for a student's own finished submission. Reads
  `GET /api/submissions/[id]` only (already ownership- and
  release-gated server-side via `canStudentViewMarks`); never calls
  exam-start, never touches camera/timer/secure-client state.
- **New state resolver**: `src/lib/studentSubmissionState.ts` —
  `resolveStudentSubmissionState()` is the one place that turns
  `Submission.status` + `Exam.marksReleasedAt` + exam availability into
  one of six states (`AVAILABLE_TO_START`, `IN_PROGRESS`,
  `SUBMITTED_RESULTS_PENDING`, `GRADED_NOT_RELEASED`,
  `RESULTS_RELEASED`, `CLOSED_NO_ATTEMPT`), plus `isStartableState()`
  (true only for the first two) and `hasReadOnlySubmissionView()` (true
  only for the three completed states). The dashboard card and its
  "View submission"/"View results" link are both derived from this, so
  they can never disagree.
- **Root-cause fix**: `GET /api/submissions/[id]/secure-client/status`
  now also returns `submissionStatus` (additive — `deliveryMode`'s own
  meaning is unchanged, still read verbatim by `tether-launch`/
  `secure-client` pages for a live attempt). The exam-taking page's
  pre-load gate now treats a finished submission as never "gated" by
  the reactivation flow, regardless of what its frozen policy would
  otherwise imply, and falls through to loading submission data
  normally.
- **Defense in depth**: the exam-taking page, once it discovers a
  loaded submission is not `IN_PROGRESS`, redirects immediately to
  `/student/submissions/[id]` — *unless* this exact component instance
  just performed that submission itself (tracked by the pre-existing
  `terminalSubmitRef`, set synchronously by every successful-submit
  path), in which case it keeps showing the existing post-submit
  confirmation message with a link onward. This means direct navigation
  to the exam-taking route for an already-finished submission never
  renders exam content — not even momentarily — before redirecting.
- `GET /api/exams/available` now also returns `marksReleased`,
  `totalPoints`, and (once released) `submission.totalScore`, so the
  dashboard card can show "74 / 100" once results are released without
  a second request.

## What is unchanged

- `POST /api/exams/[id]/start`'s attempt-count rejection (the actual
  "no attempts remaining" 409) — untouched. This fix is entirely about
  routing/UX; a student still cannot create a second attempt once
  finalized attempts exhaust `maxAttempts`.
- `GET /api/submissions/[id]`'s own ownership/marks-release gating
  (`canStudentViewMarks`) — already correct before this fix; this fix
  only makes sure the right page reaches it in the right state, and
  surfaces the same gated fields to the dashboard card.
- No student is ever shown `correctAnswer` for any question, released
  or not — unchanged, matching existing assessment policy.
- No Prisma schema change — every field this fix reads or exposes
  (`Submission.status`/`totalScore`, `Exam.marksReleasedAt`,
  `Answer.score`/`feedback`) already existed and was already read
  correctly by `GET /api/submissions/[id]`; the gap was routing, not
  data storage.
