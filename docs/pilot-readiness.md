# Pilot Readiness

Index/reference doc pointing at where pilot-readiness tooling actually
lives in this repo, plus the pilot-validation requirements added by
Controlled AI Brainstorming Assistance v1
(docs/controlled-ai-brainstorming-assistance-v1.md). This file did not
exist before that feature.

## Existing pilot-readiness tooling

- `/lecturer/pilot-readiness` (`src/app/lecturer/pilot-readiness/page.tsx`)
  — live dashboard: core platform readiness, optional Canvas integration
  readiness, optional AI readiness (a single `ANTHROPIC_API_KEY` presence
  check, `src/lib/env/readiness.ts` — already shared by essay marking, AI
  question generation, AI-use review, and now Controlled AI Brainstorming
  Assistance; no separate env var is required for this feature), and
  deployment readiness.
- `docs/pilot-operator-checklist.md`, `docs/controlled-pilot-operator-guide.md`,
  `docs/pilot-proposal-template.md`, `docs/concurrent-exam-pilot-capacity.md`,
  `docs/camera-preview-and-deep-link-pilot-signoff.md` — the established
  process for validating an opt-in feature with real hardware/institution
  configuration before broad rollout.

## Controlled AI Brainstorming Assistance v1 — pilot requirements

This feature must NOT be treated as validated-by-implementation. Before
enabling it for a real cohort:

1. **Confirm `ANTHROPIC_API_KEY` is configured** — the existing
   `/lecturer/pilot-readiness` "AI" section already checks this; no new
   check was added since the requirement is identical to the existing
   essay-marking/question-generation dependency.
2. **Run a small pilot with real model calls.** This repo's automated
   tests mock the Anthropic API entirely (see
   `src/lib/aiAssistanceRunner.test.ts`) — the generator's Socratic tone,
   the verifier's actual accuracy at catching near-complete answers/
   option disclosure/complete code, and the regenerate-then-fallback
   flow's real-world behaviour have NOT been validated against live model
   responses in this environment (no API access available to the
   implementing agent). A pilot with real students and real API access
   is required before relying on this for a graded, high-stakes exam.
3. **Review the default limits and thresholds** for the pilot's subject
   area — `aiAssistanceMaxPromptsPerQuestion`/`PerAttempt`/
   `MaxResponseCharacters` (lecturer-configurable per exam) and the fixed
   `CUMULATIVE_HINT_LEAKAGE_THRESHOLD`/confidence constants in
   `src/lib/aiAssistancePolicy.ts` (not currently lecturer-configurable)
   are principled starting points, not the output of a validated study.
4. **Spot-check the lecturer review view** (`/lecturer/submissions/[id]/ai-assistance`)
   against real pilot interactions to confirm the transcript reads
   clearly and nothing unexpected leaked through.
5. **Confirm the student notice** (docs/privacy-and-student-notice.md /
   `/privacy/student-exam-notice`) is shown and understood before a
   student's first use.

See docs/controlled-ai-brainstorming-assistance-v1.md "Known
limitations" for the complete list of what has and hasn't been
validated in this implementation session.

## Screen-share Evidence Mode v1 — pilot requirements

This feature must NOT be treated as validated-by-implementation.
Before enabling it for a real cohort:

1. **Run the manual Preview validation checklist** in
   docs/screen-share-evidence-v1.md — this repo's automated tests mock
   `getDisplayMedia()`/`MediaStream`/`MediaStreamTrack` entirely (see
   `screenShareLifecycle.test.ts`); no real browser screen-share flow
   has been exercised in this implementation environment. This
   includes checking `displaySurface` reporting on each browser the
   institution actually uses — support is inconsistent across Chrome,
   Edge, Safari, and Firefox.
2. **Run the DB-backed route tests against a reachable, migrated
   Preview database.** `screenShareEvidence.routes.test.ts` — including
   the concurrent-evidence-slot-reservation test — could not execute
   its assertions in this environment (see "Known limitations" in
   docs/screen-share-evidence-v1.md); this must pass against a real
   database, and ideally be backed by a manual double-tab/double-click
   smoke test, before relying on the max-evidence-frame guarantee in
   production.
3. **Apply the migration** (docs/screen-share-evidence-migration.sql)
   to the shared Production/Preview database per
   docs/migration-ledger.md before any pilot attempt — the feature is
   inert (policy always parses as OFF) without it, but any student who
   reaches the new API routes before the columns exist will see a
   generic failure rather than the intended block.
4. **Review the default evidence bounds** (60s interval, 20 frames/
   attempt, hard-capped at 300s/50 frames server-side) for the pilot's
   context — these are the task's recommended v1 starting points, not
   validated study output.
5. **Confirm the student notice** (docs/privacy-and-student-notice.md /
   `/privacy/student-exam-notice`) is shown and understood before a
   student's first use, and that students are told to close unrelated
   windows/applications before sharing.
6. **Spot-check the lecturer review view**
   (`/lecturer/submissions/[id]/evidence`) against real pilot attempts
   to confirm the lifecycle timeline and evidence thumbnails read
   clearly, and that the human-review disclaimer is visible.

See docs/screen-share-evidence-v1.md "Known limitations" for the
complete list of what has and hasn't been validated in this
implementation session.
