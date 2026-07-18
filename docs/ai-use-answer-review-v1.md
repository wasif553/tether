# AI-use answer review — v1

Status: implemented, v1. Algorithm version string: `v1.0`
(`AI_USE_REVIEW_ALGORITHM_VERSION` in [`src/lib/aiUseReview.ts`](../src/lib/aiUseReview.ts)).

## This is not an AI detector

This feature does not, and cannot, determine whether an answer was written by AI. It analyses
**observable characteristics** of a submitted answer — how well it references the specific
scenario in the question, whether it addresses explicitly required concepts, whether it contains
claims not grounded in the supplied material, whether it contains directly observable generated-text
artefacts, and whether its writing style is internally consistent with the student's own other
answers in the same attempt — and surfaces each finding as an **explainable review signal** for a
human lecturer. No signal, and no combination of signals, is ever presented as proof of anything.
The lecturer or institution makes the final decision.

It is **not**:
- An AI-generated-answer detector, or any kind of binary "AI vs. human" classifier.
- An internet/source plagiarism checker (no web search, no external plagiarism API).
- A misconduct-reporting or penalty system — it never creates a misconduct case.
- A grading feature — it never changes a score, a grade, `Submission.status`, or marks release.
- A trigger for oral verification — it only ever *recommends*; an `OralVerification` row is still
  only ever created by the lecturer's explicit "Require oral verification" action (see
  [`docs/oral-verification-workflow-v1.md`](./oral-verification-workflow-v1.md)).
- A student-facing feature in v1 — results are never shown to students.
- A comparison against demographic, language-group, cohort, or historical-student norms — style
  comparison is scoped to the student's own answers within one attempt only.

## Required wording

Every user-facing label uses one of these exact strings:

- "AI-use review signal" (generic signal headline — `SIGNAL_TYPE_HEADLINES` default)
- "Lecturer review recommended" (`NEEDS_REVIEW` review status, and the `LECTURER_REVIEW_RECOMMENDED`
  recommendation)
- "Oral verification recommended" (the `ORAL_VERIFICATION_RECOMMENDED` recommendation)
- "Response grounding concern" (`REQUIRED_CONCEPTS_MISSING` headline)
- "Writing consistency concern" (`STYLE_INCONSISTENCY` headline)

See `SIGNAL_TYPE_HEADLINES`, `REVIEW_STATUS_LABELS`, and `RECOMMENDATION_LABELS` in
`src/lib/aiUseReview.ts`.

The following are never used anywhere in this feature's code, UI copy, or audit metadata:
"AI-generated answer", "AI detected", "Written by ChatGPT", "Student used AI", "Cheating detected",
"Proof of AI use", "AI probability", "Guilty", "Misconduct confirmed" (or any percentage/likelihood
framed as an AI-use probability). This is enforced by `containsBannedWording()` in
`src/lib/aiUseReview.ts`, used both to self-check deterministic output and to reject (never
sanitise-and-keep) any optional AI-assisted response that contains banned wording — see
`aiUseReview.test.ts` and `aiUseReviewAssistant.test.ts` ("banned wording").

## Two layers

### Layer A — deterministic (always available)

Implemented in `src/lib/aiUseReview.ts`. Pure functions — no Prisma, no Next.js, no browser APIs, no
LLM client, no network. Always runs, regardless of whether an AI provider is configured, and can
never fail because of the AI provider.

1. **`WEAK_SCENARIO_GROUNDING`** — extracts question-specific anchors (numbers, currency, quoted
   terms, capitalised organisation/system/person names, technical tokens) from the question text
   and checks how many the answer actually references. Requires a sufficiently specific question
   (≥2 anchors) and a meaningful-length answer (≥40 words) before it applies at all — broad
   theoretical questions and short answers are never flagged.
2. **`GENERIC_RESPONSE`** — flags answers with low question-specific term overlap **and** multiple
   generic filler phrases ("in general", "plays a crucial role", etc.). Neither condition alone is
   sufficient: a vocabulary list alone never triggers this, and answer length alone never does
   either.
3. **`REQUIRED_CONCEPTS_MISSING`** — only runs when the question text itself explicitly names a
   required concept (e.g. "Refer to least privilege and separation of duties."). Never infers a
   hidden rubric. A small curated synonym list allows a few common security concepts to be
   recognised under equivalent wording.
4. **`UNSUPPORTED_SPECIFIC_CLAIMS`** — identifies *candidate* claims (numbers/dates/percentages/
   named "Act"/"Study"/"Report"/etc. sources) present in the answer but not in the question. This
   never asserts a claim is false — only that it is not grounded in the supplied material — and
   every occurrence is worded with an explicit uncertainty/limitation statement.
