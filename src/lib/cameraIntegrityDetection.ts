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

  /** Increments (or resets) a consecutive-detection counter for a signal that occurred this check. */
  recordObservation(key: string, observedThisCheck: boolean): number {
    const next = observedThisCheck ? (this.consecutiveCounts[key] ?? 0) + 1 : 0;
    this.consecutiveCounts[key] = next;
    return next;
  }

  getConsecutiveCount(key: string): number {
    return this.consecutiveCounts[key] ?? 0;
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

export type DetectedObject = { className: string; score: number };

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
};

/** Counts person-class detections at or above `minConfidence`, and separately at or above `highConfidence`. */
export function evaluatePersonDetections(
  detections: DetectedObject[],
  minConfidence = 0.6,
  highConfidence = 0.75,
): PersonDetectionResult {
  const atMinConfidence = detections.filter(
    (d) => d.className.toLowerCase() === "person" && d.score >= minConfidence,
  );
  const personCount = atMinConfidence.length;
  const highConfidenceCount = atMinConfidence.filter((d) => d.score >= highConfidence).length;
  return {
    personCount,
    noPersonDetected: personCount === 0,
    multiplePersons: personCount >= 2,
    multiplePersonsHighConfidence: highConfidenceCount >= 2,
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

export type NoPersonEmissionDecision = {
  /** Whether the no-person confirmation rule (≥3 consecutive no-person ticks) is satisfied — independent of cooldown. */
  conditionMet: boolean;
  /** Whether this tick should send a NEW backend integrity event: conditionMet AND the cooldown has elapsed. */
  shouldEmit: boolean;
};

/**
 * NO_PERSON_VISIBLE requires 3 consecutive no-person checks — unchanged
 * confirmation rule, factored out as its own decision function (mirroring
 * decidePhoneEmission/decideSecondPersonEmission) so `conditionMet` can
 * drive the local overlay independent of the backend cooldown.
 */
export function decideNoPersonEmission(
  person: PersonDetectionResult,
  consecutiveCount: number,
  cooldownOk: boolean,
): NoPersonEmissionDecision {
  const conditionMet = person.noPersonDetected && consecutiveCount >= 3;
  return { conditionMet, shouldEmit: conditionMet && cooldownOk };
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
