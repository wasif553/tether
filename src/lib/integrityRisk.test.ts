import { describe, expect, it } from "vitest";
import { computeRiskScore, riskLevelForScore, SEVERITY_WEIGHTS } from "./integrityRisk";
import { DEFAULT_SECURE_SETTINGS, severityFor } from "./secureExam";

describe("computeRiskScore", () => {
  it("sums severity weights", () => {
    expect(
      computeRiskScore([
        { severity: "INFO" },
        { severity: "LOW" },
        { severity: "MEDIUM" },
        { severity: "HIGH" },
      ]),
    ).toBe(0 + 1 + 3 + 7);
  });

  it("returns 0 for no events", () => {
    expect(computeRiskScore([])).toBe(0);
  });
});

describe("riskLevelForScore", () => {
  it("classifies CLEAN at 0", () => {
    expect(riskLevelForScore(0)).toBe("CLEAN");
  });

  it("classifies LOW between 1 and 4", () => {
    expect(riskLevelForScore(1)).toBe("LOW");
    expect(riskLevelForScore(4)).toBe("LOW");
  });

  it("classifies MEDIUM between 5 and 12", () => {
    expect(riskLevelForScore(5)).toBe("MEDIUM");
    expect(riskLevelForScore(12)).toBe("MEDIUM");
  });

  it("classifies HIGH at 13+", () => {
    expect(riskLevelForScore(13)).toBe("HIGH");
    expect(riskLevelForScore(100)).toBe("HIGH");
  });
});

describe("camera and browser-friction event risk contributions", () => {
  it("CAMERA_HEARTBEAT_MISSED contributes the MEDIUM weight to the risk score", () => {
    const severity = severityFor("CAMERA_HEARTBEAT_MISSED", DEFAULT_SECURE_SETTINGS);
    expect(severity).toBe("MEDIUM");
    expect(computeRiskScore([{ severity }])).toBe(SEVERITY_WEIGHTS.MEDIUM);
    expect(computeRiskScore([{ severity }])).toBe(3);
  });

  it("KEYBOARD_SHORTCUT_BLOCKED has a risk weight of 0 so it never dominates the score", () => {
    const severity = severityFor("KEYBOARD_SHORTCUT_BLOCKED", DEFAULT_SECURE_SETTINGS);
    expect(severity).toBe("INFO");
    expect(computeRiskScore([{ severity }])).toBe(0);
    // Even many repeated keyboard-shortcut events contribute nothing.
    expect(computeRiskScore(Array(50).fill({ severity }))).toBe(0);
  });

  it("FULLSCREEN_FORCED_RETURN contributes the LOW weight (1) to the risk score", () => {
    const severity = severityFor("FULLSCREEN_FORCED_RETURN", DEFAULT_SECURE_SETTINGS);
    expect(severity).toBe("LOW");
    expect(computeRiskScore([{ severity }])).toBe(1);
  });

  it("a HIGH-severity camera event uses the normal HIGH weight (7)", () => {
    const settings = { ...DEFAULT_SECURE_SETTINGS, requireCamera: true };
    const severity = severityFor("CAMERA_UNAVAILABLE", settings);
    expect(severity).toBe("HIGH");
    expect(computeRiskScore([{ severity }])).toBe(7);
  });
});
