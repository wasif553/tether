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
marking drafts), AI Brainstorming Assistance, screen-share evidence, who
can review the data, who makes assessment decisions. Kept in sync with
each opt-in feature as it ships — every section is additive and only
appears/applies when the corresponding exam setting is enabled.

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

## Screen-share Evidence Mode v1 — privacy summary

Added to the notice page under "Screen-share evidence, if enabled by
your lecturer":

- Only video is shared — no microphone or system audio is ever
  captured, and the screen is never continuously recorded or streamed.
- Sharing lifecycle (started/stopped/restored) is recorded as a review
  signal; a limited number of still frames may also be saved, only if
  the lecturer has separately enabled evidence capture.
- These are records for lecturer review, not automatic findings — an
  interruption does not, by itself, mean the student did anything
  wrong.
- Because the entire display may be shared, students are advised to
  close unrelated windows/applications beforehand.
- Screen sharing cannot detect a second physical device, and on some
  browsers cannot fully confirm the shared surface was the entire
  screen rather than a single window — this limitation is disclosed to
  the student when it applies.

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

## Screen-share Evidence Mode v1 — retention and institutional review

Lifecycle events (`IntegrityEvent`) and evidence frames
(`IntegrityEvidenceAsset`) are retained for the same lifetime as the
rest of the submission record — no separate retention window or
deletion mechanism exists in v1; this follows the institution's own
data-retention policy exactly like camera evidence frames already do.

Before enabling Screen-share Evidence Mode for a real cohort, an
institution should:

- Confirm the screen-share disclosure text on the student notice page
  (above) meets local student-data-notice requirements, and that
  students are told before sharing that their entire display — which
  may contain personal or unrelated information — could be visible.
- Confirm that evidence-frame retention is consistent with the
  institution's own data-retention and deletion policy; deletion beyond
  the submission's normal lifecycle is an institutional/administrative
  action outside this feature's v1 scope.
- Decide whether evidence-frame capture (a separate, nested setting
  from the sharing requirement itself) is appropriate for the exam, and
  review the default interval/max-frame bounds.
- Understand and accept the disclosed limitations — no OS-level
  lockdown, no second-device detection, and, on some browsers, no way
  to confirm the shared surface was the entire screen — before treating
  this as a meaningful integrity control for a given cohort.
- Run a pilot per docs/pilot-readiness.md before broad rollout.

See docs/screen-share-evidence-v1.md for the full technical design and
known limitations.
