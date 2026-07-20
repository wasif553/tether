# Privacy and Student Notice

Index/reference doc pointing at where student-facing privacy disclosure
actually lives in this repo, plus the privacy-relevant points added by
Controlled AI Brainstorming Assistance v1
(docs/controlled-ai-brainstorming-assistance-v1.md). This file did not
exist before that feature; it's created here rather than duplicating the
canonical student-facing text, which lives in the app itself.

## Canonical student-facing notice

`src/app/privacy/student-exam-notice/page.tsx` — "What Safe Exam System
records during an exam." Covers: answers, timing information, network
evidence, integrity events, camera monitoring, student verification/AI
camera checks, camera evidence frames, exam watermark, one-question-at-
a-time delivery, browser secure mode, existing AI features (essay
marking drafts), who can review the data, who makes assessment
decisions. Kept in sync with each opt-in feature as it ships — every
section is additive and only appears/applies when the corresponding
exam setting is enabled.

## Controlled AI Brainstorming Assistance v1 — privacy summary

Added to the notice page under "AI Brainstorming Assistance, if enabled
by your lecturer":

- The assistant will not provide the answer, correct MCQ option, or a
  submission-ready response.
- Every response is checked by a separate verification step before it is
  shown.
- Prompts and approved responses are recorded as part of the assessment
  record, visible to the lecturer who created the exam — the same
  visibility model as answers and integrity events (see "Who can review
  this data" on the same page).
- Using it as intended is an allowed part of the exam, not an integrity
  concern, and never affects the student's integrity risk score.

## Provider use

Student prompts and question text are sent to Anthropic's API
(server-side only, via `src/lib/aiAssistanceGenerator.ts` and
`src/lib/aiAssistanceVerifier.ts`) to generate and verify assistant
responses — the same provider and server-side-only pattern already used
for essay-marking drafts and AI question generation elsewhere in this
repo. No image, video, or camera data is ever part of this feature. No
tool use, web search, or external retrieval is permitted (v1).

## Retention

Interactions (`AiAssistanceInteraction` rows) are retained for the
lifetime of the submission record — the same retention scope as answers
and integrity events, with no separate deletion window in v1. An
institution's own data-retention policy governs how long submission data
as a whole is kept; this feature introduces no new retention mechanism
and should be reviewed alongside that policy before enabling.

## Institutional review expectations

Before enabling Controlled AI Brainstorming Assistance for a real
cohort, an institution should:

- Confirm the AI-assistance disclosure text on the student notice page
  (above) meets local student-data-notice requirements.
- Confirm sending question text and student prompts to Anthropic's API
  is consistent with the institution's data processing agreements.
- Review the default prompt/response limits and decide whether they suit
  the institution's assessment style.
- Run a pilot per docs/pilot-readiness.md before broad rollout.

See docs/controlled-ai-brainstorming-assistance-v1.md for the full
technical design, generator/verifier separation, and known limitations.
