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
  decideVisibilityRestoredEmission,
  shouldLogAiCameraDebug,
  shouldLogAiIntegrityEvent,
  shouldShowLocalAiOverlay,
  DetectionCooldownTracker,
  PHONE_CONFIDENCE_THRESHOLD,
  UNCERTAIN_PERSON_CONFIDENCE_LOWER_BOUND,
  MIN_NO_PERSON_SUSTAINED_DURATION_MS,
  NEUTRAL_CAMERA_VISIBILITY_MESSAGES,
  assertSafeIntegrityMetadata,
  isVideoFrameReady,
  shouldSuppressCameraIntegrityDuringStartup,
  cameraStartupPhase,
  CAMERA_STARTUP_GRACE_PERIOD_MS,
  CAMERA_READY_TIMEOUT_MS,
  classifyCameraStreamHealth,
  decideCameraStreamEmission,
  resolveCameraIntegrityState,
  CAMERA_INTEGRITY_STATES,
  NO_PERSON_MIN_CONSECUTIVE_TICKS,
  MIN_CONSECUTIVE_VISIBLE_FOR_RECOVERY,
  type PersonDetectionResult,
  type CameraIntegrityState,
} from "./cameraIntegrityDetection";

/** Test-fixture helper — fills in bestPersonScore consistently with noPersonDetected/personCount unless a case deliberately overrides it (e.g. an "uncertain" near-threshold reading). */
function personResult(overrides: Partial<PersonDetectionResult> & Pick<PersonDetectionResult, "personCount" | "noPersonDetected">): PersonDetectionResult {
  return {
    multiplePersons: false,
    multiplePersonsHighConfidence: false,
    bestPersonScore: overrides.noPersonDetected ? 0 : 0.8,
    ...overrides,
  };
}

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
    expect(result.bestPersonScore).toBe(0);
  });

  it("bestPersonScore (Part 4) reports the highest raw person-class score even when it's below minConfidence — the 'detector uncertain' signal", () => {
    const result = evaluatePersonDetections([{ className: "person", score: 0.45 }], 0.6);
    expect(result.noPersonDetected).toBe(true);
    expect(result.bestPersonScore).toBe(0.45);
  });

  it("bestPersonScore reports the highest of several person-class scores, not just the first", () => {
    const result = evaluatePersonDetections(
      [
        { className: "person", score: 0.2 },
        { className: "person", score: 0.55 },
        { className: "cell phone", score: 0.9 },
      ],
      0.6,
    );
    expect(result.bestPersonScore).toBe(0.55);
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
      personResult({ personCount: 2, noPersonDetected: false, multiplePersons: true, multiplePersonsHighConfidence: true }),
      0,
      true,
    );
    expect(decision.shouldEmit).toBe(true);
    expect(decision.confidenceBand).toBe("high");
  });

  it("6. second-person logic still requires 2 consecutive checks at normal confidence (unchanged by the phone speed-up)", () => {
    const decision = decideSecondPersonEmission(
      personResult({ personCount: 2, noPersonDetected: false, multiplePersons: true, multiplePersonsHighConfidence: false }),
      1,
      true,
    );
    expect(decision.shouldEmit).toBe(false);
  });

  it("emits on second consecutive tick for normal-confidence multi-person", () => {
    const decision = decideSecondPersonEmission(
      personResult({ personCount: 2, noPersonDetected: false, multiplePersons: true, multiplePersonsHighConfidence: false }),
      2,
      true,
    );
    expect(decision.shouldEmit).toBe(true);
    expect(decision.confidenceBand).toBe("medium");
  });

  it("respects cooldown even for high-confidence detection", () => {
    const decision = decideSecondPersonEmission(
      personResult({ personCount: 2, noPersonDetected: false, multiplePersons: true, multiplePersonsHighConfidence: true }),
      0,
      false,
    );
    expect(decision.shouldEmit).toBe(false);
    expect(decision.confidenceBand).toBeNull();
  });

  it("does not emit when multiplePersons is false", () => {
    const decision = decideSecondPersonEmission(
      personResult({ personCount: 1, noPersonDetected: false, multiplePersons: false, multiplePersonsHighConfidence: false }),
      2,
      true,
    );
    expect(decision.shouldEmit).toBe(false);
  });

  it("2. backend cooldown does not suppress conditionMet for high-confidence second-person", () => {
    const decision = decideSecondPersonEmission(
      personResult({ personCount: 2, noPersonDetected: false, multiplePersons: true, multiplePersonsHighConfidence: true }),
      0,
      false,
    );
    expect(decision.shouldEmit).toBe(false);
    expect(decision.conditionMet).toBe(true);
  });

  it("5. second-person overlay can reopen after acknowledgement if the second person remains visible", () => {
    const twoPeopleNormalConfidence = personResult({
      personCount: 2,
      noPersonDetected: false,
      multiplePersons: true,
      multiplePersonsHighConfidence: false,
    });
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
      personResult({ personCount: 1, noPersonDetected: false, multiplePersons: false, multiplePersonsHighConfidence: false }),
      0,
      false,
    );
    expect(decision.conditionMet).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Face-visibility false-positive fix (corrective pass v1.2.0, Part 4):
// decideNoPersonEmission now takes (person, frameQuality, consecutiveCount,
// streakDurationMs, cooldownOk) and separates FIVE states — adequate image
// + face visible; adequate image + sustained face absent (CONFIRMED);
// insufficient lighting; detector uncertain; camera interruption (handled
// upstream by suppressStartup, unchanged) — never conflating "the room is
// dark" or "the detector isn't sure" with "no student visible appears".
// ---------------------------------------------------------------------------

describe("decideNoPersonEmission", () => {
  const SUSTAINED = MIN_NO_PERSON_SUSTAINED_DURATION_MS;
  const noPersonConfident = personResult({ personCount: 0, noPersonDetected: true, multiplePersons: false, multiplePersonsHighConfidence: false, bestPersonScore: 0 });

  it("adequate image + face visible: never confirms absence, regardless of streak bookkeeping", () => {
    const personVisible = personResult({ personCount: 1, noPersonDetected: false });
    const decision = decideNoPersonEmission(personVisible, "ok", 5, SUSTAINED, true);
    expect(decision.conditionMet).toBe(false);
    expect(decision.qualifier).toBeNull();
  });

  it("requires 3 consecutive no-person checks AND the sustained duration before the condition is met (adequate lighting throughout)", () => {
    expect(decideNoPersonEmission(noPersonConfident, "ok", 1, SUSTAINED, true).conditionMet).toBe(false);
    expect(decideNoPersonEmission(noPersonConfident, "ok", 2, SUSTAINED, true).conditionMet).toBe(false);
    const confirmed = decideNoPersonEmission(noPersonConfident, "ok", 3, SUSTAINED, true);
    expect(confirmed.conditionMet).toBe(true);
    expect(confirmed.qualifier).toBe("CONFIRMED");
  });

  it("sustained-duration requirement: 3 consecutive ticks is not enough on its own if the streak hasn't run long enough yet", () => {
    const decision = decideNoPersonEmission(noPersonConfident, "ok", 3, SUSTAINED - 1, true);
    expect(decision.conditionMet).toBe(false);
  });

  it("1/8. shouldEmit additionally requires the cooldown to have elapsed (backend spam prevention, unchanged)", () => {
    const cooldownBlocked = decideNoPersonEmission(noPersonConfident, "ok", 3, SUSTAINED, false);
    expect(cooldownBlocked.conditionMet).toBe(true);
    expect(cooldownBlocked.shouldEmit).toBe(false);
  });

  it("6. no-person overlay can reopen after acknowledgement if no person remains visible", () => {
    // Tick 3: confirmation rule satisfied, cooldown fresh — emits and the overlay shows.
    const confirmingTick = decideNoPersonEmission(noPersonConfident, "ok", 3, SUSTAINED, true);
    expect(confirmingTick.shouldEmit).toBe(true);
    // Acknowledged locally. Tick 4: still no person, cooldown still
    // active (backend suppressed), but conditionMet stays true so the
    // local overlay reopens.
    const afterAcknowledge = decideNoPersonEmission(noPersonConfident, "ok", 4, SUSTAINED + 1000, false);
    expect(afterAcknowledge.shouldEmit).toBe(false);
    expect(afterAcknowledge.conditionMet).toBe(true);
  });

  it("stays cleared after acknowledgement once a person reappears (consecutive count/streak duration reset to 0)", () => {
    const personVisible = personResult({ personCount: 1, noPersonDetected: false });
    const decision = decideNoPersonEmission(personVisible, "ok", 0, 0, false);
    expect(decision.conditionMet).toBe(false);
  });

  it("insufficient lighting must not produce 'No student visible' — the bug this fix corrects: a dark frame previously satisfied the no-person streak on its own", () => {
    for (const quality of ["dark", "blocked"] as const) {
      const decision = decideNoPersonEmission(noPersonConfident, quality, 5, SUSTAINED, true);
      expect(decision.conditionMet).toBe(false);
      expect(decision.shouldEmit).toBe(false);
      expect(decision.qualifier).toBe("LIGHTING_INSUFFICIENT");
    }
  });

  it("detector uncertain: a near-threshold person-class score is never reported as confirmed absence", () => {
    const uncertain = personResult({ personCount: 0, noPersonDetected: true, bestPersonScore: UNCERTAIN_PERSON_CONFIDENCE_LOWER_BOUND });
    const decision = decideNoPersonEmission(uncertain, "ok", 5, SUSTAINED, true);
    expect(decision.conditionMet).toBe(false);
    expect(decision.qualifier).toBe("UNCERTAIN");
  });

  it("a genuinely empty room (score well below the uncertain band) still confirms absence given adequate lighting and a sustained streak", () => {
    const genuinelyEmpty = personResult({ personCount: 0, noPersonDetected: true, bestPersonScore: UNCERTAIN_PERSON_CONFIDENCE_LOWER_BOUND - 0.1 });
    const decision = decideNoPersonEmission(genuinelyEmpty, "ok", 3, SUSTAINED, true);
    expect(decision.conditionMet).toBe(true);
    expect(decision.qualifier).toBe("CONFIRMED");
  });

  it("uses the exact required neutral copy for each qualifier", () => {
    expect(NEUTRAL_CAMERA_VISIBILITY_MESSAGES.LIGHTING_INSUFFICIENT).toBe("Lighting is too low to verify camera visibility.");
    expect(NEUTRAL_CAMERA_VISIBILITY_MESSAGES.UNCERTAIN).toBe("Camera visibility is temporarily uncertain.");
    expect(NEUTRAL_CAMERA_VISIBILITY_MESSAGES.CONFIRMED).toBe("Face not visible for a sustained period.");
  });
});

describe("decideVisibilityRestoredEmission", () => {
  it("fires only after a genuinely CONFIRMED no-person episode resolves to a confidently-visible person", () => {
    expect(decideVisibilityRestoredEmission(true, true, true).shouldEmit).toBe(true);
  });

  it("never fires if the previous episode was never CONFIRMED (e.g. it was only LIGHTING_INSUFFICIENT/UNCERTAIN and froze)", () => {
    expect(decideVisibilityRestoredEmission(false, true, true).shouldEmit).toBe(false);
  });

  it("never fires while no person is currently confidently visible", () => {
    expect(decideVisibilityRestoredEmission(true, false, true).shouldEmit).toBe(false);
  });

  it("respects its own cooldown", () => {
    expect(decideVisibilityRestoredEmission(true, true, false).shouldEmit).toBe(false);
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

  // Sustained-duration requirement (Part 4 of the corrective pass) —
  // getStreakDurationMs tracks how long the CURRENT streak has been
  // running, independent of the tick count, so decideNoPersonEmission
  // can require a minimum elapsed time (not just a minimum tick count,
  // which is sensitive to the adaptive detection cadence).
  describe("getStreakDurationMs", () => {
    it("is 0 when there is no active streak", () => {
      const tracker = new DetectionCooldownTracker();
      expect(tracker.getStreakDurationMs("noPerson", 10_000)).toBe(0);
    });

    it("tracks elapsed time since the streak began, not since the last observation", () => {
      const tracker = new DetectionCooldownTracker();
      tracker.recordObservation("noPerson", true, 1_000);
      tracker.recordObservation("noPerson", true, 2_000);
      tracker.recordObservation("noPerson", true, 3_000);
      expect(tracker.getStreakDurationMs("noPerson", 4_000)).toBe(3_000);
    });

    it("resets to 0 the moment the streak breaks (a single missed tick)", () => {
      const tracker = new DetectionCooldownTracker();
      tracker.recordObservation("noPerson", true, 1_000);
      tracker.recordObservation("noPerson", false, 2_000);
      expect(tracker.getStreakDurationMs("noPerson", 3_000)).toBe(0);
    });

    it("reset() also clears streak-start bookkeeping", () => {
      const tracker = new DetectionCooldownTracker();
      tracker.recordObservation("noPerson", true, 1_000);
      tracker.reset();
      expect(tracker.getStreakDurationMs("noPerson", 5_000)).toBe(0);
    });
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

// Camera Startup Readiness v1 — see
// docs/on-device-ai-integrity-detection-v1.md ("Camera startup
// readiness"). Fixes false CAMERA_VIEW_BLOCKED/CAMERA_TOO_DARK/
// NO_PERSON_VISIBLE on first exam start, caused by transiently black/
// dark/artifacted frames while the camera's auto-exposure/auto-focus
// settle, even after readyState/videoWidth/videoHeight already report
// the video as playable.
describe("isVideoFrameReady", () => {
  it("1. is false when videoWidth or videoHeight is 0", () => {
    expect(isVideoFrameReady({ readyState: 4, videoWidth: 0, videoHeight: 480 })).toBe(false);
    expect(isVideoFrameReady({ readyState: 4, videoWidth: 640, videoHeight: 0 })).toBe(false);
  });

  it("2. is false when readyState is below HAVE_CURRENT_DATA (2)", () => {
    expect(isVideoFrameReady({ readyState: 0, videoWidth: 640, videoHeight: 480 })).toBe(false);
    expect(isVideoFrameReady({ readyState: 1, videoWidth: 640, videoHeight: 480 })).toBe(false);
  });

  it("3. is true when readyState >= 2 and both dimensions are non-zero", () => {
    expect(isVideoFrameReady({ readyState: 2, videoWidth: 640, videoHeight: 480 })).toBe(true);
    expect(isVideoFrameReady({ readyState: 4, videoWidth: 320, videoHeight: 240 })).toBe(true);
  });

  it("is false when there is no video element at all", () => {
    expect(isVideoFrameReady(null)).toBe(false);
    expect(isVideoFrameReady(undefined)).toBe(false);
  });
});

describe("shouldSuppressCameraIntegrityDuringStartup", () => {
  it("suppresses when no ready frame has ever been observed", () => {
    expect(shouldSuppressCameraIntegrityDuringStartup(null, Date.now())).toBe(true);
  });

  it("suppresses within the grace period after the first ready frame", () => {
    const firstReadyFrameAt = 1_000;
    expect(shouldSuppressCameraIntegrityDuringStartup(firstReadyFrameAt, 1_000, 3_000)).toBe(true);
    expect(shouldSuppressCameraIntegrityDuringStartup(firstReadyFrameAt, 3_999, 3_000)).toBe(true);
  });

  it("9/10. allows emission once the grace period has elapsed", () => {
    const firstReadyFrameAt = 1_000;
    expect(shouldSuppressCameraIntegrityDuringStartup(firstReadyFrameAt, 4_000, 3_000)).toBe(false);
    expect(shouldSuppressCameraIntegrityDuringStartup(firstReadyFrameAt, 10_000, 3_000)).toBe(false);
  });

  it("uses the default 3000ms grace period when none is given", () => {
    expect(CAMERA_STARTUP_GRACE_PERIOD_MS).toBe(3_000);
    expect(shouldSuppressCameraIntegrityDuringStartup(0, 2_999)).toBe(true);
    expect(shouldSuppressCameraIntegrityDuringStartup(0, 3_000)).toBe(false);
  });

  it("11. re-suppresses after a restart resets firstReadyFrameAt to null", () => {
    // Simulates: camera was ready and past its grace period, then the
    // stream was lost and restarted (caller resets firstReadyFrameAt).
    expect(shouldSuppressCameraIntegrityDuringStartup(1_000, 10_000, 3_000)).toBe(false);
    expect(shouldSuppressCameraIntegrityDuringStartup(null, 10_001, 3_000)).toBe(true);
  });
});

describe("cameraStartupPhase", () => {
  it("is 'waiting_for_first_frame' before any ready frame and before the timeout", () => {
    expect(
      cameraStartupPhase({ firstReadyFrameAt: null, now: 5_000, streamStartedAt: 1_000 }),
    ).toBe("waiting_for_first_frame");
  });

  it("is 'warming_up' during the grace period after the first ready frame", () => {
    expect(
      cameraStartupPhase({ firstReadyFrameAt: 1_000, now: 2_000, streamStartedAt: 500, gracePeriodMs: 3_000 }),
    ).toBe("warming_up");
  });

  it("is 'ready' once the grace period has elapsed", () => {
    expect(
      cameraStartupPhase({ firstReadyFrameAt: 1_000, now: 5_000, streamStartedAt: 500, gracePeriodMs: 3_000 }),
    ).toBe("ready");
  });

  it("is 'timed_out' if no ready frame ever arrives within the timeout", () => {
    expect(CAMERA_READY_TIMEOUT_MS).toBe(15_000);
    expect(
      cameraStartupPhase({
        firstReadyFrameAt: null,
        now: 20_000,
        streamStartedAt: 1_000,
        readyTimeoutMs: 15_000,
      }),
    ).toBe("timed_out");
  });

  it("never times out once a ready frame has actually arrived, even much later", () => {
    expect(
      cameraStartupPhase({
        firstReadyFrameAt: 1_000,
        now: 100_000,
        streamStartedAt: 500,
        gracePeriodMs: 3_000,
        readyTimeoutMs: 15_000,
      }),
    ).toBe("ready");
  });
});

describe("camera startup suppression combined with phone/second-person decisions", () => {
  it("12. decidePhoneEmission's emit-on-first-frame rule is unaffected by the readiness gate itself — the caller (student page) is what forces the decision to 'not detected' during suppression, this function stays fast either way", () => {
    // decidePhoneEmission has no knowledge of camera startup at all — it
    // always emits on the very first qualifying detection, exactly as
    // before this fix. The student page is responsible for not calling
    // it with a real phone detection during suppression (it substitutes
    // a forced { conditionMet: false, shouldEmit: false } instead — see
    // src/app/student/exams/[id]/page.tsx). This test pins that
    // decidePhoneEmission's own behavior — the fast, no-consecutive-wait
    // rule phone detection depends on — never regresses.
    const decision = decidePhoneEmission({ detected: true, confidence: 0.9 }, true);
    expect(decision.conditionMet).toBe(true);
    expect(decision.shouldEmit).toBe(true);
  });

  it("13. once suppression ends (grace period elapsed), a real detection is no longer suppressed", () => {
    const firstReadyFrameAt = 1_000;
    const now = firstReadyFrameAt + CAMERA_STARTUP_GRACE_PERIOD_MS + 1;
    expect(shouldSuppressCameraIntegrityDuringStartup(firstReadyFrameAt, now)).toBe(false);
    // With suppression false, the student page uses the real decision —
    // confirm decidePhoneEmission emits immediately once actually called.
    const decision = decidePhoneEmission({ detected: true, confidence: 0.9 }, true);
    expect(decision.shouldEmit).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Corrective pass v1.2.2, Task 8. Physical testing showed repeated
// Chromium/Windows Media Foundation "Failed to reserve output capture
// buffer" errors while Microsoft Teams held the camera, which was
// silently feeding a stale/frozen frame into person-detection and
// eventually reporting NO_PERSON_VISIBLE. classifyCameraStreamHealth /
// decideCameraStreamEmission are the fix: a capture-level interruption
// must be classified and reported as CAMERA_STREAM_UNAVAILABLE, never as
// face absence.
// ---------------------------------------------------------------------------

describe("classifyCameraStreamHealth", () => {
  it("a live, unmuted track is healthy", () => {
    expect(classifyCameraStreamHealth({ readyState: "live", muted: false })).toBe("ok");
  });

  it("no track at all (stream torn down) is unavailable", () => {
    expect(classifyCameraStreamHealth(null)).toBe("unavailable");
    expect(classifyCameraStreamHealth(undefined)).toBe("unavailable");
  });

  it("a muted track is unavailable — this is exactly the signal a capture-buffer reservation failure produces", () => {
    expect(classifyCameraStreamHealth({ readyState: "live", muted: true })).toBe("unavailable");
  });

  it("an ended track is unavailable", () => {
    expect(classifyCameraStreamHealth({ readyState: "ended", muted: false })).toBe("unavailable");
  });
});

describe("decideCameraStreamEmission", () => {
  it("a single unhealthy tick does not yet emit (requires 2 consecutive, same rule as CAMERA_VIEW_BLOCKED/CAMERA_TOO_DARK)", () => {
    const decision = decideCameraStreamEmission("unavailable", 1, true);
    expect(decision.conditionMet).toBe(false);
    expect(decision.shouldEmit).toBe(false);
  });

  it("2 consecutive unhealthy ticks with cooldown available emits", () => {
    const decision = decideCameraStreamEmission("unavailable", 2, true);
    expect(decision.conditionMet).toBe(true);
    expect(decision.shouldEmit).toBe(true);
  });

  it("condition met but cooldown not yet elapsed: conditionMet true, shouldEmit false", () => {
    const decision = decideCameraStreamEmission("unavailable", 3, false);
    expect(decision.conditionMet).toBe(true);
    expect(decision.shouldEmit).toBe(false);
  });

  it("a healthy stream never triggers this emission regardless of consecutive count", () => {
    const decision = decideCameraStreamEmission("ok", 5, true);
    expect(decision.conditionMet).toBe(false);
    expect(decision.shouldEmit).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Camera integrity reliability pass. resolveCameraIntegrityState is the
// single source of truth combining stream health, frame quality, and
// person detection + hysteresis counters into exactly one of the six
// named states. These tests cover every scenario listed in the task:
// ended stream, muted stream, missing track, frozen/unavailable frames,
// low light, uncertain confidence, one weak frame, sustained reliable
// absence, duplicate-event cooldown, stable recovery, and — the single
// most important property — a stream failure never becoming
// SUSTAINED_NO_PERSON_VISIBLE.
// ---------------------------------------------------------------------------

function baseCameraStateParams(overrides: Partial<Parameters<typeof resolveCameraIntegrityState>[0]> = {}): Parameters<typeof resolveCameraIntegrityState>[0] {
  return {
    streamHealth: "ok",
    frameQuality: "ok",
    person: personResult({ personCount: 1, noPersonDetected: false, bestPersonScore: 0.9 }),
    noPersonConsecutiveCount: 0,
    noPersonStreakDurationMs: 0,
    visibleConsecutiveCount: 0,
    wasSustainedNoPersonVisible: false,
    ...overrides,
  };
}

describe("CAMERA_INTEGRITY_STATES", () => {
  it("names exactly the six required states", () => {
    expect([...CAMERA_INTEGRITY_STATES].sort()).toEqual(
      [
        "CAMERA_VISIBLE",
        "LIGHTING_TOO_LOW",
        "CAMERA_VISIBILITY_UNCERTAIN",
        "CAMERA_STREAM_UNAVAILABLE",
        "SUSTAINED_NO_PERSON_VISIBLE",
        "CAMERA_VISIBILITY_RESTORED",
      ].sort(),
    );
  });
});

describe("resolveCameraIntegrityState", () => {
  it("a confidently visible person with a healthy stream and good light is CAMERA_VISIBLE", () => {
    expect(resolveCameraIntegrityState(baseCameraStateParams())).toBe("CAMERA_VISIBLE");
  });

  // --- Stream failure: ended / muted / missing track / frozen ---------

  it("an ENDED track reports CAMERA_STREAM_UNAVAILABLE, never a person-detection state, regardless of what the (necessarily stale) frame content might otherwise suggest", () => {
    const state = resolveCameraIntegrityState(
      baseCameraStateParams({
        streamHealth: "unavailable", // classifyCameraStreamHealth({readyState:"ended", muted:false}) -> "unavailable"
        person: personResult({ personCount: 0, noPersonDetected: true, bestPersonScore: 0 }),
        noPersonConsecutiveCount: 10,
        noPersonStreakDurationMs: 60_000,
      }),
    );
    expect(state).toBe("CAMERA_STREAM_UNAVAILABLE");
  });

  it("a MUTED track (the Windows Media Foundation capture-buffer-failure signal) reports CAMERA_STREAM_UNAVAILABLE, not SUSTAINED_NO_PERSON_VISIBLE", () => {
    expect(classifyCameraStreamHealth({ readyState: "live", muted: true })).toBe("unavailable");
    const state = resolveCameraIntegrityState(
      baseCameraStateParams({
        streamHealth: "unavailable",
        person: personResult({ personCount: 0, noPersonDetected: true, bestPersonScore: 0 }),
        noPersonConsecutiveCount: 10,
        noPersonStreakDurationMs: 60_000,
      }),
    );
    expect(state).toBe("CAMERA_STREAM_UNAVAILABLE");
  });

  it("a MISSING track (no track at all) reports CAMERA_STREAM_UNAVAILABLE", () => {
    expect(classifyCameraStreamHealth(null)).toBe("unavailable");
    expect(classifyCameraStreamHealth(undefined)).toBe("unavailable");
  });

  it("a FROZEN stream — readyState/dimensions stay stale at their last good values, which is exactly why stream health is checked independently of frame content — still reports CAMERA_STREAM_UNAVAILABLE once classified unavailable, never inferred from pixel data", () => {
    // The whole point of classifyCameraStreamHealth (see its doc comment)
    // is that a frozen frame's own readyState/dimensions can look
    // perfectly fine — this test documents that resolveCameraIntegrityState
    // trusts the pre-classified streamHealth input entirely and never
    // second-guesses it from frameQuality/person data.
    const state = resolveCameraIntegrityState(
      baseCameraStateParams({
        streamHealth: "unavailable",
        frameQuality: "ok", // the stale/frozen frame's own quality metrics can still read "ok"
        person: personResult({ personCount: 1, noPersonDetected: false, bestPersonScore: 0.9 }), // even a stale frame that LOOKS like a visible person
      }),
    );
    expect(state).toBe("CAMERA_STREAM_UNAVAILABLE");
  });

  it("stream failure never becomes SUSTAINED_NO_PERSON_VISIBLE under ANY combination of person/streak inputs — the single most important property this task requires", () => {
    const noPersonInputs = [
      { noPersonDetected: true, bestPersonScore: 0 },
      { noPersonDetected: true, bestPersonScore: 0.5 }, // would otherwise be "uncertain"
      { noPersonDetected: false, bestPersonScore: 0.9 }, // would otherwise be visible
    ];
    for (const personOverride of noPersonInputs) {
      for (const noPersonConsecutiveCount of [0, 1, 3, 10]) {
        for (const noPersonStreakDurationMs of [0, 1_000, 5_000]) {
          const state = resolveCameraIntegrityState(
            baseCameraStateParams({
              streamHealth: "unavailable",
              person: personResult({ personCount: personOverride.noPersonDetected ? 0 : 1, ...personOverride }),
              noPersonConsecutiveCount,
              noPersonStreakDurationMs,
              wasSustainedNoPersonVisible: true, // even mid-recovery bookkeeping must not leak through
            }),
          );
          expect(state).toBe("CAMERA_STREAM_UNAVAILABLE");
        }
      }
    }
  });

  // --- Low light ---------------------------------------------------------

  it("dark frame quality reports LIGHTING_TOO_LOW, never SUSTAINED_NO_PERSON_VISIBLE even with a fully-absent-looking person reading", () => {
    const state = resolveCameraIntegrityState(
      baseCameraStateParams({
        frameQuality: "dark",
        person: personResult({ personCount: 0, noPersonDetected: true, bestPersonScore: 0 }),
        noPersonConsecutiveCount: 5,
        noPersonStreakDurationMs: 10_000,
      }),
    );
    expect(state).toBe("LIGHTING_TOO_LOW");
  });

  it("a blocked (covered lens) frame is also reported via LIGHTING_TOO_LOW's freeze path, not as absence — CAMERA_VIEW_BLOCKED remains the separate, unaffected event for that specific case", () => {
    const state = resolveCameraIntegrityState(baseCameraStateParams({ frameQuality: "blocked" }));
    expect(state).toBe("LIGHTING_TOO_LOW");
  });

  // --- Detector uncertainty ------------------------------------------

  it("a near-threshold person score reports CAMERA_VISIBILITY_UNCERTAIN, neither visible nor absent", () => {
    const state = resolveCameraIntegrityState(
      baseCameraStateParams({ person: personResult({ personCount: 0, noPersonDetected: true, bestPersonScore: UNCERTAIN_PERSON_CONFIDENCE_LOWER_BOUND }) }),
    );
    expect(state).toBe("CAMERA_VISIBILITY_UNCERTAIN");
  });

  it("a score just below the uncertain band is genuine absence, not uncertainty", () => {
    const state = resolveCameraIntegrityState(
      baseCameraStateParams({
        person: personResult({ personCount: 0, noPersonDetected: true, bestPersonScore: UNCERTAIN_PERSON_CONFIDENCE_LOWER_BOUND - 0.01 }),
        noPersonConsecutiveCount: NO_PERSON_MIN_CONSECUTIVE_TICKS,
        noPersonStreakDurationMs: MIN_NO_PERSON_SUSTAINED_DURATION_MS,
      }),
    );
    expect(state).toBe("SUSTAINED_NO_PERSON_VISIBLE");
  });

  // --- Sustained absence: multiple consecutive frames + minimum duration ---

  it("one weak (absent) frame alone is not enough — reports CAMERA_VISIBLE-adjacent non-sustained state, never SUSTAINED_NO_PERSON_VISIBLE", () => {
    const state = resolveCameraIntegrityState(
      baseCameraStateParams({
        person: personResult({ personCount: 0, noPersonDetected: true, bestPersonScore: 0 }),
        noPersonConsecutiveCount: 1,
        noPersonStreakDurationMs: 500,
      }),
    );
    expect(state).not.toBe("SUSTAINED_NO_PERSON_VISIBLE");
  });

  it("enough consecutive ticks but not yet enough elapsed duration is not sustained", () => {
    const state = resolveCameraIntegrityState(
      baseCameraStateParams({
        person: personResult({ personCount: 0, noPersonDetected: true, bestPersonScore: 0 }),
        noPersonConsecutiveCount: NO_PERSON_MIN_CONSECUTIVE_TICKS,
        noPersonStreakDurationMs: MIN_NO_PERSON_SUSTAINED_DURATION_MS - 1,
      }),
    );
    expect(state).not.toBe("SUSTAINED_NO_PERSON_VISIBLE");
  });

  it("sustained reliable absence — enough consecutive usable frames AND enough elapsed duration AND adequate lighting AND confidence below the person threshold — reports SUSTAINED_NO_PERSON_VISIBLE", () => {
    const state = resolveCameraIntegrityState(
      baseCameraStateParams({
        frameQuality: "ok",
        person: personResult({ personCount: 0, noPersonDetected: true, bestPersonScore: 0 }),
        noPersonConsecutiveCount: NO_PERSON_MIN_CONSECUTIVE_TICKS,
        noPersonStreakDurationMs: MIN_NO_PERSON_SUSTAINED_DURATION_MS,
      }),
    );
    expect(state).toBe("SUSTAINED_NO_PERSON_VISIBLE");
  });

  // --- Stable recovery (hysteresis) -----------------------------------

  it("recovering from a sustained absence: a single visible frame is not enough to clear it — still reports SUSTAINED_NO_PERSON_VISIBLE, never a bare CAMERA_VISIBLE", () => {
    const state = resolveCameraIntegrityState(
      baseCameraStateParams({
        person: personResult({ personCount: 1, noPersonDetected: false, bestPersonScore: 0.9 }),
        visibleConsecutiveCount: 1,
        wasSustainedNoPersonVisible: true,
      }),
    );
    expect(state).toBe("SUSTAINED_NO_PERSON_VISIBLE");
  });

  it("recovering with enough consecutive visible frames reports the one-time CAMERA_VISIBILITY_RESTORED transition", () => {
    const state = resolveCameraIntegrityState(
      baseCameraStateParams({
        person: personResult({ personCount: 1, noPersonDetected: false, bestPersonScore: 0.9 }),
        visibleConsecutiveCount: MIN_CONSECUTIVE_VISIBLE_FOR_RECOVERY,
        wasSustainedNoPersonVisible: true,
      }),
    );
    expect(state).toBe("CAMERA_VISIBILITY_RESTORED");
  });

  it("recovery is never reported unless there WAS a prior sustained absence — a freshly-visible student with no absence history is just CAMERA_VISIBLE", () => {
    const state = resolveCameraIntegrityState(
      baseCameraStateParams({
        person: personResult({ personCount: 1, noPersonDetected: false, bestPersonScore: 0.9 }),
        visibleConsecutiveCount: 10,
        wasSustainedNoPersonVisible: false,
      }),
    );
    expect(state).toBe("CAMERA_VISIBLE");
  });
});

describe("decideVisibilityRestoredEmission — duplicate-event cooldown", () => {
  it("emits once when a confirmed absence resolves to confident visibility with cooldown available", () => {
    expect(decideVisibilityRestoredEmission(true, true, true).shouldEmit).toBe(true);
  });

  it("a second call while the cooldown has not yet elapsed does not re-emit (duplicate-event protection)", () => {
    // Simulates the caller's own cooldown tracker reporting `false` on a
    // subsequent tick immediately after the first emission — exactly
    // what markEmitted()/canEmit() achieve together in the real tick.
    expect(decideVisibilityRestoredEmission(true, true, false).shouldEmit).toBe(false);
  });

  it("never emits when there was nothing to recover from (no prior confirmed absence)", () => {
    expect(decideVisibilityRestoredEmission(false, true, true).shouldEmit).toBe(false);
  });
});

describe("integration: the full camera-state pipeline never conflates a stream failure with confirmed absence, across a realistic sequence of ticks", () => {
  it("walks through startup -> visible -> confirmed absence -> stream failure mid-episode -> recovery, asserting the state at each step", () => {
    const steps: Array<{ params: Parameters<typeof resolveCameraIntegrityState>[0]; expected: CameraIntegrityState }> = [
      {
        params: baseCameraStateParams(),
        expected: "CAMERA_VISIBLE",
      },
      {
        params: baseCameraStateParams({
          person: personResult({ personCount: 0, noPersonDetected: true, bestPersonScore: 0 }),
          noPersonConsecutiveCount: 1,
          noPersonStreakDurationMs: 500,
        }),
        expected: "CAMERA_VISIBLE", // one weak frame is not yet sustained
      },
      {
        params: baseCameraStateParams({
          person: personResult({ personCount: 0, noPersonDetected: true, bestPersonScore: 0 }),
          noPersonConsecutiveCount: NO_PERSON_MIN_CONSECUTIVE_TICKS,
          noPersonStreakDurationMs: MIN_NO_PERSON_SUSTAINED_DURATION_MS,
        }),
        expected: "SUSTAINED_NO_PERSON_VISIBLE",
      },
      {
        // Camera fails (another app grabs it) WHILE the episode is still
        // open — must report the stream failure, never keep reporting
        // (or silently re-derive) SUSTAINED_NO_PERSON_VISIBLE.
        params: baseCameraStateParams({
          streamHealth: "unavailable",
          person: personResult({ personCount: 0, noPersonDetected: true, bestPersonScore: 0 }),
          noPersonConsecutiveCount: NO_PERSON_MIN_CONSECUTIVE_TICKS + 2,
          noPersonStreakDurationMs: MIN_NO_PERSON_SUSTAINED_DURATION_MS + 5_000,
          wasSustainedNoPersonVisible: true,
        }),
        expected: "CAMERA_STREAM_UNAVAILABLE",
      },
      {
        // Stream recovers, student now visible but not yet stable.
        params: baseCameraStateParams({
          person: personResult({ personCount: 1, noPersonDetected: false, bestPersonScore: 0.9 }),
          visibleConsecutiveCount: 1,
          wasSustainedNoPersonVisible: true,
        }),
        expected: "SUSTAINED_NO_PERSON_VISIBLE",
      },
      {
        // Stable now — recovery reported.
        params: baseCameraStateParams({
          person: personResult({ personCount: 1, noPersonDetected: false, bestPersonScore: 0.9 }),
          visibleConsecutiveCount: MIN_CONSECUTIVE_VISIBLE_FOR_RECOVERY,
          wasSustainedNoPersonVisible: true,
        }),
        expected: "CAMERA_VISIBILITY_RESTORED",
      },
    ];
    for (const step of steps) {
      expect(resolveCameraIntegrityState(step.params)).toBe(step.expected);
    }
  });
});
