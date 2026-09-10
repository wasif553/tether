# Post-Submission Question Protection

## The requirement

Once a student submits an exam attempt (`SUBMITTED` or `GRADED`), the
student-facing "View submission" page must never display or transmit the
exam's questions — text, options, images, correct answers, model answers,
explanations, or the student's own per-question answers/scores/feedback
(a free-text answer, or lecturer feedback on it, can itself restate or
expose substantial question content). This must hold server-side: no
student-reachable API may send that data to the browser for a finished
attempt, regardless of what the page chooses to render.

## What students see instead

The "View submission" route (`/student/submissions/[id]`) renders a
minimal submission summary:

- Exam title
- Status (Submitted / Graded)
- Submitted time
- Duration (submitted − started)
- Grading status (Pending / Graded — not yet released / Released)
- Total score, only once the exam's marks are released
  (`Exam.marksReleasedAt` — the same `canStudentViewMarks` gate this app
  already used for marks visibility)

No per-question breakdown is shown at all, even after marks release:
`Answer.feedback`/`Answer.score` are Question-scoped fields with no
aggregate/submission-level equivalent in the schema, and displaying them
without the question they're attached to is both close to meaningless and
a residual content-exposure risk (feedback text routinely references the
question's subject matter). The aggregate `totalScore` is the one
release-gated field this feature intentionally keeps.

## Where this is enforced

- **`GET /api/submissions/[id]`** (`src/app/api/submissions/[id]/route.ts`)
  — the actual endpoint the results page reads. A new
  `restrictQuestionContentForStudent` gate (`isOwner && !isExamOwner &&
  submission.status !== "IN_PROGRESS"`) makes `exam.questions` and
  `answers` both `[]` for the student's own finished attempt — the full
  question fetch is skipped entirely (never even queried), matching the
  same latency-driven pattern the route already used for one-question-at-
  a-time delivery. The lecturer's grading view (`isExamOwner`) is
  completely unaffected — this gate can only ever be true for the
  submission's own student. A student's still-`IN_PROGRESS` attempt
  (including a fresh retry after an earlier finalized attempt) is also
  completely unaffected — this only fires once THIS attempt itself is
  finished.
- **`GET /api/exams/[id]`** (`src/app/api/exams/[id]/route.ts`) — a
  second, independent student-reachable route that already returned full
  question text/options for a published exam, gated only on
  `exam.published` with no awareness of submission status at all. No
  current or legitimate student-facing page calls it — real question
  delivery for a student's own active attempt always goes through
  `GET /api/submissions/[id]` (full-paper) or `GET/POST
  /api/submissions/[id]/question(-progress)` (one-question-at-a-time),
  both scoped to one specific submission (and, for one-question mode, one
  specific position). Because this bare exam-level route is unscoped, it
  could otherwise become an alternate delivery path that bypasses those
  boundaries entirely — most concretely, for a one-question-at-a-time
  exam, a direct call would hand back every future question at once,
  defeating the whole point of sequential delivery. `questions` is
  therefore now **unconditionally `[]` for every STUDENT caller** — no
  attempt, `IN_PROGRESS`, a retry's `IN_PROGRESS`, `SUBMITTED`, or
  `GRADED` all behave identically. Every other field on this route
  (title, schedule, `secureSettings`, `secureClientAvailability`, etc.)
  is unchanged and always returned — only `questions` is gated, and no
  separate restricted DTO shape was needed since nothing else on this
  route was ever question content in the first place.
- **`src/app/student/submissions/[id]/page.tsx`** — rewritten from a full
  exam-review UI (question text, options, the student's picked answer)
  to the summary above. This is presentation-layer cleanup, not the
  security boundary — the boundary is the two API routes above, which
  send no question-shaped data to redact in the first place.

## What is unaffected

- Every one-question-at-a-time route (`GET/POST
  /api/submissions/[id]/question(-progress)`, `POST .../save-and-
  navigate`, `PATCH .../question-state/[questionId]`) already rejected a
  non-`IN_PROGRESS` submission before this change (`loadOneQuestionSubmission`
  throws 409) — verified, not modified.
- `PATCH /api/submissions/[id]/answers` already rejected a non-`IN_PROGRESS`
  submission before this change — verified, not modified.
- The exam-taking page (`/student/exams/[id]`) already never rendered
  question content for a non-`IN_PROGRESS` submission (its own top-level
  status gate returns before reaching any exam-content JSX) — verified,
  not modified. It now additionally receives an already-empty `exam.
  questions` from the API for that case, as defense in depth.
- Lecturer grading, review, evidence, and administrative workflows —
  every one reaches submission/question data through `isExamOwner` (or a
  dedicated lecturer-only route), never through the restricted student
  branch added here.
- `POST /api/lecturer/exams/[examId]/preview-sample` (question-pool
  sampling preview) — confirmed `LECTURER`-role-only, not student-
  reachable; no changes needed.
- Brainstorm runtime, Secure Browser integrity controls, phone/camera
  evidence, the exam watermark, integrity review, and question-bank
  functionality — untouched.
- No Prisma schema change, no migration — every field this fix restricts
  already existed and was already correctly read; the gap was exposure at
  the API boundary, not data storage.
