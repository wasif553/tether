/**
 * Optional Student Verification + On-Device AI Camera Integrity
 * Detection v1 — see docs/on-device-ai-integrity-detection-v1.md.
 *
 * Pure, dependency-free helpers so the timing/cooldown/classification
 * logic can be unit tested without a browser, a camera, or a loaded ML
 * model. Nothing in this file touches image pixels directly beyond
 * simple numeric aggregates (average luminance, variance) computed by
 * the caller from a canvas `ImageData` — no image, frame, or pixel
 * buffer is ever returned, logged, or persisted by anything here.
 *
 * This is NOT live proctoring: nothing here transmits video anywhere.
 */

export type ConfidenceBand = "low" | "medium" | "high";

/** Buckets a raw 0-1 confidence score into a coarse band for display/metadata. */
export function bandForConfidence(confidence: number): ConfidenceBand {
  if (confidence >= 0.85) return "high";
  if (confidence >= 0.65) return "medium";
  return "low";
}

/**
 * Computes average luminance and variance from raw RGBA pixel data (as
 * returned by canvas `ImageData.data`). Pure numeric math — takes a
 * plain typed array, never a canvas/video element — so it is testable
 * in Node without jsdom and never itself retains or returns the pixel
 * buffer. Samples every 4th pixel (configurable stride) for speed;
 * exact enough for coarse "blocked/dark" classification, not for any
 * image analysis beyond that.
 */
export function computeLuminanceVariance(
  data: Uint8ClampedArray | number[],
  stride = 4,
): { avgLuminance: number; variance: number } {
  const pixelStep = 4 * Math.max(1, stride);
  const luminances: number[] = [];
  for (let i = 0; i < data.length; i += pixelStep) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (r === undefined || g === undefined || b === undefined) break;
    luminances.push(0.299 * r + 0.587 * g + 0.114 * b);
  }
  if (luminances.length === 0) return { avgLuminance: 0, variance: 0 };
  const avg = luminances.reduce((a, b) => a + b, 0) / luminances.length;
  const variance = luminances.reduce((a, l) => a + (l - avg) ** 2, 0) / luminances.length;
  return { avgLuminance: avg, variance };
}

export type FrameQuality = "ok" | "blocked" | "dark";

export type FrameQualityThresholds = {
  /** Below this average luminance (0-255), the frame is considered too dark. */
  darkLuminance: number;
  /** Below this pixel variance, the frame is considered flat/blocked (e.g. a covered lens). */
  blockedVariance: number;
};

export const DEFAULT_FRAME_QUALITY_THRESHOLDS: FrameQualityThresholds = {
  darkLuminance: 25,
  blockedVariance: 15,
};

/**
 * Classifies a frame from simple luminance/variance aggregates (computed
 * by the caller from canvas ImageData — see readFrameLuminanceVariance
 * in the client-only module). A near-uniform frame (very low variance)
 * is treated as "blocked" even if not fully dark, since a covered lens
 * often still lets some light through; darkness is checked afterward.
 */
export function classifyFrameQuality(
  avgLuminance: number,
  variance: number,
  thresholds: FrameQualityThresholds = DEFAULT_FRAME_QUALITY_THRESHOLDS,
): FrameQuality {
  if (variance < thresholds.blockedVariance) return "blocked";
  if (avgLuminance < thresholds.darkLuminance) return "dark";
  return "ok";
}

/**
 * Tracks per-event-type cooldowns and consecutive-detection counters in
 * plain objects (no DOM/React dependency) so it can be driven from a
 * ref in a client component and unit tested in isolation.
 */
export class DetectionCooldownTracker {
  private lastEmittedAt: Partial<Record<string, number>> = {};
  private consecutiveCounts: Partial<Record<string, number>> = {};
  private streakStartedAt: Partial<Record<string, number>> = {};

  /**
   * Increments (or resets) a consecutive-detection counter for a signal
   * that occurred this check. `nowMs`, when supplied, also tracks when
   * the CURRENT streak began, so callers can additionally require a
   * minimum sustained duration (see MIN_NO_PERSON_SUSTAINED_DURATION_MS
   * below) — not just a minimum tick count, which is sensitive to the
   * adaptive detection cadence.
   */
  recordObservation(key: string, observedThisCheck: boolean, nowMs?: number): number {
    const next = observedThisCheck ? (this.consecutiveCounts[key] ?? 0) + 1 : 0;
    this.consecutiveCounts[key] = next;
    if (!observedThisCheck) {
      delete this.streakStartedAt[key];
    } else if (next === 1 && nowMs != null) {
      this.streakStartedAt[key] = nowMs;
    }
    return next;
  }

  getConsecutiveCount(key: string): number {
    return this.consecutiveCounts[key] ?? 0;
  }

