import { describe, expect, it } from "vitest";
import { computeRiskScore, riskLevelForScore } from "./integrityRisk";

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
