/**
 * Strengthened phone detection — multi-scale crop regions and adaptive
 * scheduling. See docs/phone-detection-calibration-v1.md.
 *
 * Pure, dependency-free: defines WHICH regions of the frame get a
 * second, zoomed-in detector pass and WHEN, plus the coordinate mapping
 * to translate a detection made on a cropped/rescaled canvas back into
 * normalized ORIGINAL-frame coordinates so it can be merged with
 * full-frame detections (see phoneDetectionTracking.ts, dedupeObservations).
 * Actually drawing the crop and running the detector on it is done by
 * the caller (src/app/student/exams/[id]/page.tsx) — this module never
 * touches a canvas, video element, or model.
 */
import type { NormalizedBox } from "@/lib/phoneDetectionTracking";

export type CropRegionName =
  | "lower_half"
  | "lower_left"
  | "lower_center"
  | "lower_right"
  | "left_edge"
  | "right_edge";

export type CropRegion = { name: CropRegionName; box: NormalizedBox };

/**
 * Fixed, bounded set of regions (Part 3) — deliberately NOT an exhaustive
 * tiling of the frame (that would multiply inference cost far past what
 * an ordinary student laptop can sustain alongside the exam UI itself).
 * Regions overlap each other and the full frame on purpose so a phone
 * near a region boundary is still fully contained in at least one crop.
 */
export const PHONE_CROP_REGIONS: readonly CropRegion[] = [
  { name: "lower_half", box: { x: 0, y: 0.42, width: 1, height: 0.58 } },
  { name: "lower_left", box: { x: 0, y: 0.42, width: 0.44, height: 0.58 } },
  { name: "lower_center", box: { x: 0.28, y: 0.42, width: 0.44, height: 0.58 } },
  { name: "lower_right", box: { x: 0.56, y: 0.42, width: 0.44, height: 0.58 } },
  { name: "left_edge", box: { x: 0, y: 0, width: 0.32, height: 1 } },
  { name: "right_edge", box: { x: 0.68, y: 0, width: 0.32, height: 1 } },
] as const;

export function findCropRegion(name: CropRegionName): CropRegion {
  const region = PHONE_CROP_REGIONS.find((r) => r.name === name);
  if (!region) throw new Error(`Unknown phone crop region: ${name}`);
  return region;
}

export type CropScheduleDecision = {
  /** Full-frame detection always runs — this schedule only adds crops on top of it. */
  runFullFrame: true;
  cropsToRun: CropRegionName[];
};

/**
 * Adaptive schedule (Part 3): full-frame every tick, additional lower/edge
 * crops every second or third tick — never every crop on every tick. When
 * a moderate candidate is already being tracked, the caller should ALSO
 * schedule an immediate re-check of that candidate's own local region
 * (handled separately by the caller via expandCandidateBoxForVerification
 * in phoneDetectionTracking.ts, not by this schedule) rather than waiting
 * for the next scheduled crop cycle.
 */
export function computeCropSchedule(tickIndex: number): CropScheduleDecision {
  const cropsToRun: CropRegionName[] = [];
  const cyclePosition = ((tickIndex % 3) + 3) % 3;
  if (cyclePosition === 0) cropsToRun.push("lower_half");
  if (cyclePosition === 1) cropsToRun.push("lower_left", "lower_right");
  if (cyclePosition === 2) cropsToRun.push("left_edge", "right_edge");
  return { runFullFrame: true, cropsToRun };
}

/** Maps a detection box given in crop-local normalized (0-1) coordinates into ORIGINAL-frame normalized coordinates. */
export function mapCropDetectionToOriginalFrame(cropBox: NormalizedBox, detectionInCrop: NormalizedBox): NormalizedBox {
  return {
    x: cropBox.x + detectionInCrop.x * cropBox.width,
    y: cropBox.y + detectionInCrop.y * cropBox.height,
    width: detectionInCrop.width * cropBox.width,
    height: detectionInCrop.height * cropBox.height,
  };
}

/** Converts a detector bounding box (pixel coords in the SOURCE image/canvas that was actually passed to detect()) into normalized 0-1 coordinates for that same source. */
export function pixelBoxToNormalized(
  pixelBox: { x: number; y: number; width: number; height: number },
  sourceWidth: number,
  sourceHeight: number,
): NormalizedBox {
  if (sourceWidth <= 0 || sourceHeight <= 0) return { x: 0, y: 0, width: 0, height: 0 };
  return {
    x: pixelBox.x / sourceWidth,
    y: pixelBox.y / sourceHeight,
    width: pixelBox.width / sourceWidth,
    height: pixelBox.height / sourceHeight,
  };
}

// ---------------------------------------------------------------------------
// Performance controls (Part 14)
// ---------------------------------------------------------------------------

/** Crop passes (lower/edge + verification) allowed within CROP_INFERENCE_WINDOW_MS — bounds worst-case CPU cost regardless of how many candidates are active. */
export const MAX_CROP_INFERENCES_PER_WINDOW = 6;
export const CROP_INFERENCE_WINDOW_MS = 5_000;
/** Re-exported for convenience — canonically defined in phoneDetectionTracking.ts, next to the track map it bounds. */
export { MAX_ACTIVE_PHONE_TRACKS } from "@/lib/phoneDetectionTracking";
/** At most one second-stage verification crop per tick, regardless of how many moderate candidates exist simultaneously. */
export const MAX_VERIFICATION_ATTEMPTS_PER_TICK = 1;

/** True if running another crop inference right now would stay within the budget, given recent crop-inference timestamps (ms epoch). */
export function withinCropInferenceBudget(recentCropInferenceTimestampsMs: number[], nowMs: number): boolean {
  const cutoff = nowMs - CROP_INFERENCE_WINDOW_MS;
  const recent = recentCropInferenceTimestampsMs.filter((t) => t >= cutoff);
  return recent.length < MAX_CROP_INFERENCES_PER_WINDOW;
}

/** Drops the oldest timestamps outside the budget window — the caller should store the return value back into its ref/state. */
export function prunedCropInferenceTimestamps(recentCropInferenceTimestampsMs: number[], nowMs: number): number[] {
  const cutoff = nowMs - CROP_INFERENCE_WINDOW_MS;
  return recentCropInferenceTimestampsMs.filter((t) => t >= cutoff);
}
