# Phone Detection Calibration v1

Strengthens on-device mobile-phone detection for angled, low-position,
edge-of-frame and partially visible phones, without simply lowering the
existing global confidence threshold. See
docs/on-device-ai-integrity-detection-v1.md for the surrounding camera
integrity feature this composes with, and
docs/secure-exam-threat-model.md for how this fits the overall threat
model.

## Why not just lower the threshold

A single global confidence threshold cannot distinguish "an angled phone
near the bottom edge of the frame" from "a calculator, hand, dark book, or
keyboard" — both often score in a similar mid-confidence range from a
single full-frame detector pass. Lowering the threshold to catch the
former inevitably catches more of the latter too. Instead, this feature
adds **recall through multiple independent signals** — a second, zoomed-in
look at likely regions; persistence across several ticks; spatial
consistency; and a second-stage local re-check — and only turns a
candidate into a warning once enough of those signals agree, per the
decision model below.

```text
Strong candidate    → high confidence, spatially consistent → confirm quickly
Moderate candidate  → lower confidence, persists across several frames → confirm after temporal verification
Weak/unstable       → do not warn, keep observing
```

## Current detector (unchanged)

- **Model/library:** TensorFlow.js + COCO-SSD (`@tensorflow-models/coco-ssd`, `lite_mobilenet_v2` base) — see `src/lib/cameraObjectDetector.ts`. Not replaced or retrained; this feature adds a second, targeted *use* of the same model (extra crops + a verification pass), not a new model.
- **Phone class:** COCO-SSD's `"cell phone"` label (the matcher also accepts `"mobile phone"`/`"phone"` for robustness, though the model itself only ever emits `"cell phone"`).
- **Existing global threshold:** `PHONE_CONFIDENCE_THRESHOLD = 0.45` (`src/lib/cameraIntegrityDetection.ts`) — **left unchanged**. The original single-frame, instant-confirm path (`evaluatePhoneDetections`/`decidePhoneEmission`) still exists and is still exercised for debug logging, but the student exam page's live emission decision for `POSSIBLE_PHONE_VISIBLE` now comes from the candidate tracker described below, which is a strict superset of the old behaviour (an obvious full-frame phone still confirms on the very next tick — see "Strong candidate" below) plus new recall for weaker signals.
- **Inference cadence:** unchanged adaptive 1000ms/1500ms self-scheduling tick (`computeNextDetectionDelayMs`).
- **Non-maximum suppression:** performed internally by the COCO-SSD/TF Object Detection API model on each individual inference call; this feature adds its own application-level merge (`dedupeObservations`, IoU ≥ 0.3) **across sources** (full frame + crops), which the model has no way to do on its own since it never sees more than one image at a time.

## Multi-scale analysis (Part 3/4)

`src/lib/phoneMultiScaleCrops.ts` defines a small, fixed set of overlapping
regions (`PHONE_CROP_REGIONS`): `lower_half`, `lower_left`, `lower_center`,
`lower_right`, `left_edge`, `right_edge`. Full-frame detection still runs
every tick; `computeCropSchedule(tickIndex)` adds 1-2 crops on a rotating
3-tick cycle (never every crop every tick). Each crop is redrawn onto an
offscreen canvas at **300×300** — the same scale COCO-SSD's own model
input uses — before a second `detector.detect()` call, so a phone that
would occupy only a handful of pixels after the whole frame is downscaled
instead occupies a meaningful fraction of the crop. Crop-local detections
are mapped back into normalized ORIGINAL-frame coordinates
(`mapCropDetectionToOriginalFrame`) before being merged with full-frame
detections.

## Confidence bands (Part 5)

`src/lib/phoneDetectionTracking.ts`:

```ts
PHONE_CONFIDENCE_STRONG = 0.65
PHONE_CONFIDENCE_MODERATE = 0.32
PHONE_CONFIDENCE_WEAK = 0.18
```

