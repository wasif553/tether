# Optional Student Verification + On-Device AI Camera Integrity Detection v1

**Status:** Implemented locally, not yet deployed to production. One additive schema migration required (see "Production DDL" below).

This document covers three lecturer-optional, independently-toggleable features layered on top of the existing Camera Monitoring v1 / Persistent Camera Preview v1:

1. **Student verification** — a one-time, pre-exam self-confirmation step.
2. **On-device AI camera integrity checks** — local, in-browser checks for a possible phone, a possible additional person, no visible person, or a blocked/dark camera view.
3. **Evidence frames** (additive, opt-in — see "Evidence Frames v1" below) — a single, privacy-minimised webcam still frame saved only for a possible-phone or possible-second-person signal, and only when a lecturer/institution has explicitly enabled it in addition to feature 2 above.

**This is not live proctoring.** No one — lecturer, institution, or SES — ever sees the student's camera live, and nothing is streamed. By default, nothing is recorded or stored either — feature 3 above is the one deliberate, opt-in, clearly-disclosed exception, and even then it is a single low-resolution still image, never a video. See `docs/live-proctoring-v1-design-audit.md` for the (separate, not-implemented) design audit of what live proctoring would require.

A separate, independent opt-in — **Exam Watermark v1** — works alongside these camera-based features but captures/uploads nothing itself; see `docs/exam-watermark-v1.md`.

---

## Lecturer opt-in

All three features are off by default and controlled independently on the exam edit page, under "Student verification and AI integrity checks":

- **Require student verification before exam** (`requireStudentVerification`)
- **Enable AI-assisted camera integrity checks** (`enableAiCameraIntegrityChecks`)
- **Save evidence frame for phone or second-person warnings** (`captureAiViolationEvidence`) — has no effect unless `enableAiCameraIntegrityChecks` is also enabled; the checkbox is disabled in the UI until then

`requireStudentVerification`/`enableAiCameraIntegrityChecks`/`captureAiViolationEvidence` are all stored in the existing `Exam.secureSettings` JSON column (`src/lib/secureExam.ts`) — no schema change was needed for the settings themselves, only for the new `IntegrityEventType` values features 1-2 can produce, and the new `IntegrityEvidenceAsset` table feature 3 needs (see "Production DDL" below). None of these settings is inferred from or replaces `requireCamera` — a lecturer can require a local camera preview without any of them, exactly as before. **Enabling `captureAiViolationEvidence` never retroactively applies to an exam already in progress or already taken** — settings are read fresh per exam, and existing exams are never silently opted in.

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

### Camera startup lifecycle (v2)

**Problem this fixes:** a flat 3-second warm-up grace period (v1, described below for history) only ever suppressed AI-detection *emission* — it never addressed the actual root cause of intermittent first-start "camera blocked/unavailable" failures, which was that `startCamera()` marked the camera `"granted"` the **instant `getUserMedia()` resolved** — before `video.play()`, before `loadedmetadata`, before any dimensions or rendered frame existed, and without ever tearing down a stale/zombie stream before a retry. Some students had to refresh, log out, and log back in before the camera would work — a full page reload was really just the only thing that fully released the browser's device handle and reset the broken state, since nothing in-page did.

**v2 replaces the flat timer with an explicit state machine** (`src/lib/cameraLifecycle.ts`, pure and unit-tested):

```
IDLE → REQUESTING_PERMISSION → PERMISSION_GRANTED → STREAM_RECEIVED → VIDEO_ATTACHED
     → WAITING_FOR_PLAYBACK → WAITING_FOR_FIRST_FRAME → WARMING_UP → READY
                                                        ↘ RETRYING ↗
                                                        ↘ FAILED
```

`cameraStatus === "granted"` (and every downstream gate that depends on it — the exam-start gate, the heartbeat, the detection tick loop) now means **READY**, not merely "permission was granted."

