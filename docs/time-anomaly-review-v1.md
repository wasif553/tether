# Time anomaly review — v1

Status: implemented, v1. Algorithm version string: `v1.0`
(`TIME_ANOMALY_ALGORITHM_VERSION` in [`src/lib/timeAnomalyDetection.ts`](../src/lib/timeAnomalyDetection.ts)).
Migration: `docs/exam-session-binding-migration.sql` (combined with the session-binding tables —
see that file's header for why).

## What this feature is

Post-submission, lecturer-triggered analysis of coarse answer-activity timing, producing explainable
**review signals** — "Timing review recommended", never "pasted answer confirmed". The lecturer or
institution makes the final decision; this feature never changes a grade, blocks marks release, or
creates a misconduct case.

It is **not** a keystroke-timing analyser, a plagiarism-detection tool, or a tool that infers
question difficulty from question text using AI (v1 has no reliable difficulty data at all — see
"Signals deliberately omitted" below).

## Required wording

- "Timing review recommended" (`NEEDS_REVIEW`, and every timing signal's headline)
- "Rapid answer appearance" (student-facing convention — the actual signal type is
  `RAPID_LARGE_RESPONSE_APPEARANCE`, deliberately never called "pasted"; paste is already blocked by
  Secure Exam Mode elsewhere, so this uses neutral, observable-only wording)

Never used: `PASTED_ANSWER_CONFIRMED` (explicitly rejected by the task) or any wording that asserts
how a response was produced.

## Review-only workflow; no automatic misconduct decision

Confirmed by test coverage (`timeAnomalyDetection.test.ts`, `combinedReviewRecommendation.test.ts`,
`sessionAndTimingReview.routes.test.ts`): no timing signal or combination of signals ever creates an
`OralVerification` record, changes `Answer.score`/`isCorrect`, or touches `Submission.status`. The
recommendation function's allowed outputs are exactly `NO_IMMEDIATE_ACTION` |
`LECTURER_REVIEW_RECOMMENDED` | `ORAL_VERIFICATION_RECOMMENDED` | `ESCALATION_RECOMMENDED` — never
`AI_USE_CONFIRMED`/`MISCONDUCT_CONFIRMED`/anything "proven" or "guilty".

## Server time is authoritative

Every threshold comparison in `src/lib/timeAnomalyDetection.ts` uses `serverReceivedAtMs` —
`AnswerActivityEvent.serverReceivedAt`, set by the database at insert time. `clientElapsedMs` is
captured and stored but is purely supplementary; it is never read by any of the pure analysis
functions and never overrides a server timestamp.

## Signals implemented

All in `src/lib/timeAnomalyDetection.ts` (pure) + `src/lib/timingAnalysisRunner.ts` (orchestration):

1. **`EXTREMELY_FAST_ATTEMPT`** — requires ≥10 answered questions
   (`MIN_QUESTIONS_FOR_FAST_ATTEMPT_SIGNAL`) and a valid submit time. `MEDIUM` at ≤3s/question
   average, `HIGH` at ≤1s/question. A 5-question quiz finished in 2 minutes never triggers this — the
   minimum-question floor exists specifically so a legitimately short exam isn't flagged.
2. **`RAPID_MULTI_QUESTION_COMPLETION`** — ≥8 *distinct* questions saved/navigated with non-empty
   responses within a 60-second sliding window, using only server timestamps.
3. **`RAPID_LARGE_RESPONSE_APPEARANCE`** — ≥500 characters of growth between two *consecutive* saved
   versions of the same question within ≤5 seconds. Progressive autosave growth (many small saves)
   never triggers this, since each individual delta stays below the threshold. Wording is always
   neutral ("a response of roughly N characters appeared…") — never "pasted".
4. **`LONG_INACTIVITY_THEN_LARGE_RESPONSE`** — a ≥10-minute gap in *any* recorded activity (not just
   saves — a heartbeat gap counts too) immediately followed by a ≥300-character saved-response
   increase. The explanation and limitation both explicitly note that a closed laptop or a network
   outage produce an identical pattern — absence of a heartbeat is never treated as proof.
5. **`VERY_FAST_CORRECT_RESPONSE_PATTERN`** — see "Signals deliberately omitted" below.
6. **`SIMILAR_RESPONSE_TIMING_PATTERN`** — cross-submission only, compared on the actual shared
   `Question.id`s (never by display position, since question pools and per-attempt randomisation
   mean position is meaningless across students), using relative-from-attempt-start timing and
   Spearman rank correlation. Requires ≥5 shared questions
   (`MIN_SHARED_QUESTIONS_FOR_TIMING_COMPARISON`). Capped at `MEDIUM` — **never `HIGH` on its own** —
   and its limitation text says explicitly that it only becomes meaningful alongside other
   independent signals.
7. **`ABRUPT_ACTIVITY_BURST`** — ≥12 activity events of any kind within a 10-second window,
   independent of question distinctness or correctness — a general event-density detector distinct
   from #2 above.
8. **`INSUFFICIENT_TIMING_DATA`** — returned instead of any other signal when there isn't enough
   recorded data (no submit time, or zero activity events) to run analysis at all. This is an
   explicit, neutral, informational result — never an accusation by omission.

## Signals deliberately omitted (or disabled) in v1

- **`VERY_FAST_CORRECT_RESPONSE_PATTERN` is implemented but never actually triggered by the v1
  runner.** The function (`analyzeVeryFastCorrectResponsePattern`) only runs when the caller
  supplies explicit per-question difficulty; `src/lib/timingAnalysisRunner.ts` never populates that
  parameter, because `Question` has no difficulty field in this schema and v1 implements no
  cohort-difficulty estimation. It is never inferred from question text via AI, as the task
  explicitly forbids. **Future enhancement**: add an optional, lecturer-set `Question.difficulty`
  field (or a cohort-derived p-value once enough graded attempts exist) and wire it through.
- No internet-source plagiarism checking, no external device-intelligence or timing-analysis
  service — the whole engine is local and deterministic.
- No use of individual keystroke timing, mouse movement, or any biometric behavioural signal —
  `AnswerActivityEvent` never stores any of these (see `docs/exam-session-binding-v1.md`).

## Question-pool / randomised-order handling

Every timing comparison keys on the actual `Question.id`, never a display index or array position —
this matters because Question Pools v1 means two students in the same exam may have been shown
different questions, and per-attempt question/option randomisation means even shared questions can
appear in a different order for each student. `analyzeSimilarResponseTimingPattern()` takes the
intersection of `Question.id`s present in both students' relative-timing vectors before comparing
anything.

## Combined recommendation (Part 12)

`src/lib/combinedReviewRecommendation.ts` combines session-binding signals (see
`docs/exam-session-binding-v1.md`), timing signals, and the **recommendations already produced** by
the pre-existing answer-similarity and AI-use-review features (never their raw internal
signals/scores — each stays owned by its own module) into one explainable, rule-based
recommendation:

- `NETWORK_PREFIX_CHANGED`, `USER_AGENT_CHANGED`, `SIMILAR_RESPONSE_TIMING_PATTERN`,
  `CAMERA_PERMISSION_CHANGED`, `SESSION_TOKEN_MISMATCH`, `SESSION_RESTARTED` can never — even at
  `MEDIUM` — justify `ORAL_VERIFICATION_RECOMMENDED` purely on their own or combined only with each
  other.
- Two or more independent non-limited signal types (e.g. `CONCURRENT_ACTIVE_SESSIONS` +
  `DEVICE_TOKEN_CHANGED`) → `LECTURER_REVIEW_RECOMMENDED`.
- Three or more independent non-limited signal types, or two plus an existing high-risk similarity/
  AI-use-review recommendation → `ORAL_VERIFICATION_RECOMMENDED`.
- A very strong combination (≥3 independent types, ≥2 at `HIGH`, plus existing high-risk
  corroboration) → `ESCALATION_RECOMMENDED`.
- This function never creates an `OralVerification` record — that always requires the lecturer's
  explicit "Require oral verification" action on the existing oral-verification workflow.

This combined recommendation is computed and stored whenever a lecturer runs
`POST /api/lecturer/submissions/[id]/timing-analysis` — there is no separate trigger route for it,
since session signals accumulate continuously from heartbeats with no natural "run" moment of their
own.

## Threshold configuration

Every default is a named, documented constant in `src/lib/timeAnomalyDetection.ts` — never an
unexplained magic number in a UI component:

| Constant | Default | Meaning |
|---|---|---|
| `MIN_QUESTIONS_FOR_FAST_ATTEMPT_SIGNAL` | 10 | Floor before "fast attempt" is even considered |
| `FAST_ATTEMPT_MEDIUM_SECONDS_PER_QUESTION` | 3 | ≤ this average → MEDIUM |
| `FAST_ATTEMPT_HIGH_SECONDS_PER_QUESTION` | 1 | ≤ this average → HIGH |
| `RAPID_MULTI_QUESTION_WINDOW_MS` | 60,000 | Sliding window for signal #2 |
| `RAPID_MULTI_QUESTION_MIN_DISTINCT_COUNT` | 8 | Distinct questions required in that window |
| `RAPID_RESPONSE_MIN_CHAR_DELTA` | 500 | "Large" growth threshold for signal #3 |
| `RAPID_RESPONSE_MAX_ELAPSED_MS` | 5,000 | "Very short" interval for signal #3 |
| `LONG_INACTIVITY_THRESHOLD_MS` | 600,000 (10 min) | Gap floor for signal #4 |
| `LARGE_RESPONSE_DELTA_AFTER_INACTIVITY` | 300 | Growth floor for signal #4 |
| `FAST_CORRECT_RESPONSE_MAX_SECONDS` | 8 | (unused in v1 — see omission above) |
| `MIN_SHARED_QUESTIONS_FOR_TIMING_COMPARISON` | 5 | Floor for signal #6 |
| `TIMING_CORRELATION_LOW_THRESHOLD` / `_MEDIUM_THRESHOLD` | 0.85 / 0.95 | Spearman correlation bands |
| `ABRUPT_BURST_WINDOW_MS` | 10,000 | Window for signal #7 |
| `ABRUPT_BURST_MIN_EVENT_COUNT` | 12 | Event-count floor for signal #7 |

## Performance and limits

- One submission at a time — the runner never scans an entire institution.
- Cross-submission comparison is bounded by `MAX_TIMING_COHORT_SUBMISSIONS` (100), mirroring
  `MAX_ANALYSIS_SUBMISSIONS` in the pre-existing answer-similarity feature
  (`TimingCohortTooLargeError` if exceeded — a clear 422, never a silent timeout).
- Runs synchronously inside the lecturer-triggered request (this repo has no queue/worker), exactly
  like the similarity and AI-use-review runners.
- Analysis failure only ever marks the `TimingAnalysis` row `FAILED` — it never affects the
  submission, its grade, or its status. The lecturer can retry.

## Lecturer-only visibility and access control

Identical convention to every other lecturer route in this repo:
`assertSameInstitution` + exam-owner-or-platform-admin check. Students always receive 401/403 from
`GET/POST /api/lecturer/submissions/[id]/timing-analysis` and
`PATCH /api/lecturer/timing-signals/[signalId]/review`. Responses never include correct answers,
unrelated students' answers, or private review notes.

## Migration

Purely additive — `TimingAnalysis` and `TimingIntegritySignal` tables, defined in
`docs/exam-session-binding-migration.sql` alongside the session-binding tables. No backfill; no
existing submission is affected until a lecturer explicitly runs timing analysis for it.