These are starting points calibrated against the *existing* single
threshold (0.45) already shipping in this repo, not the result of a
labelled evaluation run (see "Known limitations" below) — STRONG sits
comfortably above it (unambiguous phones keep confirming instantly, no
regression), MODERATE starts below it (the new recall this feature adds),
WEAK is the floor below which a detection isn't even retained as an
observation. Named, versioned constants (`PHONE_DETECTION_ALGORITHM_VERSION`)
in a pure module — never hardcoded in the React component.

## Temporal candidate tracking (Part 6/7)

`PhoneCandidateTracker` (a plain class, no DOM/React dependency, same
shape as the existing `DetectionCooldownTracker`) matches each tick's
detections to existing "candidates" by bounding-box IoU and centre
distance, updates a rolling 5-tick eligibility window per candidate, and
decides confirmation:

- **Strong:** confirms on the very first observation (mirrors the old
  instant-confirm behaviour for a clear phone).
- **Moderate:** confirms once observed in at least 3 of the last 5
  eligible ticks (spatial consistency is inherent — a new observation only
  updates a track if it's close enough in position/size to be the "same"
  candidate).
- **Weak:** never confirms alone, but doesn't retroactively un-confirm an
  already-confirmed track either.

One missed frame does not drop a candidate; it expires after
`TRACK_MAX_MISSED_FRAMES` (3) consecutive misses (hysteresis — quick
activation, slower recovery, no flicker). A camera restart
(`teardownCameraStream` in the student exam page) calls
`PhoneCandidateTracker.reset()` unconditionally, clearing every track —
generation changes never carry a stale candidate into a new stream.

## Edge and partial-object handling (Part 8)

`touchesFrameEdge()` flags (does not reject) a candidate near any frame
edge; `visibleAreaEstimate()` accounts for a crop-mapped box that extends
past the visible frame. An edge-touching MODERATE candidate needs one
additional confirming observation (`TRACK_CONFIRM_MODERATE_EDGE_COUNT`,
4 instead of 3) before it warns — a stable phone held low near the bottom
edge still confirms, just slightly more cautiously than one fully inside
the frame. A STRONG edge candidate still confirms immediately, same as
anywhere else in the frame.

## Plausibility checks (Part 9)

`isPlausiblePhoneGeometry()` rejects only geometric nonsense — a
degenerate box, one far smaller or larger than a hand-held phone at
typical exam-camera distance, or an extreme aspect-ratio sliver. It makes
no assumption about phone *shape* (portrait, landscape, tilted, cased, or
side-on are all accepted) — geometry is a noise filter, never a
confirmation signal on its own.

## Second-stage verification (Part 10)

For a MODERATE candidate, `expandCandidateBoxForVerification()` grows its
box with surrounding context, the student exam page crops+rescales that
region from the live video, and reruns the **existing** on-device detector
on it (no second model). `PhoneCandidateTracker.applyVerification()`
either raises the candidate to STRONG (if a phone-class detection appears
in the expanded crop) or demotes it (if not) — never an irreversible
single-frame decision; the tracker's normal temporal rules still apply
either way. Bounded to `MAX_VERIFICATION_ATTEMPTS_PER_TICK` (1) candidate
per tick.

## False-positive controls (Part 11)

- Plausibility geometry (above) rejects wildly implausible shapes
  (calculators, mice, remotes, wallets tend to be smaller/differently
  proportioned than the accepted range, though this is a coarse filter,
  not an object classifier).
- MODERATE candidates require either temporal persistence (3-of-5) or a
  positive second-stage verification — a single ambiguous frame from a
  hand, dark book, or glasses case never alone produces a warning.
- STRONG-band false positives (an object confidently classified as
  `"cell phone"` by COCO-SSD itself) are a model-accuracy question this
  feature cannot fully solve without retraining/replacing the model — see
  "Known limitations."
- If an institution permits calculator use under exam policy, this
  feature does **not** lower the visual threshold for that exam — a
  permitted calculator that is genuinely misclassified may still produce
  a review signal (labelled "Possible phone visible," never "confirmed"),
  exactly as intended: the lecturer's review workflow, not the detector,
  is where "permitted calculator" context gets applied.