5. **`GENERATED_RESPONSE_META_LANGUAGE`** — detects directly observable response artefacts such as
   "As an AI language model", "[insert example here]", or a direct address to "you" the user rather
   than an academic answer. This is a stronger signal because it is observable text, not an
   inference — but it is still only ever "Generated-response artefact review recommended", never
   "AI use confirmed".
6. **`STYLE_INCONSISTENCY`** — compares a student's own written (non-MCQ) answers **within the same
   attempt only**, on transparent features (average sentence length, vocabulary diversity,
   punctuation frequency, first-person ratio, contraction ratio). Requires ≥3 meaningful answers
   (≥20 words each); compares like-for-like question types where enough same-type answers exist.
   An outlier answer must deviate ≥1.5 standard deviations on **at least two** features. This signal
   can never exceed `MEDIUM` on its own.
7. **`POLISHED_BUT_SHALLOW_RESPONSE`** — requires **multiple** structural-polish indicators
   (≥2 headings/list items, ≥150 words, a polished concluding phrase) **combined with** low scenario
   grounding or a generic-response flag. A well-written response is never flagged on its own.

### Layer B — optional AI-assisted (only when configured)

Implemented in `src/lib/ai/aiUseReviewAssistant.ts`, using the same Anthropic provider as
`src/lib/ai/essayMarker.ts` and `src/lib/ai/questionGenerator.ts` (`ANTHROPIC_API_KEY`, model
`claude-sonnet-4-6`). Only runs when the key is configured; the system prompt explicitly forbids the
model from determining whether AI wrote the answer, inferring misconduct, using writing quality as
proof, or returning a probability/likelihood of AI use — and instructs it to state uncertainty and
alternative explanations in every response.

The model's JSON output is validated against a strict Zod schema (signal `type`/`level` restricted
to the same enums as Layer A) and then re-checked: any signal referencing a question outside the
request, or any free-text field containing banned wording, causes the **entire** AI-assisted
response to be rejected — never partially sanitised and kept, since a partially-cleaned accusatory
signal could still look authoritative to a lecturer. A rejected/failed AI-assisted step never
affects the deterministic (Layer A) results, which are always persisted regardless.

**Privacy of the AI provider payload** — the request sent to the provider contains only:
- an opaque per-run submission reference (never a student name, email, or institution student id)
- bounded question text and answer text (see limits below)

It never contains: camera evidence, institution secrets, or (in v1) the correct answer. See
`aiUseReviewAssistant.test.ts` ("never sends student identity" / "never sends a correct answer").

## What the analysis status means

`AiUseReviewAnalysis.status` is `COMPLETE` once the deterministic layer finishes — the optional
AI-assisted step's own outcome is tracked separately in `summaryJson.aiAssisted.status`
(`NOT_CONFIGURED` | `COMPLETE` | `FAILED`) so the lecturer page can distinguish "deterministic
signals only, AI not configured" from "deterministic signals only, AI attempted and failed" from
"deterministic + AI-assisted signals". If the AI provider is not configured, the UI shows
"AI-assisted review is not configured." and the deterministic checks still run normally — the
platform remains fully usable without an AI API key. `status` only becomes `FAILED` if the
deterministic layer itself throws (e.g. a database error), and even then the submission, its grade,
and its status are completely unaffected — the lecturer can retry.

## Overall recommendation

`calculateAiUseReviewRecommendation()` in `src/lib/aiUseReview.ts` is an explainable, rule-based
function — never a hidden numeric "accusation score" and never `AI_USE_CONFIRMED`/
`MISCONDUCT_CONFIRMED`. Outputs: `NO_IMMEDIATE_ACTION` | `LECTURER_REVIEW_RECOMMENDED` |
`ORAL_VERIFICATION_RECOMMENDED`, always with machine-readable reason codes.

Rules:
- A single `LOW` signal → `NO_IMMEDIATE_ACTION`.
- `STYLE_INCONSISTENCY`, `GENERIC_RESPONSE`, and `POLISHED_BUT_SHALLOW_RESPONSE` can never, even at
  `MEDIUM`, justify `ORAL_VERIFICATION_RECOMMENDED` on their own or in combination with each other.
- Two or more independent `MEDIUM+` signal types, at least one of which is *not* in the limited set
  above, → `ORAL_VERIFICATION_RECOMMENDED`.
- An existing `HIGH` answer-similarity match, or an active oral-verification request, already on
  this submission can corroborate a single `MEDIUM+` AI-use signal into
  `ORAL_VERIFICATION_RECOMMENDED` — but this is corroboration between independent evidence
  categories, never a merged black-box score (see "Independent evidence categories" below).
- Otherwise, any `MEDIUM+` signal → `LECTURER_REVIEW_RECOMMENDED`.

This function **never** creates an `OralVerification` record. That is always an explicit lecturer
action — see [`docs/oral-verification-workflow-v1.md`](./oral-verification-workflow-v1.md).

