# Pool Selection Refinement v1

Refinement pass on top of Question Bank / Exam Pools redesign v1 (see
docs/question-bank-exam-pools-v1.md). Adds: full MCQ/short-answer/essay
detail inline in the exam questions table, a lecturer-only non-mutating
Exam Preview (including a re-rollable random sample for pooled exams),
and an "automatic" (difficulty-quota) mode for building a question pool
from a Question Bank, alongside the existing manual pick-exact-questions
mode.

## Two distinct randomisation stages

This feature is built around keeping two distributions visually and
conceptually separate, per the task's own explicit requirement:

- **Pool composition** — how many Easy/Medium/Hard questions are copied
  from the Question Bank into the exam's QuestionPool. Configured once,
  at pool-construction time (`POST .../questions/auto-from-bank`).
- **Student draw** — how many of each difficulty an individual student
  attempt actually receives from that pool. Configured independently
  (optionally, at the same time) via `QuestionPool.drawCountEasy/Medium/
  Hard`, and enforced by `buildSelectedQuestionIds()` at attempt start —
  the exact same function real delivery has always used.

Example: a pool built with 10 Easy / 5 Medium / 5 Hard (20 total) can
independently be configured to draw 4 Easy / 3 Medium / 3 Hard (10 total)
per student.

## Schema change (approved before implementation)

Two genuine gaps were found and reported before any Prisma edit, per this
task's own "STOP before changing Prisma" instruction — approved via the
same AskUserQuestion gate used for the prior feature's schema change:

1. `Question` had no `difficulty` field. Per-difficulty student draw
   needs to know each exam question's difficulty; deriving it from
   `sourceBankQuestion` after copy was explicitly disallowed (copies are
   independent snapshots, not live links), so it must live on `Question`
   itself.
2. `QuestionPool` only had a single `drawCount` — no way to express "4
   Easy / 3 Medium / 3 Hard" as three independent quotas.

Both are additive/nullable — see docs/pool-selection-refinement-v1-migration.sql
and the corresponding docs/migration-ledger.md row. **Not applied to the
shared Preview/Production database** — only to the disposable local test
database used by `release:validate`.

Backward compatibility (required, and verified by tests): every pool
that predates this feature has all three quota columns `null`, which
`buildSelectedQuestionIds()` treats as "quota-unconfigured" — it falls
through to the exact same plain-`drawCount` logic as before, byte-for-
byte unchanged. A pool only becomes quota-aware once a lecturer sets at
least one of the three fields (via the automatic-mode route, or a direct
PATCH).

## New backend surface

- `POST /api/lecturer/exams/[examId]/questions/auto-from-bank` —
  automatic mode. Given exact per-difficulty quotas and a target pool
  (new or existing), randomly selects that many eligible BankQuestions
  (respecting optional type/topic filters, and excluding anything
  already copied into this exam) and copies them in, using the same
  `mapBankQuestionToQuestionData()` copy semantics as the manual
  `from-bank` route. If any band is short, or an optional student-draw
  quota would exceed what the resulting pool can deliver, **nothing is
  created** — the caller gets back exactly which band(s) fell short.
- `POST /api/lecturer/exams/[examId]/preview-sample` — lecturer-only,
  entirely read-only. Reuses `buildSelectedQuestionIds()` (the exact
  function real student delivery uses) against the exam's live data, but
  never persists anything — no Submission, no IntegrityEvent, no
  `questionOrderJson` write. Every call is an independent draw; "Generate
  another sample" is simply calling it again.
- `GET/POST /api/exams/[id]/question-pools` and
  `PATCH /api/exams/[id]/question-pools/[poolId]` — extended to accept/
  return `drawCountEasy/Medium/Hard`, and the GET now also returns each
  pool's live `composition` (computed from the pool's current Question
  rows, never stored — always accurate even after questions are added or
  removed later).

## Frontend

- Exam questions table rows expand inline (chevron toggle,
  `aria-expanded`/`aria-controls`) to show full MCQ options with the
  correct answer highlighted, or the expected answer/marking guidance
  for Short Answer/Essay — only one row expanded at a time.
- "Preview exam" button opens a modal that renders the exam the way a
  student would see it (radio/textarea inputs, disabled — no reuse of
  the actual student exam page, which is deeply entangled with camera/
  lockdown/integrity-event state that preview must never touch). When
  pools are active it shows a re-rollable sample with a "Sample preview —
  students may receive different questions" banner; otherwise the
  (deterministic) full question set.
- "Add from Question Bank" now has two tabs: **Select manually**
  (unchanged) and **Select automatically**, which surfaces eligible
  counts per difficulty band live (computed client-side from the same
  bank-question list the manual tab already loads), quota inputs for
  pool composition and (optionally) student draw, and a running summary
  before the lecturer commits.
- Pool cards show pool composition and per-student draw broken down by
  difficulty when quota-configured, or the legacy "Draw N per student"
  line when not — plus a "Preview sample" action.

## What this deliberately does NOT change

- Duplicate detection still keys off `Question.sourceBankQuestionId`
  (Question Bank / Exam Pools redesign v1) — automatic mode reuses the
  exact same check, never a separate mechanism.
- No new published/in-progress-attempt guard was added on Question/
  QuestionPool mutation — same known, deliberate limitation already
  documented in docs/question-bank-exam-pools-v1.md, unchanged by this
  feature.
- Manual "Select manually" mode's own backend (`from-bank`) is untouched.
