/**
 * Optional Student Verification + On-Device AI Camera Integrity
 * Detection v1 — see docs/on-device-ai-integrity-detection-v1.md.
 *
 * Pure unit tests only — no Prisma/DB, no browser, no webcam, no
 * TensorFlow. These exercise the dependency-free helpers in
 * cameraIntegrityDetection.ts directly, so they run (and stay green)
 * independent of whether the local test Postgres instance is up.
 *
 * DB-backed route/evidence-report/risk-scoring tests for this same
 * feature live in onDeviceAiIntegrity.routes.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  bandForConfidence,
  classifyFrameQuality,
  computeLuminanceVariance,
  evaluatePersonDetections,
  evaluatePhoneDetections,
  decideSecondPersonEmission,
  shouldLogAiCameraDebug,
  DetectionCooldownTracker,
  assertSafeIntegrityMetadata,
} from "./cameraIntegrityDetection";

describe("shouldLogAiCameraDebug", () => {
  it("is false in production regardless of the debug flag", () => {
    expect(shouldLogAiCameraDebug("production", "true")).toBe(false);
  });

  it("is false in development when the flag is absent", () => {
    expect(shouldLogAiCameraDebug("development", null)).toBe(false);
    expect(shouldLogAiCameraDebug("development", undefined)).toBe(false);
  });

  it("is false in development when the flag is any value other than the exact string \"true\"", () => {
    expect(shouldLogAiCameraDebug("development", "false")).toBe(false);
    expect(shouldLogAiCameraDebug("development", "1")).toBe(false);
    expect(shouldLogAiCameraDebug("development", "")).toBe(false);
  });

  it("is true only when NODE_ENV is development AND the flag is exactly \"true\"", () => {
    expect(shouldLogAiCameraDebug("development", "true")).toBe(true);
  });

  it("is false when NODE_ENV is undefined even if the flag is set", () => {
    expect(shouldLogAiCameraDebug(undefined, "true")).toBe(false);
  });
});

describe("bandForConfidence", () => {
  it("buckets scores into low/medium/high", () => {
    expect(bandForConfidence(0.5)).toBe("low");
    expect(bandForConfidence(0.7)).toBe("medium");
    expect(bandForConfidence(0.9)).toBe("high");
  });
});

describe("computeLuminanceVariance", () => {
  it("returns high avg luminance and zero variance for a uniform bright frame", () => {
    const data = new Uint8ClampedArray(4 * 100).fill(0);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = 255;
    }
    const { avgLuminance, variance } = computeLuminanceVariance(data);
    expect(avgLuminance).toBeCloseTo(255, 0);
    expect(variance).toBeCloseTo(0, 1);
  });

  it("returns low avg luminance for a uniform dark frame", () => {
    const data = new Uint8ClampedArray(4 * 100).fill(0);
    const { avgLuminance } = computeLuminanceVariance(data);
    expect(avgLuminance).toBeCloseTo(0, 1);
  });

  it("returns nonzero variance for a mixed frame", () => {
    const data = new Uint8ClampedArray(4 * 100);
    for (let i = 0; i < data.length; i += 4) {
      const bright = i % 8 === 0;
      data[i] = bright ? 255 : 0;
      data[i + 1] = bright ? 255 : 0;
      data[i + 2] = bright ? 255 : 0;
      data[i + 3] = 255;
    }
    const { variance } = computeLuminanceVariance(data, 1);
    expect(variance).toBeGreaterThan(1000);
  });
});

describe("classifyFrameQuality", () => {
  it("12. classifies a flat/low-variance frame as blocked", () => {
    expect(classifyFrameQuality(120, 5)).toBe("blocked");
  });

  it("12. classifies a dark-but-varied frame as dark", () => {
    expect(classifyFrameQuality(10, 50)).toBe("dark");
  });

  it("classifies a normal frame as ok", () => {
    expect(classifyFrameQuality(120, 50)).toBe("ok");
  });
});

describe("evaluatePhoneDetections", () => {
  it("7. accepts a phone-like class at or above the confidence threshold", () => {
    const result = evaluatePhoneDetections([{ className: "cell phone", score: 0.7 }], 0.65);
    expect(result.detected).toBe(true);
    expect(result.confidence).toBe(0.7);
  });

  it("ignores phone-like detections below the confidence threshold", () => {
    const result = evaluatePhoneDetections([{ className: "cell phone", score: 0.5 }], 0.65);
    expect(result.detected).toBe(false);
  });

  it("ignores unrelated classes", () => {
    const result = evaluatePhoneDetections([{ className: "book", score: 0.9 }], 0.65);
    expect(result.detected).toBe(false);
  });
});

describe("evaluatePersonDetections", () => {
  it("10. detects multiple persons above the confidence threshold", () => {
    const result = evaluatePersonDetections(
      [
        { className: "person", score: 0.7 },
        { className: "person", score: 0.65 },
      ],
      0.6,
    );
    expect(result.personCount).toBe(2);
    expect(result.multiplePersons).toBe(true);
    expect(result.noPersonDetected).toBe(false);
  });

  it("11. reports no person visible when nothing meets the threshold", () => {
    const result = evaluatePersonDetections([{ className: "person", score: 0.3 }], 0.6);
    expect(result.noPersonDetected).toBe(true);
  });

  it("no-person logic detects zero persons in an empty detection set", () => {
    const result = evaluatePersonDetections([], 0.6);
    expect(result.personCount).toBe(0);
    expect(result.noPersonDetected).toBe(true);
    expect(result.multiplePersons).toBe(false);
  });

  it("does not treat a single confident person as multiplePersons", () => {
    const result = evaluatePersonDetections([{ className: "person", score: 0.9 }], 0.6);
    expect(result.multiplePersons).toBe(false);
    expect(result.noPersonDetected).toBe(false);
  });

  it("detects high-confidence multiple persons when both ≥0.75", () => {
    const result = evaluatePersonDetections(
      [
        { className: "person", score: 0.8 },
        { className: "person", score: 0.76 },
      ],
      0.6,
      0.75,
    );
    expect(result.multiplePersons).toBe(true);
    expect(result.multiplePersonsHighConfidence).toBe(true);
  });

  it("does not flag high-confidence when one person is below 0.75", () => {
    const result = evaluatePersonDetections(
      [
        { className: "person", score: 0.8 },
        { className: "person", score: 0.65 },
      ],
      0.6,
      0.75,
    );
    expect(result.multiplePersons).toBe(true);
    expect(result.multiplePersonsHighConfidence).toBe(false);
  });
});

describe("decideSecondPersonEmission", () => {
  it("allows immediate emission for high-confidence multi-person detection", () => {
    const decision = decideSecondPersonEmission(
      { personCount: 2, noPersonDetected: false, multiplePersons: true, multiplePersonsHighConfidence: true },
      0,
      true,
    );
    expect(decision.shouldEmit).toBe(true);
    expect(decision.confidenceBand).toBe("high");
  });

  it("requires 2 consecutive checks for normal-confidence multi-person detection", () => {
    const decision = decideSecondPersonEmission(
      { personCount: 2, noPersonDetected: false, multiplePersons: true, multiplePersonsHighConfidence: false },
      1,
      true,
    );
    expect(decision.shouldEmit).toBe(false);
  });

  it("emits on second consecutive tick for normal-confidence multi-person", () => {
    const decision = decideSecondPersonEmission(
      { personCount: 2, noPersonDetected: false, multiplePersons: true, multiplePersonsHighConfidence: false },
      2,
      true,
    );
    expect(decision.shouldEmit).toBe(true);
    expect(decision.confidenceBand).toBe("medium");
  });

  it("respects cooldown even for high-confidence detection", () => {
    const decision = decideSecondPersonEmission(
      { personCount: 2, noPersonDetected: false, multiplePersons: true, multiplePersonsHighConfidence: true },
      0,
      false,
    );
    expect(decision.shouldEmit).toBe(false);
    expect(decision.confidenceBand).toBeNull();
  });

  it("does not emit when multiplePersons is false", () => {
    const decision = decideSecondPersonEmission(
      { personCount: 1, noPersonDetected: false, multiplePersons: false, multiplePersonsHighConfidence: false },
      2,
      true,
    );
    expect(decision.shouldEmit).toBe(false);
  });
});

describe("DetectionCooldownTracker", () => {
  it("19. allows emission only after the cooldown window elapses", () => {
    const tracker = new DetectionCooldownTracker();
    expect(tracker.canEmit("PHONE", 0, 1000)).toBe(true);
    tracker.markEmitted("PHONE", 0);
    expect(tracker.canEmit("PHONE", 500, 1000)).toBe(false);
    expect(tracker.canEmit("PHONE", 1001, 1000)).toBe(true);
  });

  it("cooldown prevents repeated events for the same signal within the window", () => {
    const tracker = new DetectionCooldownTracker();
    expect(tracker.canEmit("POSSIBLE_SECOND_PERSON_VISIBLE", 1_000, 45_000)).toBe(true);
    tracker.markEmitted("POSSIBLE_SECOND_PERSON_VISIBLE", 1_000);
    // Repeated detections within the 45s cooldown must not re-emit.
    expect(tracker.canEmit("POSSIBLE_SECOND_PERSON_VISIBLE", 10_000, 45_000)).toBe(false);
    expect(tracker.canEmit("POSSIBLE_SECOND_PERSON_VISIBLE", 40_000, 45_000)).toBe(false);
    // Once the cooldown elapses, emission is allowed again.
    expect(tracker.canEmit("POSSIBLE_SECOND_PERSON_VISIBLE", 46_001, 45_000)).toBe(true);
  });

  it("19. tracks consecutive-detection counts per key, resetting on a miss", () => {
    const tracker = new DetectionCooldownTracker();
    expect(tracker.recordObservation("PHONE", true)).toBe(1);
    expect(tracker.recordObservation("PHONE", true)).toBe(2);
    expect(tracker.recordObservation("PHONE", false)).toBe(0);
    expect(tracker.getConsecutiveCount("PHONE")).toBe(0);
  });

  it("reset() clears all cooldowns and counters", () => {
    const tracker = new DetectionCooldownTracker();
    tracker.markEmitted("PHONE", 0);
    tracker.recordObservation("PHONE", true);
    tracker.reset();
    expect(tracker.canEmit("PHONE", 0, 1000)).toBe(true);
    expect(tracker.getConsecutiveCount("PHONE")).toBe(0);
  });
});

describe("assertSafeIntegrityMetadata", () => {
  it("8. throws for a key that looks like image/frame/media data", () => {
    expect(() => assertSafeIntegrityMetadata({ image: "x" })).toThrow();
    expect(() => assertSafeIntegrityMetadata({ frameData: "x" })).toThrow();
    expect(() => assertSafeIntegrityMetadata({ screenshotUrl: "x" })).toThrow();
    expect(() => assertSafeIntegrityMetadata({ thumbnail: "x" })).toThrow();
    expect(() => assertSafeIntegrityMetadata({ base64Payload: "x" })).toThrow();
    expect(() => assertSafeIntegrityMetadata({ blobRef: "x" })).toThrow();
  });

  it("8. throws for a data: URL value under any key name", () => {
    expect(() => assertSafeIntegrityMetadata({ note: "data:image/png;base64,AAAA" })).toThrow();
  });

  it("allows safe, AI-detection-only metadata", () => {
    expect(() =>
      assertSafeIntegrityMetadata({
        source: "on_device_camera_ai",
        confidence: 0.8,
        confidenceBand: "high",
        modelName: "coco-ssd",
        modelVersion: "lite_mobilenet_v2",
        detectionIntervalSeconds: 3,
      }),
    ).not.toThrow();
  });
});
