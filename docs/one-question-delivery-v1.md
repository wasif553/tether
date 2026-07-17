# One-Question-At-A-Time Exam Delivery v1

See also docs/secure-exam-threat-model.md ("One-Question-At-A-Time Exam
Delivery v1") and docs/one-question-delivery-migration.sql for the
production migration.

## What this is

An opt-in, lecturer-configured exam delivery mode that shows a student
only the current question at a time — instead of the full exam paper —
optionally in a stable, per-attempt randomised order, with configurable
forward-only or free back-navigation. It is a **low-friction deterrent**
against exam-content leakage (screenshots, photos, copy-paste of the
whole paper, uploading the full paper to an AI tool), not an access
control and not a guarantee.

**This does not guarantee cheating is impossible.** A student can still
photograph or copy a single question at a time. It works alongside, and
does not replace, the exam watermark, camera monitoring, AI camera
integrity checks, evidence frames, and post-exam lecturer review — see
docs/exam-watermark-v1.md, docs/on-device-ai-integrity-detection-v1.md,
and docs/secure-exam-threat-model.md.

**This deliberately does not hide or blur question content** based on
camera/integrity uncertainty — that approach was explicitly ruled out
(risk of frustrating genuine students) and is unrelated to this feature.

## Settings (`src/lib/secureExam.ts`)

| Setting | Default | Effect |
|---|---|---|
| `oneQuestionAtATime` | `false` | Master switch. When off, delivery is completely unchanged from before this feature — the student page still receives the full question list in one response, exactly as always. |
| `allowBackNavigation` | `true` | Only matters when `oneQuestionAtATime` is on. When `false`, a student can never move to an earlier question once they've moved past it — enforced server-side, not just by hiding a button. |
| `randomiseQuestionOrder` | `false` | Only matters when `oneQuestionAtATime` is on. Generates a stable, per-submission question order once at attempt start. |
| `randomiseMcqOptionOrder` | `false` | Only matters when `oneQuestionAtATime` is on. Generates a stable, per-submission, per-question MCQ option display order once at attempt start. Safe for grading — see below. |

All four default to values that never change behavior for an existing
exam until a lecturer explicitly opts in, exactly like every other
Secure Exam Mode control in this codebase.

## Server-side delivery model

**When `oneQuestionAtATime` is `false`:** `GET /api/submissions/[id]`
behaves exactly as before — the full `exam.questions` array (id, type,
text, options, points; never `correctAnswer` to a student) is returned
in one response, and the student page renders and autosaves all
questions at once, unchanged.

**When `oneQuestionAtATime` is `true`, for the STUDENT's own view only:**
`GET /api/submissions/[id]` returns `exam.questions: []` (the full paper
is never sent) plus `exam.totalQuestions` (a count, for "Question X of
N" — no question content). The student page instead uses two new routes:

- **`GET /api/submissions/[id]/question`** — read-only. Returns the
  student's *currently stored* question (never accepts a client-supplied
  index — see "Why GET never takes an index" below): `{ currentIndex,
  totalQuestions, canGoPrevious, canGoNext, question: { id, type, text,
  options, points }, existingResponse }`. Used for initial load and for
  restoring position after a refresh.
- **`POST /api/submissions/[id]/question-progress`** — the only way the
  stored position actually changes. Body: `{ currentIndex }` (the
  requested index). Validates the request against `allowBackNavigation`
  server-side (a direct API call is clamped exactly the same way a
  disabled Previous button would prevent in the UI — see "Navigation
  behaviour" below), persists the result, and returns the same shape as
  the GET route for the new position in one round trip.

**The lecturer's grading view is completely unaffected** — `isExamOwner`
requests to `GET /api/submissions/[id]` always get the full question
list, regardless of `oneQuestionAtATime`, since that setting is a
student-delivery concern, not a grading concern.

### Why GET never takes an index

An earlier design considered letting `GET .../question?index=N` jump
directly to any question. This was simplified: GET is now purely a
read of whatever is already stored, and POST `.../question-progress` is
the only way to move. This keeps "refresh restores the current position"
trivially true (nothing to get wrong) and keeps exactly one code path
responsible for enforcing back-navigation rules.

## Stable question order (Part 5)

Generated **once**, at attempt start (`POST /api/exams/[id]/start`), and
persisted to `Submission.questionOrderJson`. It is **never recomputed**
on later requests — "stable across refresh" and "different across
submissions" are both properties of this one-time generation +
persistence, not of a reproducible/derivable seed. There is no seed to
ever expose to the client, because there is no seed at all — only the
already-resolved order, which is exactly what gets served.

- `randomiseQuestionOrder: false` → `questionOrderJson` stays `null`;
  question order at read time falls back to the exam's original
  `Question.order` (`resolveQuestionOrder()` in
  `src/lib/questionDelivery.ts`).
- `randomiseQuestionOrder: true` → a Fisher–Yates shuffle
  (`shuffleWithRng()`) of the question ids runs once at attempt start and
  is stored.
- If a question is later added/removed from the exam after an attempt
  already started, `resolveQuestionOrder()` detects the stored order no
  longer matches the current question set and falls back to the current
  original order, rather than serving a corrupted/partial order.

## Stable MCQ option order (Part 6) — implemented, not deferred

Investigated first, as instructed, before implementing: `Answer.response`
already stores the **option's text value**, not a positional index — the
submit route grades with
`answer.response.trim().toLowerCase() === question.correctAnswer.trim().toLowerCase()`.
This means shuffling MCQ *display* order can never affect grading; the
student's selection is always compared by value, regardless of the order
it was shown in. Given this, MCQ option randomisation was safe to
implement immediately rather than deferred as a follow-up.

Per-question option order is stored alongside the question order, in the
same `questionOrderJson.optionOrders` map (`{ [questionId]: string[] }`),
generated once at attempt start (`buildOptionOrders()`), only for
`MULTIPLE_CHOICE` questions with more than one option. Essay and
short-answer questions are never touched.

## Navigation behaviour (Part 7)

- **Question X of N**, **Previous**/**Next** buttons, and a **Save
  status** indicator are shown; **Submit** stays always visible (matching
  the existing full-paper design, which already always shows Submit).
- **Next and Previous both save the current answer first** — the client
  flushes any pending debounced autosave and awaits the PATCH before
  calling `question-progress`; if that save fails, navigation is refused
  and a clear error is shown (`"Your answer could not be saved. Please
  try again before moving on."`) rather than silently losing the answer
  or trapping the student on a broken retry loop.
- When `allowBackNavigation` is `false`: the Previous button is not
  rendered once `canGoPrevious` is `false`, **and** the server's
  `nextAllowedIndex()` independently refuses to move the stored index
  backward even if a Previous-equivalent request is sent directly via the
  API — the UI hiding the button is not the only enforcement.
- **Refresh restores the last allowed/current question** automatically
  (the initial `GET .../question` call on mount reads the persisted
  `currentQuestionIndex`).
- **Timer and auto-submit are completely unchanged** — one-question mode
  doesn't touch `shouldRunExamTimer`/`shouldAutoSubmit`/the deadline
  logic at all.
- **The watermark (if enabled) still renders** — it overlays the same
  outer wrapper regardless of which question-rendering branch (full list
  vs. one-question) is active underneath it; nothing about
  `ExamWatermark` was changed.

## Integrity logging (Part 8)

Three new, additive `IntegrityEventType` values:
`QUESTION_NAVIGATED_NEXT`, `QUESTION_NAVIGATED_PREVIOUS`,
`QUESTION_BACK_NAVIGATION_BLOCKED`. Logged directly by the
`question-progress` route itself (not by the client separately calling
the generic integrity-events endpoint) — that route is the single source
of truth for whether a request was actually a next, a previous, or a
blocked back-navigation attempt, so logging happens exactly there.
Next/Previous are `INFO` severity (routine, expected, never raise risk);
a blocked back-navigation attempt is `LOW` (mirrors
`FULLSCREEN_FORCED_RETURN`'s weight) — a student hitting a
disabled/removed control is not itself suspicious, so it must never
dominate a risk score. No per-question-view event is logged on every
render — only on an actual navigation action.

## Privacy/security safeguards

- Never exposes `correctAnswer` in the one-question payload.
- Never exposes the full question list to a student when
  `oneQuestionAtATime` is on — only the current question.
- Never exposes `questionOrderJson` (or any "seed") to the client — there
  is no seed, only the already-resolved, persisted order.
- Back-navigation is enforced server-side, not just via a disabled
  button.

## Limitations

- Does not prevent a student from photographing/screenshotting one
  question at a time — it only reduces how much of the exam is exposed
  at once.
- Randomised question/option order only takes effect through the
  one-question delivery routes; enabling `randomiseQuestionOrder`/
  `randomiseMcqOptionOrder` without `oneQuestionAtATime` has no effect
  (the lecturer UI disables those checkboxes in that case, to avoid a
  silently-inert setting combination).
- No mid-attempt migration: if a lecturer edits exam questions after
  students have already started (added/removed questions), a stored
  order that no longer matches falls back to the current original order
  rather than attempting a partial merge.

## Schema changes (Part 12)

Additive only — see `docs/one-question-delivery-migration.sql`:

- `Submission.questionOrderJson` (nullable `Json`) and
  `Submission.currentQuestionIndex` (`Int`, default `0`) — two new,
  nullable/defaulted columns on an existing table.
- Three new `IntegrityEventType` enum values (`ALTER TYPE ... ADD VALUE`)
  — Postgres allows this without rewriting the table or any existing row.

Both changes are safe to apply to a live production database at any
time: no existing column/index/constraint is touched, and neither change
has any effect on any exam until a lecturer explicitly enables
`oneQuestionAtATime` (and, optionally, the sub-settings) for that exam.
Regenerate the Prisma client after applying (`npx prisma generate` —
schema-only, no DB connection required). Do **not** run `prisma db push`
against production; apply `docs/one-question-delivery-migration.sql` via
the Supabase SQL Editor (or `psql`) instead, per the existing convention
in `docs/evidence-frame-migration.sql`.