## Detection evidence tiers (Part 12)

```text
OBSERVED_CANDIDATE       — internal only, no warning, no backend event, no evidence frame
CONFIRMED_LOCAL_WARNING  — temporal/spatial rules satisfied, "Possible phone visible" shown locally
BACKEND_REVIEW_EVENT     — confirmation persisted past the existing 45s cooldown, backend event created
EVIDENCE_FRAME_ELIGIBLE  — backend event accepted AND evidence capture enabled AND generation still valid AND candidate still present
```

`phoneEvidenceTier()` in `phoneDetectionTracking.ts` derives this purely
for diagnostics/logging. The actual evidence-frame upload gate is
unchanged — `shouldAttemptEvidenceUpload`/`shouldCaptureEvidenceFrame` in
`src/lib/aiCameraEvidenceFrame.ts` (not modified by this feature) already
enforce "only after a backend-accepted event, only if the lecturer
explicitly enabled capture."

## Safe metadata (Part 13)

`POSSIBLE_PHONE_VISIBLE` events now additionally carry: `algorithmVersion`,
`confirmingObservationCount`, `observationWindowLength`, `detectionSource`
(`full_frame`/`lower_crop`/`edge_crop`/`verification_crop`), `edgeContact`
(boolean), and a normalized `boundingBox` (`{x,y,width,height}`, rounded to
3 decimal places — a coarse location, never pixel data). Metadata keys
deliberately avoid the substring `"frame"` in anything that isn't the
existing `detectionSource` enum value, matching the server's
`FORBIDDEN_METADATA_KEY_PATTERN` check in
`src/app/api/submissions/[id]/integrity-events/route.ts` (unchanged) —
e.g. `confirmingObservationCount`/`edgeContact`, not
`confirmationFrameCount`/`touchesFrameEdge`. No raw image data, tensor, or
biometric information is ever included, mirroring
`assertSafeIntegrityMetadata` in `src/lib/cameraIntegrityDetection.ts`.

## Performance controls (Part 14)

- `MAX_CROP_INFERENCES_PER_WINDOW` (6 per `CROP_INFERENCE_WINDOW_MS`,
  5000ms) — a hard ceiling on crop+verification inference calls,
  independent of how many candidates are active; `withinCropInferenceBudget`/
  `prunedCropInferenceTimestamps` enforce it. When exhausted, the current
  tick simply skips remaining scheduled crops and continues with
  whatever it already has — never blocks or delays the tick.
- `MAX_ACTIVE_PHONE_TRACKS` (6) — `PhoneCandidateTracker.update()` prunes
  the lowest-priority tracks (unconfirmed first, then lowest score) if
  this is ever exceeded.
- `MAX_VERIFICATION_ATTEMPTS_PER_TICK` (1) — at most one second-stage
  verification crop per tick regardless of how many moderate candidates
  exist simultaneously.
- Detection (including all of the above) is fully paused whenever the
  camera isn't armed (`suppressStartup`, unchanged from the existing
  startup-suppression gate) — no crop or verification inference ever runs
  before the camera is ready.
- The detection tick loop remains self-scheduling (never overlapping —
  the next tick is only scheduled once the current one, crops and all,
  fully resolves), so a slow device naturally falls back toward
  full-frame-only cadence rather than stacking up concurrent inference
  calls.

No new performance measurement harness (frame timers dumped to a report)
was added beyond the existing `inferenceMs`/`cadenceMs` debug fields —
see "Known limitations."

## Debug diagnostics (Part 15)

`localStorage.setItem("sesAiCameraDebug", "true")` (existing, unchanged
gate — `shouldLogAiCameraDebug`) now additionally logs, via
`logAiCameraDebug`: observation count, active track count, the best
track's band/score/source/edge-contact, the derived evidence tier, and
(on a verification attempt) the track id and raised/lowered outcome.
Never logs image, frame, or pixel data — only the same class of numeric/
categorical fields the existing debug logging already used. No dev-only
bounding-box visualization overlay was added in v1 — see "Known
limitations."

