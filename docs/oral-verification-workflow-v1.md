# Oral verification workflow — v1

Status: implemented, v1. See also [`docs/answer-similarity-review-v1.md`](answer-similarity-review-v1.md).

## What this is

A lecturer-controlled follow-up workflow for asking a student a short set of questions about their
own submitted answer, when the lecturer wants more confidence about a submission (for example,
after reviewing a similarity signal — though a lecturer can request one for any reason, not only a
similarity flag).

It is **never automatic**. Running a similarity analysis, or a match being flagged, does **not** by
itself create an `OralVerification` record — the only way one is ever created is an explicit
`POST /api/lecturer/submissions/[id]/oral-verification` call made by a lecturer, with a required
`reason`. This is verified by a dedicated regression test
(`answerSimilarity.routes.test.ts`: "does not automatically create an OralVerification record from
analysis alone").

## Status model

`OralVerification.status` (plain validated string, see `ORAL_VERIFICATION_STATUSES` in
[`src/lib/oralVerificationQuestions.ts`](../src/lib/oralVerificationQuestions.ts)):

| Status | Label shown to lecturer |
|---|---|
| `NOT_REQUIRED` | Not required |
| `REQUIRED` | Oral verification recommended |
| `SCHEDULED` | Scheduled |
| `COMPLETED_NO_CONCERN` | Reviewed — no concern |
| `COMPLETED_CONCERN_REMAINS` | Concern remains |
| `CANCELLED` | Cancelled |

None of these labels, and no other copy in this workflow, use "cheating", "guilty", "suspected", or
any other accusatory language — enforced by test.

Student-facing notice text is fixed and neutral: `ORAL_VERIFICATION_STUDENT_NOTICE` =
*"A follow-up academic discussion has been requested for this assessment."* This never states or
implies a misconduct finding.

## Question generation

`generateOralVerificationQuestions` (pure function, no LLM, deterministic) produces 3–5 questions
from a student's own answer text and the question text/number:

- 3 fixed templates anchored to the actual question number and the student's own answer (e.g. "Can
  you walk me through your answer to Question 4 in your own words?").
- Up to 2 additional questions built from up to 3 "important terms" extracted from the student's
  own answer (`extractImportantTerms` — frequency/length/first-seen ranking over non-stopwords),
  e.g. "You mentioned '<term>' — can you explain what that means in this context?"
- Capped at 5 total questions.
- **Never** includes `Question.correctAnswer` — the function is never passed it at all, so there is
  no way for a generated question to leak the correct answer to the student being asked.
- Deterministic: identical input always produces identical output (no randomness, no external
  call).

The anchor question for generation is either the question the lecturer explicitly picked
(`questionId` in the request body) or, by default, the submission's first answered non-MCQ
question — resolved through the same `resolveEffectiveQuestionIds` used everywhere else, so it
respects question pools (a lecturer is never shown/asked about a question the student wasn't
actually given).

## Lifecycle

1. **Require** — lecturer `POST`s a reason (required, ≤ 2000 chars) and optionally a `questionId`.
   Creates the record at `REQUIRED` with generated questions. Audited as
   `ORAL_VERIFICATION_REQUIRED`.
2. **Schedule** — lecturer `PATCH`es `status: "SCHEDULED"` (optionally `scheduledAt`). Audited as
   `ORAL_VERIFICATION_SCHEDULED`.
3. **Complete** — lecturer `PATCH`es to `COMPLETED_NO_CONCERN` or `COMPLETED_CONCERN_REMAINS`, with
   optional `outcome`/`lecturerNotes`. Sets `completedAt`/`completedById`. Audited as
   `ORAL_VERIFICATION_COMPLETED`.
4. **Cancel** — lecturer `PATCH`es `status: "CANCELLED"`. Audited as `ORAL_VERIFICATION_CANCELLED`.

At every step, the lecturer can also edit the generated questions before use (`questions` field on
the `PATCH`, capped at 10 strings).

## Access control

Every route in this workflow requires a `LECTURER` (owning the exam) or `PLATFORM_ADMIN` session,
checked via `assertSameInstitution`/`institutionScope.ts` against the submission's exam. Students
have no read or write access to `OralVerification` records through any API route.

## What this workflow never does

- Never changes a grade, score, or `Submission.status`.
- Never files or triggers an automatic misconduct report.
- Never happens without an explicit lecturer action with a stated reason.
- Never asks the student a question containing the correct answer.
- Never uses an LLM or external service to generate questions — fully deterministic, local logic.