## Independent evidence categories (never merged)

The submission review page shows AI-use review signals alongside — but never merged with — answer
similarity (linked to the exam's similarity review page) and the existing oral-verification section.
Each is its own explainable category; there is no combined "risk score".

## Lecturer-only visibility and access control

- `POST`/`GET /api/lecturer/submissions/[id]/ai-use-review` and
  `PATCH /api/lecturer/ai-use-review-signals/[signalId]/review` all require a `LECTURER` (who owns
  the exam) or `PLATFORM_ADMIN` session, in the same institution (`assertSameInstitution`) —
  identical convention to the similarity-review routes. A student session always receives 401/403.
- Results are never exposed to any student-facing route in v1.
- Correct answers are never included in any response body or sent to the AI provider.

## Privacy and fairness safeguards

1. Lecturer-only results (see access control above).
2. Same-institution access control, enforced identically to every other lecturer route in this repo.
3. No student name/email/institution student id sent to the AI provider — only an opaque reference.
4. No camera evidence sent to the AI provider.
5. No correct answer sent to the AI provider in v1.
6. No automatic misconduct decision, grade change, or marks-release block — analysis never touches
   `Answer.score`, `Answer.isCorrect`, `Submission.status`, `Submission.totalScore`, or
   `Exam.marksReleasedAt`.
7. No automatic `OralVerification` creation and no automatic student notification.
8. No comparison against demographic, language, disability, nationality, or cohort-level norms.
9. No historical-student profiling — style comparison is scoped to the current attempt's own
   answers only.
10. Every signal states what was observed, why it may warrant review, what evidence supports it, and
    its limitations — see the signal-card fields in the API response and the UI.
11. A lecturer can mark any signal "Reviewed — no concern" to dismiss a false positive.
12. Every review-status change and every analysis run is audited (see below).
13. AI provider failure never affects the submission — the deterministic layer's results are always
    preserved and persisted regardless of the AI-assisted step's outcome.
14. The platform remains fully usable without `ANTHROPIC_API_KEY` set.

## Audit logging

`createPlatformAuditLog()` (same helper as every other feature) records, scoped to the submission's
institution:
- `AI_USE_REVIEW_ANALYSIS_STARTED`
- `AI_USE_REVIEW_DETERMINISTIC_ANALYSIS_COMPLETED` / `AI_USE_REVIEW_AI_ASSISTED_ANALYSIS_COMPLETED`
- `AI_USE_REVIEW_AI_ASSISTED_ANALYSIS_FAILED`
- `AI_USE_REVIEW_SIGNAL_REVIEW_UPDATED` (old/new review status only — never the answer text or the
  lecturer's private review note)

## Performance limits (v1)

- One submitted attempt at a time — never run across an entire institution or exam cohort.
- `MAX_ANSWERS_PER_ANALYSIS` (50 written answers) — above this, the run is refused with a clear 422
  error rather than left to time out (`AiUseReviewCohortTooLargeError`).
- `MAX_ITEMS_PER_ASSIST_REQUEST` (12), `MAX_CHARS_PER_QUESTION` (800), `MAX_CHARS_PER_ANSWER`
  (2000), `MAX_TOTAL_PAYLOAD_CHARS` (20,000), `ASSIST_REQUEST_TIMEOUT_MS` (20s) bound the optional
  AI-assisted request. Truncation/omission is never silent — `buildBoundedAssistInput()` reports
  which question ids were truncated and how many items were omitted.

## Signals deliberately omitted in v1

- No internet-source plagiarism checking, no web search, no external plagiarism API (explicitly
  out of scope — see the task constraints).
- No cross-student comparison in this feature (that already exists, separately, in answer
  similarity — see `docs/answer-similarity-review-v1.md`).
- No comparison against prior courses, prior years, or any other student's historical work.
- No use of `Answer.timeSpentSeconds` or answer edit history — `Answer` has neither timestamps nor
  revision history in this schema (same limitation documented in
  `docs/answer-similarity-review-v1.md`), so no timing-based signal is implemented; fabricating one
  is out of the question.

## Schema

Two new tables, fully additive — see `prisma/schema.prisma` (`AiUseReviewAnalysis`,
`AiUseReviewSignal`) and [`docs/ai-use-review-migration.sql`](./ai-use-review-migration.sql).
Status/level/type/review-status/recommendation fields are validated `String` columns, not Postgres
enums, following the `SubmissionSimilarityAnalysis` convention — validation lives in
`src/lib/aiUseReview.ts`. No existing table, column, or enum is altered. No backfill is required or
possible — analysis only ever runs going forward, triggered explicitly by a lecturer clicking
"Run AI-use review".

Apply the migration via the Supabase SQL Editor (or `psql`) against production. **Never** run
`prisma db push` against production.
