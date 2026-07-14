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
  computeNextDetectionDelayMs,
  DEFAULT_ADAPTIVE_CADENCE_CONFIG,
  evaluatePersonDetections,
  evaluatePhoneDetections,
  decidePhoneEmission,
  decideSecondPersonEmission,
  decideNoPersonEmission,
  decideFrameQualityEmission,
  shouldLogAiCameraDebug,
  shouldLogAiIntegrityEvent,
  shouldShowLocalAiOverlay,
  DetectionCooldownTracker,
  PHONE_CONFIDENCE_THRESHOLD,
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
  it("1. detects class \"cell phone\" at or above the confidence threshold", () => {
    const result = evaluatePhoneDetections([{ className: "cell phone", score: 0.7 }], 0.65);
    expect(result.detected).toBe(true);
    expect(result.confidence).toBe(0.7);
  });

  it("2. a low-confidence \"cell phone\" detection does not emit (detected stays false)", () => {
    const result = evaluatePhoneDetections([{ className: "cell phone", score: 0.3 }], PHONE_CONFIDENCE_THRESHOLD);
    expect(result.detected).toBe(false);
  });

  it("ignores phone-like detections below the confidence threshold", () => {
    const result = evaluatePhoneDetections([{ className: "cell phone", score: 0.5 }], 0.65);
    expect(result.detected).toBe(false);
  });

  it("ignores unrelated classes", () => {
    const result = evaluatePhoneDetections([{ className: "book", score: 0.9 }], 0.65);
    expect(result.detected).toBe(false);
  });

  it("uses PHONE_CONFIDENCE_THRESHOLD (0.45) as the default threshold", () => {
    expect(PHONE_CONFIDENCE_THRESHOLD).toBe(0.45);
    expect(evaluatePhoneDetections([{ className: "cell phone", score: 0.5 }]).detected).toBe(true);
    expect(evaluatePhoneDetections([{ className: "cell phone", score: 0.4 }]).detected).toBe(false);
  });

  it("normalizes label case/whitespace defensively", () => {
    const result = evaluatePhoneDetections([{ className: "  Cell Phone  ", score: 0.6 }], 0.45);
    expect(result.detected).toBe(true);
  });
});

