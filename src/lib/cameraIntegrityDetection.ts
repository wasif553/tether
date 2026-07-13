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

export type DetectedObject = { className: string; score: number };

export type PhoneDetectionResult = { detected: boolean; confidence: number };

/** Highest-confidence phone-like detection at or above `minConfidence`, or not detected. */
export function evaluatePhoneDetections(
  detections: DetectedObject[],
  minConfidence = 0.65,
): PhoneDetectionResult {
  const phoneClasses = new Set(["cell phone", "mobile phone", "phone"]);
  const matches = detections.filter((d) => phoneClasses.has(d.className.toLowerCase()) && d.score >= minConfidence);
  if (matches.length === 0) return { detected: false, confidence: 0 };
  const best = matches.reduce((max, d) => (d.score > max.score ? d : max), matches[0]);
  return { detected: true, confidence: best.score };
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
  shouldEmit: boolean;
  confidenceBand: "high" | "medium" | null;
};

/**
 * Decision function for whether POSSIBLE_SECOND_PERSON_VISIBLE should emit:
 * - High confidence (both persons ≥0.75): emit immediately (no consecutive-check wait)
 * - Normal confidence (0.60-0.75): require 2 consecutive ticks (guard against fleeting misclassification)
 * - Either path respects the 45s cooldown to prevent flooding
 */
export function decideSecondPersonEmission(
  person: PersonDetectionResult,
  consecutiveCount: number,
  cooldownOk: boolean,
): SecondPersonEmissionDecision {
  if (!cooldownOk) return { shouldEmit: false, confidenceBand: null };
  if (person.multiplePersonsHighConfidence) return { shouldEmit: true, confidenceBand: "high" };
  if (person.multiplePersons && consecutiveCount >= 2) return { shouldEmit: true, confidenceBand: "medium" };
  return { shouldEmit: false, confidenceBand: null };
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
