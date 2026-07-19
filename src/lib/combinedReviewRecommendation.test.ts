/**
 * Combined session/timing recommendation tests. See
 * src/lib/combinedReviewRecommendation.ts.
 */
import { describe, expect, it } from "vitest";
import { calculateCombinedReviewRecommendation, type CombinedSignalInput } from "./combinedReviewRecommendation";

describe("calculateCombinedReviewRecommendation", () => {
  it("one network change gives no immediate action", () => {
    const signals: CombinedSignalInput[] = [{ category: "SESSION", signalType: "NETWORK_PREFIX_CHANGED", signalLevel: "LOW" }];
    expect(calculateCombinedReviewRecommendation(signals).recommendation).toBe("NO_IMMEDIATE_ACTION");
  });

  it("one UA change gives no immediate action", () => {
    const signals: CombinedSignalInput[] = [{ category: "SESSION", signalType: "USER_AGENT_CHANGED", signalLevel: "LOW" }];
    expect(calculateCombinedReviewRecommendation(signals).recommendation).toBe("NO_IMMEDIATE_ACTION");
  });

  it("timing similarity alone (even MEDIUM) does not recommend oral verification", () => {
    const signals: CombinedSignalInput[] = [{ category: "TIMING", signalType: "SIMILAR_RESPONSE_TIMING_PATTERN", signalLevel: "MEDIUM" }];
    const result = calculateCombinedReviewRecommendation(signals);
    expect(result.recommendation).not.toBe("ORAL_VERIFICATION_RECOMMENDED");
  });

  it("concurrent sessions plus device change recommends lecturer review (not oral verification alone)", () => {
    const signals: CombinedSignalInput[] = [
      { category: "SESSION", signalType: "CONCURRENT_ACTIVE_SESSIONS", signalLevel: "MEDIUM" },
      { category: "SESSION", signalType: "DEVICE_TOKEN_CHANGED", signalLevel: "MEDIUM" },
    ];
    const result = calculateCombinedReviewRecommendation(signals);
    expect(result.recommendation).toBe("LECTURER_REVIEW_RECOMMENDED");
  });

  it("multiple independent strong signals may recommend oral verification", () => {
    const signals: CombinedSignalInput[] = [
      { category: "SESSION", signalType: "CONCURRENT_ACTIVE_SESSIONS", signalLevel: "MEDIUM" },
      { category: "SESSION", signalType: "DEVICE_TOKEN_CHANGED", signalLevel: "MEDIUM" },
      { category: "TIMING", signalType: "RAPID_LARGE_RESPONSE_APPEARANCE", signalLevel: "MEDIUM" },
    ];
    const result = calculateCombinedReviewRecommendation(signals);
    expect(result.recommendation).toBe("ORAL_VERIFICATION_RECOMMENDED");
  });

  it("matches the documented example: concurrent + device + rapid response + existing high similarity", () => {
    const signals: CombinedSignalInput[] = [
      { category: "SESSION", signalType: "CONCURRENT_ACTIVE_SESSIONS", signalLevel: "MEDIUM" },
      { category: "SESSION", signalType: "COARSE_DEVICE_PROFILE_CHANGED", signalLevel: "MEDIUM" },
      { category: "TIMING", signalType: "RAPID_LARGE_RESPONSE_APPEARANCE", signalLevel: "MEDIUM" },
    ];
    const result = calculateCombinedReviewRecommendation(signals, { similarityRecommendation: "ORAL_VERIFICATION_RECOMMENDED" });
    expect(result.recommendation).toBe("ORAL_VERIFICATION_RECOMMENDED");
  });

  it("includes reason codes", () => {
    const signals: CombinedSignalInput[] = [{ category: "SESSION", signalType: "DEVICE_TOKEN_CHANGED", signalLevel: "MEDIUM" }];
    const result = calculateCombinedReviewRecommendation(signals);
    expect(result.reasonCodes.length).toBeGreaterThan(0);
  });

  it("never outputs a confirmed/misconduct-style recommendation", () => {
    const signals: CombinedSignalInput[] = [
      { category: "SESSION", signalType: "CONCURRENT_ACTIVE_SESSIONS", signalLevel: "HIGH" },
      { category: "SESSION", signalType: "DEVICE_TOKEN_CHANGED", signalLevel: "HIGH" },
      { category: "TIMING", signalType: "RAPID_LARGE_RESPONSE_APPEARANCE", signalLevel: "HIGH" },
    ];
    const result = calculateCombinedReviewRecommendation(signals, { similarityRecommendation: "ESCALATION_RECOMMENDED" });
    expect(["NO_IMMEDIATE_ACTION", "LECTURER_REVIEW_RECOMMENDED", "ORAL_VERIFICATION_RECOMMENDED", "ESCALATION_RECOMMENDED"]).toContain(
      result.recommendation,
    );
  });

  it("no signals and no existing recommendations gives no immediate action", () => {
    expect(calculateCombinedReviewRecommendation([]).recommendation).toBe("NO_IMMEDIATE_ACTION");
  });

  it("Exam Design Policy v1: one policy inconsistency (EVIDENCE) alone recommends lecturer review at most, never oral verification", () => {
    const signals: CombinedSignalInput[] = [{ category: "EVIDENCE", signalType: "WINDOW_BLUR", signalLevel: "HIGH" }];
    const result = calculateCombinedReviewRecommendation(signals);
    expect(result.recommendation).toBe("LECTURER_REVIEW_RECOMMENDED");
  });

  it("Exam Design Policy v1: multiple EVIDENCE signals alone still never reach oral verification on their own", () => {
    const signals: CombinedSignalInput[] = [
      { category: "EVIDENCE", signalType: "WINDOW_BLUR", signalLevel: "HIGH" },
      { category: "EVIDENCE", signalType: "COPY_ATTEMPT", signalLevel: "HIGH" },
      { category: "EVIDENCE", signalType: "POSSIBLE_PHONE_VISIBLE", signalLevel: "HIGH" },
    ];
    const result = calculateCombinedReviewRecommendation(signals);
    expect(result.recommendation).not.toBe("ORAL_VERIFICATION_RECOMMENDED");
    expect(result.recommendation).not.toBe("ESCALATION_RECOMMENDED");
  });

  it("Exam Design Policy v1: EVIDENCE signal combined with real independent session/timing signals can still reach oral verification", () => {
    const signals: CombinedSignalInput[] = [
      { category: "EVIDENCE", signalType: "WINDOW_BLUR", signalLevel: "HIGH" },
      { category: "SESSION", signalType: "CONCURRENT_ACTIVE_SESSIONS", signalLevel: "HIGH" },
      { category: "SESSION", signalType: "DEVICE_TOKEN_CHANGED", signalLevel: "HIGH" },
      { category: "TIMING", signalType: "RAPID_LARGE_RESPONSE_APPEARANCE", signalLevel: "HIGH" },
    ];
    const result = calculateCombinedReviewRecommendation(signals);
    expect(result.recommendation).toBe("ORAL_VERIFICATION_RECOMMENDED");
  });

  it("Exam Design Policy v1: examMode is included in reasonCodes as policy context", () => {
    const result = calculateCombinedReviewRecommendation([], { examMode: "CLOSED_BOOK" });
    expect(result.reasonCodes).toContain("POLICY_CONTEXT:CLOSED_BOOK");
  });
});