1. **`startCameraAttempt()`** (student page) drives the whole chain explicitly: awaits `getUserMedia()`, assigns `video.srcObject`, awaits `loadedmetadata`, awaits (but does not hard-fail on a rejected) `video.play()`, then polls for genuinely rendered frames.
2. **`isRenderedFrameValid()`** (`src/lib/cameraLifecycle.ts`) is a materially stricter check than the old `isVideoFrameReady()`: `readyState >= HAVE_CURRENT_DATA`, non-zero `videoWidth`/`videoHeight`, `currentTime > 0` (playback has actually advanced), `!paused`, and the video track's `readyState === "live"`. **`REQUIRED_CONSECUTIVE_RENDERED_FRAMES` (3) consecutive** valid observations are required — a single bad frame resets the streak to zero — using `HTMLVideoElement.requestVideoFrameCallback()` where supported, falling back to `requestAnimationFrame` polling otherwise.
3. Only once that 3-frame streak completes does the **warm-up** begin (`CAMERA_WARMUP_MS`, 2500ms) — anchored to the first genuinely rendered frame, never to permission grant or stream acquisition. `isWarmupComplete()` gates the final `READY` transition.
4. **Generation guard:** `cameraStartGenerationRef` is bumped on every `startCamera()` call. Every async continuation checks `isCurrentGeneration()` before touching shared state (assigning/stopping a stream, updating lifecycle state, or reporting an error) — a stale in-flight attempt from a previous click/retry can never overwrite a newer successful one.
5. **Idempotent, teardown-first startup:** `startCamera()` always calls `teardownCameraStream()` — stopping any existing tracks and clearing every `<video>` element's `srcObject` — before requesting a new stream, whether this is the very first attempt, an automatic retry, or the manual "Try camera again" button. This is the fix for the previous "have to log in again" symptom: a broken/zombie stream can no longer block a fresh `getUserMedia()` call from in-page code.
6. **Bounded automatic retry:** if the stream/frame pipeline fails to reach readiness (not a permission denial), up to `CAMERA_MAX_AUTO_RETRIES` (2) automatic retries run, each with a full teardown and a `CAMERA_RETRY_DELAY_MS` (750ms) delay. After that, the UI shows "Camera could not start. Check browser permission and try again." with a **Try camera again** button — which calls the same `startCamera()` entry point, requiring no page reload, no logout, and preserving the current question/answers/submission.
7. **Permission-dialog focus suppression (Part 7):** `shouldSuppressFocusEvent()` suppresses `WINDOW_BLUR` reporting for every startup phase (`REQUESTING_PERMISSION` through `WARMING_UP`) — the browser's/OS's camera-permission prompt can itself trigger a window blur or `visibilitychange`, and that must never be misread as the student switching away from the exam. A genuine focus loss once the camera is `READY` is never suppressed.
8. **Detection arming (Part 11):** `isDetectionArmed(state)` is `true` **only** at `READY`. Both backend `IntegrityEvent` creation *and* the local violation overlay for `CAMERA_VIEW_BLOCKED` / `CAMERA_TOO_DARK` / `NO_PERSON_VISIBLE` / `POSSIBLE_PHONE_VISIBLE` / `POSSIBLE_SECOND_PERSON_VISIBLE` are forced to `{ conditionMet: false, shouldEmit: false }` before `READY` — and since evidence-frame upload is only ever triggered from inside a successful `reportIntegrityEvent()` call for those event types, it is impossible before `READY` too, with no separate gate needed.
9. **Camera restart (Part 12):** if the heartbeat later detects a dead/muted track after `READY`, "Restore camera" calls the same `startCamera()` entry point — full teardown, a fresh generation, and the entire readiness/warm-up chain re-runs from scratch. Old consecutive-frame counters never carry over (`resetCameraLifecycleTimers()`).
10. **Timeout, not an indefinite wait:** if readiness is never reached within `CAMERA_READY_TIMEOUT_MS` (15000ms) of the stream starting, the frame-polling promise resolves `false` and the retry/failure path above takes over — the exam is never blocked or hung.

### Detection-sampling sink readiness (v2.2 — current)