  /** How long (ms) the current streak for `key` has been running, or 0 if there is no active streak or no start time was ever recorded for it. */
  getStreakDurationMs(key: string, nowMs: number): number {
    const startedAt = this.streakStartedAt[key];
    if (startedAt == null) return 0;
    return Math.max(0, nowMs - startedAt);
  }

  /** True if `cooldownMs` has elapsed since the last time this key was emitted (or it was never emitted). */
  canEmit(key: string, nowMs: number, cooldownMs: number): boolean {
    const last = this.lastEmittedAt[key];
    if (last == null) return true;
    return nowMs - last >= cooldownMs;
  }

  markEmitted(key: string, nowMs: number): void {
    this.lastEmittedAt[key] = nowMs;
  }

  reset(): void {
    this.lastEmittedAt = {};
    this.consecutiveCounts = {};
    this.streakStartedAt = {};
  }
}

/**
 * Gate for the dev-only, opt-in AI camera diagnostic logging (see
 * docs/on-device-ai-integrity-detection-v1.md). Pure so it's testable
 * without a browser: BOTH the environment must be "development" AND the
 * caller must have explicitly set `localStorage.sesAiCameraDebug` to the
 * exact string "true" — being in development mode alone is never enough,
 * and this must always be false when `nodeEnv` is "production" regardless
 * of the flag value.
 */
export function shouldLogAiCameraDebug(
  nodeEnv: string | undefined,
  debugFlagValue: string | null | undefined,
): boolean {
  if (nodeEnv !== "development") return false;
  return debugFlagValue === "true";
}

/**
 * Physical acceptance follow-up — phone-detection calibration
 * observability. Gate for whether a CONFIRMED phone-detection event's
 * backend report should include the bounded calibration summary (see
 * buildPhoneCalibrationEventSummary in phoneDetectionTracking.ts).
 * Deliberately SEPARATE from shouldLogAiCameraDebug above, which
 * hard-disables outside `development` and requires a localStorage flag a
 * packaged production build cannot use: a physical test runs against a
 * genuine production-mode Tether build, so a gate that excludes
 * production would make this unusable for exactly the environment it
 * exists to diagnose. Off by default everywhere (an unset/non-"true"
 * value never attaches the summary) and must be deliberately set
 * (`NEXT_PUBLIC_TETHER_PHONE_CALIBRATION_ENABLED` — a client-side,
 * build-time flag, since this decision is made in the browser where the
 * calibration data itself is already computed) for a bounded test
 * window, in ANY environment including production. Reading the flag's
 * value and threading it to the one call site that attaches calibration
 * metadata is the caller's responsibility; this function only decides
 * the boolean. Never alters detection decisions, cadence, evidence
 * generation, or event emission — see this module's own decide*
 * functions, none of which take this flag as an input.
 */
export function isPhoneCalibrationEnabled(envFlag: string | undefined): boolean {
  return envFlag === "true";
}

export type AdaptiveCadenceConfig = {
  /** Delay used when the previous tick's inference was fast (or hasn't run yet). */
  fastIntervalMs: number;
  /** Delay used when the previous tick's inference was slow, to avoid hammering a struggling CPU. */
  slowIntervalMs: number;
  /** Inference time (ms) above which the next tick backs off to `slowIntervalMs`. */
  slowInferenceThresholdMs: number;
};

/**
 * Fast enough that a briefly-shown phone is very likely caught on the
 * very next tick (phone no longer waits for consecutive frames — see
 * decidePhoneEmission), while still backing off automatically on
 * hardware where inference itself is taking most of the budget.
 */
export const DEFAULT_ADAPTIVE_CADENCE_CONFIG: AdaptiveCadenceConfig = {
  fastIntervalMs: 1_000,
  slowIntervalMs: 1_500,
  slowInferenceThresholdMs: 900,
};

/**
 * Chooses the delay before the next detection tick from how long the
 * previous tick's inference took. The detection loop remains
 * self-scheduling/non-overlapping regardless of which delay is chosen
 * (the caller only schedules the next tick after this one fully
 * resolves) — this only changes how long that gap is. `inferenceMs:
 * null` (no inference has run yet, or the model isn't loaded / the tick
 * short-circuited before inference) always resolves to the fast
 * interval, so the first tick and any quality-only tick stay prompt.
 */
export function computeNextDetectionDelayMs(
  inferenceMs: number | null,
  config: AdaptiveCadenceConfig = DEFAULT_ADAPTIVE_CADENCE_CONFIG,
): number {
  if (inferenceMs == null) return config.fastIntervalMs;
  return inferenceMs > config.slowInferenceThresholdMs ? config.slowIntervalMs : config.fastIntervalMs;
}

