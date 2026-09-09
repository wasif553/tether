# Question Bank / Exam Pools redesign v1

Reorganises the lecturer-facing Question Bank / Question Pool / Exam
Questions workflow around one simple mental model, without changing the
underlying delivery/randomisation semantics that already exist and are
already correct:

- **Question Bank** — a reusable, long-term, per-lecturer question
  library (`QuestionBank`/`BankQuestion`), independent of any exam.
- **Exam Question** (`Question`) — belongs to exactly one exam. Always
  created as an independent snapshot, even when copied from a bank
  question — never a live link (see "Copy semantics" below).
- **Question Pool** (`QuestionPool`) — an exam-scoped randomisation
  group. `Question.questionPoolId == null` means "always included for
  every student"; `!= null` means "eligible for random draw from that
  pool, `drawCount` questions drawn per attempt" (`Question` Pools v1,
  unchanged — see `src/lib/questionDelivery.ts`).

## Schema change

See `docs/question-bank-exam-pools-v1-migration.sql` (NOT yet applied to
the shared Preview/Production database — local disposable-Postgres
testing only, per `docs/migration-ledger.md`). Two new nullable columns
on the existing `Question` table:

- `source` (`String?`) — `"MANUAL" | "AI_GENERATED" | "BULK_IMPORT" |
  "QUESTION_BANK"`, validated in `src/lib/questionSource.ts`. Null for
  every question created before this feature (their real origin is
  genuinely unrecorded — never guessed or backfilled).
- `sourceBankQuestionId` (`String?`, FK to `BankQuestion`, `SetNull` on
  delete) — which bank question this exam question was copied FROM, at
  copy time. Never a live link.

Both fields exist ONLY to support two explicitly-requested,
otherwise-impossible features: a reliable "Source" column on the exam
questions list, and reliable Bank→Exam duplicate-add detection. Nothing
else reads or depends on them; deleting a `BankQuestion` (or copying one
into ten exams) has zero effect on any already-copied `Question` beyond
that trail going null.

## Copy semantics (Bank → Exam)

`src/lib/questionBank.ts`'s `mapBankQuestionToQuestionData()` already
produced a fully independent copy before this feature (type, text,
options, correctAnswer, points) — this was already correct and needed no
schema change. This feature only adds the two provenance fields to that
same copy call. Editing a `BankQuestion` after copying never touches any
`Question` already copied from it, and editing that `Question` never
touches the `BankQuestion` — there is no code path that could propagate
either direction; the tables are joined only by the new nullable,
`SetNull`-on-delete `sourceBankQuestionId` trail.

## New API surface

- `POST /api/lecturer/exams/[examId]/questions/from-bank` — the one
  Bank→Exam copy endpoint, used by BOTH the exam page's "Add from
  Question Bank" flow and the bank page's "Add to exam" flow. Body:
  `{ bankId, bankQuestionIds: string[], delivery: { kind: "REQUIRED" } |
  { kind: "EXISTING_POOL", poolId } | { kind: "NEW_POOL", name,
  drawCount? } }`. Skips (never silently duplicates) any
  `bankQuestionId` already copied into this exam — see "Duplicate
  detection" below — and reports which were created vs skipped.
- The existing single-question route
  (`/api/exams/[id]/questions/[questionId]`, PATCH) already supported
  setting `questionPoolId` to `null` or to another pool in this exam —
  unchanged; this is what "Make required" / "Move to pool" use, no new
  route needed.
- `bulk-questions` (manual/bulk-paste) and `questions/bulk-import` (AI)
  now both stamp `source` (`"MANUAL"` vs `"BULK_IMPORT"` — distinguished
  by which existing input variant was used — vs `"AI_GENERATED"`
  respectively) on every question they create, and both now accept the
  same optional `saveToBankId` (bulk-questions already had it; bulk-import
  did not and now does, satisfying "Add selected to exam + Question
  Bank" for AI-generated questions).
- `POST /api/lecturer/exams/[examId]/questions/[questionId]/save-to-bank`
  — the reverse direction: "Save copy to Question Bank" for an
  ALREADY-EXISTING exam question (Part 3's exam-questions-list action).
  Body: `{ bankId }`. Snapshots the question's current field values into
  a brand-new, independent `BankQuestion`; no field is stored back onto
  the exam `Question` (the existing `sourceBankQuestionId` trail only
  ever points Bank→Exam, never the reverse), so editing either side
  afterward never touches the other.

## Duplicate detection

Before copying, the endpoint queries
`Question.findMany({ where: { examId, sourceBankQuestionId: { in:
bankQuestionIds } } })` — a real, indexed, reliable check now that
provenance exists (previously would have needed unreliable text-equality
guessing). Already-copied ids are skipped, never re-copied, and reported
back distinctly from newly-created ones.

## Authorization

Normalised to the same `institutionWhere(session)` + owner-equality
pattern already used by the question-pools and single-question-CRUD
routes — the question-bank routes and the AI bulk-import route
previously checked bare `lecturerId`/`createdById` equality only, with
no institution boundary at all (a real inconsistency found during
investigation, not a new requirement invented for this feature).

## What this deliberately does NOT change

- `src/lib/questionDelivery.ts` (randomisation/draw logic) — untouched.
- The existing `Question`/`QuestionPool` schema fields — untouched,
  only additive columns.
- No new blocking guard on editing questions/pools after an exam is
  published or has submissions — investigation confirmed no such guard
  exists today for `Question`/`QuestionPool` mutation (only exam
  hard-delete is blocked by existing submissions), so there is no
  existing rule to "reuse"; inventing a brand-new blocking behaviour
  here was judged out of scope for a UI/workflow redesign task and is
  called out explicitly in the final report instead.
