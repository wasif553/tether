# Final Minor UX Refinements v1

Three targeted refinements on top of the approved student exam +
Brainstorm workspace, with nothing else touched.

## 1. Watermark — restored darkness

`src/components/ExamWatermark.tsx` — opacity `0.06` → `0.1` (the
original value, before a prior pass lightened it). Purely a CSS visual
property; text, tile pattern, positioning, `pointer-events: none`,
`aria-hidden`, and evidence/security semantics all unchanged (confirmed
by `src/components/ExamWatermark.test.ts`, new this pass, alongside a
structural check that the pattern/rotation/text-building call are
untouched).

## 2. Camera preview — default position + drag

Default desktop location moved from "below Tether Brainstorm in the
right column" to "in the left column, under the Questions navigator,"
per the approved reference, and made draggable — a lightweight
picture-in-picture panel, not a dependency.

- **`src/lib/draggablePanelBounds.ts`** — pure, dependency-free
  clamping logic (`clampPanelPosition`), 8 tests. Never lets the panel
  disappear off-screen; keeps it below a `minTop` (96px, clears the
  exam header/timer/status strip) and within 8px of every other edge,
  accounting for the panel's own width/height. Re-clamps correctly
  after a viewport resize.
- **`src/components/DraggableCameraPreview.tsx`** — a generic wrapper:
  renders in normal flow by default (`position === null`); once the
  student drags its header (`Your camera — only you can see this`,
  `cursor-grab`/`cursor-grabbing`, Pointer Events + `setPointerCapture`,
  no drag-and-drop dependency), it becomes `position: fixed`, clamped,
  and stays that way for the rest of the session. The collapse/expand
  toggle button stops its own `pointerdown` from bubbling into the
  drag-start handler, so clicking it still just collapses/expands
  rather than starting a drag.
- **Persistence**: `sessionStorage`, keyed
  `tether-camera-position-${submissionId}` — read once on mount,
  written on drag-end. No DB/schema change, no server round-trip.
  Because the SAME `DraggableCameraPreview` instance renders across
  every question (it isn't keyed by `questionId`), switching questions
  can never remount it or reset a dragged position.
- **Placement**: only in one-question-at-a-time delivery WITH a
  question navigator enabled (`showCameraInNavigatorColumn`) — inside
  that same grid cell, after the navigator/placeholder. Every other
  case (full-paper mode, or one-question mode without a navigator)
  keeps the exact original non-draggable fixed-bottom-right behaviour,
  untouched.
- **Single video element, never duplicated**: the actual camera
  content (`<video ref={examVideoRef}>` + integrity-check status
  messages) is computed once as `cameraStatusContent` and rendered in
  exactly ONE of the two mutually-exclusive locations per render — a
  React ref can only ever point at the most recently mounted instance,
  so rendering it twice would silently break the stream in whichever
  copy loses the ref. Confirmed by a structural test asserting exactly
  one `<video ref={examVideoRef}>` tag exists in source.
- Dragging never touches the camera stream, never creates an
  `IntegrityEvent`, and never changes camera monitoring/integrity-check
  behaviour — it is local UI state only, the same convention already
  established for the existing minimize/expand toggle.

## 3. Submit exam — moved into the centre column

`submitExamButton` (the exact original onClick logic — confirm-dialog/
review-modal gating, autosubmit-on-timer-expiry, disabled conditions —
byte-for-byte unchanged) is now computed once and rendered in exactly
one of two mutually exclusive locations:
- One-question-at-a-time mode: inside the centre question card, below
  Previous/Next, separated by its own `border-t` divider.
- Full-paper mode: unchanged, at its original end-of-page location —
  that mode has no distinct centre column for it to move into.

Never duplicated (confirmed structurally — the button's own JSX/text
literal appears exactly once in source, referenced from two mutually
exclusive call sites).

## Unchanged (confirmed, not touched this pass)

Claude guardrails, prompt limits, authorization, evidence semantics,
question-scoped Brainstorm history, autosave, submission API, timer
enforcement/urgency states, exam title, right-side Brainstorm and its
colours, question navigator styling, centre question card, Previous/
Next visual hierarchy, Secure Browser, camera monitoring/integrity
checks.