**Problem this fixes:** v2.1 (below) correctly stopped false `CAMERA_VIEW_BLOCKED` events at startup, but as a side effect left detection **permanently unarmed for the entire first exam attempt** on some browsers — no blocked-camera, no-person, or phone detection ever fired, and only a full page refresh restored them. **Root cause:** v2.1's readiness tracking for the hidden sampling `<video>` (`detectionVideoRef`) lived in `let` variables local to the AI-detection `useEffect`, and that effect's own gate (`if (!video || video.readyState < 2 ...) return`) relied entirely on the `autoPlay` HTML attribute — `video.play()` was never explicitly called on this element. `detectionVideoRef` is also only mounted once past the pre-exam gate screen's own early `return` (`secureModeEnabled && !gateAcknowledged`), and its `srcObject` was previously assigned only by a `useEffect` gated on `[gateAcknowledged, cameraStatus]` — i.e. strictly *after* the primary camera had already reached `READY`. On some browsers, `autoPlay` alone is not reliable for a second, initially `display: none` consumer of a stream already flowing to another element, so the sampling sink's frames never actually started rendering — `detectionSamplingReady` (see below) never became `true`, and detection stayed suppressed indefinitely with no retry, no timeout, and no visible status explaining why.

**The fix, in `src/app/student/exams/[id]/page.tsx`:**

1. **`startDetectionSamplingVideo(stream, generation)`** — an explicit, authoritative startup sequence for the sampling sink, mirroring the primary lifecycle step-for-step: clear any stale `srcObject`, reattach the stream, set `muted`/`playsInline`/`autoplay`, await `loadedmetadata`, **explicitly call and await `video.play()`** (never relying on the HTML attribute alone), then poll for `REQUIRED_CONSECUTIVE_RENDERED_FRAMES` (3) genuinely rendered frames via the same `isRenderedFrameValid()`/`waitForRenderedFrames()` used by the primary camera, then `DETECTION_SAMPLING_WARMUP_MS` (1000ms) of settle time.
2. **Started in parallel with the primary camera**, from inside `startCameraAttempt()` right after the stream is obtained (fire-and-forget — never awaited there, so it can never delay the primary reaching `READY`) — not gated behind the primary already being `READY`, and not gated behind `gateAcknowledged`. Because the sampling `<video>` element still cannot exist before the gate screen closes (a structural constraint of the existing early-return gate screen, not rewritten here), `waitForDetectionVideoRef()` polls briefly (up to 20s, well past any reasonable "read the instructions" pause) for the ref to appear rather than failing immediately — this is a generous, silent wait, not counted against the sampling startup timeout below.
3. **Readiness lives in persistent refs** (`detectionSamplingReadyRef`, `detectionSamplingConsecutiveFramesRef`, `detectionSamplingFirstFrameAtRef`), owned solely by `startDetectionSamplingVideo()` — never effect-local `let`s. The AI-detection tick effect only *reads* `detectionSamplingReadyRef.current`; a restart of that effect (e.g. `cameraStatus` flips during a camera restart) can no longer discard in-progress readiness.
4. **Generation-guarded** using the SAME `cameraStartGenerationRef` as the primary lifecycle (Part 5) — every step checks `isCurrentGeneration()` before touching shared state, so a stale sampling attempt can never arm detection for, or stop the stream of, a newer camera generation.
5. **Bounded, sink-only retry** (`startDetectionSamplingWithRetry`) — if the sampling sink times out (`DETECTION_SAMPLING_STARTUP_TIMEOUT_MS`, 9000ms) or fails, it's retried up to `DETECTION_SAMPLING_MAX_RETRIES` (2) times with a `DETECTION_SAMPLING_RETRY_DELAY_MS` (500ms) delay — clearing and reattaching only the sampling sink's own `srcObject`, never touching the primary stream, never restarting the submission, never discarding an answer or the current question. After retries are exhausted, the UI shows "Camera preview is active, but camera integrity checks could not start." with a **Retry camera checks** button (`retryDetectionSampling()`) that restarts only the sink, using the already-live primary stream — no `getUserMedia()` call, no page reload.
6. **Hard arming rule composed from two independently-owned states** (Part 8/9): `isDetectionFullyArmed(primaryLifecycleReady, detectionSamplingReady)` — both `cameraLifecycleRef.current === "READY"` AND `detectionSamplingReadyRef.current` must hold. The UI never shows "Camera integrity checks active" merely because the primary camera is `READY`; it shows "Starting camera integrity checks…" until the sampling sink independently confirms readiness too.
7. **Stale-counter guard at the arm transition:** the frame-*quality* counters (`blocked`/`dark`/`secondPerson`/`noPerson` in `DetectionCooldownTracker`) keep recording every tick regardless of arming (so a persistent signal confirms quickly once armed) — but this means a couple of transient bad ticks recorded *while unarmed* could otherwise satisfy a 2-consecutive-tick rule on the very first armed tick. The detection tick effect now resets the cooldown tracker at the exact `false → true` arming transition, guaranteeing post-arm counting always starts from zero.

