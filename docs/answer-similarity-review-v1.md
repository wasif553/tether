# Answer similarity review — v1

Status: implemented, v1. Algorithm version string: `v1.0` (`SIMILARITY_ALGORITHM_VERSION` in
[`src/lib/answerSimilarity.ts`](../src/lib/answerSimilarity.ts)).

## What this feature is

After an exam has submissions, a lecturer can run a **post-submission** similarity analysis that
compares students' own submitted answers to each other, on the same exam, on the same question.
It surfaces **explainable review signals** for a human lecturer to look at — it never makes an
automatic decision.

It is **not**:
- An internet/source plagiarism checker (no web search, no external plagiarism API).
- An AI-generated-answer detector.
- A proctoring/camera-integrity feature (unrelated to `src/lib/cameraIntegrityDetection.ts`).
- A grading feature — it never changes a score, a grade, or `Submission.status`.
- An automatic misconduct-reporting or penalty system.

## Required wording

Every user-facing label uses one of these six exact strings (see
`SIMILARITY_REVIEW_STATUS_LABELS` in `answerSimilarity.ts` and `ORAL_VERIFICATION_STATUS_LABELS`
in `oralVerificationQuestions.ts`):

- "Similarity review recommended" (initial/default state of a flagged match — `NEEDS_REVIEW`)
- "Oral verification recommended" (`OralVerification.status = REQUIRED`)
- "Reviewed — no concern"
- "Concern remains"
- "Escalated"
- "Resolved"

The following are never used anywhere in this feature's code, UI copy, or audit metadata:
"Cheating detected", "Plagiarism confirmed", "Student cheated", "AI-generated",
"Proof of misconduct", "Guilty". This is enforced by tests in `answerSimilarity.test.ts` and
`oralVerificationQuestions.test.ts` ("no banned wording").

## Signals implemented

All signals are deterministic, local, explainable comparisons — no embeddings, no external APIs,
no LLM calls.

1. **`IDENTICAL_SHORT_ANSWER`** — two students gave the same (post-normalisation) non-trivial short
   answer to the same question. Normalisation: NFKC, lowercased, punctuation stripped except
   internal `. _ -`, whitespace collapsed (`normalizeAnswerText`). Excludes answers below
   `IDENTICAL_ANSWER_MIN_CHARS` (40) / `IDENTICAL_ANSWER_MIN_WORDS` (8), and excludes a fixed list
   of trivial answers (`TRIVIAL_ANSWERS`: "yes", "no", "n/a", "idk", etc.) so that two students both
   answering "no" is never flagged.
2. **`HIGH_TEXT_SIMILARITY`** — for longer free-text answers (≥ `LONG_ANSWER_MIN_CHARS` 80 chars,
   ≥ `LONG_ANSWER_MIN_WORDS` 15 words), computed from three independent local metrics:
   - cosine similarity over term-frequency vectors (`cosineSimilarity`)
   - word 3-gram Jaccard similarity (`wordNgrams` + `jaccardSimilarity`)
   - longest shared contiguous token run (`longestSharedPhrase`)
   `HIGH` requires cosine ≥ 0.85 **and** n-gram Jaccard ≥ 0.5 **and** a shared phrase of at least
   `DISTINCTIVE_PHRASE_MIN_TOKENS` (6) tokens — i.e. never a single opaque score. `MEDIUM` is a
   lower band (cosine ≥ 0.7 and n-gram Jaccard ≥ 0.3) surfaced only in the analysis summary, not as
   its own flagged item in v1.
3. **`SAME_WRONG_MCQ_PATTERN`** — across the multiple-choice questions two students share, how many
   times they picked the **same incorrect** option (never counts matching *correct* answers,
   verified by a dedicated test). Requires ≥ `MCQ_MIN_SHARED_QUESTIONS` (5) shared MCQ questions and
   ≥ `MCQ_MIN_SAME_WRONG_COUNT` (3) identical wrong answers before it is considered at all; `HIGH`
   requires ≥ 5 identical wrong answers and a ≥ 50% same-wrong ratio.

## Signals deliberately omitted in v1

- **Answer-sequence similarity** and **response-timing similarity** were in the original design
  space but are **not implemented**, because the data does not exist yet:
  - `Answer` has no `createdAt`/`updatedAt` and there is no autosave history table, so there is no
    way to reconstruct the order or pacing in which a student answered questions.
  - `Answer.timeSpentSeconds` exists in the schema but is confirmed (by code search) to be **read
    only** by `src/lib/analytics.ts` and is **never written** by any route — no route currently
    populates real timing data for it.

  Per the task's explicit instruction not to invent data the system doesn't collect, these signals
  are left out entirely rather than faked. If per-answer timestamps or autosave history are added
  in a future task, `SIMILAR_ANSWER_SEQUENCE` / `SIMILAR_RESPONSE_TIMING` can be added to
  `SIMILARITY_SIGNAL_TYPES` without changing anything else in this design.