## Test-fixture requirements and evaluation (Part 16/17/21)

**Pure/unit tests** (`src/lib/phoneDetectionTracking.test.ts`,
`src/lib/phoneMultiScaleCrops.test.ts`) cover confidence bands, geometry/
plausibility, IoU/merge, temporal confirmation (strong/moderate/weak,
3-of-5, spatial consistency), miss tolerance and expiry, edge-candidate
stricter confirmation, second-stage verification raising/lowering a
candidate, generation reset, evidence-tier derivation, crop scheduling,
coordinate mapping, and the performance budget helpers.

**What was NOT run, and must not be claimed as validated:** this
environment has no physical webcam, no labelled fixture image set, and no
browser automation harness capable of driving `getUserMedia()` with real
video. Per the task's own instruction ("do not claim improved accuracy
without running labelled fixture tests or a documented browser test
matrix"), **no computer-vision accuracy claim is made here** — the pure
tests above verify the *decision logic* (given a score/box, does the
right thing happen), not real-world detection accuracy on genuine angled/
partial/low-light phones vs. genuine calculators/hands/books. A
`test-fixtures/camera-integrity/{phone-positive,phone-negative}/`
directory structure as suggested by the task was not created in this
session — doing so meaningfully requires consented/synthetic image
capture this environment cannot produce. Real calibration of
`PHONE_CONFIDENCE_STRONG`/`MODERATE`/`WEAK` and the crop regions against
actual hardware/lighting requires running with `sesAiCameraDebug` enabled
against a real camera and real test objects (phone at various angles/
positions, plus calculator/hand/keyboard/book negatives), and adjusting
the named constants in `phoneDetectionTracking.ts` from those
observations — this is expected follow-up work, not something this
session could complete.

## Known limitations

- No guarantee of zero false positives or zero missed detections — this
  was an explicit non-goal of the task. The system trades some recall on
  briefly-glimpsed phones (a MODERATE candidate that disappears before
  reaching 3-of-5 observations, or before a verification pass runs, never
  warns) for materially fewer false alarms on calculators/hands/books than
  a blanket threshold-lowering would produce.
- STRONG-band detections still confirm on a single frame — a model
  misclassification at ≥0.65 confidence (rare, but possible for a dark,
  rectangular, phone-proportioned object) is not caught by this feature's
  temporal/spatial safeguards, since those only apply to MODERATE
  candidates. This mirrors the previous behaviour for the old
  single-threshold path and was a deliberate choice to avoid slowing down
  genuine urgent detections.
- The confidence-band boundaries (0.65/0.32/0.18) and crop regions are
  principled starting points, not the output of a labelled evaluation —
  see "Test-fixture requirements" above.
- No dev-only bounding-box visualization overlay was implemented.
- No dedicated frame-timing performance report (average full-frame vs.
  crop inference time, dropped-cycle count) was added — only the existing
  per-tick `inferenceMs`/`cadenceMs` debug fields.
- Calculator/hand/book/keyboard/remote/glasses-case/tablet-edge/laptop-
  corner/dark-clothing negative testing (Part 11) was reasoned about via
  the plausibility-geometry design, not verified against real footage of
  those objects.

## Wording

The local overlay and backend event both continue to say **"Possible
phone visible"** (never "Phone confirmed," "Student used a phone," or
"Cheating detected") — this feature changes *when* that signal fires, not
its wording or its status as a review signal rather than a finding of
fact.

## No third-party camera API

All of the above — full-frame detection, crop analysis, second-stage
verification — runs the same on-device `@tensorflow-models/coco-ssd`
model already shipped in this repo, entirely in the student's browser. No
frame, crop, or verification image is ever sent to Anthropic, OpenAI,
Microsoft, or any other external service; nothing here changes that.
