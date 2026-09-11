# AI Marking Assistance

## v3 — Missing-Only vs. Regenerate (exam-wide bulk UX)

### The problem

After v2 (below) let a lecturer save a marking guide for a question with
existing AI drafts, clicking the exam-wide bulk button appeared to do
nothing. Root cause: the bulk endpoint's `WHERE aiDraftScore: null` filter
meant an answer that already had a draft was excluded from the query
entirely — never even counted as "skipped". In an exam where every eligible
essay answer already had a draft (generated with the Tether default rubric,
before any guide existed), the response was `{marked: 0, skipped: 0}` and
the UI showed *"No essays were marked (0 skipped)"* — technically accurate,
but indistinguishable from a genuine failure, and the newly-saved guide had
no visible way to actually take effect on those existing drafts.

### Two distinct exam-wide actions

- **"Generate missing AI suggestions"** (`POST
  /api/lecturer/exams/[examId]/ai-mark-essays`) — unchanged skip behaviour
  (never overwrites an existing draft), but now queries every eligible
  essay answer regardless of draft state and returns a full breakdown:
  `{ eligible, generated, alreadySuggested, failed }`. The UI always shows
  one of: "AI marking complete — N generated, M skipped" / "Nothing to
  generate — all eligible essay answers already have AI suggestions" / "No
  eligible essay answers to mark yet" — never a silent, ambiguous "0, 0".
- **"Regenerate AI suggestions"** (new: `POST
  /api/lecturer/exams/[examId]/ai-mark-essays/regenerate`) — the tool for
  "I just added/changed a marking guide and want existing drafts to reflect
  it". Deliberately overwrites every eligible essay answer's existing
  `Answer.aiDraftScore`/`aiReasoning`/`aiGradedAt` using each question's
  *current* `Question.aiMarkingGuide` (or the default rubric). Requires an
  explicit browser `confirm()` dialog before calling the endpoint — this is
  the one action in this feature that intentionally replaces existing AI
  drafts, and it must never fire without the lecturer's explicit
  confirmation. Returns `{ eligible, regenerated, failed, skipped,
  defaultRubricQuestionCount }`; the UI surfaces all four counts plus, when
  relevant, "N question(s) used Tether default rubric."

Both routes share the exact same eligibility query (`question.type ===
"ESSAY"`, `submission.status === "SUBMITTED"`) and the exact same
rubric-selection logic (`Question.aiMarkingGuide` if set, else
`buildDefaultRubric`) — only the "skip vs. overwrite" behaviour on an
already-drafted answer differs between them. Neither route ever reads or
writes `Answer.score`/`feedback`/`response` or
`Submission.status`/`totalScore` — verified by dedicated tests, including
one that regenerates while a *different* submission in the same exam is
already `GRADED`, confirming that finalized submission is left completely
untouched (and is not even eligible, since eligibility requires `SUBMITTED`).

The existing per-answer "Regenerate suggestion" (single-answer endpoint,
see v2 below) already read `Question.aiMarkingGuide` fresh on every call
before this pass — no change was needed there for it to already do the
right thing.

## v2 — Question-Level Marking Guides

### The problem

The first pass (below, "v1 — Single-Answer Entry Point") let a lecturer type
a marking guide directly on one student's grading page — but that guide was
never saved anywhere beyond that one AI draft's snapshot, so the lecturer
had to retype the identical guide for every other student's answer to the
same question. A marking guide is a property of the *question*, not of any
one student's answer.

### Data model — schema change required

No existing `Question` field could safely hold this (`options` is
already-serialized MCQ content; `correctAnswer` has an established,
different meaning). Added one nullable column:

```prisma
model Question {
  ...
  correctAnswer  String?
  // AI Marking Assistance v1 (additive, nullable). Optional, lecturer-
  // authored marking guide, owned by the QUESTION — reused automatically
  // for every student's answer to this question by both the single-
  // answer and exam-wide bulk AI-marking endpoints. Null means "no guide
  // configured", falling back to the auto-generated default rubric.
  // NEVER serialized to a STUDENT-facing response. Editing this later
  // never mutates any existing Answer.aiReasoning snapshot.
  aiMarkingGuide String?
  ...
}
```

