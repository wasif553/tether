# Exam Design Policy v1

Lecturer-controlled exam-condition policies (Closed-book / Open-book / Custom, permitted
resources) plus a policy-aware layer over existing integrity signals. This feature is
**governance and interpretation only** — it never determines misconduct, never terminates an
attempt, never alters a grade, never blocks marks release, and never automatically escalates a
student or requires oral verification.

See also [`docs/evidence-review-workflow-v1.md`](evidence-review-workflow-v1.md) for the review
workflow that consumes this policy layer.

## Exam format

- **Closed-book** — students must complete the assessment without unauthorised external
  resources. Every permitted-resource default is OFF; stronger secure-exam controls are
  recommended (never forced).
- **Open-book** — students may use only the resources explicitly permitted below. Selecting
  Open-book **never automatically implies** internet access, AI tools, collaboration, or
  unrestricted resources — those each require an explicit, separate opt-in.
- **Custom** — every permitted-resource and secure-control setting is configured explicitly, with
  no preset applied.

Every existing exam defaults to **CUSTOM** with all four resources (calculator/notes/internet/AI
tools) **disallowed**. This is a deliberate default, not an inference: the app never assumes an
existing secure exam is closed-book just because it has camera/fullscreen controls enabled.

## Permitted-resource settings

Stored inside the existing `Exam.secureSettings` JSON column — see
`secureExamSettingsSchema` in `src/lib/secureExam.ts`. No new database column was needed for
these four fields:

- `examMode`: `"CLOSED_BOOK" | "OPEN_BOOK" | "CUSTOM"`
- `calculatorAllowed`, `notesAllowed`, `internetAllowed`, `aiToolsAllowed`: booleans

## Policy presets and warnings

`src/lib/examPolicy.ts:getExamModePreset()` returns a **proposal only** for Closed-book/Open-book
— the lecturer UI (`src/app/lecturer/exams/[id]/page.tsx`) shows the proposal and requires an
explicit "Apply preset" click before any setting changes. Selecting Custom, or editing any field
after a preset was applied, never re-applies the preset automatically.

`validateExamPolicy()` produces advisory, explainable warnings (never blocking):

| Situation | Warning |
| --- | --- |
| Closed-book + internet allowed | "This combination is treated as a custom policy because internet access is enabled." |
| Closed-book + AI tools allowed | "AI tools are enabled for an otherwise closed-book exam. Review the policy before publishing." |
| Internet allowed + strict fullscreen | "Students may need to leave the exam page to access permitted internet resources. Strict fullscreen enforcement may conflict with this policy." |
| AI tools allowed + internet disabled | "Confirm how students will access the permitted AI tool, such as through an institution-managed service." |
| Notes allowed + camera monitoring | "Looking away from the screen may be consistent with consulting permitted notes." |
| Calculator allowed | "The application cannot reliably distinguish a permitted physical calculator from another handheld device using camera evidence alone." |

## A standard browser cannot guarantee internet blocking

**Disabling internet in a standard web browser is a policy and monitoring control, not a
guaranteed technical block. Stronger enforcement requires the configured secure or lockdown
browser.** `internetAllowed: false` is a policy setting that shapes how existing signals (focus
loss, tab changes) are interpreted — it does not itself prevent a student from opening another
tab or application. Institutions requiring real enforcement should pair it with the existing
Secure Exam Mode / lockdown-browser controls (`secureModeEnabled`, `requireFullscreen`, etc.).

## Attempt-policy snapshots

An **immutable** snapshot (`Submission.examPolicySnapshotJson`) is built once, at attempt start
(`POST /api/exams/[id]/start`), from the exam's settings **as they exist at that moment** —
never recomputed, never overwritten by a later exam edit. Contains:

`schemaVersion`, `policyVersion`, `examMode`, the four permitted-resource booleans, the relevant
secure-settings subset, the derived integrity profile, the student's acknowledgement timestamp,
and the snapshot's own creation timestamp. It never contains secrets, correct answers, hidden
question-pool contents, session-binding hashes, IP information, or reviewer comments.

Evidence review and integrity interpretation always read from this snapshot, never from the
exam's current editable settings — so editing the exam after an attempt starts can never change
how that attempt is interpreted.

## Student acknowledgement

Before every new attempt (from the dashboard or a shared join link — both routes now go through
`/student/exams/join/[examId]`), the student sees an "Exam conditions" panel built from
`buildStudentExamPolicySummary()` and must check "I understand the permitted resources and exam
conditions." `POST /api/exams/[id]/start` rejects the request with 400 unless
`policyAcknowledged: true` is present — the client-side checkbox is a UX convenience, not the
actual enforcement. The acknowledgement timestamp (server time) is embedded directly in the
snapshot; there is no separate acknowledgement table.

## Policy-aware signal interpretation

`classifyIntegritySignalForPolicy()` never rewrites an original `IntegrityEvent` (event type,
severity, timestamp, metadata all stay exactly as recorded) — it returns a separate, derived
interpretation: `applicable`, `policyAlignment` (`PERMITTED | NOT_PERMITTED | NOT_APPLICABLE |
UNKNOWN`), `adjustedReviewLevel`, `reasonCode`, `explanation`, `limitation`. See
[`docs/evidence-review-workflow-v1.md`](evidence-review-workflow-v1.md) for the full rule table
and the "Activity was permitted under this exam policy" / "Activity was inconsistent with this
exam policy" wording.

Session/device-continuity signals, concurrent-session signals, and answer-similarity signals
remain relevant under **every** policy — the policy layer never suppresses them.

## Accessibility and reasonable-adjustment considerations

Institutions should account for approved accessibility accommodations (e.g. permitted note access
for a documented condition, permitted screen-reader software, extended focus-loss tolerance) when
configuring `notesAllowed`/`internetAllowed`/secure controls for a specific student's approved
plan. This feature does not implement per-student policy overrides in v1 — a lecturer applying an
accommodation today does so by adjusting the exam-level policy for that student's exam instance,
consistent with how existing secure-exam accommodations are already handled outside this feature.

## AI-tools-allowed behaviour

When `aiToolsAllowed: true`, AI-use answer-review signals (from
[`docs/ai-use-answer-review-v1.md`](ai-use-answer-review-v1.md)) remain visible for answer-quality
and grounding review, but the policy layer never classifies them as a policy breach, never
increases integrity concern merely because AI-like characteristics were observed, and never uses
them alone to recommend oral verification. When `aiToolsAllowed: false`, those same signals are
still never treated as proof that AI was used — "AI-use review signals may be considered alongside
other evidence, but they do not prove that AI was used."

## Legacy-attempt behaviour

- Existing exams: `examMode` reads back as `"CUSTOM"` with all resources `false` — never inferred
  as closed-book.
- Existing submissions: `examPolicySnapshotJson` is `null`. Every signal for that attempt gets
  `policyAlignment: "UNKNOWN"` — never retrospectively classified as a policy breach.
- In-progress attempts at deploy time: unaffected. They behave exactly like a legacy submission
  for policy-interpretation purposes; the underlying exam flow (answers, grading, submission) is
  untouched.
