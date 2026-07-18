# Question Pools v1

See also docs/one-question-delivery-v1.md ("Stable question order" /
"Stable MCQ option order," both reused by this feature),
docs/exam-watermark-v1.md, and docs/secure-exam-threat-model.md.

## What this is

An opt-in, lecturer-configured feature that lets a lecturer create a
larger set of interchangeable questions (a **pool**) and have each
student attempt draw a smaller, random, per-attempt-stable subset from
it — for example, a pool of 20 "Programming basics" questions with a
draw count of 8, so each student answers a different 8-question subset.
Combined with unpooled questions (always included for everyone), this
means **no two students necessarily see the same paper**, which reduces
answer sharing during and after the exam and prevents every student
from seeing an identical set of questions.

**This does not make cheating impossible.** Two students can still be
drawn overlapping (or, with a small pool, even identical) question sets,
and a student can still share the individual questions they were given.
It is a deterrent that raises the cost/reliability of blanket answer
sharing, not an access control. It works alongside — and does not
replace — one-question-at-a-time delivery, the exam watermark, camera
monitoring, AI camera integrity checks, and evidence frames; a lecturer
can combine any or all of these.

## Settings (`src/lib/secureExam.ts`)

| Setting | Default | Effect |
|---|---|---|
| `enableQuestionPools` | `false` | Master switch for pool *management* — lets a lecturer define pools and assign questions to them via the exam editor UI. On its own, does not change what any student sees. |
| `questionPoolSelectionMode` | `"ALL_QUESTIONS"` | Only matters when `enableQuestionPools` is true. `"DRAW_FROM_POOLS"` actually turns on the per-attempt random draw described below; `"ALL_QUESTIONS"` means pools can be defined and edited without yet affecting delivery — see `questionPoolsActive()` in `secureExam.ts`, the single source of truth every route uses for "is drawing actually active." |

Both default to values that never change behavior for an existing exam
until a lecturer explicitly opts in to both.

## Data model

- **`QuestionPool`** (new model) — `id`, `examId` (cascade-deletes with
  the exam), `name`, `description` (nullable), `drawCount` (nullable —
  see below), `order`, timestamps.
- **`Question.questionPoolId`** (new, nullable column) — `null` means
  "not in any pool," which is exactly the pre-existing state for every
  question in every exam before this feature. Deleting a pool sets this
  back to `null` for its questions (`onDelete: SetNull`) rather than
  deleting the questions.
- **`Submission.questionOrderJson`** (existing column, reused) — when
  question pools are active, this stores `{ selectedQuestionIds: [...],
  optionOrders: {...} }`: the final, already-drawn, already-ordered
  subset of question ids for this specific submission, generated exactly
  once at attempt start and never recomputed. This is the same JSON
  column One-Question-At-A-Time v1 already added
  (`docs/one-question-delivery-migration.sql`) for the plain
  full-exam-reorder case (which uses a different field, `questionIds`,
  within the same object) — see "Why reuse `questionOrderJson`" below.
  **No new Submission column was needed.**

### Why reuse `questionOrderJson`

The two features are conceptually the same operation — "the final
ordered list of question ids this submission should see" — generated
once at attempt start and persisted. Reusing the column meant no new
migration was needed for `Submission` itself, and a single resolution
function (`resolveEffectiveQuestionIds()` in
`src/lib/questionDelivery.ts`) can serve both cases:

- When pools are **not** active: resolves via `resolveQuestionOrder()`
  (existing, unchanged) — requires the stored `questionIds` to be an
  **exact set match** with the exam's current questions, falling back to
  the original order if not (e.g. a question was added/removed after the
  attempt started).
- When pools **are** active: resolves via the new
  `resolveSelectedQuestionIds()` — accepts the stored
  `selectedQuestionIds` as a **subset** of the exam's current questions
  (a pool draw is legitimately a subset), filtering out any id that's no
  longer valid and falling back to every exam question if nothing valid
  is stored at all (e.g. pools were enabled after the attempt already
  started).

These two validation rules are deliberately different (exact-set vs.
subset-tolerant), which is why they're two separate functions rather
than one relaxed rule — relaxing the exact-set check for the no-pools
case would silently change existing, tested behavior for question
reordering.

## Selection algorithm (`buildSelectedQuestionIds()` in `src/lib/questionDelivery.ts`)

Runs **exactly once**, at attempt start (`POST /api/exams/[id]/start`),
using real (not seed-derived) randomness:

1. Every unpooled question is always included (v1 rule).
2. For each pool: draw `drawCount` questions at random.
   - `drawCount` null or `<= 0` → include every question in that pool.
   - `drawCount` greater than the number of questions actually in the
     pool → include every available question in that pool. No error is
     raised either way — this is documented, expected behavior, not a
     misconfiguration.
3. If `randomiseQuestionOrder` is also enabled, the combined selected set
   is shuffled; otherwise it's ordered by the questions' original
   lecturer-defined `order`.
4. The resulting id list is persisted to
   `Submission.questionOrderJson.selectedQuestionIds` and **never
   recomputed** — refreshing the page, navigating away and back, or any
   other request always reads this same persisted list. There is no
   reproducible seed anywhere in this system; the randomness happens once
   and its *result* is what's stored and served, so there is nothing to
   ever expose to the client.

