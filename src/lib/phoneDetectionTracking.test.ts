/**
 * Strengthened phone detection — pure tests. See
 * docs/phone-detection-calibration-v1.md and src/lib/phoneDetectionTracking.ts.
 *
 * Covers as much of the ~26-item test list from the "Strengthen angled,
 * low-position and partially visible phone detection" task as maps onto
 * PURE functions. Items that are inherently DOM/integration-level (e.g.
 * "pre-READY detections cannot create tracks" — enforced by the caller in
 * src/app/student/exams/[id]/page.tsx gating tracker.update() behind
 * `suppressStartup`, not by the tracker itself) are noted inline rather
 * than faked with a jsdom-free approximation.
 */
import { describe, expect, it } from "vitest";
import {
  PHONE_CONFIDENCE_STRONG,
  PHONE_CONFIDENCE_MODERATE,
  PHONE_CONFIDENCE_WEAK,
  PHONE_DETECTION_ALGORITHM_VERSION,
  phoneConfidenceBand,
  boxArea,
  boxIoU,
  boxCenterDistance,
  boxSizeSimilarity,
  isPlausiblePhoneGeometry,
  visibleAreaEstimate,
  touchesFrameEdge,
  dedupeObservations,
  PhoneCandidateTracker,
  TRACK_MAX_MISSED_FRAMES,
  TRACK_CONFIRM_MODERATE_COUNT,
  TRACK_CONFIRM_MODERATE_EDGE_COUNT,
  MAX_ACTIVE_PHONE_TRACKS,
  shouldRunSecondStageVerification,
  expandCandidateBoxForVerification,
  phoneEvidenceTier,
  type NormalizedBox,
  type PhoneObservation,
} from "./phoneDetectionTracking";

function box(x: number, y: number, width: number, height: number): NormalizedBox {
  return { x, y, width, height };
}

function obs(x: number, y: number, w: number, h: number, score: number, source: PhoneObservation["source"] = "full_frame"): PhoneObservation {
  return { box: box(x, y, w, h), score, source };
}

describe("confidence bands", () => {
  it("bands are ordered and versioned (test 24)", () => {
    expect(PHONE_CONFIDENCE_STRONG).toBeGreaterThan(PHONE_CONFIDENCE_MODERATE);
    expect(PHONE_CONFIDENCE_MODERATE).toBeGreaterThan(PHONE_CONFIDENCE_WEAK);
    expect(PHONE_CONFIDENCE_WEAK).toBeGreaterThan(0);
    expect(typeof PHONE_DETECTION_ALGORITHM_VERSION).toBe("string");
    expect(PHONE_DETECTION_ALGORITHM_VERSION.length).toBeGreaterThan(0);
  });

  it("classifies scores into strong/moderate/weak/none", () => {
    expect(phoneConfidenceBand(0.9)).toBe("strong");
    expect(phoneConfidenceBand(PHONE_CONFIDENCE_STRONG)).toBe("strong");
    expect(phoneConfidenceBand(0.4)).toBe("moderate");
    expect(phoneConfidenceBand(0.2)).toBe("weak");
    expect(phoneConfidenceBand(0.05)).toBe("none");
  });
});