/**
 * `bbox` is `[x, y, width, height]` in PIXEL coordinates of whatever
 * source element/canvas was actually passed to `detect()` — optional
 * because not every caller needs it (the existing quality/person checks
 * never used it), but required for the multi-scale phone tracking in
 * phoneDetectionTracking.ts / phoneMultiScaleCrops.ts, which converts it
 * to normalized original-frame coordinates via `pixelBoxToNormalized`.
 */
export type DetectedObject = { className: string; score: number; bbox?: [number, number, number, number] };

export type PhoneDetectionResult = { detected: boolean; confidence: number };

/**
 * Default phone-class confidence threshold. Deliberately lower than the
 * person threshold (0.6): a phone is the highest-urgency signal (a
 * student can photograph a question and hide the phone again within a
 * couple of seconds), so this trades a somewhat higher false-positive
 * rate for materially lower miss risk. If real-hardware testing (via
 * `sesAiCameraDebug`) shows too many false positives, raise toward 0.5 —
 * avoid going much below 0.4, which invites noisy false positives from
 * unrelated small dark rectangular objects (e.g. remotes, wallets).
 */
export const PHONE_CONFIDENCE_THRESHOLD = 0.45;

/** Highest-confidence phone-like detection at or above `minConfidence`, or not detected. */
export function evaluatePhoneDetections(
  detections: DetectedObject[],
  minConfidence = PHONE_CONFIDENCE_THRESHOLD,
): PhoneDetectionResult {
  const phoneClasses = new Set(["cell phone", "mobile phone", "phone"]);
  const matches = detections.filter(
    (d) => phoneClasses.has(d.className.toLowerCase().trim()) && d.score >= minConfidence,
  );
  if (matches.length === 0) return { detected: false, confidence: 0 };
  const best = matches.reduce((max, d) => (d.score > max.score ? d : max), matches[0]);
  return { detected: true, confidence: best.score };
}

export type PhoneEmissionDecision = {
  /**
   * Whether the phone detection rule itself is satisfied this tick —
   * independent of the backend-logging cooldown. This is what should
   * drive the LOCAL overlay (see shouldShowLocalAiOverlay /
   * src/lib/aiCameraViolationOverlay.ts): a phone that's still visible
   * keeps this true tick after tick, even while `shouldEmit` below is
   * suppressed by cooldown.
   */
  conditionMet: boolean;
  /** Whether this tick should send a NEW backend integrity event: conditionMet AND the cooldown has elapsed. */
  shouldEmit: boolean;
  confidenceBand: ConfidenceBand | null;
};

/**
 * Phone is the urgent exception to the consecutive-frame policy used by
 * second-person/no-person: unlike those signals, it emits on the very
 * first qualifying "cell phone" detection — no waiting for a second
 * consecutive tick — because a student may show a phone only briefly
 * (e.g. to photograph a question) and hide it again before a second
 * check would run. The existing cooldown still applies to backend
 * logging, so a phone that stays visible does not flood the evidence
 * timeline with repeat events — but see `conditionMet` above for what
 * should still drive the local overlay regardless of that cooldown.
 */
export function decidePhoneEmission(
  phone: PhoneDetectionResult,
  cooldownOk: boolean,
): PhoneEmissionDecision {
  const conditionMet = phone.detected;
  const shouldEmit = conditionMet && cooldownOk;
  return { conditionMet, shouldEmit, confidenceBand: shouldEmit ? bandForConfidence(phone.confidence) : null };
}

export type PersonDetectionResult = {
  personCount: number;
  noPersonDetected: boolean;
  multiplePersons: boolean;
  multiplePersonsHighConfidence: boolean;
  /**
   * Highest raw person-class confidence score among ALL person-class
   * detections this tick, regardless of `minConfidence` — 0 when there
   * is no person-class detection at all. Used by decideNoPersonEmission
   * (Part 4 low-light/false-positive fix) to distinguish "genuinely no
   * one there" from "the detector is uncertain" (a near-threshold
   * score), which must never be reported as confirmed absence.
   */
  bestPersonScore: number;
};

/** Counts person-class detections at or above `minConfidence`, and separately at or above `highConfidence`. */
export function evaluatePersonDetections(
  detections: DetectedObject[],
  minConfidence = 0.6,
  highConfidence = 0.75,
): PersonDetectionResult {
  const personDetections = detections.filter((d) => d.className.toLowerCase() === "person");
  const atMinConfidence = personDetections.filter((d) => d.score >= minConfidence);
  const personCount = atMinConfidence.length;
  const highConfidenceCount = atMinConfidence.filter((d) => d.score >= highConfidence).length;
  const bestPersonScore = personDetections.reduce((max, d) => Math.max(max, d.score), 0);
  return {
    personCount,
    noPersonDetected: personCount === 0,
    multiplePersons: personCount >= 2,
    multiplePersonsHighConfidence: highConfidenceCount >= 2,
    bestPersonScore,
  };
}