An existing `IN_PROGRESS` submission (e.g. the student refreshed, or
called "start" again by navigating back to the exam) reuses its already-
persisted selection — `POST /api/exams/[id]/start` is idempotent and
returns the existing submission without regenerating anything.

## Server-side delivery

**Question pools disabled, or `questionPoolSelectionMode` is
`"ALL_QUESTIONS"`:** completely unaffected — every route behaves exactly
as it did before this feature (verified by a dedicated regression test).

**Question pools active:** `resolveEffectiveQuestionIds()` (in
`src/lib/questionDelivery.ts`) is the single function every route below
uses to determine "the question ids this submission was actually given,"
and it is applied consistently everywhere a question set is read:

- **`GET /api/submissions/[id]`** (both the student's own view and the
  lecturer's per-submission grading view) — the `exam.questions` array
  returned is filtered and reordered to exactly the selected set;
  `exam.totalQuestions` reflects the selected count, never the full pool
  size. "Full paper" mode, when pools are active, means the full
  *selected* paper — never every pool question.
- **`GET /api/submissions/[id]/question`** /
  **`POST /api/submissions/[id]/question-progress`** (One-Question-At-
  A-Time v1) — `total`/`currentIndex`/navigation all operate over the
  selected set, not the full exam. Answers still save against the real
  `Question.id` (the answers route itself is untouched — see
  `docs/one-question-delivery-v1.md`).
- **`POST /api/submissions/[id]/submit`** — grading iterates only the
  selected question set (see "Grading and scoring" below).

**The student browser is never sent a non-selected pool question** —
the server-side filtering happens before any response is built; there is
no client-side hiding of extra data.

## Grading and scoring

The submit route's grading loop was changed from iterating
`submission.exam.questions` (every question in the exam) to iterating
only the questions returned by `resolveEffectiveQuestionIds()` for that
specific submission. Consequences:

- A student is **never penalised** for a pool question they were never
  shown — it's never scored, never counted toward `hasEssay`, and no
  `Answer` row is ever created for it.
- **Total possible marks reflect the selected set only** — `totalScore`
  is the sum of points for the questions that submission actually
  contains, not the full pool/exam.
- **Marks release behaviour is completely unchanged** — the same
  `marksReleasedAt` gate on the exam controls when a student can see
  their score, regardless of pools.
- The **lecturer's grading view already shows only the selected
  questions** for that student (via the same `GET
  /api/submissions/[id]` filtering above) — no separate UI was needed to
  satisfy "show which questions were selected."

**Known v1 limitation:** the CSV/PDF exam-level export routes (separate
from the per-submission grading view) were not modified in this pass —
they were not touched to avoid introducing risk into working export code
without dedicated review, and are called out here as a limitation rather
than silently left inconsistent. If pools are enabled with drawing on,
an export that assumes every student answered an identical, fixed
question set should be treated as approximate until reviewed
specifically for that assumption.

## Lecturer UI

A "Question pools" section appears in the exam editor's Secure Exam Mode
settings (two checkboxes — "Enable question pools" and, nested under it,
"Draw a random selection for each student attempt") and, when pools are
enabled, a dedicated "Question pools" management section above the
question list:

- Create a pool (name + optional draw count).
- Edit a pool's draw count inline; delete a pool (its questions become
  unpooled, never deleted).
- Each pool shows its current question count and draw count, with an
  inline warning — *"This pool has fewer questions than the draw count.
  Students will receive all available questions from this pool."* — when
  `drawCount` exceeds the pool's question count.
- Each question gets a "Question pool" dropdown (No pool / a specific
  pool), shown only when pools are enabled, so the UI stays uncluttered
  for the majority of exams that never use this feature.

## What students see

Nothing pool-specific. A student simply sees their own selected question
set, presented exactly like a normal exam (or, if `oneQuestionAtATime` is
also on, one question at a time from that set) — no pool names, no draw
counts, no "you got 8 of 20" messaging, no indication that other students
might have different questions. `GET /api/exams/[id]` (used before a
student starts an exam) strips `questionPools` and every question's
`questionPoolId` entirely from the student-facing response.

## Integrity / audit logging

A single, best-effort `PlatformAuditLog` entry
(`action: "QUESTION_POOL_SELECTION_GENERATED"`) is written once per
attempt start when pools are active, with minimal metadata: the exam id,
the total selected count, and a per-pool draw summary (`{poolId,
drawCount, selectedCount}`). **Never includes question text.** This is
one log entry per attempt, not per question or per request — no
per-question-view logging was added, to avoid noise.

## Schema changes (additive and safe)

See `docs/question-pools-migration.sql` for the full SQL and
verification queries. Summary:

- New `QuestionPool` table (cascade-deletes with its exam).
- New nullable `Question.questionPoolId` column (`SET NULL` on pool
  delete).
- **No new `Submission` column** — `questionOrderJson` (added by
  `docs/one-question-delivery-migration.sql`) is reused.

Both changes are safe to apply to a live production database at any
time: no existing table/column/constraint is touched, every existing
question is unaffected (`questionPoolId` starts `null` for all of them,
meaning "always included," identical to today's behavior), and neither
change has any effect on any exam until a lecturer explicitly creates a
pool and enables `enableQuestionPools` +
`questionPoolSelectionMode = "DRAW_FROM_POOLS"`. Regenerate the Prisma
client after applying (`npx prisma generate` — schema-only, no DB
connection required). Do **not** run `prisma db push` against
production.
