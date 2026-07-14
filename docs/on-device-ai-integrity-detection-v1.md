# Optional Student Verification + On-Device AI Camera Integrity Detection v1

**Status:** Implemented locally, not yet deployed to production. One additive schema migration required (see "Production DDL" below).

This document covers two lecturer-optional, independently-toggleable features layered on top of the existing Camera Monitoring v1 / Persistent Camera Preview v1:

1. **Student verification** — a one-time, pre-exam self-confirmation step.
2. **On-device AI camera integrity checks** — local, in-browser checks for a possible phone, a possible additional person, no visible person, or a blocked/dark camera view.

**This is not live proctoring.** No one — lecturer, institution, or SES — ever sees the student's camera live. Nothing is recorded, streamed, or stored. See `docs/live-proctoring-v1-design-audit.md` for the (separate, not-implemented) design audit of what live proctoring would require.

---

## Lecturer opt-in

Both features are off by default and controlled independently on the exam edit page, under "Student verification and AI integrity checks":

- **Require student verification before exam** (`requireStudentVerification`)
- **Enable AI-assisted camera integrity checks** (`enableAiCameraIntegrityChecks`)

Both are stored in the existing `Exam.secureSettings` JSON column (`src/lib/secureExam.ts`) — no schema change was needed for the settings themselves, only for the new `IntegrityEventType` values the features can produce (see "Production DDL" below). Neither setting is inferred from or replaces `requireCamera` — a lecturer can require a local camera preview without either of these, exactly as before.

## Student verification (v1)

When enabled, the pre-exam checklist gate shows a "Confirm your identity" card displaying the student's full name, institutional student ID (if set), and email — all already known to the session, not newly collected. The student must tick "I confirm I am the student listed above and I will complete this exam myself." and click "Confirm identity" before "Start secure exam" becomes enabled; if they don't confirm, exam entry is blocked with a clear message.

Confirming records exactly one metadata-only `STUDENT_VERIFICATION_CONFIRMED` integrity event (severity `INFO`, message "Student confirmed identity before starting the exam.") — nothing else. There is:

- **No photo/ID capture.** The task description's optional "show your ID to the camera" idea was deliberately **not implemented** in v1 — it would require capturing an image even if not stored, which is a meaningfully different risk profile from a text confirmation, and the self-confirmation alone already satisfies the stated goal (a deliberate, active step, not a silent default).
- **No face comparison, no biometric check of any kind.**
- **No stored image of any kind, ID or otherwise.**

## On-device AI camera integrity checks

### Architecture

Detection runs entirely in the student's browser against the **same `MediaStream`** already held in `cameraStreamRef` for the existing camera preview/heartbeat (`src/app/student/exams/[id]/page.tsx`) — no second `getUserMedia()` call. A dedicated hidden `<video>` element (`detectionVideoRef`) keeps sampling frames even while the visible preview widget is minimized, since minimizing is deliberately just a display choice (see `docs/known-limitations.md`) and must never pause any monitoring.

Every tick (1–1.5 seconds by default — see "Adaptive cadence" below; the original v1 default was 3 seconds, and before that 8 seconds), the current frame is drawn to an in-memory, never-rendered `<canvas>` and:

1. **Non-AI camera quality checks** (no model, no dependency): `computeLuminanceVariance()` and `classifyFrameQuality()` in `src/lib/cameraIntegrityDetection.ts` compute average luminance and pixel variance from the canvas `ImageData` to detect a blocked/covered lens (near-zero variance) or a too-dark room (low luminance). These run unconditionally, independent of whether the object-detection model below loaded successfully.
2. **Object-detection checks** (model-dependent): if the model loaded, a single `detector.detect(video)` call returns class/confidence pairs for every label in one pass (there is no separate detector instance or extra inference call for phone vs. person), which `evaluatePhoneDetections()` / `evaluatePersonDetections()` turn into phone/person/no-person/second-person signals.