export type SecondPersonEmissionDecision = {
  /**
   * Whether the second-person confirmation rule (high-confidence
   * immediate, or normal-confidence + 2 consecutive ticks) is satisfied
   * this tick — independent of the backend-logging cooldown. Drives the
   * local overlay (see shouldShowLocalAiOverlay below).
   */
  conditionMet: boolean;
  /** Whether this tick should send a NEW backend integrity event: conditionMet AND the cooldown has elapsed. */
  shouldEmit: boolean;
  confidenceBand: "high" | "medium" | null;
};

/**
 * Decision function for whether POSSIBLE_SECOND_PERSON_VISIBLE should emit:
 * - High confidence (both persons ≥0.75): emit immediately (no consecutive-check wait)
 * - Normal confidence (0.60-0.75): require 2 consecutive ticks (guard against fleeting misclassification)
 * - `shouldEmit` additionally respects the 45s cooldown to prevent backend flooding;
 *   `conditionMet` does not, so it can keep driving the local overlay while cooldown is active.
 */
export function decideSecondPersonEmission(
  person: PersonDetectionResult,
  consecutiveCount: number,
  cooldownOk: boolean,
): SecondPersonEmissionDecision {
  const highConfidenceMet = person.multiplePersonsHighConfidence;
  const normalConfidenceMet = person.multiplePersons && consecutiveCount >= 2;
  const conditionMet = highConfidenceMet || normalConfidenceMet;
  const shouldEmit = conditionMet && cooldownOk;
  const confidenceBand: "high" | "medium" | null = !shouldEmit ? null : highConfidenceMet ? "high" : "medium";
  return { conditionMet, shouldEmit, confidenceBand };
}

/**
 * Face-visibility false-positive fix (Part 4): a person-class score in
 * this band means the detector saw SOMETHING person-shaped but isn't
 * confident — this must be reported as "temporarily uncertain," never
 * as confirmed absence. Below this band (near-zero score, or no
 * person-class detection at all) is treated as genuine absence, not
 * uncertainty.
 */
export const UNCERTAIN_PERSON_CONFIDENCE_LOWER_BOUND = 0.4;

/**
 * NO_PERSON_VISIBLE must additionally hold for at least this long (not
 * just a fixed tick count, which is sensitive to the adaptive detection
 * cadence — see computeNextDetectionDelayMs) before being confirmed.
 * With the default ~1-1.5s cadence, 3 consecutive ticks already implies
 * roughly this much elapsed time in the common case; this is an
 * explicit floor independent of cadence drift.
 */
export const MIN_NO_PERSON_SUSTAINED_DURATION_MS = 3_000;

/** Minimum consecutive usable frames (not merely elapsed time) required before a sustained absence is confirmed — see decideNoPersonEmission and resolveCameraIntegrityState below. Named/exported so the "multiple consecutive usable frames" requirement is explicit and documented, not a bare literal. */
export const NO_PERSON_MIN_CONSECUTIVE_TICKS = 3;

/**
 * Distinguishes WHY the no-person condition is (or is not) currently
 * met — separates "adequate image + sustained face absent" from
 * "insufficient lighting" and "detector uncertain" (Part 4). Never
 * null when a reason exists; only CONFIRMED drives NO_PERSON_VISIBLE.
 */
export type CameraVisibilityQualifier = "CONFIRMED" | "LIGHTING_INSUFFICIENT" | "UNCERTAIN";

/**
 * Exact required neutral, non-accusatory copy per qualifier (Part 4).
 * LIGHTING_INSUFFICIENT/CONFIRMED are shown via the existing
 * CAMERA_TOO_DARK/NO_PERSON_VISIBLE overlay+toast paths (see page.tsx
 * MESSAGES and aiCameraViolationOverlay.ts); UNCERTAIN is deliberately
 * NOT wired into the blocking violation overlay (never automatically
 * accuse on a merely-ambiguous reading) — exported here so the copy is
 * defined once and available to any lightweight, non-blocking status
 * indicator that surfaces it.
 */
export const NEUTRAL_CAMERA_VISIBILITY_MESSAGES: Record<CameraVisibilityQualifier, string> = {
  LIGHTING_INSUFFICIENT: "Lighting is too low to verify camera visibility.",
  UNCERTAIN: "Camera visibility is temporarily uncertain.",
  CONFIRMED: "Face not visible for a sustained period.",
};