describe("geometry", () => {
  it("boxIoU is 0 for non-overlapping boxes and 1 for identical boxes", () => {
    expect(boxIoU(box(0, 0, 0.1, 0.1), box(0.5, 0.5, 0.1, 0.1))).toBe(0);
    expect(boxIoU(box(0.1, 0.1, 0.2, 0.2), box(0.1, 0.1, 0.2, 0.2))).toBeCloseTo(1);
  });

  it("boxCenterDistance and boxSizeSimilarity behave sanely", () => {
    expect(boxCenterDistance(box(0, 0, 0.1, 0.1), box(0, 0, 0.1, 0.1))).toBe(0);
    expect(boxSizeSimilarity(box(0, 0, 0.1, 0.1), box(0, 0, 0.1, 0.1))).toBe(1);
    expect(boxSizeSimilarity(box(0, 0, 0.1, 0.1), box(0, 0, 0.4, 0.4))).toBeLessThan(1);
  });

  it("11. degenerate bounding boxes are rejected", () => {
    expect(isPlausiblePhoneGeometry(box(0.1, 0.1, 0, 0.1))).toBe(false);
    expect(isPlausiblePhoneGeometry(box(0.1, 0.1, 0.1, 0))).toBe(false);
    expect(isPlausiblePhoneGeometry(box(0.1, 0.1, -0.1, 0.1))).toBe(false);
  });

  it("12. implausible geometry (too small, too large, extreme aspect ratio) is rejected", () => {
    expect(isPlausiblePhoneGeometry(box(0.5, 0.5, 0.001, 0.001))).toBe(false); // far too small
    expect(isPlausiblePhoneGeometry(box(0, 0, 0.9, 0.9))).toBe(false); // implausibly large
    expect(isPlausiblePhoneGeometry(box(0.1, 0.1, 0.5, 0.01))).toBe(false); // degenerate sliver
  });

  it("a normal, plausible phone-sized box in various orientations is accepted", () => {
    expect(isPlausiblePhoneGeometry(box(0.4, 0.6, 0.08, 0.15))).toBe(true); // portrait
    expect(isPlausiblePhoneGeometry(box(0.4, 0.6, 0.15, 0.08))).toBe(true); // landscape
  });

  it("touchesFrameEdge flags boxes near any edge, not just fully-clipped ones", () => {
    expect(touchesFrameEdge(box(0, 0.5, 0.1, 0.1))).toBe(true);
    expect(touchesFrameEdge(box(0.95, 0.5, 0.08, 0.1))).toBe(true);
    expect(touchesFrameEdge(box(0.4, 0.4, 0.1, 0.1))).toBe(false);
  });

  it("visibleAreaEstimate clips a crop-mapped box that extends past the frame", () => {
    expect(visibleAreaEstimate(box(0.4, 0.4, 0.1, 0.1))).toBeCloseTo(0.01);
    expect(visibleAreaEstimate(box(-0.05, 0.4, 0.1, 0.1))).toBeLessThan(0.01);
  });
});

describe("15/16. cross-source merge", () => {
  it("15. duplicate full-frame/crop detections of the same phone merge, keeping the higher score", () => {
    const merged = dedupeObservations([
      obs(0.4, 0.6, 0.1, 0.15, 0.5, "full_frame"),
      obs(0.41, 0.61, 0.1, 0.15, 0.7, "lower_crop"),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].score).toBe(0.7);
  });

  it("16. separate physical objects in different regions remain separate", () => {
    const merged = dedupeObservations([obs(0.05, 0.5, 0.1, 0.1, 0.5), obs(0.85, 0.5, 0.1, 0.1, 0.5)]);
    expect(merged).toHaveLength(2);
  });
});

describe("candidate tracking — activation (tests 1-3)", () => {
  it("1. a strong candidate confirms on its first observation", () => {
    const tracker = new PhoneCandidateTracker();
    const result = tracker.update([obs(0.4, 0.6, 0.1, 0.15, 0.9)], 1000);
    expect(result.newlyConfirmed).toHaveLength(1);
    expect(tracker.hasConfirmedWarning()).toBe(true);
  });

  it("2. a single moderate observation does not confirm", () => {
    const tracker = new PhoneCandidateTracker();
    tracker.update([obs(0.4, 0.6, 0.1, 0.15, 0.4)], 1000);
    expect(tracker.hasConfirmedWarning()).toBe(false);
  });

  it("3. a weak candidate never warns, even repeated many times", () => {
    const tracker = new PhoneCandidateTracker();
    for (let i = 0; i < 10; i++) {
      tracker.update([obs(0.4, 0.6, 0.1, 0.15, PHONE_CONFIDENCE_WEAK + 0.01)], 1000 + i * 1000);
    }
    expect(tracker.hasConfirmedWarning()).toBe(false);
  });
});

describe("candidate tracking — temporal confirmation (tests 4-5)", () => {
  it("4. three-of-five spatially consistent moderate observations confirm", () => {
    const tracker = new PhoneCandidateTracker();
    const b = { x: 0.4, y: 0.6, w: 0.1, h: 0.15 };
    tracker.update([obs(b.x, b.y, b.w, b.h, 0.4)], 1000); // 1
    tracker.update([], 2000); // miss
    tracker.update([obs(b.x, b.y, b.w, b.h, 0.4)], 3000); // 2
    expect(tracker.hasConfirmedWarning()).toBe(false);
    tracker.update([obs(b.x, b.y, b.w, b.h, 0.4)], 4000); // 3 of last 5 -> confirm
    expect(tracker.hasConfirmedWarning()).toBe(true);
  });

  it("5. spatially inconsistent observations (different locations each time) never accumulate into one track", () => {
    const tracker = new PhoneCandidateTracker();
    tracker.update([obs(0.05, 0.1, 0.05, 0.05, 0.4)], 1000);
    tracker.update([obs(0.5, 0.5, 0.05, 0.05, 0.4)], 2000);
    tracker.update([obs(0.9, 0.9, 0.05, 0.05, 0.4)], 3000);
    // Three separate, short-lived tracks — none individually reaches 3-of-5.
    expect(tracker.hasConfirmedWarning()).toBe(false);
  });
});

