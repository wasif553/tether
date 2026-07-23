import { describe, it, expect } from "vitest";
import { rarityBandForFraction, rarityWeightForFraction } from "./cohortCollusionThresholds";

describe("rarity weighting", () => {
  it("common correct/incorrect answers (given by most of the cohort) get minimal weight", () => {
    expect(rarityBandForFraction(0.6)).toBe("COMMON");
    expect(rarityWeightForFraction(0.6)).toBeLessThanOrEqual(0.05);
  });

  it("rare wrong answers (almost no one else) get full weight", () => {
    expect(rarityBandForFraction(0.05)).toBe("RARE");
    expect(rarityWeightForFraction(0.05)).toBe(1.0);
  });

  it("uncommon (but not rare) wrong answers get partial weight, strictly between rare and common", () => {
    expect(rarityBandForFraction(0.2)).toBe("UNCOMMON");
    const uncommonWeight = rarityWeightForFraction(0.2);
    expect(uncommonWeight).toBeLessThan(rarityWeightForFraction(0.05));
    expect(uncommonWeight).toBeGreaterThan(rarityWeightForFraction(0.6));
  });
});