export type NoPersonEmissionDecision = {
  /** Whether the no-person confirmation rule (adequate lighting + confident absence + sustained duration/tick count) is satisfied — independent of cooldown. */
  conditionMet: boolean;
  /** Whether this tick should send a NEW backend integrity event: conditionMet AND the cooldown has elapsed. */
  shouldEmit: boolean;
  /** Why conditionMet is (or isn't) true this tick — null only when the streak simply hasn't been sustained long/consistently enough yet, with no other qualifying reason. */
  qualifier: CameraVisibilityQualifier | null;
};

/**
 * NO_PERSON_VISIBLE (Part 4 fix — corrective pass v1.2.0): a dark or
 * blocked frame can no longer itself produce "No student visible
 * appears" — CAMERA_TOO_DARK/CAMERA_VIEW_BLOCKED already report that
 * separately (see classifyFrameQuality/decideFrameQualityEmission) and
 * this function now defers to them instead of racing them. A
 * near-threshold ("uncertain") person-class score is reported neither
 * as visible nor as confirmed-absent. Both LIGHTING_INSUFFICIENT and
 * UNCERTAIN ticks freeze (never increment or reset) the no-person
 * streak — the caller achieves this by not calling
 * DetectionCooldownTracker.recordObservation for a frozen tick and
 * instead reading getConsecutiveCount/getStreakDurationMs directly
 * (hysteresis). CONFIRMED additionally requires BOTH ≥3 consecutive
 * ticks AND ≥MIN_NO_PERSON_SUSTAINED_DURATION_MS elapsed.
 */
export function decideNoPersonEmission(
  person: PersonDetectionResult,
  frameQuality: FrameQuality,
  consecutiveCount: number,
  streakDurationMs: number,
  cooldownOk: boolean,
): NoPersonEmissionDecision {
  if (frameQuality !== "ok") {
    return { conditionMet: false, shouldEmit: false, qualifier: "LIGHTING_INSUFFICIENT" };
  }
  if (person.noPersonDetected && person.bestPersonScore >= UNCERTAIN_PERSON_CONFIDENCE_LOWER_BOUND) {
    return { conditionMet: false, shouldEmit: false, qualifier: "UNCERTAIN" };
  }
  const conditionMet =
    person.noPersonDetected && consecutiveCount >= NO_PERSON_MIN_CONSECUTIVE_TICKS && streakDurationMs >= MIN_NO_PERSON_SUSTAINED_DURATION_MS;
  return { conditionMet, shouldEmit: conditionMet && cooldownOk, qualifier: conditionMet ? "CONFIRMED" : null };
}

export type VisibilityRestoredDecision = { shouldEmit: boolean };

/**
 * The "stable recovery event" (Part 4) — mirrors the
 * DISPLAY_POLICY_RESTORED / SCREEN_SHARE_RESTORED pattern already used
 * elsewhere in this codebase: fired once when a genuinely CONFIRMED
 * no-person episode resolves back to a confidently-visible person,
 * never merely because lighting/uncertainty caused the streak to
 * freeze (those were never confirmed absent in the first place, so
 * there is nothing to report as "restored"). Has its own cooldown so a
 * flickering borderline case can't flood the timeline.
 */
export function decideVisibilityRestoredEmission(
  wasConfirmedAbsent: boolean,
  personConfidentlyVisibleNow: boolean,
  cooldownOk: boolean,
): VisibilityRestoredDecision {
  return { shouldEmit: wasConfirmedAbsent && personConfidentlyVisibleNow && cooldownOk };
}

// ---------------------------------------------------------------------------
// Camera integrity reliability pass — a single, explicit state model
// unifying every signal above so the six lecturer-relevant camera states
// stay clearly, testably separate rather than being scattered across
// per-signal booleans/qualifiers. Never adds a new capability (no face
// identity, no biometric matching, no additional image capture) — this
// only names and composes the existing pure signals (stream health,
// frame quality, person detection + hysteresis counters) that already
// exist above.
// ---------------------------------------------------------------------------

export const CAMERA_INTEGRITY_STATES = [
  "CAMERA_VISIBLE",
  "LIGHTING_TOO_LOW",
  "CAMERA_VISIBILITY_UNCERTAIN",
  "CAMERA_STREAM_UNAVAILABLE",
  "SUSTAINED_NO_PERSON_VISIBLE",
  "CAMERA_VISIBILITY_RESTORED",
] as const;
export type CameraIntegrityState = (typeof CAMERA_INTEGRITY_STATES)[number];

/**
 * Symmetric with NO_PERSON_MIN_CONSECUTIVE_TICKS: a previously CONFIRMED
 * (SUSTAINED_NO_PERSON_VISIBLE) episode requires this many consecutive,
 * confidently-visible frames before it is reported as recovered — a
 * single improved frame is never enough to clear an absence state
 * (hysteresis).
 */
