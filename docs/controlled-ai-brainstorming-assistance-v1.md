# Controlled AI Brainstorming Assistance v1

An optional, opt-in exam mode that lets students use a heavily
restricted AI assistant to understand a question, organise their
reasoning, and get guiding questions during a live exam — **an allowed
assessment resource, not an integrity violation.** Disabled by default;
a lecturer must explicitly enable it per exam.

## What assistance is allowed

- Explaining what a question is asking, in general terms.
- Identifying relevant concepts.
- Giving a broad starting point.
- Asking a guiding (Socratic) question.
- Helping organise ideas or structure an approach.
- Challenging the student's own stated reasoning.
- Suggesting what to verify or check before finalising an answer.
- (If the lecturer allows it) high-level programming-concept discussion
  and debugging questions.

## What is prohibited, always

- The correct answer, or anything close enough to count as one.
- The correct MCQ option, or ranking/eliminating options.
- A final numeric result, or the last substitution/computation step.
- Submission-ready prose the student could paste directly into their
  answer.
- Complete code, a complete function, or a complete algorithm.
- The marking rubric, a model answer, lecturer-only notes, or hidden
  test cases, in any form.

This holds **regardless of how the student phrases the request** —
including attempts to instruct the assistant to ignore its rules (see
"Prompt injection" below).

## Architecture

```text
Student request
      │
      ▼
Classifier (src/lib/aiAssistanceClassifier.ts)      — pure, deterministic
      │  blocked?──────────────► declined, no generation ever runs
      ▼ allowed
Generator (src/lib/aiAssistanceGenerator.ts)         — Anthropic, narrow input
      │
      ▼
Verifier (src/lib/aiAssistanceVerifier.ts)           — Anthropic, independent, wider input
      │  rejected?
      ├─── regenerate once, stricter instructions ──► verify again
      │                                                    │ still rejected
      │                                                    ▼
      │                                        deterministic safe fallback
      ▼ allowed
Shown to student, persisted (AiAssistanceInteraction)
```

Orchestrated entirely by `src/lib/aiAssistanceRunner.ts` — the only
module that imports both the generator and the verifier. Neither of
them is ever called directly from an API route.

### Generator/verifier separation (Part 6-9)

- **Classifier** (`src/lib/aiAssistanceClassifier.ts`) — pure,
  dependency-free, runs on the STUDENT'S REQUEST before any generation.
  Several independently-scored signal families (verb+object proximity
  patterns, MCQ-specific phrasing, code/calculation requests, rubric/
  hidden-info requests, prompt-injection attempts), not a single flat
  keyword list. There is no ML-based intent classifier in this v1 (see
  "Known limitations").
- **Generator** (`src/lib/aiAssistanceGenerator.ts`) — Anthropic-backed,
  restricted input. `BrainstormGeneratorInput` structurally has no field
  for a correct answer, rubric, hidden test cases, or lecturer notes —
  it cannot receive them by construction. `assertPromptExcludesSecrets()`
  is a runtime belt-and-braces check against future refactor bugs.
- **Verifier** (`src/lib/aiAssistanceVerifier.ts`) — a SEPARATE Anthropic
  call, its own system prompt, and a wider input that DOES include the
  hidden model answer/rubric (when available) — purely so it can judge
  disclosure accurately, never to pass through to the student. Returns
  structured JSON: `{ allowed, riskScore, riskCodes, reason }`. This
  structured output is never itself shown to the student.
- Generator output is **never** returned to a caller of
  `aiAssistanceRunner.ts` without passing the verifier first — see
  `attemptGenerateAndVerify()`, and `aiAssistanceRunner.test.ts`, which
  proves this with the generator/verifier mocked.

### Regeneration and fallback (Part 9)

1. Generate → verify.
2. If rejected: regenerate ONCE with explicitly stricter system-prompt
   instructions (temperature 0) → verify again.
