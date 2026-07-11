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

Every 3 seconds by default (minimum 2 seconds; the previous default was 8 seconds), the current frame is drawn to an in-memory, never-rendered `<canvas>` and:

1. **Non-AI camera quality checks** (no model, no dependency): `computeLuminanceVariance()` and `classifyFrameQuality()` in `src/lib/cameraIntegrityDetection.ts` compute average luminance and pixel variance from the canvas `ImageData` to detect a blocked/covered lens (near-zero variance) or a too-dark room (low luminance). These run unconditionally, independent of whether the object-detection model below loaded successfully.
2. **Object-detection checks** (model-dependent): if the model loaded, `detector.detect(video)` returns class/confidence pairs, which `evaluatePhoneDetections()` / `evaluatePersonDetections()` turn into phone/person/no-person/second-person signals.

**Nothing above ever returns, logs, or transmits pixel data.** The canvas and its `ImageData` never leave the browser tab; only the numeric aggregates (luminance, variance) and, from the model, class names and confidence scores are ever used — and only those are sent to the server as `IntegrityEvent` metadata.

**Scheduling:** the loop is self-scheduling (`setTimeout` after each inference resolves), not a fixed-rate `setInterval` — the next tick is only scheduled once the current frame's checks (including the async `detector.detect()` call) have fully completed. This means a slow device can never stack up overlapping inference calls even at a short interval; a single slow tick simply delays the next one rather than compounding. 2–3 seconds is the recommended range: below 2 seconds is not the default and is not recommended without first confirming CPU/inference-time impact on real hardware, since `lite_mobilenet_v2` inference itself can take a non-trivial fraction of a second on a slower device.

### Model/library choice

**TensorFlow.js + COCO-SSD** (`@tensorflow/tfjs`, `@tensorflow-models/coco-ssd`, `lite_mobilenet_v2` base), loaded via `src/lib/cameraObjectDetector.ts`. Chosen over MediaPipe Tasks Vision and ONNX Runtime Web because it is the smallest well-supported browser option that recognizes both "cell phone" and "person" out of the box, with no custom model training or hosting required.

- **Loaded client-side only**, via dynamic `import()` inside `loadCameraObjectDetector()` — never at module scope, never during SSR.
- **A failed load never crashes the exam.** `loadCameraObjectDetector()` resolves to `null` on any failure (slow network, unsupported browser, blocked CDN); the student page treats `null` as "unavailable," shows "Camera integrity checks unavailable," and records one metadata-only `AI_CAMERA_CHECK_UNAVAILABLE` event (severity `INFO` — never increases risk).
- **A single failed inference pass** (e.g. the model call throws) is treated as "nothing detected this check," not as the model becoming unavailable — the interval keeps running.