**Not implemented:** a primary-video fallback for detection sampling (task Part 7's optional suggestion) — the explicit play()/readiness/bounded-retry sequence above resolves the reported failure without needing a second detection source, and a fallback would add its own generation/warm-up-gating surface for comparatively little benefit once the sink genuinely restarts reliably.

**Not affected by this fix:** phone/second-person/blocked/dark detection *thresholds*, the object-detection model, the consecutive-observation confirmation rules for those signals, evidence-frame handling, or the exam watermark — only *how reliably and how quickly* the sampling sink itself becomes ready.

<details>
<summary>v2.1 history — per-tick sampling readiness in effect-local state (superseded by v2.2 above)</summary>

v2.1 correctly identified that the hidden sampling `<video>` needed its own readiness bar (reusing `isRenderedFrameValid`/`REQUIRED_CONSECUTIVE_RENDERED_FRAMES`/`DETECTION_SAMPLING_WARMUP_MS`), but tracked that readiness in `let` variables inside the AI-detection tick effect and relied on the `autoPlay` attribute rather than an explicit, awaited `video.play()`. Combined with the sink only being attached after the primary camera reached `READY`, this could leave detection permanently unarmed on the first attempt on some browsers, recoverable only by a full page refresh. Superseded by the explicit, ref-persisted, generation-guarded startup sequence above.

</details>

**Dev diagnostics** (`localStorage.sesAiCameraDebug = "true"`, dev builds only — same existing gate as "Adaptive cadence" above): logs every lifecycle transition (with generation number), the Permissions API state (`granted`/`denied`/`prompt`/`unknown`), `getUserMedia()` request/success/failure, `video.play()` success/failure, each rendered-frame observation (valid/invalid, consecutive count, `readyState`/dimensions), warm-up start/end, whether detection is armed, suppressed focus events (with reason), automatic retry attempts, stale-generation-ignored events, and stream cleanup reasons. Never logs image/frame/base64 data, full device labels, or student personal information.

<details>
<summary>v1 history — flat 3-second grace period (superseded by v2 above)</summary>

The original fix only suppressed AI-detection *emission* for `CAMERA_STARTUP_GRACE_PERIOD_MS` (3000ms) after the first tick where `isVideoFrameReady()` (readyState + non-zero dimensions only) was true. It never addressed `startCamera()` marking the camera ready before playback actually started, never guarded against overlapping start attempts, and never tore down a stale stream before a retry — which is why it did not fully fix the intermittent first-start failure. Superseded by the lifecycle state machine above.

</details>

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

**Strengthened detection for angled/edge/partial phones — see
docs/phone-detection-calibration-v1.md.** The single global 0.45 threshold
above (still unchanged) governs the original instant-confirm full-frame
path, but it alone struggles with a phone that is angled, small, near the
bottom or a side edge, or briefly occluded by a hand. The student exam
page's live emission decision for `POSSIBLE_PHONE_VISIBLE` now comes from
a candidate tracker (`src/lib/phoneDetectionTracking.ts`) fed by both the
full frame and a small set of additional zoomed-in crops on an adaptive
schedule (`src/lib/phoneMultiScaleCrops.ts`): a clear ("strong") detection
still confirms on the very first observation exactly as before, while a
weaker ("moderate") one only warns after persisting across several ticks
at a spatially consistent location, optionally strengthened by a bounded
second-stage verification crop. This is additive recall, not a lowered
threshold — see the calibration doc for the full design, false-positive
controls, and known limitations (in particular: no labelled fixture or
real-hardware evaluation has been run in this environment).

### Timing, debounce, and cooldown

Two independent layers prevent event flooding:

1. **Client-side:** `DetectionCooldownTracker` (`src/lib/cameraIntegrityDetection.ts`) tracks a per-signal consecutive-detection counter (reset to 0 on any miss) and a per-signal "last emitted" timestamp. For second-person (normal-confidence path), no-person, blocked, and dark, a **backend** event is only sent once the consecutive-count threshold is met **and** the cooldown window has elapsed. **Phone is the exception**: `decidePhoneEmission()` only checks the cooldown, not a consecutive count, so it can log to the backend on the very first qualifying tick — see "Phone detection is high-priority" above.
2. **Server-side:** `POST /api/submissions/[id]/integrity-events` independently enforces the same cooldown windows by checking the most recent event of that type for the submission — a second, defense-in-depth layer in case client-side state is somehow bypassed.

Both layers are cleared on unmount, on submission, or when the camera stream stops (`stopAiDetection()`).

### Local overlay vs. backend logging — two independent decisions

Every signal's decide* function (`decidePhoneEmission`, `decideSecondPersonEmission`, `decideNoPersonEmission`, `decideFrameQualityEmission` — all in `src/lib/cameraIntegrityDetection.ts`) returns **two** separate fields, not one:

- **`conditionMet`** — whether the signal's detection rule (confidence threshold, and where applicable the consecutive-check count) is satisfied *this tick*, independent of any cooldown. This is what the local exam-content overlay is driven by (`shouldShowLocalAiOverlay(conditionMet)`), via `computeLocalAiCameraOverlay()` in `src/lib/aiCameraViolationOverlay.ts`, which is recomputed on **every** detection tick.
- **`shouldEmit`** — whether *this tick* should send a new `IntegrityEvent` to the backend: `conditionMet` **and** the 45s/60s cooldown above has elapsed (`shouldLogAiIntegrityEvent(conditionMet, cooldownOk)`). This is unchanged from before and still exists specifically to stop the evidence timeline from filling up with a near-duplicate row every tick while a signal stays continuously true.

**Why this split exists:** earlier, the local overlay was set only as a side effect of a backend log actually being sent (`handleAiCameraIntegrityReport()`, called from inside `reportIntegrityEvent()`). Since backend logging is cooldown-gated, this meant the overlay was *also* accidentally cooldown-gated — once shown, "I understand — continue" cleared it locally, but the phone/person condition being *still present* couldn't reopen it until the full 45–60s cooldown had elapsed, because nothing else was checking the overlay's underlying condition. `handleAiCameraIntegrityReport()` still fires the overlay immediately on the very first occurrence (unchanged, and still tested in `aiCameraViolationOverlay.test.ts`); what's new is the *second*, independent check every tick afterwards, driven purely by `conditionMet`, that keeps the overlay in sync with reality regardless of whether a backend log happens that tick.

**What this means for the student experience:**
- Acknowledging the overlay ("I understand — continue") only ever clears the local display — never the backend `IntegrityEvent`, never the cooldown tracker, never the detection loop (which keeps running exactly as before).
- If the same condition (phone / second person / no person / blocked / dark) is **still true** on the next detection tick (typically ~1–1.5s later), the overlay reopens immediately — it does not wait for the 45–60s backend cooldown to elapse.
- If the condition has **cleared** by the next tick, the overlay stays cleared.
- If a **different** condition becomes true, its overlay replaces whatever was showing, immediately (priority order when more than one signal is true in the same tick: phone > second person > no person > blocked > dark — phone is highest because it's the most urgent signal).
- None of this changes auto-submit or lockout behavior: the overlay is always dismissible, the exam is never permanently locked, and no signal triggers automatic submission.

The overlay reflects **only local, on-device detection state** — no image, video, or snapshot is ever part of this decision or sent anywhere as a result of it (see "Metadata shape and safety guardrails" below). Every signal remains a review indicator for the lecturer, never an automatic misconduct finding.

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
  - `tick: model not loaded` / `tick: inference threw` — when object detection didn't run this tick (model unavailable, or a single failed inference pass); frame-quality (blocked/dark) checks and their overlay contribution still proceed independently.
  - `tick: inference complete` — whether the model is loaded, the **raw** detection results (all classes and confidence scores, not just phone/person), the phone/person thresholds each detection is compared against, `inferenceMs` (wall-clock time of the `detector.detect()` call only, measured with `performance.now()` immediately before/after), and the current cadence.
  - `tick: phone decision` / `tick: second-person decision` / `tick: no-person decision` — for each: whether the underlying condition is currently true (`conditionMet`), whether the backend cooldown has elapsed (`backendLogCooldownOk`), and whether a backend event was actually sent this tick (`backendLogSent`). `conditionMet` can be `true` while `backendLogSent` is `false` — that's the local overlay continuing to reflect reality while backend logging stays cooldown-suppressed.
  - `tick: local overlay decision` — whether any AI camera violation is currently present (`violationPresent`) and which one (`activeReason`), whether the overlay was already showing and awaiting acknowledgement before this tick (`overlayAwaitingAcknowledgement`), and whether this tick actually changed the overlay (`overlayWillChange` — `false` on most ticks once a condition is stable, which is what keeps the overlay from visibly flickering).
- Never sent to the server, never enabled by default, and never includes image/frame/base64/blob data — only class names, confidence numbers, timing numbers, and boolean decision flags ever appear in the log.

**Confidence threshold tuning is expected before broad institutional rollout.** The current thresholds (phone ≥0.45, person ≥0.6) are defaults and have not been calibrated against real-world lighting/camera/distance conditions. The phone threshold was deliberately lowered from its original 0.65 alongside removing the consecutive-check requirement (see "Phone detection is high-priority" above) — use `sesAiCameraDebug` to collect real confidence scores on representative hardware before deciding whether to raise it back toward 0.5; avoid going far below 0.4.

**Structural guardrail, not just convention:** `POST /api/submissions/[id]/integrity-events` rejects any request whose metadata contains a key matching `image|frame|screenshot|thumbnail|snapshot|base64|blob|dataurl` (case-insensitive), or any string value that looks like a `data:` URL or a long base64 blob — with a 400 response, before anything is written. The same check is mirrored client-side as `assertSafeIntegrityMetadata()` for defense-in-depth. This endpoint itself never accepts an uploaded image, video, or file, and image bytes are never stored inline in `IntegrityEvent.metadataJson` — the only endpoint that accepts image bytes at all is the separate, purpose-built evidence-frame upload route described next, which writes to its own dedicated storage layer, never to an `IntegrityEvent` row.

---

## Evidence Frames v1 (additive, opt-in)

**Off by default.** Evidence frames only exist for an exam where the lecturer/institution has explicitly enabled `captureAiViolationEvidence` (in addition to `enableAiCameraIntegrityChecks`) — see "Lecturer opt-in" above. Enabling it never retroactively applies to exams already taken, and existing exams are never silently opted in.

### What gets captured, and when

- **Only two event types trigger a capture in v1**: `POSSIBLE_PHONE_VISIBLE` and `POSSIBLE_SECOND_PERSON_VISIBLE` (`EVIDENCE_CAPTURE_EVENT_TYPES` in `src/lib/aiCameraEvidenceFrame.ts`). `NO_PERSON_VISIBLE`, `CAMERA_VIEW_BLOCKED`, `CAMERA_TOO_DARK`, and `AI_CAMERA_CHECK_UNAVAILABLE` never capture a frame in v1 — this is a deliberate scope limit, not an oversight, and any future addition needs its own explicit review.
- **One capture per backend-logged event, not per overlay redisplay.** Capture is wired into the SAME code path as backend integrity-event logging in `src/app/student/exams/[id]/page.tsx` — it only runs once the backend `POST /api/submissions/[id]/integrity-events` call has actually created (or returned) an event, and only fires again the next time that same 45-second backend cooldown allows a NEW event to be logged. The local overlay itself can reopen far more often (see "Local overlay vs. backend logging" above) — that reopening never triggers a new capture on its own.
- **A single still image, never a video.** One canvas draw from the existing hidden `detectionVideoRef` `<video>` element — the exact same source already used for on-device detection — at the moment the event is created. No new `getUserMedia()` call, and no `getDisplayMedia()`/screen-capture call anywhere in this feature.
- **Downscaled and re-encoded client-side** to at most 640×360 (preserving aspect ratio if smaller), as JPEG at ~0.6 quality, before upload — both to keep the file small and because re-encoding through canvas implicitly strips any embedded metadata from the original frame.
- **Never blocks anything.** The overlay is already showing (see the overlay-first design above) before capture even starts; upload happens after the backend event is created, never before, and a failed capture/upload never blocks the overlay, never blocks exam continuation, and is never retried indefinitely — at most a dev-only diagnostic log via `sesAiCameraDebug`.

### What this does NOT do

- **No video recording, no streaming** — a single still frame, captured once per qualifying event.
- **No screen or desktop capture** — only the webcam frame; the exam question content is never captured.
- **No facial recognition, no biometric template, no identity matching** — the frame is stored as an opaque image for a human to look at; nothing in this feature analyses, encodes, or compares faces.
- **Not proof of misconduct** — exactly like the text-only signal it accompanies, an evidence frame is a review aid for a human reviewer, worded and treated the same as every other AI camera signal in this document.

### Storage

`src/lib/evidenceStorage.ts` defines a small `EvidenceStorageAdapter` interface with:

- a fully-working `local_dev` adapter (plain filesystem under `.evidence-storage/` at the repo root — gitignored, never under `public/`, never served statically) for local development and tests;
- a fully-working `supabase_storage` adapter — a **private** Supabase Storage bucket, using `@supabase/supabase-js` with the server-only service role key (never exposed to the client; this module is never imported from client components). This is the recommended production provider, since this app already deploys on Vercel + Supabase. Requires `EVIDENCE_STORAGE_BUCKET`, `SUPABASE_URL` (or `NEXT_PUBLIC_SUPABASE_URL`), and `SUPABASE_SERVICE_ROLE_KEY` — see docs/deployment-vercel-supabase.md for bucket setup steps and the full env var list;
- clearly-stubbed `vercel_blob` / `s3` adapters that throw a descriptive `EvidenceStorageNotConfiguredError` until a real implementation (plus the provider's SDK) is added.

**`local_dev` storage must never be used in production** — Vercel serverless function instances do not share a persistent, writable filesystem across invocations, so a file written during one request would not reliably be readable from another. `resolveEvidenceStorageAdapter()` fails closed (throws) in production unless `EVIDENCE_STORAGE_PROVIDER` names a real, fully-configured provider — and `supabase_storage` itself fails closed if any of its three required env vars are missing, rather than guessing.

The `supabase_storage` adapter's `get()` downloads the object server-side and returns raw bytes to the caller — the already-authenticated `GET /api/integrity-evidence/[evidenceAssetId]` route below — rather than generating a signed URL. This keeps the "never send a storage reference to the browser" guarantee trivially true (there's no URL to leak) and means route code never needs to branch by provider.

Image bytes are never stored inline in the database. The `IntegrityEvidenceAsset` Prisma model (see "Production DDL" below) only holds a `storageKey` — an opaque pointer resolved server-side only, through `src/lib/evidenceStorage.ts` — and that key is never returned to any client, in any response, at any time. The key itself is a single flat folder, `ai-camera-evidence/{submissionId}-{integrityEventId}-{random}.{jpg|webp}` (`generateEvidenceFrameStorageKey()` in `src/lib/aiCameraEvidenceFrame.ts`) — built entirely from IDs the system already generates, never from a student's name or email, so even direct inspection of the Supabase Storage dashboard reveals nothing identity-linkable without cross-referencing the database. (An earlier version nested `institution/{id}/exam/{id}/submission/{id}/event/{id}/{random}.{ext}` as separate path segments; Supabase Storage rejected that with "Invalid path specified in request URL", so v1 uses this flatter format instead. `institutionId`/`examId` remain the source of truth for scoping — they're stored as columns on `IntegrityEvidenceAsset`, not encoded into the storage path.)

### Upload and access-control routes

1. `POST /api/submissions/[id]/integrity-events/[eventId]/evidence-frame` — student only, only for their own submission, only for an event that belongs to that submission and is one of the two eligible types, only when `captureAiViolationEvidence` is enabled for the exam. Validates content type (`image/jpeg` or `image/webp` only — rejects SVG, HTML, and anything else) and size (300 KB ceiling). One asset per event in v1, enforced by a database unique constraint on `integrityEventId`, not just application logic. Returns only `{ ok, evidenceAssetId }` — never a storage key.
2. `GET /api/integrity-evidence/[evidenceAssetId]` — the ONLY way to view a frame's bytes. Lecturer (owner of the exam) or `PLATFORM_ADMIN`, same institution — the same rule `buildEvidenceReport()` already enforces for the rest of a submission's evidence. A student can never reach this route. Every successful view is recorded to `PlatformAuditLog` (`action: "VIEW_AI_CAMERA_EVIDENCE_FRAME"`, actor, role, submission/exam ids, evidence asset id) — never the image itself.

### Retention

`IntegrityEvidenceAsset.capturedAt`/`createdAt` are recorded, and a per-institution retention window (suggested default: 30–90 days after the exam is finalized) is the intended policy — a scheduled deletion job is not implemented in v1 (no scheduler exists in this repo yet) but the schema supports it: deleting an `IntegrityEvidenceAsset` row (and its corresponding storage object via `EvidenceStorageAdapter.delete()`) is a well-defined, self-contained operation that a future scheduled job or manual admin action can perform without touching any other table. `onDelete: Cascade` from `Submission`/`Exam`/`IntegrityEvent` means evidence assets are also cleaned up automatically if any of those parent rows are ever deleted.

### Lecturer review UI

The evidence report page (`/lecturer/submissions/[id]/evidence`) shows an "Evidence frame available" badge and a "View evidence frame" button next to any event that has one; clicking it opens a modal that fetches the image via the authenticated `GET /api/integrity-evidence/[evidenceAssetId]` route (never a raw storage URL) and shows the event time, event type, and the same privacy note as everywhere else in this feature. Events with no captured frame render exactly as before — no visible change.

---

## Evidence report and risk scoring

The lecturer evidence report (`src/lib/evidenceReport.ts`) gained:

- A `confidenceBand` field on each event (from metadata, when present).
- A dedicated `aiCameraIntegritySummary` section: counts of possible-phone, possible-second-person, no-person, and blocked/dark events, plus the disclaimer *"AI camera signals are indicators for review. They are not automatic misconduct decisions."* Rendered as its own "AI-assisted camera integrity signals" section on the evidence page, and included in the CSV export.
- Each event in `EvidenceReport.events` now also carries its own `id` and an `evidenceAssetId` (`null` unless a frame was actually captured for that specific event) — this is what drives the "Evidence frame available" badge described in "Evidence Frames v1" above. Never the image itself, never a storage key — just the id needed to call `GET /api/integrity-evidence/[evidenceAssetId]`.

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

Generate/verify the exact statements via `prisma migrate diff` before applying, per the existing production-DDL pattern in `docs/network-evidence-and-ip-location.md`. No `prisma db push` against production. `requireStudentVerification`/`enableAiCameraIntegrityChecks`/`captureAiViolationEvidence` all live in the existing `Exam.secureSettings` JSON column — no schema change needed for the settings themselves.

**Evidence Frames v1 additionally requires a new table**, `IntegrityEvidenceAsset` — additive only, no existing table/column/enum changed or removed. The full `CREATE TABLE`/index/foreign-key statements plus post-migration verification queries are in `docs/evidence-frame-migration.sql`, generated the same way (`npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script`, hand-extracted to just this table). Apply via the Supabase SQL Editor; do not `prisma db push` against production.

**Set `EVIDENCE_STORAGE_PROVIDER` in production before enabling `captureAiViolationEvidence` for any real exam** — see "Storage" under "Evidence Frames v1" above and docs/deployment-vercel-supabase.md. There is no working production storage provider wired up in this codebase yet; only local filesystem storage for development, which must never be used in production.