export const MIN_CONSECUTIVE_VISIBLE_FOR_RECOVERY = 3;

/**
 * The single source of truth for "which of the six camera-integrity
 * states applies right now." Priority order matters and is deliberate:
 *
 * 1. CAMERA_STREAM_UNAVAILABLE — checked FIRST, before any pixel content
 *    is even considered. A missing/muted/ended/frozen stream can never
 *    fall through to any person-detection-based state (Task 3's core
 *    requirement) because this function returns before `person`/
 *    `frameQuality` are examined at all.
 * 2. LIGHTING_TOO_LOW — a dark or blocked frame's content cannot be
 *    trusted for person detection either way; reported as insufficient
 *    lighting, never as absence.
 * 3. CAMERA_VISIBILITY_UNCERTAIN — a near-threshold person-class score:
 *    genuinely ambiguous, reported as neither visible nor absent.
 * 4. SUSTAINED_NO_PERSON_VISIBLE — requires BOTH
 *    NO_PERSON_MIN_CONSECUTIVE_TICKS consecutive usable frames AND
 *    MIN_NO_PERSON_SUSTAINED_DURATION_MS elapsed (Task 5).
 * 5. CAMERA_VISIBILITY_RESTORED — a one-time transitional state: only
 *    reachable coming FROM a confirmed absence, and only once
 *    MIN_CONSECUTIVE_VISIBLE_FOR_RECOVERY consecutive confidently-visible
 *    frames have been observed (Task 6 hysteresis) — a single good frame
 *    keeps reporting SUSTAINED_NO_PERSON_VISIBLE, not a premature
 *    CAMERA_VISIBLE, so the lecturer timeline never shows an absence
 *    "silently" clearing on a flicker.
 * 6. CAMERA_VISIBLE — the default/steady state; not itself an event.
 */
export function resolveCameraIntegrityState(params: {
  streamHealth: CameraStreamHealth;
  frameQuality: FrameQuality;
  person: PersonDetectionResult;
  /** Consecutive ticks the no-person condition has held — frozen (unchanged), not reset, on an uncertain or bad-quality tick; see the caller's isNoPersonStreakFrozen pattern in page.tsx. */
  noPersonConsecutiveCount: number;
  noPersonStreakDurationMs: number;
  /** Consecutive ticks a person has been confidently visible — frozen the same way as noPersonConsecutiveCount on an uncertain/bad-quality tick, so a single ambiguous frame during recovery neither advances nor resets recovery progress. */
  visibleConsecutiveCount: number;
  /** Caller-owned bookkeeping: true from the tick a SUSTAINED_NO_PERSON_VISIBLE episode is first confirmed until CAMERA_VISIBILITY_RESTORED is reported for it. */
  wasSustainedNoPersonVisible: boolean;
}): CameraIntegrityState {
  if (params.streamHealth === "unavailable") return "CAMERA_STREAM_UNAVAILABLE";
  if (params.frameQuality !== "ok") return "LIGHTING_TOO_LOW";
  if (params.person.noPersonDetected && params.person.bestPersonScore >= UNCERTAIN_PERSON_CONFIDENCE_LOWER_BOUND) {
    return "CAMERA_VISIBILITY_UNCERTAIN";
  }
  const sustainedAbsent =
    params.person.noPersonDetected &&
    params.noPersonConsecutiveCount >= NO_PERSON_MIN_CONSECUTIVE_TICKS &&
    params.noPersonStreakDurationMs >= MIN_NO_PERSON_SUSTAINED_DURATION_MS;
  if (sustainedAbsent) return "SUSTAINED_NO_PERSON_VISIBLE";
  if (params.wasSustainedNoPersonVisible) {
    if (!params.person.noPersonDetected && params.visibleConsecutiveCount >= MIN_CONSECUTIVE_VISIBLE_FOR_RECOVERY) {
      return "CAMERA_VISIBILITY_RESTORED";
    }
    // Still recovering: an absence state is never cleared by a single
    // improved frame — keep reporting the prior confirmed state until
    // stability is actually reached.
    return "SUSTAINED_NO_PERSON_VISIBLE";
  }
  return "CAMERA_VISIBLE";
}

export type FrameQualityEmissionDecision = {
  /** Whether the frame-quality condition (blocked or dark) has held for ≥2 consecutive checks — independent of cooldown. */
  conditionMet: boolean;
  /** Whether this tick should send a NEW backend integrity event: conditionMet AND the cooldown has elapsed. */
  shouldEmit: boolean;
};

/**
 * CAMERA_VIEW_BLOCKED / CAMERA_TOO_DARK both require 2 consecutive
 * checks of the matching frame-quality classification — unchanged
 * confirmation rule, factored out for the same reason as
 * decideNoPersonEmission above.
 */