**Verification status:** the code path was manually exercised locally, confirming the pre-exam gate, verification flow, and event pipeline all behave correctly end-to-end. **Actual object-detection accuracy (phone/person recognition) has not been verified against a real webcam** in this environment (no camera hardware available to the implementing agent — the same limitation noted for Persistent Camera Preview v1's real-device signoff). A human with real hardware should complete the manual checklist in this document's final section before relying on this feature in a real exam.

### Detection signals (v1)

| Event | Trigger | Severity | Cooldown |
|---|---|---|---|
| `POSSIBLE_PHONE_VISIBLE` | A phone-class detection ≥0.65 confidence, on ≥2 consecutive checks | MEDIUM | 45s |
| `POSSIBLE_SECOND_PERSON_VISIBLE` | Confidence-aware — see below | MEDIUM | 45s |
| `NO_PERSON_VISIBLE` | Zero person detections, on ≥3 consecutive checks | MEDIUM | 45s |
| `CAMERA_VIEW_BLOCKED` | Near-zero frame variance, on ≥2 consecutive checks | MEDIUM | 60s |
| `CAMERA_TOO_DARK` | Low average luminance, on ≥2 consecutive checks | LOW | 60s |
| `AI_CAMERA_CHECK_UNAVAILABLE` | Model failed to load | INFO | 60s |

Existing camera lifecycle events (`CAMERA_STOPPED`, `CAMERA_PERMISSION_DENIED`, `CAMERA_UNAVAILABLE`, `CAMERA_HEARTBEAT_MISSED`) are reused unchanged — no duplicate event types were created for camera-stopped/revoked scenarios.

### Confidence-aware second-person detection and timing

`POSSIBLE_SECOND_PERSON_VISIBLE` uses a two-tier confidence rule (`decideSecondPersonEmission()` in `src/lib/cameraIntegrityDetection.ts`), tuned to reduce perceived latency without lowering the underlying person-detection threshold (0.60) or raising false-positive risk:

- **High confidence (both persons ≥0.75):** emits on the very first tick they're observed — no consecutive-tick wait.
- **Normal confidence (0.60-0.75):** still requires 2 consecutive ticks, same as v1, to guard against a single fleeting misclassification.
- Either path is gated by the same 45s cooldown, so a second person who remains visible in frame does not repeatedly flood the evidence timeline.

Combined with running the first detection tick immediately (instead of waiting a full interval after the camera stream is ready — see "Architecture" above) and the 3s interval, expected latency is:

| Scenario | Old (v1) | New |
|---|---|---|
| High-confidence second person, already in frame when detection starts | up to 8s (interval wait) + 2 ticks (~16s) | ~0-3s (first tick, immediate emit) |
| Normal/lower-confidence second person | up to 8s + 2 ticks (~16s) | up to 3s + 1 more tick (~6s) |

These are expected-case estimates, not guarantees — actual latency depends on device inference speed (see `inferenceMs` in the dev diagnostic log below) and exactly when in the tick cycle the second person becomes visible.

Two independent layers prevent event flooding beyond the confidence-tier logic above:

1. **Client-side:** `DetectionCooldownTracker` (`src/lib/cameraIntegrityDetection.ts`) tracks a per-signal consecutive-detection counter (reset to 0 on any miss) and a per-signal "last emitted" timestamp; an event is only sent once the confidence/consecutive-count rule above is satisfied **and** the cooldown window has elapsed.
2. **Server-side:** `POST /api/submissions/[id]/integrity-events` independently enforces the same cooldown windows by checking the most recent event of that type for the submission — a second, defense-in-depth layer in case client-side state is somehow bypassed.

Both layers are cleared on unmount, on submission, or when the camera stream stops (`stopAiDetection()`).

**Still no image/frame/snapshot capture, no face recognition, and no person-change (biometric identity) detection** — this feature only ever counts how many `person`-class detections are in frame per tick; it does not compare faces or attempt to determine whether the *same* person left and a *different* person returned. See "Explicitly out of scope" below.

### Metadata shape and safety guardrails

Every AI-sourced event's metadata contains only:

```json
{
  "source": "on_device_camera_ai",
  "confidence": 0.82,
  "confidenceBand": "high",
  "modelName": "coco-ssd",
  "modelVersion": "lite_mobilenet_v2",
  "detectionIntervalSeconds": 3
}
```

`confidence`/`modelName`/`modelVersion` are omitted for the two non-AI quality checks (blocked/dark), which have no model to report.

### Dev-only diagnostic logging (`sesAiCameraDebug`)

To help tune the interval and confidence threshold against real hardware without adding any student-facing UI or server-side logging, the detection loop supports an opt-in, development-only console log:

- Gated on **both** `process.env.NODE_ENV === "development"` **and** `localStorage.getItem("sesAiCameraDebug") === "true"` (pure gate function: `shouldLogAiCameraDebug()` in `src/lib/cameraIntegrityDetection.ts`) — being in a dev server alone is never enough, and it is hard-disabled whenever `NODE_ENV` is not exactly `"development"`.
- To enable: open the browser console on a local dev build and run `localStorage.setItem("sesAiCameraDebug", "true")`, then reload the exam page. To disable: `localStorage.removeItem("sesAiCameraDebug")`.
- Logs, per detection tick: whether the model is loaded, the **raw** detection results (all classes and confidence scores, not just phone/person), the phone/person thresholds each detection is compared against, and `inferenceMs` (wall-clock time of the `detector.detect()` call only, measured with `performance.now()` immediately before/after).
- Never sent to the server, never enabled by default, and never includes image/frame/base64/blob data — only class names, confidence numbers, and timing numbers ever appear in the log.

**Confidence threshold tuning is expected before broad institutional rollout.** The current thresholds (phone ≥0.65, person ≥0.6) are initial defaults carried over from v1 and have not been calibrated against real-world lighting/camera/distance conditions. Use `sesAiCameraDebug` to collect real confidence scores on representative hardware (see the manual test steps in the PR/commit that introduced this logging) before deciding whether to adjust either threshold — do not lower them speculatively without that data.

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

- **False positives are expected.** Object detection models misclassify; a book held up, a reflection, or unusual lighting can trigger a false "possible phone" or "possible person" signal. This is why every wording choice says "possible" and "needs review," never a determination.
- **Camera field of view is limited.** The webcam sees only what's in frame — it cannot detect a phone or person outside that view, under a desk, or behind the student.
- **No face recognition, no gaze tracking, no biometric identity verification, no emotion detection** — none of these exist anywhere in this feature, and none should be added under a future version without a fresh, separate privacy review.
- **No automatic misconduct finding.** Every signal is a review indicator; the lecturer and institution make the final academic decision, exactly as with every other integrity signal in SES.
- **Real-webcam accuracy verification is pending** — see "Model/library choice" above.

**Explicitly out of scope (not implemented, and not planned without a separate
review):** snapshot/image/frame/screenshot capture, video recording, live
streaming, face recognition, face comparison, biometric identity matching,
and "the person changed" detection across time. Detecting that the visible
person changed would require comparing faces or another biometric signal —
that is a separate privacy/legal/product decision, not a natural extension
of the existing metadata-only counting approach this feature uses.

**Possible future non-biometric work (documented, not implemented):** a
lecturer-configurable "re-confirm after camera interruption" step — i.e.
re-showing the existing (non-biometric) student verification tick-box
confirmation from "Student verification (v1)" above if the camera stream
stops and restarts mid-exam — would not require any image storage or face
comparison, since it reuses the existing yes/no confirmation gate. This is
future work, not implemented in this pass.

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