describe("decidePhoneEmission", () => {
  it("3. emits on the first qualifying frame (no consecutive-frame requirement)", () => {
    const decision = decidePhoneEmission({ detected: true, confidence: 0.6 }, true);
    expect(decision.shouldEmit).toBe(true);
  });

  it("4. does not require consecutive frames — a single detected=true call is enough", () => {
    // Unlike decideSecondPersonEmission, there is no consecutiveCount
    // parameter at all: the function's signature itself proves phone
    // detection never waits for a second tick.
    const decisionOnFirstObservation = decidePhoneEmission({ detected: true, confidence: 0.5 }, true);
    expect(decisionOnFirstObservation.shouldEmit).toBe(true);
  });

  it("5. cooldown prevents a repeated/duplicate emission", () => {
    const stillDetected = { detected: true, confidence: 0.6 };
    const firstTick = decidePhoneEmission(stillDetected, true);
    expect(firstTick.shouldEmit).toBe(true);
    // Cooldown not yet elapsed on a later tick where the phone is still visible.
    const secondTick = decidePhoneEmission(stillDetected, false);
    expect(secondTick.shouldEmit).toBe(false);
  });

  it("does not emit when no phone is detected, even if cooldown allows it", () => {
    const decision = decidePhoneEmission({ detected: false, confidence: 0 }, true);
    expect(decision.shouldEmit).toBe(false);
  });

  it("does not emit when cooldown blocks it, even if a phone is detected", () => {
    const decision = decidePhoneEmission({ detected: true, confidence: 0.9 }, false);
    expect(decision.shouldEmit).toBe(false);
    expect(decision.confidenceBand).toBeNull();
  });

  it("reports a confidence band matching bandForConfidence for the detected score", () => {
    const decision = decidePhoneEmission({ detected: true, confidence: 0.9 }, true);
    expect(decision.confidenceBand).toBe(bandForConfidence(0.9));
    expect(decision.confidenceBand).toBe("high");
  });

  it("2. backend logging cooldown does not suppress conditionMet (the local-overlay driver)", () => {
    // The core acknowledge-then-reappear fix: a phone that stays visible
    // keeps conditionMet true even while shouldEmit (backend logging) is
    // suppressed by cooldown.
    const decision = decidePhoneEmission({ detected: true, confidence: 0.9 }, false);
    expect(decision.shouldEmit).toBe(false); // backend still suppressed
    expect(decision.conditionMet).toBe(true); // but the condition itself is still true
  });

  it("3/4. phone overlay reopens after acknowledgement if the phone remains visible (simulated across two ticks)", () => {
    const stillVisible = { detected: true, confidence: 0.7 };
    // Tick 1: first sighting — cooldown is fresh, so both fire.
    const tick1 = decidePhoneEmission(stillVisible, true);
    expect(tick1.shouldEmit).toBe(true);
    expect(tick1.conditionMet).toBe(true);
    // Student acknowledges (a purely local UI action — does not touch
    // the cooldown tracker). Tick 2, ~1s later: cooldown hasn't elapsed
    // yet, so backend logging is suppressed, but the phone is still
    // visible, so conditionMet (and therefore the local overlay) is true again.
    const tick2 = decidePhoneEmission(stillVisible, false);
    expect(tick2.shouldEmit).toBe(false);
    expect(tick2.conditionMet).toBe(true);
  });

  it("4. phone overlay stays cleared after acknowledgement if the phone is gone", () => {
    // Same cooldown-blocked state as above, but the phone has left frame.
    const decision = decidePhoneEmission({ detected: false, confidence: 0 }, false);
    expect(decision.conditionMet).toBe(false);
    expect(decision.shouldEmit).toBe(false);
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

  it("6. second-person logic still requires 2 consecutive checks at normal confidence (unchanged by the phone speed-up)", () => {
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

  it("2. backend cooldown does not suppress conditionMet for high-confidence second-person", () => {
    const decision = decideSecondPersonEmission(
      { personCount: 2, noPersonDetected: false, multiplePersons: true, multiplePersonsHighConfidence: true },
      0,
      false,
    );
    expect(decision.shouldEmit).toBe(false);
    expect(decision.conditionMet).toBe(true);
  });

  it("5. second-person overlay can reopen after acknowledgement if the second person remains visible", () => {
    const twoPeopleNormalConfidence = {
      personCount: 2,
      noPersonDetected: false,
      multiplePersons: true,
      multiplePersonsHighConfidence: false,
    };
    // Tick 1 and 2: consecutive-check rule satisfied on the 2nd tick, cooldown fresh — emits.
    decideSecondPersonEmission(twoPeopleNormalConfidence, 1, true);
    const confirmingTick = decideSecondPersonEmission(twoPeopleNormalConfidence, 2, true);
    expect(confirmingTick.shouldEmit).toBe(true);
    // Acknowledged locally; cooldown now blocks backend re-logging, but
    // the second person is still in frame on tick 3 — conditionMet stays
    // true (consecutive count keeps climbing past the >=2 threshold),
    // so the local overlay can reopen even though shouldEmit is false.
    const afterAcknowledge = decideSecondPersonEmission(twoPeopleNormalConfidence, 3, false);
    expect(afterAcknowledge.shouldEmit).toBe(false);
    expect(afterAcknowledge.conditionMet).toBe(true);
  });

  it("stays cleared after acknowledgement once the second person leaves frame", () => {
    const decision = decideSecondPersonEmission(
      { personCount: 1, noPersonDetected: false, multiplePersons: false, multiplePersonsHighConfidence: false },
      0,
      false,
    );
    expect(decision.conditionMet).toBe(false);
  });
});

describe("decideNoPersonEmission", () => {
  it("requires 3 consecutive no-person checks before the condition is met (unchanged confirmation rule)", () => {
    const noPerson = { personCount: 0, noPersonDetected: true, multiplePersons: false, multiplePersonsHighConfidence: false };
    expect(decideNoPersonEmission(noPerson, 1, true).conditionMet).toBe(false);
    expect(decideNoPersonEmission(noPerson, 2, true).conditionMet).toBe(false);
    expect(decideNoPersonEmission(noPerson, 3, true).conditionMet).toBe(true);
  });

  it("1/8. shouldEmit additionally requires the cooldown to have elapsed (backend spam prevention, unchanged)", () => {
    const noPerson = { personCount: 0, noPersonDetected: true, multiplePersons: false, multiplePersonsHighConfidence: false };
    const cooldownBlocked = decideNoPersonEmission(noPerson, 3, false);
    expect(cooldownBlocked.conditionMet).toBe(true);
    expect(cooldownBlocked.shouldEmit).toBe(false);
  });

  it("6. no-person overlay can reopen after acknowledgement if no person remains visible", () => {
    const noPerson = { personCount: 0, noPersonDetected: true, multiplePersons: false, multiplePersonsHighConfidence: false };
    // Tick 3: confirmation rule satisfied, cooldown fresh — emits and the overlay shows.
    const confirmingTick = decideNoPersonEmission(noPerson, 3, true);
    expect(confirmingTick.shouldEmit).toBe(true);
    // Acknowledged locally. Tick 4: still no person, cooldown still
    // active (backend suppressed), but conditionMet stays true so the
    // local overlay reopens.
    const afterAcknowledge = decideNoPersonEmission(noPerson, 4, false);
    expect(afterAcknowledge.shouldEmit).toBe(false);
    expect(afterAcknowledge.conditionMet).toBe(true);
  });

  it("stays cleared after acknowledgement once a person reappears (consecutive count resets to 0)", () => {
    const personVisible = { personCount: 1, noPersonDetected: false, multiplePersons: false, multiplePersonsHighConfidence: false };
    const decision = decideNoPersonEmission(personVisible, 0, false);
    expect(decision.conditionMet).toBe(false);
  });
});

describe("decideFrameQualityEmission", () => {
  it("requires 2 consecutive matching-quality checks before the condition is met", () => {
    expect(decideFrameQualityEmission(true, 1, true).conditionMet).toBe(false);
    expect(decideFrameQualityEmission(true, 2, true).conditionMet).toBe(true);
  });

  it("shouldEmit additionally requires the cooldown to have elapsed", () => {
    const decision = decideFrameQualityEmission(true, 2, false);
    expect(decision.conditionMet).toBe(true);
    expect(decision.shouldEmit).toBe(false);
  });

  it("does not meet the condition when the quality no longer matches", () => {
    expect(decideFrameQualityEmission(false, 2, true).conditionMet).toBe(false);
  });
});

describe("shouldLogAiIntegrityEvent", () => {
  it("1/8. is true only when the condition is met AND the cooldown has elapsed (backend spam prevention)", () => {
    expect(shouldLogAiIntegrityEvent(true, true)).toBe(true);
    expect(shouldLogAiIntegrityEvent(true, false)).toBe(false);
    expect(shouldLogAiIntegrityEvent(false, true)).toBe(false);
    expect(shouldLogAiIntegrityEvent(false, false)).toBe(false);
  });
});

describe("shouldShowLocalAiOverlay", () => {
  it("2. is true whenever the condition is met, regardless of the backend cooldown", () => {
    // This is the entire point of the fix: the local overlay must never
    // be gated by the same cooldown that protects backend logging.
    expect(shouldShowLocalAiOverlay(true)).toBe(true);
  });

  it("is false when the condition is not currently met", () => {
    expect(shouldShowLocalAiOverlay(false)).toBe(false);
  });
});

describe("no-person consecutive-frame policy (unchanged by the phone speed-up)", () => {
  it("7. NO_PERSON_VISIBLE still requires 3 consecutive no-person checks, not the first one", () => {
    // Mirrors the page's `noPersonCount >= 3` gate, driven by the same
    // DetectionCooldownTracker primitive used for every non-phone signal.
    const tracker = new DetectionCooldownTracker();
    expect(tracker.recordObservation("noPerson", true)).toBe(1); // 1st: not enough yet
    expect(tracker.recordObservation("noPerson", true)).toBe(2); // 2nd: still not enough
    expect(tracker.recordObservation("noPerson", true)).toBe(3); // 3rd: threshold reached
    expect(tracker.getConsecutiveCount("noPerson")).toBe(3);
  });

  it("resets the no-person streak on any frame where a person is visible again", () => {
    const tracker = new DetectionCooldownTracker();
    tracker.recordObservation("noPerson", true);
    tracker.recordObservation("noPerson", true);
    expect(tracker.recordObservation("noPerson", false)).toBe(0);
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

describe("computeNextDetectionDelayMs", () => {
  it("8. chooses the fast interval (~1000ms) when inference is healthy", () => {
    expect(computeNextDetectionDelayMs(200)).toBe(DEFAULT_ADAPTIVE_CADENCE_CONFIG.fastIntervalMs);
    expect(computeNextDetectionDelayMs(200)).toBe(1_000);
    expect(computeNextDetectionDelayMs(900)).toBe(1_000); // exactly at the threshold: still fast
  });

  it("8. chooses the fast interval when no inference has run yet (null)", () => {
    expect(computeNextDetectionDelayMs(null)).toBe(1_000);
  });

  it("9. backs off to the slow interval when inference is slow", () => {
    expect(computeNextDetectionDelayMs(901)).toBe(DEFAULT_ADAPTIVE_CADENCE_CONFIG.slowIntervalMs);
    expect(computeNextDetectionDelayMs(2_000)).toBe(1_500);
  });

  it("respects a custom config", () => {
    const config = { fastIntervalMs: 500, slowIntervalMs: 800, slowInferenceThresholdMs: 400 };
    expect(computeNextDetectionDelayMs(100, config)).toBe(500);
    expect(computeNextDetectionDelayMs(500, config)).toBe(800);
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