export function decideFrameQualityEmission(
  qualityMatches: boolean,
  consecutiveCount: number,
  cooldownOk: boolean,
): FrameQualityEmissionDecision {
  const conditionMet = qualityMatches && consecutiveCount >= 2;
  return { conditionMet, shouldEmit: conditionMet && cooldownOk };
}

// ---------------------------------------------------------------------------
// Corrective pass v1.2.2, Task 8. Physical testing showed repeated
// Chromium/Windows Media Foundation errors ("Failed to reserve output
// capture buffer: 1") while another application (Microsoft Teams, in
// three processes) held the camera. A capture-buffer reservation failure
// does not necessarily change the <video> element's own
// readyState/videoWidth/videoHeight/currentTime — those can stay frozen
// at their last good values — so it was silently feeding a stale frame
// into the object detector, which then found no person and eventually
// reported NO_PERSON_VISIBLE ("Face not visible"). This must never
// happen: a camera resource interruption is not evidence of face
// absence.
// ---------------------------------------------------------------------------

export type CameraStreamHealth = "ok" | "unavailable";

export type CameraTrackLike = { readyState: string; muted: boolean };

/**
 * Classifies MediaStreamTrack health independently of pixel content —
 * the same two signals the existing camera heartbeat already relies on
 * (see startCamera/heartbeat wiring in src/app/student/exams/[id]/page.tsx):
 * the browser marks a track `muted` when its source cannot currently
 * deliver data (exactly what a capture-buffer reservation failure is),
 * and `readyState` becomes "ended" on a terminal failure. `null`/`undefined`
 * (no track at all, e.g. the stream was torn down) is also "unavailable".
 */
export function classifyCameraStreamHealth(track: CameraTrackLike | null | undefined): CameraStreamHealth {
  if (!track) return "unavailable";
  if (track.readyState !== "live") return "unavailable";
  if (track.muted) return "unavailable";
  return "ok";
}

export type CameraStreamEmissionDecision = {
  /** Whether the stream-unavailable condition has held for ≥2 consecutive checks — independent of cooldown. */
  conditionMet: boolean;
  /** Whether this tick should send a NEW backend integrity event: conditionMet AND the cooldown has elapsed. */
  shouldEmit: boolean;
};

/**
 * CAMERA_STREAM_UNAVAILABLE — same 2-consecutive-check confirmation rule
 * as decideFrameQualityEmission, so a single-tick blip (e.g. one dropped
 * frame during a benign resolution change) isn't itself reported.
 * Distinct from the existing CAMERA_UNAVAILABLE event (total acquisition
 * failure at startup/restore, see handleRestoreCamera) — this is a
 * transient mid-exam interruption of an otherwise-running stream.
 */
export function decideCameraStreamEmission(
  streamHealth: CameraStreamHealth,
  consecutiveCount: number,
  cooldownOk: boolean,
): CameraStreamEmissionDecision {
  const conditionMet = streamHealth === "unavailable" && consecutiveCount >= 2;
  return { conditionMet, shouldEmit: conditionMet && cooldownOk };
}

/**
 * Camera Startup Readiness v1 — see docs/on-device-ai-integrity-detection-v1.md
 * ("Camera startup readiness"). Many webcams deliver a few transiently
 * black/dark/artifacted frames while auto-exposure/auto-focus settle,
 * even after `readyState`/`videoWidth`/`videoHeight` already report the
 * video element as playable — that gap is exactly what produced false
 * CAMERA_VIEW_BLOCKED events on first exam start. A plain readiness
 * check alone (see isVideoFrameReady below) is necessary but not
 * sufficient; the grace period below is the additional fix.
 */

export type VideoFrameLike = {
  readyState: number;
  videoWidth: number;
  videoHeight: number;
};

/**
 * True once the video element has a real, non-zero-dimension current
 * frame — HTMLMediaElement.HAVE_CURRENT_DATA (2) or higher, and both
 * dimensions non-zero. This alone does NOT mean the frame content is
 * meaningful yet (see shouldSuppressCameraIntegrityDuringStartup) — only
 * that there is a frame to draw at all.
 */
export function isVideoFrameReady(
  video: VideoFrameLike | null | undefined,
): video is VideoFrameLike {
  return Boolean(video) && video!.readyState >= 2 && video!.videoWidth > 0 && video!.videoHeight > 0;
}

/** How long after the first ready frame to suppress blocked/dark/no-person/phone/second-person emission, to let camera auto-exposure/auto-focus settle. */
export const CAMERA_STARTUP_GRACE_PERIOD_MS = 3_000;