describe("candidate tracking — miss tolerance and expiry (tests 6-8)", () => {
  it("6. one missed frame does not immediately remove a track", () => {
    const tracker = new PhoneCandidateTracker();
    tracker.update([obs(0.4, 0.6, 0.1, 0.15, 0.9)], 1000);
    const result = tracker.update([], 2000);
    expect(result.tracks).toHaveLength(1);
  });

  it("7. a candidate expires after the configured absence", () => {
    const tracker = new PhoneCandidateTracker();
    tracker.update([obs(0.4, 0.6, 0.1, 0.15, 0.9)], 1000);
    let result = { tracks: tracker.getTracks() };
    for (let i = 0; i < TRACK_MAX_MISSED_FRAMES + 1; i++) {
      result = tracker.update([], 2000 + i * 1000);
    }
    expect(result.tracks).toHaveLength(0);
  });

  it("8. recovery: a confirmed warning clears only after several clear frames, not the very next miss", () => {
    const tracker = new PhoneCandidateTracker();
    tracker.update([obs(0.4, 0.6, 0.1, 0.15, 0.9)], 1000);
    expect(tracker.hasConfirmedWarning()).toBe(true);
    tracker.update([], 2000); // one miss — still tolerated
    expect(tracker.getTracks()[0]?.confirmedLocalWarning).toBe(true);
    for (let i = 1; i < TRACK_MAX_MISSED_FRAMES; i++) {
      tracker.update([], 2000 + i * 1000);
    }
    expect(tracker.hasConfirmedWarning()).toBe(false);
  });
});

describe("candidate tracking — edge handling (tests 9-10)", () => {
  it("9. an edge-touching moderate candidate needs one more confirming observation than a non-edge one", () => {
    const tracker = new PhoneCandidateTracker();
    const edgeBox = { x: 0, y: 0.5, w: 0.08, h: 0.15 }; // touches left edge
    for (let i = 0; i < TRACK_CONFIRM_MODERATE_COUNT; i++) {
      tracker.update([obs(edgeBox.x, edgeBox.y, edgeBox.w, edgeBox.h, 0.4)], 1000 + i * 1000);
    }
    expect(tracker.hasConfirmedWarning()).toBe(false); // exactly the non-edge count isn't enough at the edge
    tracker.update(
      [obs(edgeBox.x, edgeBox.y, edgeBox.w, edgeBox.h, 0.4)],
      1000 + TRACK_CONFIRM_MODERATE_COUNT * 1000,
    );
    expect(tracker.hasConfirmedWarning()).toBe(true);
    expect(TRACK_CONFIRM_MODERATE_EDGE_COUNT).toBeGreaterThan(TRACK_CONFIRM_MODERATE_COUNT);
  });

  it("10. a stable bottom-edge candidate remains detectable — it is never rejected outright for touching the edge", () => {
    const tracker = new PhoneCandidateTracker();
    const bottomEdgeBox = { x: 0.4, y: 0.9, w: 0.1, h: 0.1 }; // touches bottom edge
    for (let i = 0; i < TRACK_CONFIRM_MODERATE_EDGE_COUNT; i++) {
      tracker.update([obs(bottomEdgeBox.x, bottomEdgeBox.y, bottomEdgeBox.w, bottomEdgeBox.h, 0.4)], 1000 + i * 1000);
    }
    expect(tracker.hasConfirmedWarning()).toBe(true);
  });
});