3. If still rejected: return the fixed, deterministic
   `AI_ASSISTANCE_FALLBACK_RESPONSE` (`src/lib/aiAssistancePolicy.ts`) —
   never any model output on this path.

The rejected candidate's text is discarded in memory and **never**
written to any database column, on any status, on either attempt.

### Cumulative hint protection (Part 10)

`AiAssistanceInteraction.cumulativeRiskScore` is a running, per-question
total of every approved interaction's own `riskScore` — never reset
mid-attempt. Even a candidate the verifier calls individually safe is
rejected if the projected cumulative total would cross
`CUMULATIVE_HINT_LEAKAGE_THRESHOLD` (1.6), forcing the regenerate/
fallback path instead (`isCumulativeHintLeakageRisk()` in
`aiAssistanceRunner.ts`). The verifier is also given
`priorApprovedHintCount` and `cumulativeRiskScoreSoFar` directly, so its
own judgement already accounts for history, not only the current
message.

The hint ladder (`HINT_LADDER_LEVELS` in `aiAssistancePolicy.ts`) shapes
what the GENERATOR is asked to attempt, based on how many responses have
already been approved for a question:

```text
Level 1 (1st approved hint): clarify the task
Level 2 (2nd):                identify broad concepts
Level 3 (3rd):                ask a targeted reasoning question
Level 4 (4th+):                identify one missing reasoning step — never beyond
```

This is guidance for the generator, not the enforcement point — the
verifier (and the cumulative-risk override) is what actually decides
whether a response is shown.

## Question-type policies (Part 11)