/** If no ready frame is observed within this long after the stream starts, camera startup is considered failed (shown as a clear setup error, never an indefinite spinner). */
export const CAMERA_READY_TIMEOUT_MS = 15_000;

/**
 * Whether AI camera integrity events (CAMERA_VIEW_BLOCKED, CAMERA_TOO_DARK,
 * NO_PERSON_VISIBLE, POSSIBLE_PHONE_VISIBLE, POSSIBLE_SECOND_PERSON_VISIBLE)
 * must be suppressed right now because the camera is still starting up:
 * either no ready frame has been observed yet (`firstReadyFrameAt` is
 * null), or one has but the warm-up grace period since then hasn't
 * elapsed. `firstReadyFrameAt` must be reset to null whenever the camera
 * stream (re)starts, so a lost-and-restarted stream gets its own fresh
 * warm-up window (see docs/on-device-ai-integrity-detection-v1.md,
 * "Camera recovery").
 */
export function shouldSuppressCameraIntegrityDuringStartup(
  firstReadyFrameAt: number | null,
  now: number,
  gracePeriodMs: number = CAMERA_STARTUP_GRACE_PERIOD_MS,
): boolean {
  if (firstReadyFrameAt == null) return true;
  return now - firstReadyFrameAt < gracePeriodMs;
}

export type CameraStartupPhase = "waiting_for_first_frame" | "warming_up" | "ready" | "timed_out";

/**
 * Derives the user-facing camera startup phase from raw timing state —
 * pure, so both the UI copy and tests can rely on the same derivation.
 * `streamStartedAt` should be set the moment getUserMedia resolves (not
 * when the video element becomes ready), so a camera that never
 * delivers a frame at all is still caught by the timeout rather than
 * waiting forever.
 */
export function cameraStartupPhase(params: {
  firstReadyFrameAt: number | null;
  now: number;
  streamStartedAt: number | null;
  gracePeriodMs?: number;
  readyTimeoutMs?: number;
}): CameraStartupPhase {
  const gracePeriodMs = params.gracePeriodMs ?? CAMERA_STARTUP_GRACE_PERIOD_MS;
  const readyTimeoutMs = params.readyTimeoutMs ?? CAMERA_READY_TIMEOUT_MS;
  if (params.firstReadyFrameAt == null) {
    if (params.streamStartedAt != null && params.now - params.streamStartedAt > readyTimeoutMs) {
      return "timed_out";
    }
    return "waiting_for_first_frame";
  }
  if (params.now - params.firstReadyFrameAt < gracePeriodMs) return "warming_up";
  return "ready";
}

/**
 * Backend integrity-event logging should happen only when the on-device
 * detection condition is currently met AND the spam-prevention cooldown
 * has elapsed — this is exactly the `shouldEmit` field each decide*
 * function above already returns; exported as a small named function so
 * the "backend logging is cooldown-gated" rule is explicit and directly
 * testable on its own, separate from the local-overlay rule below. See
 * docs/on-device-ai-integrity-detection-v1.md.
 */
export function shouldLogAiIntegrityEvent(conditionMet: boolean, cooldownOk: boolean): boolean {
  return conditionMet && cooldownOk;
}

/**
 * The local exam-content overlay should be shown whenever the detection
 * condition is currently true, full stop — never gated by the backend
 * cooldown. This is the crux of the acknowledge-then-reappear fix: even
 * while `shouldLogAiIntegrityEvent` is false (cooldown still active),
 * this stays true for as long as the underlying signal (phone/person/
 * frame quality) keeps being detected, so the overlay can reopen almost
 * immediately after the student acknowledges it if the condition
 * persists. See src/lib/aiCameraViolationOverlay.ts and
 * docs/on-device-ai-integrity-detection-v1.md.
 */
export function shouldShowLocalAiOverlay(conditionMet: boolean): boolean {
  return conditionMet;
}

/**
 * Structural guardrail: the metadata this feature ever sends must never
 * contain image/frame/media data. Mirrors the server-side check in
 * src/app/api/submissions/[id]/integrity-events/route.ts so client code
 * can self-check before ever making the request — defense in depth,
 * not a replacement for the server check.
 */
const FORBIDDEN_METADATA_KEY_PATTERN = /image|frame|screenshot|thumbnail|snapshot|base64|blob|dataurl/i;

export function assertSafeIntegrityMetadata(metadata: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(metadata)) {
    if (FORBIDDEN_METADATA_KEY_PATTERN.test(key)) {
      throw new Error(`Integrity event metadata key "${key}" looks like media data and is not allowed`);
    }
    if (typeof value === "string" && /^data:/i.test(value)) {
      throw new Error(`Integrity event metadata value for "${key}" looks like a data URL and is not allowed`);
    }
  }
}
