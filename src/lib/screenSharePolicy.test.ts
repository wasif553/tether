/**
 * Screen-share Evidence Mode v1 — pure policy tests. See
 * docs/screen-share-evidence-v1.md.
 */
import { describe, expect, it } from "vitest";
import {
  buildScreenSharePolicySnapshot,
  parseScreenSharePolicy,
  isScreenShareRequired,
  isScreenShareEvidenceEnabled,
  hasReachedMaxEvidenceFrames,
  isEvidenceCaptureDue,
  isWithinMinCaptureGap,
  minServerCaptureGapMs,
  isWithinScreenEvidenceRateLimit,
  isValidScreenShareCaptureTrigger,
  clampScreenShareEvidenceIntervalSeconds,
  clampScreenShareMaxEvidenceFrames,
  DEFAULT_EVIDENCE_INTERVAL_SECONDS,
  MIN_EVIDENCE_INTERVAL_SECONDS,
  MAX_EVIDENCE_INTERVAL_SECONDS,
  DEFAULT_MAX_EVIDENCE_FRAMES,
  HARD_MAX_EVIDENCE_FRAMES,
  DISABLED_SCREEN_SHARE_POLICY,
} from "./screenSharePolicy";

const REQUIRED_SETTINGS = {
  screenShareMode: "REQUIRED" as const,
  screenShareCaptureEvidence: true,
  screenShareEvidenceIntervalSeconds: 60,
  screenShareMaxEvidenceFrames: 20,
};

describe("policy defaults and validation", () => {
  it("clamps the evidence interval to the safe server-side bounds", () => {
    expect(clampScreenShareEvidenceIntervalSeconds(60)).toBe(60);
    expect(clampScreenShareEvidenceIntervalSeconds(1)).toBe(MIN_EVIDENCE_INTERVAL_SECONDS);
    expect(clampScreenShareEvidenceIntervalSeconds(10_000)).toBe(MAX_EVIDENCE_INTERVAL_SECONDS);
    expect(clampScreenShareEvidenceIntervalSeconds(Number.NaN)).toBe(DEFAULT_EVIDENCE_INTERVAL_SECONDS);
  });

  it("clamps max evidence frames to the safe server-side bounds", () => {
    expect(clampScreenShareMaxEvidenceFrames(20)).toBe(20);
    expect(clampScreenShareMaxEvidenceFrames(0)).toBe(1);
    expect(clampScreenShareMaxEvidenceFrames(9_999)).toBe(HARD_MAX_EVIDENCE_FRAMES);
    expect(clampScreenShareMaxEvidenceFrames(Number.NaN)).toBe(DEFAULT_MAX_EVIDENCE_FRAMES);
  });

  it("builds a snapshot from settings, clamping out-of-range client-supplied values", () => {
    const snapshot = buildScreenSharePolicySnapshot({
      screenShareMode: "REQUIRED",
      screenShareCaptureEvidence: true,
      screenShareEvidenceIntervalSeconds: 5, // below MIN — must be clamped up
      screenShareMaxEvidenceFrames: 1_000, // above HARD_MAX — must be clamped down
    });
    expect(snapshot.evidenceIntervalSeconds).toBe(MIN_EVIDENCE_INTERVAL_SECONDS);
    expect(snapshot.maxEvidenceFrames).toBe(HARD_MAX_EVIDENCE_FRAMES);
  });

  it("captures default values matching the recommended v1 bounds", () => {
    expect(DEFAULT_EVIDENCE_INTERVAL_SECONDS).toBe(60);
    expect(MIN_EVIDENCE_INTERVAL_SECONDS).toBe(30);
    expect(MAX_EVIDENCE_INTERVAL_SECONDS).toBe(300);
    expect(DEFAULT_MAX_EVIDENCE_FRAMES).toBe(20);
    expect(HARD_MAX_EVIDENCE_FRAMES).toBe(50);
  });
});

