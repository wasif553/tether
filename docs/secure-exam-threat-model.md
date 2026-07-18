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

## Optional Student Verification + On-Device AI Camera Integrity Detection v1

Updates the "future controls" note below: **on-device phone/person
object detection is now implemented**, as a lecturer opt-in layered on
top of Camera Monitoring v1 — see
docs/on-device-ai-integrity-detection-v1.md for the full design. It
remains scoped narrowly:

- Detection runs **locally in the student's browser** against the
  existing camera preview stream — nothing is uploaded, streamed, or
  recorded; only metadata (event type, confidence band, model
  name/version) is ever sent to the server.
- Still explicitly out of scope, and not changed by this feature: face
  recognition, gaze tracking, emotion detection, biometric identity
  verification, and any automatic misconduct determination.
- Student verification (a one-time tick-box identity confirmation) is
  a separate, independent opt-in — no photo ID scan, no face
  comparison, no image capture.
- Risk scoring remains the same fixed, transparent point system
  described above — no anomaly-detection model was introduced; the new
  event severities were chosen conservatively (verification/unavailable
  events carry zero weight; a single low-confidence signal cannot reach
  high risk on its own).
- **Camera startup readiness** — see
  docs/on-device-ai-integrity-detection-v1.md ("Camera startup
  readiness"). A short (3s) warm-up grace period after the camera's
  first ready frame, plus a 15s startup timeout, prevents false
  CAMERA_VIEW_BLOCKED/CAMERA_TOO_DARK/NO_PERSON_VISIBLE/
  POSSIBLE_PHONE_VISIBLE/POSSIBLE_SECOND_PERSON_VISIBLE events while a
  webcam's auto-exposure/auto-focus are still settling on first exam
  start. Detection thresholds and confirmation rules are unchanged —
  only when emission is allowed to begin; once warm-up ends, detection
  behaves exactly as before, including recovering normally if the
  camera becomes genuinely blocked/dark/absent later in the exam.

## Exam Watermark v1

A separate, independent opt-in — see docs/exam-watermark-v1.md for the
full design. A visible, low-opacity, diagonal watermark (student
identifier + attempt id + timestamp + AI-aware wording) is overlaid on
the question content area to deter screenshots/photos/sharing and to
discourage AI tools from answering shared exam content, and to add
traceability if content is shared anyway. It is deliberately the
low-friction alternative to hiding/blurring question content when
integrity is uncertain, which v1 does not do (and does not plan to) since
that risks frustrating genuine students. It is a deterrent and
traceability aid, not a guarantee — it does not prevent copying, does not
guarantee any AI tool will refuse to answer, and is not itself proof of
misconduct. It captures or uploads nothing; it is a purely client-side
rendered overlay.

## One-Question-At-A-Time Exam Delivery v1

A separate, independent opt-in — see docs/one-question-delivery-v1.md
for the full design. When `oneQuestionAtATime` is enabled, a student
receives only the current question from the server (never the full exam
paper in one response), optionally in a stable per-attempt randomised
question/MCQ-option order, with configurable forward-only or free
back-navigation. Reduces exposure of the full exam paper at any one
time — it is a low-friction deterrent, not a guarantee that copying or
sharing is impossible, and it deliberately does not hide or blur question
content based on camera/integrity uncertainty. Works alongside, and does
not replace, the exam watermark, camera monitoring, AI camera integrity
checks, evidence frames, and post-exam lecturer review described
elsewhere in this document.

## Question Pools v1

A separate, independent opt-in — see docs/question-pools-v1.md for the
full design. A lecturer can group interchangeable questions into pools
and have each student attempt draw a smaller, random, per-attempt-stable
subset (plus every unpooled question), so students do not all see an
identical paper. Reduces answer sharing without making it impossible —
two students can still be drawn overlapping sets, and a student can
still share the individual questions they received. Grading, marks
release, and the lecturer's per-submission grading view all operate on
each student's own selected question set, never penalising a student for
a pool question they were never shown. Works alongside, and reuses
infrastructure from, One-Question-At-A-Time Exam Delivery v1 (the same
`Submission.questionOrderJson` column stores the selected set) — neither
feature requires the other.

## Future controls (explicitly out of scope for v1)

- Electron-based lockdown browser (blocks OS-level app switching).
- Microphone monitoring.
- Face recognition, gaze tracking, emotion detection, or biometric
  identity verification (on-device phone/person object detection is
  implemented — see above — but none of these remain out of scope).
- Certification-grade identity verification.
- AI-assisted anomaly detection across integrity signals (v1's risk score
  is a fixed, transparent point system — not a model).
- Cross-submission plagiarism comparison.
- Live proctoring — see docs/live-proctoring-v1-design-audit.md
  (design only, not implemented).

## Evidence captured

Each integrity event records: event type, severity, a short human-
readable message, the timestamp it occurred, and (server-side only) the
submission/exam/student it belongs to. No screenshots, keystrokes, screen
recordings, camera/microphone data, or full network traffic are captured
in v1 — only the specific browser signals listed above, plus (for the
on-device AI camera checks) confidence-band/model metadata, never image
or video data.

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
- No microphone or biometric data is collected in v1. If a lecturer enables
  Camera Monitoring v1 for an exam, only camera *status* events (permission
  granted/denied, started/stopped, heartbeat missed) are recorded — never
  video or images. See "Camera Monitoring v1" below.

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

## Browser-Level Friction v1

Secure Exam Mode v1 adds **best-effort browser-level friction** inside the
exam page itself. This makes casual attempts to copy exam content or leave
the exam window harder, and produces a stronger integrity signal — it is
not a guarantee.

**What can be best-effort blocked inside the exam page:**

- Copy, cut, and paste
- Right-click / context menu
- Selected keyboard shortcuts where the browser allows `preventDefault()`
  (e.g. Ctrl/Cmd+C/V/X, Ctrl/Cmd+S, Ctrl/Cmd+P, Ctrl+U, Ctrl+Shift+I/J/C,
  F12 where preventable)
- Text selection on question content and answer options (not on essay or
  short-answer input fields, so students can still select their own typed
  text for editing)

**What can be recorded as integrity events:**

- Tab/window focus loss
- Fullscreen exit (and forced return to fullscreen, if configured)
- Blocked keyboard shortcut attempts
- Right-click attempts
- Copy/paste attempts

**What cannot be guaranteed in a normal browser:**

- Closing other browser tabs or windows
- Preventing windows opened *before* the exam started
- Blocking all browser or OS-reserved shortcuts (e.g. Ctrl+Tab, Alt+Tab)
- Blocking OS-level application switching
- Fully preventing browser DevTools across all browsers and versions

Full lockdown — preventing alt-tab, other applications, virtual machines,
or secondary monitors — requires a dedicated lockdown browser (Electron or
similar), which is explicitly out of scope for this release. SES never
claims that a standard web browser can achieve this; browser-level
friction raises the effort required for casual misconduct and creates a
reviewable record, nothing more.

## Camera Monitoring v1

**What it adds:** an optional per-exam check of whether the student's
camera is available before and during a secure exam, recorded as
integrity events for lecturer review — not a proctoring or identity
verification system.

**What it detects:**

- Camera permission granted or denied
- Camera started or stopped
- Camera unavailable
- Camera heartbeat missed (the camera stream stopped responding during
  the exam)

**What it does not detect:**

- Identity verification (it does not confirm who is in front of the
  camera)
- Face recognition or face presence detection
- Gaze tracking
- Phone or object detection
- Any form of video recording or frame capture

**Privacy principles:**

- No video is stored, in v1 or planned for any future release of this
  specific feature, beyond what a future dedicated proctoring module
  would introduce separately.
- No images or frames are stored, uploaded, or transmitted anywhere. The
  camera stream stays in the student's own browser; SES only reads
  `MediaStreamTrack` status (`readyState`, `muted`) to decide whether to
  log a status event.
- Only camera *status* events are recorded — never camera content.

**False-positive handling:** a missed heartbeat or a stopped camera can
happen for harmless reasons (camera claimed by another app, USB webcam
disconnected, browser permission revoked accidentally, laptop lid
closed/reopened). Camera events are signals for human review, exactly like
every other integrity event — SES never auto-fails, auto-flags, or treats
a camera event as proof of misconduct.

**Lecturer review process:** camera events appear in the same integrity
event timeline, risk score, and evidence report as every other event type,
with friendly labels (e.g. "Camera permission denied", "Camera heartbeat
missed"). A lecturer can mark any camera event reviewed with a note, the
same as any other integrity event.

**Future options (explicitly out of scope for this release):**

- Dedicated lockdown browser
- Identity verification (e.g. photo ID matching)
- AI-based face presence detection
- Full AI proctoring (gaze tracking, multi-person detection, audio
  analysis)