## Question-pool handling

Two submissions are only ever compared on a `Question.id` that both submissions were actually
given. `similarityAnalysisRunner.ts` calls the existing `resolveEffectiveQuestionIds` (from
`src/lib/questionDelivery.ts`, the same function the exam-delivery and grading code already uses)
for each submission before comparison, so:

- If question pools are inactive, this is simply the exam's fixed question list.
- If question pools are active, each submission's actual per-attempt drawn question set is used —
  two students who were never given the same pooled question are never compared on it.
- Display order / `currentQuestionIndex` / `questionOrderJson` are never used for comparison —
  only the underlying `Question.id`.

## Recommendation logic

`computeSimilarityRecommendation` (in `answerSimilarity.ts`) is a small **rule-based** function over
discrete signal counts, not a single opaque score:

- Counts "strong" signals (`HIGH` risk matches) vs. "weak" signals (`MEDIUM`/flagged-but-lower).
- A single weak signal alone is never enough to recommend oral verification.
- Multiple strong signals, or a strong signal corroborated by an existing camera-integrity event or
  evidence frame for the same submission (read-only lookup — this feature never creates or alters
  integrity events or evidence assets), raise the recommendation toward
  `ORAL_VERIFICATION_RECOMMENDED` / `ESCALATION_RECOMMENDED`.
- Always returns a `reasonCodes: string[]` array alongside the recommendation, so the lecturer UI
  can show *why*, never just a number.

## Database migration

Purely additive — see [`docs/answer-similarity-migration.sql`](answer-similarity-migration.sql).
Three new tables (`SubmissionSimilarityAnalysis`, `SubmissionSimilarityMatch`,
`OralVerification`), no existing table/column is altered. Status/type/risk fields are plain
validated `String` columns (matching the existing `QuestionPool` / `IntegrityEvidenceAsset`
convention), not Postgres enums, so the migration carries zero `ALTER TYPE` risk. Foreign keys use
`CASCADE` along ownership chains (analysis → matches, submission → matches/verifications) and
`SET NULL` for optional references (`questionId`, `reviewedById`, `completedById`) so deleting a
question or a staff account never destroys similarity/verification history.

## Lecturer UI

`/lecturer/exams/[id]/similarity` (linked from the exam page) — shows analysis status, summary
counts, a "Run similarity analysis" button, and each flagged match with its signal type, risk,
explainable summary/metrics, matched excerpt (short-answer/n-gram case only — never the full
answer text of a long essay), the fixed disclaimer *"This is a review signal and is not an
automatic academic misconduct decision."*, and review actions (the four review-status buttons plus
an optional review note). A "Require oral verification" link jumps to the relevant submission's
detail page, where the Oral Verification section lives (see below).

## Access control

- Lecturer must own the exam (`createdById`) and be in the same institution
  (`assertSameInstitution` / `institutionScope.ts`), or be a platform admin.
- Students have no access to any similarity or oral-verification endpoint — verified in
  `answerSimilarity.routes.test.ts` (401 for `GET`/`POST` similarity-analysis, 401 for `PATCH`
  review as a student).
- `correctAnswer` is never included in any similarity API response or `matchedDetailJson` — only
  counts, ratios, and question ids. Verified by test.

## Audit logging

Every write action creates a `PlatformAuditLog` row via the existing `createPlatformAuditLog`
helper: `SIMILARITY_ANALYSIS_STARTED`, `SIMILARITY_ANALYSIS_COMPLETED`,
`SIMILARITY_MATCH_REVIEW_UPDATED` (metadata: exam id, both submission ids, old/new status — never
answer text or review-note contents), `ORAL_VERIFICATION_REQUIRED`,
`ORAL_VERIFICATION_SCHEDULED`, `ORAL_VERIFICATION_COMPLETED`, `ORAL_VERIFICATION_CANCELLED`.

## Performance

Analysis runs synchronously inside the `POST` request — there is no queue/worker in this repo, so
none is claimed. It is capped at `MAX_ANALYSIS_SUBMISSIONS = 100` submissions per exam
(`SimilarityCohortTooLargeError` beyond that, surfaced as HTTP 422), which bounds the pairwise
comparison count to at most ~4,950 pairs of small in-memory text comparisons — safely within a
normal Vercel request budget. Larger cohorts are out of scope for v1 and would need a real
background job, which does not currently exist in this codebase.

## Fairness / privacy safeguards

- Only compares a student's own submitted answers against other students' own submitted answers on
  the same exam/question — never against any external source.
- A single weak signal is never enough to trigger a strong recommendation.
- MCQ matching never flags matching *correct* answers, only matching *incorrect* ones.
- All output is framed as a review signal for the lecturer, with the fixed disclaimer shown in the
  UI; the lecturer/institution always makes the final call. No grade, score, or submission status
  is ever changed by this feature.
- Full answer text is never sent anywhere external; only local, in-process comparisons are used.
