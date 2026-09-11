# AI Marking Assistance — Single-Answer Entry Point

## The problem

"Mark essays with AI" already existed (see `0cdcb38 Add AI essay marking
assistant`), but only as an exam-wide bulk action on the exam overview page,
with results only ever displayed — never requested — from the per-submission
grading page. A lecturer looking at one student's submission had no way to
discover or trigger AI marking without first navigating away to the exam
page and running it for every essay answer in the exam at once.

## What this adds

A per-question "AI Marking Assistance" entry point directly on the grading
page (`/lecturer/exams/[id]/submissions/[submissionId]`), for **ESSAY
questions only** — MULTIPLE_CHOICE and SHORT_ANSWER are unaffected and
unchanged.

- If no AI draft exists yet for an essay answer: a compact form —
  "AI Marking Assistance", an optional marking-guide textarea, and
  "Get AI marking suggestion".
- Once a draft exists: "Suggested score", a confidence badge, "Criterion
  breakdown", "Strengths", "Areas to improve", "Accept AI draft" (still only
  ever pre-fills the lecturer's editable score field — never saves or
  finalizes anything), "Show details"/"Hide details", and "Regenerate
  suggestion" (re-opens the same guide form, pre-filled with whatever guide
  was last used, and simply overwrites the draft on submit).
- A line showing whether the suggestion is "Based on lecturer marking guide"
  (with a "View guide" toggle showing the exact text used) or "Based on
  Tether default rubric".

The lecturer remains the sole decision-maker throughout: nothing here ever
writes `Submission.status` or `Submission.totalScore` — only
`Answer.aiDraftScore`/`aiReasoning`/`aiGradedAt`, exactly the same fields
the pre-existing bulk action already wrote. Saving/finalizing still only
ever happens through the existing, unmodified `PATCH
/api/submissions/[id]/grade` → "Finalize grade" flow.

## Marking-guide persistence — no schema change

`Answer.aiReasoning` was already a plain `String?` column storing
`JSON.stringify(EssayMarkingResult)`. This is purely additive: the stored
JSON shape gained three more fields — `rubricSource: "LECTURER" | "DEFAULT"`,
`rubric` (the exact `RubricCriterion[]` sent to the marking engine), and
`lecturerGuideText` (the raw guide text, or `null`) — see `AiMarkingRecord`
in `src/lib/ai/essayMarker.ts`. A row written before this change simply has
none of these three fields; every reader treats their absence as "DEFAULT,
no guide" (never a required field, never a migration/backfill). No Prisma
schema change, no migration.

## How a lecturer-supplied guide is used

A lecturer's free-text marking guide is passed to the existing `markEssay()`
engine as a **single rubric criterion** whose description is the lecturer's
own text, verbatim (`buildLecturerGuideRubric`) — never split into multiple
criteria, never reinterpreted, never supplemented with invented criteria.
`maxMarks` is always the question's own total points, so the AI's
`criteriaScores`/`totalScore` can never fall outside the question's real
mark range regardless of what the lecturer wrote. `markEssay()` itself
(prompt-building, response validation) is completely unchanged.

When no guide is supplied, `buildDefaultRubric()` — the exact same 60%
content/accuracy + 40% clarity/structure split the bulk action always
used — is reused unchanged, and is now the single shared source for both
code paths (moved from the bulk route into `essayMarker.ts` itself).

## Single-answer endpoint

`POST /api/lecturer/submissions/[id]/answers/[questionId]/ai-mark`
(`src/app/api/lecturer/submissions/[id]/answers/[questionId]/ai-mark/route.ts`)

- LECTURER-role only; ownership (`exam.createdById`) and institution
  (`assertSameInstitution`) checks, mirroring the existing sibling routes
  under `/api/lecturer/submissions/[id]/` (e.g. `push-grade`).
- 404 if the question doesn't belong to this submission's exam; 400 if it
  isn't `ESSAY`.
- 409 if the submission is still `IN_PROGRESS` (never marks a moving
  target — mirrors `PATCH /grade`'s own "Student has not submitted yet"
  check).
- 400 if the answer has no response text to mark.
- 502 if `ANTHROPIC_API_KEY` is unset, or if `markEssay()` itself fails
  (mirrors the bulk route's own handling) — nothing is written on failure.
- On success: calls the unmodified `markEssay()`, persists the enriched
  record into that one `Answer` row, and returns
  `{ questionId, aiDraftScore, aiReasoning, aiGradedAt }` directly to the
  page — no full-page refetch needed.

**Never touches any other answer.** This is the key difference from the
bulk endpoint: it looks up and updates exactly one `Answer` row
(`submissionId_questionId` compound key), never `findMany` across the exam.

## Bulk endpoint — unaffected

`POST /api/lecturer/exams/[examId]/ai-mark-essays` keeps its exact existing
eligibility filter (`question.type === "ESSAY"`, `submission.status ===
"SUBMITTED"`, `aiDraftScore: null`), its exact existing sequential
marking loop, and its exact existing `{ marked, skipped }` response shape —
completely unchanged. It now stores the same enriched `AiMarkingRecord`
shape (`rubricSource: "DEFAULT"`, the rubric used, `lecturerGuideText:
null`) purely so the grading page's "Based on Tether default rubric" line
renders correctly for bulk-marked answers too — this does not change
eligibility, marking outcomes, or the response shape. Because the filter
already excludes any answer with a non-null `aiDraftScore`, an answer
already marked via the new single-answer endpoint (with or without a
lecturer guide) is correctly skipped by a later bulk run, rather than
silently overwritten.

## Orphaned endpoint — left untouched

`POST /api/lecturer/submissions/[id]/approve-ai-grade` was built in the
same original commit as the bulk action, to let a lecturer "finalize" a
submission with an AI-vs-human audit log line and Canvas passback — but it
has **zero callers anywhere in the client code**; the grading page has
always used the plain `PATCH /api/submissions/[id]/grade` instead. It was
not wired up for this change: doing so was not needed for a working
lecturer-controlled grading flow (the existing `Finalize grade` button
already does the finalize + passback job), and wiring up an unused,
untested endpoint "because it's there" would have been scope creep with no
clear benefit. Left as technical debt for a future pass to either adopt
deliberately or remove.

## What is unaffected

- Student Brainstorm Activity — untouched.
- `aiAssistanceGenerator.ts`, `aiAssistanceVerifier.ts`,
  `aiAssistanceRunner.ts`, `aiAssistancePolicy.ts`, `aiAssistanceReview.ts`,
  `aiAssistanceClassifier.ts` — untouched.
- Secure Browser controls, integrity evidence, `ExamWatermark.tsx`, student
  exam delivery — untouched.
- SHORT_ANSWER and MULTIPLE_CHOICE questions — no AI marking path added or
  changed for either.
- No Prisma schema change, no migration.