This project has no `prisma/migrations` folder — schema changes are applied
via `prisma db push` (see the original AI-marking commit's own message);
there is no separate SQL migration file. Additive and nullable: existing
rows simply read as "no guide configured", no backfill needed.

### Two distinct kinds of "guide" — never confused

- **`Question.aiMarkingGuide`** — the current, live, editable assessment
  configuration. One value per question, shared by every student.
- **`Answer.aiReasoning`'s stored `lecturerGuideText`/`rubric`/
  `rubricSource`** — a frozen historical snapshot of exactly what was used
  to produce *that one* AI draft. Never retroactively changed when the
  lecturer edits `Question.aiMarkingGuide` afterward. A "Regenerate
  suggestion" or a fresh single/bulk marking call always re-reads the
  question's *current* guide at that moment and writes a *new* snapshot —
  it never edits an old one in place, and never silently re-marks a
  student's already-graded work.

### Exam-level management UI

A dedicated page, `/lecturer/exams/[id]/marking-guides` (matching this
app's established pattern of focused sub-pages — evidence, timeline,
answer-development, ai-assistance — rather than growing the already-huge
exam page further), linked via a new "AI Marking Guides" button on the exam
page next to the two bulk-marking buttons (see "v3" above). Lists every
ESSAY question with its text/points and a
textarea, pre-filled from the question's current guide; one "Save marking
guides" button persists every textarea shown in a single request. An
optional "Copy this guide to all essay questions" button per question is a
pure client-side convenience (copies the current textarea's value into
every other textarea in local state) — it does not auto-apply one guide to
every question without the lecturer explicitly choosing to. Reads via the
existing `GET /api/exams/[id]` (the lecturer branch already returns every
Question field, unfiltered, for the owning lecturer) — no new GET route was
needed, only the new `PATCH /api/lecturer/exams/[examId]/marking-guides`
for saving.

### Single-answer and bulk endpoints — both now guide-aware automatically

`POST /api/lecturer/submissions/[id]/answers/[questionId]/ai-mark` no
longer accepts (or needs) a request body at all — it reads
`question.aiMarkingGuide` fresh from the database on every call. This is
also what makes "Regenerate suggestion" on the grading page always reflect
the lecturer's latest saved guide with zero extra plumbing.

`POST /api/lecturer/exams/[examId]/ai-mark-essays` (the bulk action) reads
each answer's own `question.aiMarkingGuide` the same way — its eligibility
filter, sequential loop, and `{marked, skipped}` response shape are
otherwise unchanged.

### Individual grading page

No longer shows a textarea. For an essay answer with no draft yet:

```
AI Marking Assistance

Marking guide: Lecturer marking guide · View guide
[Get AI marking suggestion]
```

or, when the question has no guide configured:

```
AI Marking Assistance

Marking guide: Tether default rubric
[Get AI marking suggestion]
```

`AiMarkingGuideStatus` (shared component) shows this status and an
optional "View guide" toggle for the *current* saved guide — never an
input. Once a draft exists, "Regenerate suggestion" is a single button
with no confirmation form (the guide is centrally managed, so there is
nothing left to configure per click).

### Permissions and student-facing audit

Only an authorised lecturer (exam owner, or platform admin) can save
guides — `PATCH /api/lecturer/exams/[examId]/marking-guides` mirrors the
same `role !== "LECTURER"` + ownership + `assertSameInstitution` checks
every sibling route in this family already uses, and silently skips (never
errors the whole batch on) any `questionId` that doesn't genuinely belong
to this exam or isn't `ESSAY`.

Re-audited every student-facing route after adding the column:

- `GET /api/exams/[id]` (STUDENT branch) — already unconditionally returns
  `questions: []` for every student, in every attempt state (from the
  post-submission question-protection pass) — safe by construction, no
  code change needed.
- `GET /api/submissions/[id]` — the one route that DOES serialize
  `Question` fields to the submission's own student during their
  `IN_PROGRESS` attempt. `aiMarkingGuide` is now gated with the exact same
  `isExamOwner ? q.aiMarkingGuide : undefined` pattern the route already
  used for `correctAnswer` — verified with a DB-backed test that
  configures a guide and asserts the raw JSON response text never
  contains it for a student, while the owning lecturer's view of the same
  submission does.
- One-question-at-a-time delivery (`buildOneQuestionPayload`) and the
  question-navigator payload both construct their response objects from an
  explicit field whitelist (never `...question` spread) — confirmed no new
  field leaks through either, unchanged by this pass.
- `POST /api/lecturer/exams/[examId]/generate-questions` and other
  question-content-touching routes are unrelated (LECTURER-role-gated,
  confirmed in an earlier audit pass) and untouched here.

---

## v1 — Single-Answer Entry Point (superseded above for guide storage)

The original problem this solved: "Mark essays with AI" existed only as an
exam-wide bulk action on the exam overview page, with results only ever
displayed (never requested) from the per-submission grading page.

- New `POST /api/lecturer/submissions/[id]/answers/[questionId]/ai-mark`:
  marks exactly one essay answer. Reuses the same
  `Answer.aiDraftScore`/`aiReasoning`/`aiGradedAt` fields and
  ownership/institution checks the rest of this route family already uses;
  never writes `Submission.status`/`totalScore`.
- `buildDefaultRubric` moved into `essayMarker.ts` (shared, not
  duplicated) so both the bulk and single-answer paths use the identical
  default rubric.
- Grading page: an essay answer with no draft yet showed a compact form
  (originally with a per-call guide textarea — removed in v2 above); an
  existing draft shows "Suggested score", confidence, criterion breakdown,
  strengths/areas to improve, and "Based on lecturer marking
  guide"/"Based on Tether default rubric". "Accept AI draft" only
  pre-fills the lecturer's editable score — Finalize grade remains the
  only way to actually save/submit.
- MCQ and SHORT_ANSWER questions are unaffected — this feature is ESSAY
  only.

### Orphaned endpoint — left untouched

`POST /api/lecturer/submissions/[id]/approve-ai-grade` was built in the
same original commit as the bulk action, to let a lecturer "finalize" a
submission with an AI-vs-human audit log line and Canvas passback — but it
has **zero callers anywhere in the client code**; the grading page has
always used the plain `PATCH /api/submissions/[id]/grade` instead. Still
not wired up: the existing `Finalize grade` button already does the
finalize + passback job, and wiring up an unused, untested endpoint
"because it's there" would be scope creep with no clear benefit. Left as
documented technical debt for a future pass to either adopt deliberately
or remove.

### What is unaffected (both passes)

- Student Brainstorm Activity — untouched.
- `aiAssistanceGenerator.ts`, `aiAssistanceVerifier.ts`,
  `aiAssistanceRunner.ts`, `aiAssistancePolicy.ts`, `aiAssistanceReview.ts`,
  `aiAssistanceClassifier.ts` — untouched.
- Secure Browser controls, integrity evidence, `ExamWatermark.tsx`,
  student exam delivery, post-submission question protection — untouched.
- No migration beyond the one additive `Question.aiMarkingGuide` column
  described above (v1 needed none at all).
