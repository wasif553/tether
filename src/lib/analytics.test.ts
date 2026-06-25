import { describe, expect, it } from "vitest";
import {
  average,
  median,
  scorePercentage,
  passRatePct,
  completionRatePct,
  scoreDistributionBands,
  reviewRecommendation,
} from "./analytics";

describe("average", () => {
  it("returns null for empty input", () => {
    expect(average([])).toBeNull();
  });

  it("computes the mean", () => {
    expect(average([10, 20, 30])).toBe(20);
  });
});

describe("median", () => {
  it("returns null for empty input", () => {
    expect(median([])).toBeNull();
  });

  it("computes the middle value for odd-length arrays", () => {
    expect(median([10, 30, 20])).toBe(20);
  });

  it("averages the two middle values for even-length arrays", () => {
    expect(median([10, 20, 30, 40])).toBe(25);
  });
});

describe("scorePercentage", () => {
  it("returns null when maxScore is zero", () => {
    expect(scorePercentage(5, 0)).toBeNull();
  });

  it("computes the percentage", () => {
    expect(scorePercentage(5, 10)).toBe(50);
  });
});

describe("passRatePct", () => {
  it("returns null for empty input", () => {
    expect(passRatePct([])).toBeNull();
  });

  it("uses the default 50% threshold", () => {
    expect(passRatePct([40, 50, 60, 90])).toBe(75);
  });

  it("respects a custom threshold", () => {
    expect(passRatePct([40, 50, 60, 90], 60)).toBe(50);
  });
});

describe("completionRatePct", () => {
  it("returns null when nobody started", () => {
    expect(completionRatePct(0, 0)).toBeNull();
  });

  it("computes submitted over started", () => {
    expect(completionRatePct(3, 4)).toBe(75);
  });
});

describe("scoreDistributionBands", () => {
  it("creates 10 bands covering 0-100", () => {
    const bands = scoreDistributionBands([]);
    expect(bands).toHaveLength(10);
    expect(bands[0]).toEqual({ band: "0-9", min: 0, max: 9, count: 0 });
    expect(bands[9]).toEqual({ band: "90-100", min: 90, max: 100, count: 0 });
  });

  it("buckets scores into the correct band, including 100", () => {
    const bands = scoreDistributionBands([5, 55, 100, 92]);
    const byBand = new Map(bands.map((b) => [b.band, b.count]));
    expect(byBand.get("0-9")).toBe(1);
    expect(byBand.get("50-59")).toBe(1);
    expect(byBand.get("90-100")).toBe(2);
  });
});

describe("reviewRecommendation", () => {
  it("does not recommend review when there are no attempts", () => {
    const result = reviewRecommendation({
      attempts: 0,
      correctRatePct: null,
      averageScorePct: null,
    });
    expect(result.reviewRecommended).toBe(false);
    expect(result.reviewReason).toBeNull();
  });

  it("recommends review when correct rate is below 40%", () => {
    const result = reviewRecommendation({
      attempts: 10,
      correctRatePct: 30,
      averageScorePct: null,
    });
    expect(result.reviewRecommended).toBe(true);
    expect(result.reviewReason).toMatch(/30%/);
  });

  it("recommends review when average score is below 40%", () => {
    const result = reviewRecommendation({
      attempts: 10,
      correctRatePct: null,
      averageScorePct: 25,
    });
    expect(result.reviewRecommended).toBe(true);
    expect(result.reviewReason).toMatch(/25%/);
  });

  it("does not recommend review when scores are healthy", () => {
    const result = reviewRecommendation({
      attempts: 10,
      correctRatePct: 80,
      averageScorePct: 85,
    });
    expect(result.reviewRecommended).toBe(false);
    expect(result.reviewReason).toBeNull();
  });
});
