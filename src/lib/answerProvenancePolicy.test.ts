import { describe, it, expect } from "vitest";
import {
  buildAnswerProvenancePolicySnapshot,
  parseAnswerProvenancePolicy,
  isAnswerProvenanceEnabled,
  isDetailedProvenanceMode,
  hasReachedMaxVersionsForQuestion,
  isVersionIntervalElapsed,
  isWithinCheckpointRateLimit,
  isWithinDevelopmentEventRateLimit,
  clampAnswerVersionIntervalSeconds,
  clampAnswerVersionMinimumCharacterChange,
  clampAnswerVersionMaximumPerQuestion,
  DISABLED_ANSWER_PROVENANCE_POLICY,
} from "./answerProvenancePolicy";

const detailedSettings = {
  answerProvenanceMode: "DETAILED" as const,
  answerVersionIntervalSeconds: 60,
  answerVersionMinimumCharacterChange: 80,
  answerVersionMaximumPerQuestion: 40,
  capturePasteMetadata: true,
  captureDeletionRewriteMetadata: true,
  enableOutlineWorkspace: true,
  enableCalculationWorkspace: true,
  enableCodeWorkspace: true,
  captureCodeRunHistory: true,
  requireAiSourceDeclaration: true,
  allowStudentDevelopmentReview: true,
};

describe("answerProvenancePolicy", () => {
  it("null/malformed snapshot means OFF", () => {
    expect(parseAnswerProvenancePolicy(null)).toEqual(DISABLED_ANSWER_PROVENANCE_POLICY);
    expect(parseAnswerProvenancePolicy(undefined)).toEqual(DISABLED_ANSWER_PROVENANCE_POLICY);
    expect(parseAnswerProvenancePolicy("not an object")).toEqual(DISABLED_ANSWER_PROVENANCE_POLICY);
    expect(parseAnswerProvenancePolicy({ mode: "GARBAGE" })).toEqual(DISABLED_ANSWER_PROVENANCE_POLICY);
    expect(isAnswerProvenanceEnabled(DISABLED_ANSWER_PROVENANCE_POLICY)).toBe(false);
  });

  it("OFF mode settings build the disabled snapshot", () => {
    const snapshot = buildAnswerProvenancePolicySnapshot({ ...detailedSettings, answerProvenanceMode: "OFF" });
    expect(snapshot.mode).toBe("OFF");
    expect(isAnswerProvenanceEnabled(snapshot)).toBe(false);
  });

  it("BASIC/DETAILED settings build an enabled snapshot with clamped limits", () => {
    const snapshot = buildAnswerProvenancePolicySnapshot(detailedSettings);
    expect(isAnswerProvenanceEnabled(snapshot)).toBe(true);
    expect(isDetailedProvenanceMode(snapshot)).toBe(true);
    expect(snapshot.versionIntervalSeconds).toBe(60);
    expect(snapshot.versionMinimumCharacterChange).toBe(80);
    expect(snapshot.versionMaximumPerQuestion).toBe(40);
    expect(typeof snapshot.createdAt).toBe("string");
  });

  it("BASIC mode forces every DETAILED-only field off, even if the underlying settings say otherwise", () => {
    const snapshot = buildAnswerProvenancePolicySnapshot({ ...detailedSettings, answerProvenanceMode: "BASIC" });
    expect(snapshot.mode).toBe("BASIC");
    expect(snapshot.enableOutlineWorkspace).toBe(false);
    expect(snapshot.enableCalculationWorkspace).toBe(false);
    expect(snapshot.enableCodeWorkspace).toBe(false);
    expect(snapshot.captureCodeRunHistory).toBe(false);
    expect(snapshot.requireAiSourceDeclaration).toBe(false);
  });

  it("parse re-applies the same DETAILED-only gating on read-back, even if the stored JSON somehow says otherwise", () => {
    const tampered = { mode: "BASIC", enableOutlineWorkspace: true, requireAiSourceDeclaration: true };
    const parsed = parseAnswerProvenancePolicy(tampered);
    expect(parsed.enableOutlineWorkspace).toBe(false);
    expect(parsed.requireAiSourceDeclaration).toBe(false);
  });

  it("build -> parse round-trips for DETAILED mode", () => {
    const snapshot = buildAnswerProvenancePolicySnapshot(detailedSettings);
    const roundTripped = parseAnswerProvenancePolicy(snapshot);
    expect(roundTripped).toEqual(snapshot);
  });

  it("clamps interval/min-change/max-checkpoints to hard bounds", () => {
    expect(clampAnswerVersionIntervalSeconds(5)).toBe(30);
    expect(clampAnswerVersionIntervalSeconds(10_000)).toBe(300);
    expect(clampAnswerVersionIntervalSeconds(NaN)).toBe(60);
    expect(clampAnswerVersionMinimumCharacterChange(1)).toBe(20);
    expect(clampAnswerVersionMinimumCharacterChange(999_999)).toBe(1000);
    expect(clampAnswerVersionMaximumPerQuestion(0)).toBe(5);
    expect(clampAnswerVersionMaximumPerQuestion(1000)).toBe(100);
  });

  it("hasReachedMaxVersionsForQuestion / isVersionIntervalElapsed", () => {
    const policy = buildAnswerProvenancePolicySnapshot(detailedSettings);
    expect(hasReachedMaxVersionsForQuestion(40, policy)).toBe(true);
    expect(hasReachedMaxVersionsForQuestion(39, policy)).toBe(false);
    expect(isVersionIntervalElapsed(null, Date.now(), policy)).toBe(true);
    expect(isVersionIntervalElapsed(Date.now(), Date.now(), policy)).toBe(false);
    expect(isVersionIntervalElapsed(Date.now() - 61_000, Date.now(), policy)).toBe(true);
  });

  it("rate limiters allow up to the max within the window, then reject", () => {
    const now = Date.now();
    const timestamps = [now, now - 1000, now - 2000, now - 3000, now - 4000, now - 5000];
    expect(isWithinCheckpointRateLimit(timestamps.slice(0, 2), now)).toBe(true);
    expect(isWithinCheckpointRateLimit(timestamps, now)).toBe(false);
    expect(isWithinDevelopmentEventRateLimit(timestamps.slice(0, 3), now)).toBe(true);
  });
});