describe("legacy policy compatibility", () => {
  it("a null/missing snapshot is ALWAYS treated as OFF", () => {
    expect(parseScreenSharePolicy(null)).toEqual(DISABLED_SCREEN_SHARE_POLICY);
    expect(parseScreenSharePolicy(undefined)).toEqual(DISABLED_SCREEN_SHARE_POLICY);
    expect(parseScreenSharePolicy("not an object")).toEqual(DISABLED_SCREEN_SHARE_POLICY);
    expect(isScreenShareRequired(parseScreenSharePolicy(null))).toBe(false);
  });

  it("a malformed stored snapshot falls back to safe defaults, never throws", () => {
    const reparsed = parseScreenSharePolicy({ mode: "REQUIRED", evidenceIntervalSeconds: "not a number" });
    expect(reparsed.evidenceIntervalSeconds).toBe(DEFAULT_EVIDENCE_INTERVAL_SECONDS);
  });

  it("maxEvidenceFrames is forced to 0 when captureEvidence is false, even if a stored value says otherwise", () => {
    const reparsed = parseScreenSharePolicy({ mode: "REQUIRED", captureEvidence: false, maxEvidenceFrames: 50 });
    expect(reparsed.maxEvidenceFrames).toBe(0);
    expect(isScreenShareEvidenceEnabled(reparsed)).toBe(false);
  });
});

describe("immutable attempt snapshot", () => {
  it("a stored snapshot round-trips unchanged, independent of any 'current settings' passed elsewhere", () => {
    const snapshot = buildScreenSharePolicySnapshot(REQUIRED_SETTINGS);
    const stored = JSON.parse(JSON.stringify(snapshot));
    const reparsed = parseScreenSharePolicy(stored);
    expect(reparsed).toEqual(snapshot);
  });
});

describe("evidence interval limits", () => {
  it("a capture is due immediately on the first request (no prior capture)", () => {
    expect(isEvidenceCaptureDue(null, Date.now(), { evidenceIntervalSeconds: 60 })).toBe(true);
  });

  it("a capture is not due before the configured interval elapses", () => {
    const now = 1_000_000;
    expect(isEvidenceCaptureDue(now - 30_000, now, { evidenceIntervalSeconds: 60 })).toBe(false);
    expect(isEvidenceCaptureDue(now - 60_000, now, { evidenceIntervalSeconds: 60 })).toBe(true);
  });

  it("the minimum server-side capture gap is bounded and never below 5s", () => {
    expect(minServerCaptureGapMs({ evidenceIntervalSeconds: 30 })).toBeGreaterThanOrEqual(5_000);
    expect(minServerCaptureGapMs({ evidenceIntervalSeconds: 300 })).toBeLessThan(300_000);
  });

  it("avoid duplicate captures within a short time window — isWithinMinCaptureGap", () => {
    const now = 1_000_000;
    expect(isWithinMinCaptureGap(now - 1_000, now, { evidenceIntervalSeconds: 60 })).toBe(true);
    expect(isWithinMinCaptureGap(now - 60_000, now, { evidenceIntervalSeconds: 60 })).toBe(false);
    expect(isWithinMinCaptureGap(null, now, { evidenceIntervalSeconds: 60 })).toBe(false);
  });
});

describe("evidence maximum enforcement", () => {
  it("blocks once the configured maximum is reached", () => {
    expect(hasReachedMaxEvidenceFrames(19, { maxEvidenceFrames: 20 })).toBe(false);
    expect(hasReachedMaxEvidenceFrames(20, { maxEvidenceFrames: 20 })).toBe(true);
    expect(hasReachedMaxEvidenceFrames(21, { maxEvidenceFrames: 20 })).toBe(true);
  });
});

describe("upload rate limiting", () => {
  it("allows up to the configured max within the window, then blocks", () => {
    const now = 100_000;
    const timestamps = [now - 1_000, now - 2_000];
    expect(isWithinScreenEvidenceRateLimit(timestamps, now, 3, 20_000)).toBe(true);
    expect(isWithinScreenEvidenceRateLimit([...timestamps, now - 500], now, 3, 20_000)).toBe(false);
  });
});

describe("capture trigger validation", () => {
  it("accepts only the three known trigger values", () => {
    expect(isValidScreenShareCaptureTrigger("PERIODIC")).toBe(true);
    expect(isValidScreenShareCaptureTrigger("INTERRUPTION")).toBe(true);
    expect(isValidScreenShareCaptureTrigger("RESTORATION")).toBe(true);
    expect(isValidScreenShareCaptureTrigger("SOMETHING_ELSE")).toBe(false);
  });
});