describe("13/14. second-stage verification", () => {
  it("shouldRunSecondStageVerification only applies to moderate candidates", () => {
    expect(shouldRunSecondStageVerification("strong")).toBe(false);
    expect(shouldRunSecondStageVerification("moderate")).toBe(true);
    expect(shouldRunSecondStageVerification("weak")).toBe(false);
    expect(shouldRunSecondStageVerification("none")).toBe(false);
  });

  it("expandCandidateBoxForVerification grows the box but stays within [0,1]", () => {
    const expanded = expandCandidateBoxForVerification(box(0.05, 0.05, 0.05, 0.05));
    expect(expanded.width).toBeGreaterThan(0.05);
    expect(expanded.x).toBeGreaterThanOrEqual(0);
    expect(expanded.y).toBeGreaterThanOrEqual(0);
    expect(expanded.x + expanded.width).toBeLessThanOrEqual(1 + 1e-9);
    expect(expanded.y + expanded.height).toBeLessThanOrEqual(1 + 1e-9);
  });

  it("13. a successful verification can raise a moderate candidate to strong (and confirm it)", () => {
    const tracker = new PhoneCandidateTracker();
    tracker.update([obs(0.4, 0.6, 0.1, 0.15, 0.4)], 1000); // moderate, not yet confirmed
    const track = tracker.getTracks()[0];
    expect(track.confirmedLocalWarning).toBe(false);
    tracker.applyVerification(track.id, true, 0.9);
    expect(tracker.getTracks()[0].latestBand).toBe("strong");
    expect(tracker.hasConfirmedWarning()).toBe(true);
  });

  it("14. a failed verification demotes the candidate and never itself creates a warning", () => {
    const tracker = new PhoneCandidateTracker();
    tracker.update([obs(0.4, 0.6, 0.1, 0.15, 0.4)], 1000);
    const track = tracker.getTracks()[0];
    tracker.applyVerification(track.id, false, 0);
    expect(tracker.getTracks()[0].verificationOutcome).toBe("lowered");
    expect(tracker.hasConfirmedWarning()).toBe(false);
  });
});

describe("17. camera-generation reset", () => {
  it("reset() clears all tracks unconditionally", () => {
    const tracker = new PhoneCandidateTracker();
    tracker.update([obs(0.4, 0.6, 0.1, 0.15, 0.9)], 1000);
    expect(tracker.getTracks()).toHaveLength(1);
    tracker.reset();
    expect(tracker.getTracks()).toHaveLength(0);
    expect(tracker.hasConfirmedWarning()).toBe(false);
  });
});

describe("Part 14 performance — active track ceiling", () => {
  it("never exceeds MAX_ACTIVE_PHONE_TRACKS even with many simultaneous non-overlapping candidates", () => {
    const tracker = new PhoneCandidateTracker();
    const observations: PhoneObservation[] = [];
    for (let i = 0; i < MAX_ACTIVE_PHONE_TRACKS + 4; i++) {
      observations.push(obs(i * 0.03, 0.05, 0.02, 0.02, 0.35));
    }
    const result = tracker.update(observations, 1000);
    expect(result.tracks.length).toBeLessThanOrEqual(MAX_ACTIVE_PHONE_TRACKS);
  });
});

describe("19/20/21. evidence tiers (Part 12)", () => {
  const confirmedTrack = { confirmedLocalWarning: true, latestBand: "strong" as const };
  const unconfirmedTrack = { confirmedLocalWarning: false, latestBand: "moderate" as const };
  const noBandTrack = { confirmedLocalWarning: false, latestBand: "none" as const };

  it("20. an unconfirmed candidate is only ever OBSERVED_CANDIDATE, never a backend event", () => {
    expect(phoneEvidenceTier(unconfirmedTrack, false, true, true, true)).toBe("OBSERVED_CANDIDATE");
    expect(phoneEvidenceTier(unconfirmedTrack, true, true, true, true)).toBe("OBSERVED_CANDIDATE");
    expect(phoneEvidenceTier(noBandTrack, false, true, true, true)).toBeNull();
  });

  it("19. a confirmed candidate whose backend event was accepted reaches BACKEND_REVIEW_EVENT", () => {
    expect(phoneEvidenceTier(confirmedTrack, false, true, true, true)).toBe("CONFIRMED_LOCAL_WARNING");
    expect(phoneEvidenceTier(confirmedTrack, true, false, true, true)).toBe("BACKEND_REVIEW_EVENT");
  });

  it("21. evidence-frame eligibility additionally requires capture enabled, a valid generation, and the candidate still present", () => {
    expect(phoneEvidenceTier(confirmedTrack, true, true, true, true)).toBe("EVIDENCE_FRAME_ELIGIBLE");
    expect(phoneEvidenceTier(confirmedTrack, true, true, false, true)).toBe("BACKEND_REVIEW_EVENT");
    expect(phoneEvidenceTier(confirmedTrack, true, true, true, false)).toBe("BACKEND_REVIEW_EVENT");
  });
});

describe("boxArea", () => {
  it("is zero for a degenerate box and positive for a normal one", () => {
    expect(boxArea(box(0, 0, 0, 0.1))).toBe(0);
    expect(boxArea(box(0, 0, 0.2, 0.2))).toBeCloseTo(0.04);
  });
});
