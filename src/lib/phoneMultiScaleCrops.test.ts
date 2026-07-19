/**
 * Strengthened phone detection — multi-scale crop pure tests. See
 * docs/phone-detection-calibration-v1.md and src/lib/phoneMultiScaleCrops.ts.
 */
import { describe, expect, it } from "vitest";
import {
  PHONE_CROP_REGIONS,
  findCropRegion,
  computeCropSchedule,
  mapCropDetectionToOriginalFrame,
  pixelBoxToNormalized,
  withinCropInferenceBudget,
  prunedCropInferenceTimestamps,
  MAX_CROP_INFERENCES_PER_WINDOW,
  CROP_INFERENCE_WINDOW_MS,
  MAX_ACTIVE_PHONE_TRACKS,
} from "./phoneMultiScaleCrops";

describe("crop regions", () => {
  it("is a small, bounded set — never an exhaustive tiling", () => {
    expect(PHONE_CROP_REGIONS.length).toBeGreaterThan(0);
    expect(PHONE_CROP_REGIONS.length).toBeLessThanOrEqual(8);
  });

  it("every region is a valid, in-bounds normalized rect", () => {
    for (const region of PHONE_CROP_REGIONS) {
      expect(region.box.x).toBeGreaterThanOrEqual(0);
      expect(region.box.y).toBeGreaterThanOrEqual(0);
      expect(region.box.x + region.box.width).toBeLessThanOrEqual(1 + 1e-9);
      expect(region.box.y + region.box.height).toBeLessThanOrEqual(1 + 1e-9);
      expect(region.box.width).toBeGreaterThan(0);
      expect(region.box.height).toBeGreaterThan(0);
    }
  });

  it("lower-left/lower-center/lower-right regions overlap each other slightly (Part 3 — no dead zone at a boundary)", () => {
    const left = findCropRegion("lower_left").box;
    const center = findCropRegion("lower_center").box;
    const right = findCropRegion("lower_right").box;
    expect(left.x + left.width).toBeGreaterThan(center.x);
    expect(center.x + center.width).toBeGreaterThan(right.x);
  });

  it("findCropRegion throws for an unknown name", () => {
    // @ts-expect-error deliberately invalid input
    expect(() => findCropRegion("not_a_region")).toThrow();
  });
});

describe("adaptive crop schedule (Part 3)", () => {
  it("full-frame always runs; only a bounded subset of crops runs on any given tick", () => {
    for (let tick = 0; tick < 9; tick++) {
      const schedule = computeCropSchedule(tick);
      expect(schedule.runFullFrame).toBe(true);
      expect(schedule.cropsToRun.length).toBeGreaterThan(0);
      expect(schedule.cropsToRun.length).toBeLessThan(PHONE_CROP_REGIONS.length);
    }
  });

  it("the schedule cycles rather than running the same crops every tick, and repeats on a 3-tick period", () => {
    const a = computeCropSchedule(0).cropsToRun;
    const b = computeCropSchedule(1).cropsToRun;
    const c = computeCropSchedule(2).cropsToRun;
    expect(a).not.toEqual(b);
    expect(b).not.toEqual(c);
    expect(computeCropSchedule(3)).toEqual(computeCropSchedule(0));
  });

  it("is deterministic for a given tick index (repeatable in tests/debugging)", () => {
    expect(computeCropSchedule(5)).toEqual(computeCropSchedule(5));
  });
});

describe("coordinate mapping", () => {
  it("pixelBoxToNormalized converts pixel coordinates to 0-1 range", () => {
    expect(pixelBoxToNormalized({ x: 150, y: 75, width: 30, height: 60 }, 300, 300)).toEqual({
      x: 0.5,
      y: 0.25,
      width: 0.1,
      height: 0.2,
    });
  });

  it("pixelBoxToNormalized is safe against a zero-size source", () => {
    expect(pixelBoxToNormalized({ x: 1, y: 1, width: 1, height: 1 }, 0, 0)).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
  });

  it("mapCropDetectionToOriginalFrame places a crop-local detection back into ORIGINAL-frame coordinates", () => {
    const cropBox = { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }; // bottom-right quadrant
    const detectionInCrop = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 }; // within that crop
    const mapped = mapCropDetectionToOriginalFrame(cropBox, detectionInCrop);
    expect(mapped).toEqual({ x: 0.6, y: 0.6, width: 0.2, height: 0.2 });
  });

  it("a detection filling the entire crop maps back to exactly the crop's own region", () => {
    const cropBox = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
    const fullCropDetection = { x: 0, y: 0, width: 1, height: 1 };
    expect(mapCropDetectionToOriginalFrame(cropBox, fullCropDetection)).toEqual(cropBox);
  });
});

describe("25. Part 14 performance budget limits crop inferences", () => {
  it("allows inferences up to the configured ceiling within the window", () => {
    const now = 10_000;
    const timestamps: number[] = [];
    for (let i = 0; i < MAX_CROP_INFERENCES_PER_WINDOW; i++) {
      expect(withinCropInferenceBudget(timestamps, now)).toBe(true);
      timestamps.push(now);
    }
    expect(withinCropInferenceBudget(timestamps, now)).toBe(false);
  });

  it("prunedCropInferenceTimestamps drops timestamps outside the window, restoring budget", () => {
    const now = 100_000;
    const stale = [now - CROP_INFERENCE_WINDOW_MS - 1, now - CROP_INFERENCE_WINDOW_MS - 500];
    const pruned = prunedCropInferenceTimestamps(stale, now);
    expect(pruned).toHaveLength(0);
    expect(withinCropInferenceBudget(pruned, now)).toBe(true);
  });

  it("MAX_ACTIVE_PHONE_TRACKS is re-exported consistently from the tracking module", () => {
    expect(MAX_ACTIVE_PHONE_TRACKS).toBeGreaterThan(0);
  });
});
