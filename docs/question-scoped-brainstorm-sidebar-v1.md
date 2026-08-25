# Question-Scoped Brainstorm Sidebar v1

UI/interaction refinement of the existing Tether Controlled AI
brainstorming panel (see
`docs/controlled-ai-brainstorming-assistance-v1.md`). No change to
Claude guardrails, prompt limits, authorization, or evidence semantics —
this is a presentation and one small read-path addition on top of the
existing, unmodified backend.

## What changed

- **Desktop layout**: in one-question-at-a-time delivery, the student
  exam page (`src/app/student/exams/[id]/page.tsx`) now renders a
  three-column workspace at `lg:` and above — question navigator (260px,
  when enabled) | current question + answer (flexible) | Tether
  Brainstorm (380px), via `oneQuestionGridColsClass`/
  `oneQuestionGridWrapperClass`. `AiBrainstormPanel` moved out from
  underneath the answer textarea into its own sibling grid cell — a
  sticky sidebar (`lg:sticky lg:top-4`) with only its transcript
  scrolling internally, header/counters/input always in view.
- **Full-paper delivery is unchanged in layout** — it already rendered
  one `AiBrainstormPanel` per question inline, each already scoped to
  that one question by construction; there is no single "current
  question" for a sidebar to be about there. It still gets the
  component-level improvements below (history restore, counter wording,
  guardrail styling) via the same component, just not the 3-column grid
  or the always-expanded-on-desktop behaviour (see the new `sidebar`
  prop on `AiBrainstormPanel`, false there).
- **Question-scoped, server-restored transcripts**: previously the
  panel only ever showed interactions created in the current
  component-mount session — reloading the page or navigating away and
  back showed an empty transcript even if the student had already used
  it for that question. Added `GET
  /api/submissions/[id]/questions/[questionId]/ai-assistance`
  (`src/lib/aiAssistanceRunner.ts`'s `loadInteractionHistory`, reusing
  the same `loadValidatedContext` ownership/activation/AI-mode gate the
  existing `POST` already used) so the panel loads the authoritative
  stored `AiAssistanceInteraction` rows for this
  `submissionId`+`questionId` on mount and on every question switch,
  keyed by a request-token ref so a fast Next/Previous can never let a
  stale response overwrite the now-current question's transcript.
- **Prompt allowance wording**: replaced the ambiguous "N prompt(s) left
  for this attempt" with an explicit "Prompts remaining" block showing
  "This question X / Y" and "This exam X / Y" — `AiAssistanceRunResult`
  and the new history response both now also carry
  `maxPromptsPerQuestion`/`maxPromptsPerAttempt` (previously only
  ever-decreasing "remaining" counts were exposed to the client; the
  max values were server-internal-only).
- **Exhausted-state messaging**: distinguishes "No prompts remaining for
  this question" from "No AI prompts remaining for this exam" (exam-wide
  takes precedence when both are true, since it's the broader, final
  constraint) — never makes the student infer which limit was hit.
  Disables only the prompt controls (starter buttons, free-text input,
  Ask), never the answer textarea, Previous/Next, or submission.
- **Guardrail response styling**: a `BLOCKED`/`FALLBACK` interaction (the
  assistant declining to hand over a final answer — the exact outcome
  for prompts like "write the final answer") is shown with a neutral
  "Guidance only" badge, not red/amber warning styling — this is
  expected, correct behaviour, not a failure. Only `ERROR`/`FAILED`
  (a genuine local/provider failure) keep failure styling.
- **Compact policy notice**: replaced the always-visible explanatory
  paragraph with "AI brainstorming is allowed · Guidance only ·
  interactions are recorded" plus an "About AI assistance" `<details>`
  disclosure holding the original longer copy — transparency about
  recording is preserved, just not always taking up space.
- **Mobile**: collapses to a single toggle line — "Tether Brainstorm ·
  N prompt(s) remaining", tap to expand — the same in-flow collapsible
  idiom already used by `QuestionNavigatorPanel` elsewhere on this page,
  not a new drawer/modal component.

## What did not change

- `src/lib/aiAssistanceRunner.ts`'s authorization chain, rate limiting,
  prompt-slot reservation, classifier, generator, verifier, and
  evidence-write path (`finalizeInteraction`) — untouched. The new `GET`
  handler is read-only and never calls Anthropic.
- Prompt limits themselves, the Claude system prompt, model
  configuration, and the direct-answer guardrail — untouched.
- `apps/lockdown`, Secure Browser/camera/display enforcement, evidence
  retention — untouched.
- Prisma schema — no migration; the new `GET` endpoint reads the
  existing `AiAssistanceInteraction` rows via the schema's existing
  `@@index([submissionId, questionId])`.

## Known non-coverage

This repo has no component-render test tooling installed anywhere (no
`@testing-library/react`, no jsdom/happy-dom Vitest environment) — every
existing test is either a pure-function unit test or a DB-backed route
test. Consistent with that, DOM-level assertions for this feature (the
exact empty-state copy rendering, guardrail badge appearing instead of
warning styling, prompt controls disabled while the answer textarea
stays enabled) are verified manually in Preview rather than via an
automated render test. `src/lib/aiAssistanceHistory.routes.test.ts`
covers the new `GET` endpoint's data-level correctness (scoping,
restoration, counters, exhaustion, RESERVED-row normalization), and
`src/components/AiBrainstormPanel.test.ts` covers the one pure-logic
helper (`discussingPreview`).