**Nothing above ever returns, logs, or transmits pixel data.** The canvas and its `ImageData` never leave the browser tab; only the numeric aggregates (luminance, variance) and, from the model, class names and confidence scores are ever used — and only those are sent to the server as `IntegrityEvent` metadata.

**Scheduling:** the loop is self-scheduling (`setTimeout` after each inference resolves), not a fixed-rate `setInterval` — the next tick is only scheduled once the current frame's checks (including the async `detector.detect()` call) have fully completed. This means a slow device can never stack up overlapping inference calls regardless of how short the delay between ticks is; a single slow tick simply delays the next one rather than compounding.

### Adaptive cadence

`computeNextDetectionDelayMs()` (`src/lib/cameraIntegrityDetection.ts`) chooses the delay before each next tick from how long the *previous* tick's inference took:

| Previous tick's `inferenceMs` | Next delay |
|---|---|
| `null` (no inference has run yet — first tick, or the model isn't loaded, or the tick short-circuited before inference) | 1000ms |
| ≤ 900ms (healthy) | 1000ms |
| \> 900ms (device is struggling) | 1500ms |

This replaces the previous fixed 3-second interval. The faster baseline exists specifically so a briefly-shown mobile phone is very likely caught on the next tick rather than several ticks later; the back-off exists so a slower device doesn't get hammered with back-to-back inference calls. The non-overlapping self-scheduling guarantee above is what actually keeps this safe on slow hardware — the adaptive delay is a cadence tuning on top of that guarantee, not a replacement for it.

### Model/library choice

**TensorFlow.js + COCO-SSD** (`@tensorflow/tfjs`, `@tensorflow-models/coco-ssd`, `lite_mobilenet_v2` base), loaded via `src/lib/cameraObjectDetector.ts`. Chosen over MediaPipe Tasks Vision and ONNX Runtime Web because it is the smallest well-supported browser option that recognizes both "cell phone" and "person" out of the box, with no custom model training or hosting required.

- **Loaded client-side only**, via dynamic `import()` inside `loadCameraObjectDetector()` — never at module scope, never during SSR.
- **A failed load never crashes the exam.** `loadCameraObjectDetector()` resolves to `null` on any failure (slow network, unsupported browser, blocked CDN); the student page treats `null` as "unavailable," shows "Camera integrity checks unavailable," and records one metadata-only `AI_CAMERA_CHECK_UNAVAILABLE` event (severity `INFO` — never increases risk).
- **A single failed inference pass** (e.g. the model call throws) is treated as "nothing detected this check," not as the model becoming unavailable — the interval keeps running.

**Verification status:** the code path was manually exercised locally, confirming the pre-exam gate, verification flow, and event pipeline all behave correctly end-to-end. **Actual object-detection accuracy (phone/person recognition) has not been verified against a real webcam** in this environment (no camera hardware available to the implementing agent — the same limitation noted for Persistent Camera Preview v1's real-device signoff). A human with real hardware should complete the manual checklist in this document's final section before relying on this feature in a real exam.

### Detection signals (v1)

| Event | Trigger | Severity | Cooldown |
|---|---|---|---|
| `POSSIBLE_PHONE_VISIBLE` | A "cell phone" class detection ≥0.45 confidence, on the **first** qualifying check (no consecutive-check wait — see "Phone detection is high-priority" below) | MEDIUM | 45s |
| `POSSIBLE_SECOND_PERSON_VISIBLE` | ≥2 person detections ≥0.60 confidence, on ≥2 consecutive checks (or immediately if both ≥0.75 — see `decideSecondPersonEmission()`) | MEDIUM | 45s |
| `NO_PERSON_VISIBLE` | Zero person detections, on ≥3 consecutive checks | MEDIUM | 45s |
| `CAMERA_VIEW_BLOCKED` | Near-zero frame variance, on ≥2 consecutive checks | MEDIUM | 60s |
| `CAMERA_TOO_DARK` | Low average luminance, on ≥2 consecutive checks | LOW | 60s |
| `AI_CAMERA_CHECK_UNAVAILABLE` | Model failed to load | INFO | 60s |

Existing camera lifecycle events (`CAMERA_STOPPED`, `CAMERA_PERMISSION_DENIED`, `CAMERA_UNAVAILABLE`, `CAMERA_HEARTBEAT_MISSED`) are reused unchanged — no duplicate event types were created for camera-stopped/revoked scenarios.

### Phone detection is high-priority

A mobile phone is the most urgent of the five signals: a student could show a phone just long enough to photograph an exam question (to use elsewhere, including with an external AI tool) and hide it again well within the multi-tick consecutive-check window the other signals use. `decidePhoneEmission()` (`src/lib/cameraIntegrityDetection.ts`) reflects this by emitting `POSSIBLE_PHONE_VISIBLE` on the **first** qualifying detection — unlike second-person (normal-confidence path) and no-person, which still require 2–3 consecutive checks to guard against a single fleeting misclassification. The 45-second cooldown is unchanged, so a phone that stays visible for an extended period still produces one event per cooldown window, not one per tick.

The confidence threshold was also lowered from the original 0.65 to `PHONE_CONFIDENCE_THRESHOLD = 0.45` (`src/lib/cameraIntegrityDetection.ts`), specifically because removing the consecutive-check requirement means a single misclassified frame can no longer be caught by "wait for a second confirming frame" the way it could before — a slightly higher false-positive rate was accepted in exchange for a much lower chance of missing a real phone. If real-hardware testing (via `sesAiCameraDebug`, below) shows too many false positives, raise it toward 0.5; avoid going far below 0.4, which invites noise from unrelated small dark rectangular objects (remotes, wallets, etc).

**Expected latency:** with the first tick running immediately and the adaptive 1–1.5s cadence above, a phone that stays in frame is typically flagged within one tick (as little as ~1 second on fast hardware, up to ~1.5s+inference time when the device has backed off). This is a *typical-case* number, not a guarantee — see "Limitations" below.

### Timing, debounce, and cooldown

Two independent layers prevent event flooding:

1. **Client-side:** `DetectionCooldownTracker` (`src/lib/cameraIntegrityDetection.ts`) tracks a per-signal consecutive-detection counter (reset to 0 on any miss) and a per-signal "last emitted" timestamp. For second-person (normal-confidence path), no-person, blocked, and dark, an event is only sent once the consecutive-count threshold is met **and** the cooldown window has elapsed. **Phone is the exception**: `decidePhoneEmission()` only checks the cooldown, not a consecutive count, so it can emit on the very first qualifying tick — see "Phone detection is high-priority" above.
2. **Server-side:** `POST /api/submissions/[id]/integrity-events` independently enforces the same cooldown windows by checking the most recent event of that type for the submission — a second, defense-in-depth layer in case client-side state is somehow bypassed.

Both layers are cleared on unmount, on submission, or when the camera stream stops (`stopAiDetection()`).

### Metadata shape and safety guardrails

Every AI-sourced event's metadata contains only:

```json
{
  "source": "on_device_camera_ai",
  "confidence": 0.82,
  "confidenceBand": "high",
  "modelName": "coco-ssd",
  "modelVersion": "lite_mobilenet_v2",
  "detectionIntervalSeconds": 1
}
```

`confidence`/`modelName`/`modelVersion` are omitted for the two non-AI quality checks (blocked/dark), which have no model to report. `detectionIntervalSeconds` now varies (1 or 1.5) per the adaptive cadence above, rather than always being the previous fixed value of 3 — it reflects whichever cadence was in effect for that particular tick.

### Dev-only diagnostic logging (`sesAiCameraDebug`)

To help tune the interval and confidence threshold against real hardware without adding any student-facing UI or server-side logging, the detection loop supports an opt-in, development-only console log:

- Gated on **both** `process.env.NODE_ENV === "development"` **and** `localStorage.getItem("sesAiCameraDebug") === "true"` (pure gate function: `shouldLogAiCameraDebug()` in `src/lib/cameraIntegrityDetection.ts`) — being in a dev server alone is never enough, and it is hard-disabled whenever `NODE_ENV` is not exactly `"development"`.
- To enable: open the browser console on a local dev build and run `localStorage.setItem("sesAiCameraDebug", "true")`, then reload the exam page. To disable: `localStorage.removeItem("sesAiCameraDebug")`.
- Logs, per detection tick:
  - `tick: start` — the tick's timestamp and the current adaptive cadence (`cadenceMs`).
  - `tick: inference complete` — whether the model is loaded, the **raw** detection results (all classes and confidence scores, not just phone/person), the phone/person thresholds each detection is compared against, `inferenceMs` (wall-clock time of the `detector.detect()` call only, measured with `performance.now()` immediately before/after), and the current cadence.
  - `tick: phone decision` — the phone confidence score and threshold, whether the cooldown blocked emission, whether an event was emitted (`shouldEmit`), and whether the overlay was set (`overlaySet` — always equal to `shouldEmit` for phone, since every `POSSIBLE_PHONE_VISIBLE` emission maps to an overlay).
  - `tick: second-person decision` — unchanged from before (multi-person state, consecutive count, cooldown, emission decision).
- Never sent to the server, never enabled by default, and never includes image/frame/base64/blob data — only class names, confidence numbers, and timing numbers ever appear in the log.

**Confidence threshold tuning is expected before broad institutional rollout.** The current thresholds (phone ≥0.45, person ≥0.6) are defaults and have not been calibrated against real-world lighting/camera/distance conditions. The phone threshold was deliberately lowered from its original 0.65 alongside removing the consecutive-check requirement (see "Phone detection is high-priority" above) — use `sesAiCameraDebug` to collect real confidence scores on representative hardware before deciding whether to raise it back toward 0.5; avoid going far below 0.4.

**Structural guardrail, not just convention:** `POST /api/submissions/[id]/integrity-events` rejects any request whose metadata contains a key matching `image|frame|screenshot|thumbnail|snapshot|base64|blob|dataurl` (case-insensitive), or any string value that looks like a `data:` URL or a long base64 blob — with a 400 response, before anything is written. The same check is mirrored client-side as `assertSafeIntegrityMetadata()` for defense-in-depth. **No API endpoint anywhere in this feature accepts an uploaded image, video, or file** — there is no upload endpoint, no storage bucket, and no code path that could accept one.

---

## Evidence report and risk scoring

The lecturer evidence report (`src/lib/evidenceReport.ts`) gained:

- A `confidenceBand` field on each event (from metadata, when present).
- A dedicated `aiCameraIntegritySummary` section: counts of possible-phone, possible-second-person, no-person, and blocked/dark events, plus the disclaimer *"AI camera signals are indicators for review. They are not automatic misconduct decisions."* Rendered as its own "AI-assisted camera integrity signals" section on the evidence page, and included in the CSV export.

**Risk scoring required no code changes to `src/lib/integrityRisk.ts`.** Risk is a simple sum of `SEVERITY_WEIGHTS` (`INFO:0, LOW:1, MEDIUM:3, HIGH:7`) across a submission's events, so the conservative-by-construction behavior falls out of severity choice alone:

- `STUDENT_VERIFICATION_CONFIRMED` and `AI_CAMERA_CHECK_UNAVAILABLE` are `INFO` (weight 0) — **never** increase risk, by construction, not by a special case.
- `CAMERA_TOO_DARK` is `LOW` (weight 1) — deliberately the lowest non-zero weight, since a dark room is far more likely an innocent lighting issue than the phone/second-person/blocked signals.
- `POSSIBLE_PHONE_VISIBLE`, `POSSIBLE_SECOND_PERSON_VISIBLE`, `NO_PERSON_VISIBLE`, `CAMERA_VIEW_BLOCKED` are `MEDIUM` (weight 3).
- A single occurrence of any signal never reaches `HIGH` risk level on its own; **repetition** (multiple cooldown-spaced occurrences, each a separate row) is what accumulates risk over time — this is the existing summation model, not new escalation logic layered on top of it.

---

## Neutral wording — enforced throughout

Every label, message, and disclaimer added by this feature uses "possible," "needs review," or "camera-based integrity signal" language — never "confirmed," "cheating," "caught," or "proof." This applies to: `src/lib/integrityEventLabels.ts`, the student-facing messages in `src/app/student/exams/[id]/page.tsx`, and the evidence report/CSV. See `docs/secure-exam-threat-model.md` for the same principle already established for existing integrity signals.

---

## Limitations

- **This does not guarantee catching every briefly shown phone.** Even with immediate-first-tick emission and no consecutive-check requirement for phone, detection is not instantaneous: a phone held up and put away faster than one detection cycle (roughly ~1–1.5s plus inference time, more on slower devices — see "Adaptive cadence" above) can still be missed entirely. Faster detection reduces this window; it does not close it. This is a review-signal system, not a guarantee of prevention, and it should never be described to students or lecturers as one.
- **Expected latency depends on device performance and camera conditions.** A fast, uncluttered laptop will typically flag a phone within about a second; a slower device, poor lighting, an odd camera angle, or a partially-obscured view can all push real-world latency higher than the adaptive cadence's nominal 1–1.5s, since `inferenceMs` itself varies by hardware and the phone must still be clearly enough in frame for the model to classify it correctly.
- **False positives are expected, and are somewhat more likely now than before.** Object detection models misclassify; a book held up, a reflection, or unusual lighting can trigger a false "possible phone" or "possible person" signal. Lowering the phone confidence threshold to 0.45 and removing its consecutive-check requirement (to prioritize not missing a real phone) makes an occasional false positive more likely, not less. This is why every wording choice says "possible" and "needs review," never a determination.
- **Camera field of view is limited.** The webcam sees only what's in frame — it cannot detect a phone or person outside that view, under a desk, or behind the student.
- **No face recognition, no gaze tracking, no biometric identity verification, no emotion detection** — none of these exist anywhere in this feature, and none should be added under a future version without a fresh, separate privacy review.
- **No automatic misconduct finding.** Every signal is a review indicator; the lecturer and institution make the final academic decision, exactly as with every other integrity signal in SES.
- **No images, video, or snapshots are ever uploaded, recorded, or streamed** by this feature, regardless of detection speed — this did not change with the phone-detection speed-up, and is enforced structurally (see "Metadata shape and safety guardrails" above), not just by convention.
- **Real-webcam accuracy verification is pending** — see "Model/library choice" above.

---

## Production DDL required

New enum values were added to `IntegrityEventType` (additive only — no existing value was changed or removed):

```sql
ALTER TYPE "IntegrityEventType" ADD VALUE 'STUDENT_VERIFICATION_CONFIRMED';
ALTER TYPE "IntegrityEventType" ADD VALUE 'POSSIBLE_PHONE_VISIBLE';
ALTER TYPE "IntegrityEventType" ADD VALUE 'POSSIBLE_SECOND_PERSON_VISIBLE';
ALTER TYPE "IntegrityEventType" ADD VALUE 'NO_PERSON_VISIBLE';
ALTER TYPE "IntegrityEventType" ADD VALUE 'CAMERA_VIEW_BLOCKED';
ALTER TYPE "IntegrityEventType" ADD VALUE 'CAMERA_TOO_DARK';
ALTER TYPE "IntegrityEventType" ADD VALUE 'AI_CAMERA_CHECK_UNAVAILABLE';
```

Generate/verify the exact statements via `prisma migrate diff` before applying, per the existing production-DDL pattern in `docs/network-evidence-and-ip-location.md`. No `prisma db push` against production. No other schema changes were required — `requireStudentVerification`/`enableAiCameraIntegrityChecks` live in the existing `Exam.secureSettings` JSON column.