This repo's `QuestionType` enum is `MULTIPLE_CHOICE | SHORT_ANSWER |
ESSAY` — there is no distinct Numeric or Programming question type. The
generator/verifier system prompts apply the task's numeric/programming
guidance within these three types rather than inventing new ones:

- **MULTIPLE_CHOICE:** never select, rank, or eliminate options; explain
  only the general concept.
- **SHORT_ANSWER:** covers both short numeric-style and short
  free-text answers in this schema — identify the relevant formula/
  concept family, never substitute all values or produce a final
  number; for a short code-style answer, discuss approach/debugging
  only, never complete code.
- **ESSAY:** themes, guiding questions, and neutral structure only — no
  complete paragraphs or submission-ready wording.
- **Programming assistance** (`allowProgrammingConceptHelp`) is an
  orthogonal capability flag, not a question type — it governs whether
  code-adjacent discussion is offered at all, independent of which of
  the three question types the question is.

## Policy snapshot (Part 3)

Exactly the same immutable-snapshot pattern as
`Submission.examPolicySnapshotJson` (`src/lib/examPolicy.ts`):
`buildAiAssistancePolicySnapshot()` copies the exam's current
`aiAssistance*` settings into `Submission.aiAssistancePolicySnapshotJson`
once, at attempt start (`POST /api/exams/[id]/start`). Every later
request for that attempt reads `parseAiAssistancePolicy()` on the STORED
snapshot — never the exam's live settings — so a lecturer changing
`aiAssistanceMode`/limits mid-exam never affects an attempt already in
progress. A null/missing snapshot (every submission created before this
feature, or any exam that never configured it) is always treated as
DISABLED.

## Interaction storage (Part 4)

`AiAssistanceInteraction` — one row per student request:
`submissionId`, `questionId`, `studentPrompt`, `approvedResponse`
(null for `BLOCKED`), `status`
(`BLOCKED | APPROVED | REGENERATED_APPROVED | FALLBACK`),
`promptNumberForQuestion`/`promptNumberForAttempt`, `policyVersion`,
`riskCodesJson`, `riskScore`, `cumulativeRiskScore`, `specificityLevel`
(hint ladder level), `providerModel`, `latencyMs`, timestamps. The
rejected candidate from a failed verification pass is **never** written
to any column — see `src/lib/aiAssistanceRunner.ts` and the migration
doc's comment on the table.

## API

`POST /api/submissions/[id]/questions/[questionId]/ai-assistance` (the
folder is named `[id]` rather than `[submissionId]` only because every
other route under `src/app/api/submissions/` already uses `[id]`, and
Next.js requires one parameter name per dynamic segment level — the
public URL shape is unaffected). Validates, in order: authenticated
STUDENT, submission ownership, submission `IN_PROGRESS`, question in the
stable attempt question set (`resolveEffectiveQuestionIds` — reused from
one-question delivery/question pools), question "currently accessible"
(under one-question-at-a-time delivery, only a question the student has
already reached), mode `BRAINSTORM_ONLY`, prompt-length bound, rate
limit, question/attempt prompt limits, then classification. Returns a
safe, student-friendly message on every rejection path — never an
implementation detail, stack trace, or the raw classifier pattern that
matched.

`GET /api/lecturer/submissions/[id]/ai-assistance` — read-only,
exam-owner-only (or platform admin), same ownership-check pattern as
`buildEvidenceReport()`.

## Rate limiting

No rate-limiting utility existed elsewhere in this repo to reuse — a
new, minimal sliding-window check (`isWithinRateLimit()` in
`aiAssistancePolicy.ts`) driven by `AiAssistanceInteraction.createdAt`
queried from the database (never in-memory process state, which would
not be safe across multiple server instances): at most 3 requests per
20 seconds per submission.

## Audit treatment (Part 14)

`AI_ASSISTANCE_USED`, `AI_ASSISTANCE_REQUEST_BLOCKED`,
`AI_ASSISTANCE_LIMIT_REACHED`, `AI_ASSISTANCE_RESPONSE_REGENERATED` —
four new `IntegrityEventType` values. Every one of them resolves to
`INFO` severity in `severityFor()` (`src/lib/secureExam.ts`), which is
weight 0 in `src/lib/integrityRisk.ts` — **permitted use of this
assistant can never increase a student's integrity risk score**, no
matter how often it's used, blocked, or regenerated.

## Privacy and security (Part 15)

- Anthropic API calls happen only in `aiAssistanceGenerator.ts`/
  `aiAssistanceVerifier.ts`, server-only modules never imported from a
  `"use client"` component — the API key (`ANTHROPIC_API_KEY`) never
  reaches the browser, exactly like the existing `essayMarker.ts`/
  `questionGenerator.ts`.
- Student prompt bounded to `MAX_STUDENT_PROMPT_CHARACTERS` (1000);
  assistant response bounded by the lecturer-configured
  `aiAssistanceMaxResponseCharacters` (200-4000, default 800).
- Rate limiting as above.
- No stored text is ever raw HTML/executable — plain strings only, no
  sanitisation gap exists since nothing here is rendered as HTML on
  either the student or lecturer side.
- **Prompt injection cannot override policy:** the classifier's
  `PROMPT_INJECTION` rule family (ignore-instructions, act-as-
  unrestricted, reveal-system-prompt, etc.) is checked first and
  independently, and the generator's own system prompt explicitly
  instructs it to treat the entire student message as untrusted content
  to respond to, never as new instructions. See
  `aiAssistanceClassifier.test.ts` ("21. prompt injection cannot
  override policy").
- Question text, student text, and any prior transcript are all treated
  as untrusted data passed into the model's user turn, never concatenated
  into the system prompt.
- No tool use, web search, or external retrieval — the generator and
  verifier are plain `messages.create()` calls with no `tools` parameter.
- Only the specific question's text and the student's own request/
  reasoning are sent — no other exam questions, no other students' data,
  no unrelated submission fields.
- **Retention:** interactions are retained for the lifetime of the
  submission record, under the same institutional data-retention policy
  as answers/integrity events — no separate retention window exists in
  v1. Institutions should review this against their own data-retention
  obligations before enabling the feature (see "Known limitations").

## Student experience

An "AI Brainstorming Assistant" panel (`src/components/AiBrainstormPanel.tsx`)
appears under each question only when `aiAssistanceMode` is
`BRAINSTORM_ONLY` — never otherwise. Six starter actions ("Help me
understand the question," "Give me a starting point," "Ask me a guiding
question," "Help me organise my ideas," "Challenge my reasoning,"
"Suggest what I should check"), a free-text box, remaining-prompt
counters (per question and per attempt), loading/rate-limit states, a
neutral explanation on a blocked request, and the approved transcript.
Fixed disclosure text: *"This assistant can help you think through the
task, but it will not provide the answer or write a response that you
can submit. Interactions may be recorded as part of the assessment
record."*

## Lecturer controls

Exam editor → "AI Brainstorming Assistance" section
(`src/app/lecturer/exams/[id]/page.tsx`): enable toggle, max prompts per
question (default 3), max prompts per attempt (default 10), max
response characters (default 800), and four capability toggles (concept
explanations, answer planning, reasoning feedback, programming-concept
help) — all default ON once the mode itself is enabled, since they only
take effect at all when `aiAssistanceMode` is `BRAINSTORM_ONLY`.

## Lecturer review

`src/app/lecturer/submissions/[id]/ai-assistance/page.tsx` — read-only,
linked from the submission detail page next to "Evidence report." Shows
question, student prompt, the response actually shown (approved/
fallback text — never the rejected candidate, which was never stored),
timestamp, status (approved / regenerated / fallback / declined), and
policy version. Explicitly does NOT show the hidden rubric, model
answer, verifier system prompts, provider credentials, or the rejected
candidate text (there is none to show). A banner states this is a
record of an allowed resource, never an integrity signal.

## Known limitations

- **No ML-based request classifier.** The classifier
  (`src/lib/aiAssistanceClassifier.ts`) is deterministic multi-signal
  pattern matching, not a trained model — a sufficiently indirect or
  novel phrasing of a direct-answer request could evade it. The
  independent VERIFIER (which does use the model, judging the actual
  generated response rather than the request) is the deeper safety net
  for this gap.
- **No guarantee that generative AI can never disclose excessive
  detail.** The verifier substantially reduces this risk but is itself a
  language model judging another language model's output — it can be
  wrong in either direction (too strict, or occasionally too lenient).
  Cumulative-hint protection and conservative defaults reduce, but do
  not eliminate, this risk.
- **No real Anthropic-API-backed evaluation was run in this
  environment** — the generator/verifier system prompts, JSON schemas,
  and orchestration logic are implemented and unit-tested with the
  Anthropic calls mocked (see `aiAssistanceRunner.test.ts`), but actual
  model behaviour (does the verifier really catch a cleverly-phrased
  near-complete answer? does the generator's Socratic tone hold up in
  practice?) has not been validated against live model calls or a
  labelled prompt/response fixture set. This requires institutional pilot
  validation with real API access before broad reliance.
- **Institutional configuration and pilot validation required.** Default
  limits (3/question, 10/attempt, 800 characters) and the risk-band/
  cumulative-threshold constants are starting points, not the result of
  a validated study — see the sibling pilot process docs
  (`docs/pilot-operator-checklist.md`,
  `docs/controlled-pilot-operator-guide.md`) for how other AI-adjacent
  features in this repo were piloted before wider rollout; the same
  process should be followed here.
- Question-type policies are mapped onto this repo's actual
  `MULTIPLE_CHOICE | SHORT_ANSWER | ESSAY` types, not the task's
  originally-envisioned MCQ/Numeric/Essay/Programming four-way split —
  see "Question-type policies" above.
- Rate limiting is DB-query-based (recent interaction timestamps), not a
  dedicated in-memory/Redis rate limiter — adequate for v1's low request
  volume per student, but would need revisiting under much higher
  concurrent load.
