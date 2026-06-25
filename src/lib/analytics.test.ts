import { describe, expect, it } from "vitest";
import {
  average,
  median,
  scorePercentage,
  passRatePct,
  completionRatePct,
  scoreDistributionBands,
  reviewRecommendation,
  summarizeIntegrityEvents,
  buildInsights,
  type ExamAnalytics,
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

describe("summarizeIntegrityEvents", () => {
  it("returns all-zero summary for no events", () => {
    expect(summarizeIntegrityEvents([])).toEqual({
      totalEvents: 0,
      highSeverityEvents: 0,
      mediumSeverityEvents: 0,
      lowSeverityEvents: 0,
      unresolvedEvents: 0,
      studentsWithEvents: 0,
    });
  });

  it("counts events by severity, resolution, and distinct students", () => {
    const summary = summarizeIntegrityEvents([
      { severity: "HIGH", studentId: "s1", resolvedAt: null },
      { severity: "MEDIUM", studentId: "s1", resolvedAt: new Date() },
      { severity: "LOW", studentId: "s2", resolvedAt: null },
      { severity: "INFO", studentId: "s2", resolvedAt: new Date() },
    ]);

    expect(summary).toEqual({
      totalEvents: 4,
      highSeverityEvents: 1,
      mediumSeverityEvents: 1,
      lowSeverityEvents: 1,
      unresolvedEvents: 2,
      studentsWithEvents: 2,
    });
  });
});

describe("buildInsights — integrity rules", () => {
  const baseSummary: ExamAnalytics["summary"] = {
    totalStudentsStarted: 2,
    totalSubmitted: 2,
    totalGraded: 2,
    averageScorePct: 80,
    medianScorePct: 80,
    highestScorePct: 90,
    lowestScorePct: 70,
    passRatePct: 100,
    completionRatePct: 100,
    pendingGradingCount: 0,
  };

  it("adds a HIGH insight when there are high-severity events", () => {
    const insights = buildInsights(baseSummary, [], {
      totalEvents: 1,
      highSeverityEvents: 1,
      mediumSeverityEvents: 0,
      lowSeverityEvents: 0,
      unresolvedEvents: 0,
      studentsWithEvents: 1,
    });

    expect(insights.some((i) => i.severity === "HIGH" && /require review/.test(i.title))).toBe(
      true,
    );
  });

  it("adds a WARNING insight when there are unresolved events", () => {
    const insights = buildInsights(baseSummary, [], {
      totalEvents: 1,
      highSeverityEvents: 0,
      mediumSeverityEvents: 1,
      lowSeverityEvents: 0,
      unresolvedEvents: 1,
      studentsWithEvents: 1,
    });

    expect(
      insights.some((i) => i.severity === "WARNING" && /not yet been reviewed/.test(i.title)),
    ).toBe(true);
  });

  it("adds an INFO insight when no integrity events were recorded but submissions exist", () => {
    const insights = buildInsights(baseSummary, [], {
      totalEvents: 0,
      highSeverityEvents: 0,
      mediumSeverityEvents: 0,
      lowSeverityEvents: 0,
      unresolvedEvents: 0,
      studentsWithEvents: 0,
    });

    expect(
      insights.some((i) => i.severity === "INFO" && /No integrity events were recorded/.test(i.title)),
    ).toBe(true);
  });

  it("does not add integrity insights when there is no student data at all", () => {
    const insights = buildInsights(
      { ...baseSummary, totalStudentsStarted: 0 },
      [],
      {
        totalEvents: 0,
        highSeverityEvents: 0,
        mediumSeverityEvents: 0,
        lowSeverityEvents: 0,
        unresolvedEvents: 0,
        studentsWithEvents: 0,
      },
    );

    expect(insights).toHaveLength(1);
    expect(insights[0].title).toBe("No data yet");
  });
});
