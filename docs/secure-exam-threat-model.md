# Secure Exam Mode v1 — Threat Model

Safe Exam System's (SES) core product is secure, cheat-resistant exam
delivery. Canvas/LTI and AI features are optional convenience modules —
SES must remain fully usable as a standalone secure exam platform without
either.

This document describes what Secure Exam Mode v1 protects against, what
it deliberately does not (yet), and the principles governing how
integrity signals are captured and reviewed.

## What v1 is

**Secure Exam Mode v1 is a browser-based secure exam mode, not OS-level
lockdown.** It runs entirely inside the student's existing browser tab. It
cannot prevent a determined student with a second device, another person
in the room, or printed material — those require OS-level or physical
controls that are explicitly out of scope for v1.

Electron lockdown browser and camera/microphone proctoring are **future
optional high-security layers**, not part of v1. Nothing in this release
assumes their presence.

## What Secure Exam Mode v1 protects against

| Threat | Control |
|---|---|
| Tab switching / window focus loss | `WINDOW_BLUR` / `WINDOW_FOCUS_RETURN` integrity events, debounced |
| Copy/paste of question content or answers | `COPY_ATTEMPT` / `PASTE_ATTEMPT` integrity events; severity raised when the lecturer enables "Block copy/paste" |
| Right-click (e.g. to open dev tools or search) | `RIGHT_CLICK_ATTEMPT` integrity event |
| Fullscreen exit | `FULLSCREEN_EXIT` integrity event; severity raised to HIGH when the lecturer requires fullscreen |
| Network disconnect/reconnect | `NETWORK_OFFLINE` / `NETWORK_ONLINE` integrity events |
| Repeated autosave failure | `AUTOSAVE_FAILED` integrity event when a save request fails |
| Suspiciously fast submission | Visible on the evidence report via started/submitted timestamps for lecturer judgment (not auto-flagged in v1) |
| Late submission | `SUBMIT_AFTER_DEADLINE` integrity event; submit is blocked server-side unless the lecturer has explicitly allowed late submission |
| Multiple attempts | `maxAttempts` setting (v1 only supports a value of 1 — see Limitations) |
| Answer editing after submit | Answer save endpoint rejects writes once a submission is no longer `IN_PROGRESS` |
| Direct API access bypassing the UI | Every mutation (start, save, submit, integrity-event) re-validates ownership, submission status, and deadline server-side — the UI is not trusted as the enforcement point |
| Student accessing another student's submission | Submission routes check `studentId === session.user.id`; lecturer-only fields are never returned to non-owning students |
| Lecturer-only data exposure | AI draft scores/reasoning, lecturer resolution notes, and Canvas passback internals are stripped from every response unless the caller owns the exam |
| Canvas/AI optionality | Core exam flow, grading, analytics, and integrity events function with zero Canvas or Anthropic configuration; pilot readiness reports these as separate optional modules, never as blockers to "core" readiness |

## What v1 does **not** yet protect against

- A second device, person, or printed material in the room (no camera/mic).
- A student using OS-level screenshot, screen-recording, or remote-access
  tools the browser cannot detect.
- A sufficiently motivated student disabling JavaScript or using browser
  developer tools to alter client-side behavior (server-side checks still
  apply to grading and submission, but client-side event detection can be
  suppressed).
- Identity verification — SES does not confirm the person taking the exam
  is who they claim to be (no photo ID check, no biometric proctoring).
- True OS-level lockdown (blocking alt-tab, other applications, virtual
  machines, secondary monitors). This is explicitly deferred to a future
  Electron lockdown layer.
- AI-assisted plagiarism detection in free-text answers.

These gaps are the reason SES never claims to be "cheat-proof." Secure
Exam Mode reduces opportunity and creates a reviewable record; it does
not guarantee academic integrity on its own.

## Current controls (v1)

- Per-exam **Secure Exam Mode** settings (`Exam.secureSettings`),
  defaulting to off for standalone/simple exams.
- Settings-driven event severity (e.g. fullscreen exit is more severe
  when fullscreen is required; copy/paste events are more severe when
  blocking is enabled).
- A pre-exam checklist students must acknowledge before starting a
  secure exam, including a fullscreen requirement if configured.
- Server-side enforcement of submission lifecycle (no answer edits after
  submit, no late submission unless explicitly allowed, idempotent
  submit) independent of any client-side UI behavior.
- A deterministic, non-AI integrity risk score per submission, visible to
  lecturers only, to help prioritize review.
- A lecturer-only evidence report per submission combining the event
  timeline, grading outcome, and optional-module status into one place.

## Future controls (explicitly out of scope for v1)

- Electron-based lockdown browser (blocks OS-level app switching).
- Camera/microphone-based proctoring and face/gaze detection.
- Certification-grade identity verification.
- AI-assisted anomaly detection across integrity signals (v1's risk score
  is a fixed, transparent point system — not a model).
- Cross-submission plagiarism comparison.

## Evidence captured

Each integrity event records: event type, severity, a short human-
readable message, the timestamp it occurred, and (server-side only) the
submission/exam/student it belongs to. No screenshots, keystrokes, screen
recordings, camera/microphone data, or full network traffic are captured
in v1 — only the specific browser signals listed above.

## False-positive handling

Integrity events are **signals for human review, not automatic misconduct
determinations.** A `WINDOW_BLUR` event might mean the student switched
to look up something they shouldn't have — or it might mean a
notification popped up, they alt-tabbed by reflex, or their browser lost
focus for an unrelated reason. SES never:

- auto-fails, auto-flags, or auto-reduces a grade based on integrity
  events,
- shows students an accusatory message,
- presents a risk score as a verdict.

The lecturer always makes the final call, with the option to mark any
event "reviewed" and attach a note (e.g. "spoke with student, no
concern"). The risk score and "review recommended" indicator exist only
to help a lecturer triage many submissions faster — they carry no
academic consequence by themselves.

## Student privacy principles

- Students are told, in plain language (`/privacy/student-exam-notice`
  and the pre-exam checklist), what is recorded and why, before they
  start.
- Students never see raw integrity-event internals beyond the calm
  warning banner described in the UI — no severity scores, no risk
  levels, no lecturer notes.
- Only the lecturer who owns the exam (or, narrowly, an exam co-owner in
  a future multi-staff model — not implemented in v1) can see a
  student's integrity events, AI draft grading, or Canvas passback
  status.
- No camera, microphone, or biometric data is collected in v1.

## Lecturer review principles

- Integrity events, risk scores, and evidence reports exist to make
  review **faster and more consistent**, not to replace lecturer
  judgment.
- The evidence report explicitly states: *"Integrity events are signals
  for human review and are not automatic misconduct determinations."*
- AI draft essay scores are always labeled as drafts; the lecturer must
  explicitly save/finalize a grade — AI never finalizes one.
- Canvas grade passback status is informational; a `FAILED` or `SKIPPED`
  passback never blocks or alters the SES-side grade.

## Known v1 limitation: attempt limits

The current data model allows exactly one `Submission` per
(exam, student) pair — this is an existing, intentional uniqueness
constraint that several other features (Canvas launch routing, grade
passback matching) already depend on. Secure Exam Mode v1 therefore only
supports `maxAttempts = 1`; the setting exists in the schema for
forward-compatibility, but values greater than 1 are not yet enforced and
should not be exposed as a working feature to lecturers until a future
release extends the data model to support multiple attempts per exam.
