/**
 * Time Anomaly Review v1 — pure timing analysis tests. See
 * docs/time-anomaly-review-v1.md and src/lib/timeAnomalyDetection.ts.
 */
import { describe, expect, it } from "vitest";
import {
  analyzeExtremelyFastAttempt,
  analyzeRapidMultiQuestionCompletion,
  analyzeRapidLargeResponseAppearance,
  analyzeLongInactivityThenLargeResponse,
  analyzeVeryFastCorrectResponsePattern,
  analyzeSimilarResponseTimingPattern,
  spearmanCorrelation,
  runTimeAnomalyAnalysis,
  type ActivityEventForAnalysis,
} from "./timeAnomalyDetection";

const START = 1_700_000_000_000;

function saveEvent(questionId: string, atMs: number, responseLength: number, delta: number | null = null): ActivityEventForAnalysis {
  return { eventType: "ANSWER_SAVED", questionId, serverReceivedAtMs: atMs, responseLength, responseLengthDelta: delta };
}
function heartbeat(atMs: number): ActivityEventForAnalysis {
  return { eventType: "HEARTBEAT", questionId: null, serverReceivedAtMs: atMs, responseLength: null, responseLengthDelta: null };
}

describe("analyzeExtremelyFastAttempt", () => {
  it("flags 20 questions completed in 45 seconds", () => {
    const result = analyzeExtremelyFastAttempt({ startedAtMs: START, submittedAtMs: START + 45_000 }, 20);
    expect(result?.signalType).toBe("EXTREMELY_FAST_ATTEMPT");
  });

  it("does not flag a small simple exam completed at a normal pace", () => {
    const result = analyzeExtremelyFastAttempt({ startedAtMs: START, submittedAtMs: START + 5 * 60_000 }, 5);
    expect(result).toBeNull();
  });

  it("does not flag a large exam completed at a reasonable pace", () => {
    const result = analyzeExtremelyFastAttempt({ startedAtMs: START, submittedAtMs: START + 20 * 60_000 }, 20);
    expect(result).toBeNull();
  });
});

describe("analyzeRapidMultiQuestionCompletion", () => {
  it("flags many distinct question saves within a short window", () => {
    const events: ActivityEventForAnalysis[] = Array.from({ length: 9 }, (_, i) => saveEvent(`q${i}`, START + i * 5_000, 50));
    const result = analyzeRapidMultiQuestionCompletion(events);
    expect(result?.signalType).toBe("RAPID_MULTI_QUESTION_COMPLETION");
  });

  it("does not flag when responses are empty", () => {
    const events: ActivityEventForAnalysis[] = Array.from({ length: 9 }, (_, i) => saveEvent(`q${i}`, START + i * 5_000, 0));
    expect(analyzeRapidMultiQuestionCompletion(events)).toBeNull();
  });

  it("does not flag a normal spread-out attempt", () => {
    const events: ActivityEventForAnalysis[] = Array.from({ length: 9 }, (_, i) => saveEvent(`q${i}`, START + i * 5 * 60_000, 50));
    expect(analyzeRapidMultiQuestionCompletion(events)).toBeNull();
  });
});

describe("analyzeRapidLargeResponseAppearance", () => {
  it("flags a large delta in a few seconds", () => {
    const events = [saveEvent("q1", START, 20), saveEvent("q1", START + 4_000, 800, 780)];
    const [signal] = analyzeRapidLargeResponseAppearance(events);
    expect(signal.signalType).toBe("RAPID_LARGE_RESPONSE_APPEARANCE");
    expect(signal.explanation.toLowerCase()).not.toContain("pasted");
  });

  it("does not flag progressive autosave growth", () => {
    const events = [
      saveEvent("q1", START, 50),
      saveEvent("q1", START + 30_000, 150, 100),
      saveEvent("q1", START + 60_000, 300, 150),
      saveEvent("q1", START + 90_000, 480, 180),
    ];
    expect(analyzeRapidLargeResponseAppearance(events)).toEqual([]);
  });

  it("never uses the word 'pasted' anywhere in output", () => {
    const events = [saveEvent("q1", START, 10), saveEvent("q1", START + 2_000, 900, 890)];
    const signals = analyzeRapidLargeResponseAppearance(events);
    expect(JSON.stringify(signals).toLowerCase()).not.toContain("pasted");
  });
});

describe("analyzeLongInactivityThenLargeResponse", () => {
  it("flags a large response immediately after a long gap", () => {
    const events = [heartbeat(START), saveEvent("q1", START + 15 * 60_000, 400, 400)];
    const [signal] = analyzeLongInactivityThenLargeResponse(events);
    expect(signal.signalType).toBe("LONG_INACTIVITY_THEN_LARGE_RESPONSE");
  });

  it("includes a connectivity-gap limitation", () => {
    const events = [heartbeat(START), saveEvent("q1", START + 15 * 60_000, 400, 400)];
    const [signal] = analyzeLongInactivityThenLargeResponse(events);
    expect(signal.limitation.toLowerCase()).toContain("network outage");
  });

  it("does not flag a short gap", () => {
    const events = [heartbeat(START), saveEvent("q1", START + 60_000, 400, 400)];
    expect(analyzeLongInactivityThenLargeResponse(events)).toEqual([]);
  });
});

describe("analyzeVeryFastCorrectResponsePattern", () => {
  it("is disabled when no difficulty data is supplied", () => {
    const result = analyzeVeryFastCorrectResponsePattern(
      [
        { questionId: "q1", elapsedMs: 3000, isCorrect: true },
        { questionId: "q2", elapsedMs: 3000, isCorrect: true },
      ],
      null,
    );
    expect(result).toBeNull();
  });

  it("flags when explicit difficulty is supplied and the pattern is met", () => {
    const difficulty = new Map([
      ["q1", "hard" as const],
      ["q2", "hard" as const],
    ]);
    const result = analyzeVeryFastCorrectResponsePattern(
      [
        { questionId: "q1", elapsedMs: 3000, isCorrect: true },
        { questionId: "q2", elapsedMs: 4000, isCorrect: true },
      ],
      difficulty,
    );
    expect(result?.signalType).toBe("VERY_FAST_CORRECT_RESPONSE_PATTERN");
  });
});

describe("spearmanCorrelation / analyzeSimilarResponseTimingPattern", () => {
  it("compares only shared Question.ids", () => {
    const a = [
      { questionId: "q1", relativeElapsedMs: 10_000 },
      { questionId: "q2", relativeElapsedMs: 20_000 },
      { questionId: "q3", relativeElapsedMs: 30_000 },
      { questionId: "q4", relativeElapsedMs: 40_000 },
      { questionId: "q5", relativeElapsedMs: 50_000 },
    ];
    const b = [
      { questionId: "q1", relativeElapsedMs: 11_000 },
      { questionId: "q2", relativeElapsedMs: 21_000 },
      { questionId: "q3", relativeElapsedMs: 31_000 },
      { questionId: "q4", relativeElapsedMs: 41_000 },
      { questionId: "q5", relativeElapsedMs: 51_000 },
      { questionId: "unrelated-q9", relativeElapsedMs: 99_999 },
    ];
    const result = analyzeSimilarResponseTimingPattern(a, b);
    expect(result?.evidence.join(" ")).toContain("5");
  });

  it("different random order (shuffled ranks) does not break the comparison", () => {
    const a = [
      { questionId: "q1", relativeElapsedMs: 50_000 },
      { questionId: "q2", relativeElapsedMs: 10_000 },
      { questionId: "q3", relativeElapsedMs: 30_000 },
      { questionId: "q4", relativeElapsedMs: 20_000 },
      { questionId: "q5", relativeElapsedMs: 40_000 },
    ];
    const b = [
      { questionId: "q4", relativeElapsedMs: 21_000 },
      { questionId: "q2", relativeElapsedMs: 11_000 },
      { questionId: "q1", relativeElapsedMs: 51_000 },
      { questionId: "q5", relativeElapsedMs: 41_000 },
      { questionId: "q3", relativeElapsedMs: 31_000 },
    ];
    const result = analyzeSimilarResponseTimingPattern(a, b);
    expect(result).not.toBeNull();
  });

  it("insufficient shared questions does not flag", () => {
    const a = [
      { questionId: "q1", relativeElapsedMs: 10_000 },
      { questionId: "q2", relativeElapsedMs: 20_000 },
    ];
    const b = [
      { questionId: "q1", relativeElapsedMs: 11_000 },
      { questionId: "q2", relativeElapsedMs: 21_000 },
    ];
    expect(analyzeSimilarResponseTimingPattern(a, b)).toBeNull();
  });

  it("timing similarity alone can never produce a HIGH signal level", () => {
    const identical = Array.from({ length: 10 }, (_, i) => ({ questionId: `q${i}`, relativeElapsedMs: i * 1000 }));
    const result = analyzeSimilarResponseTimingPattern(identical, identical);
    expect(result?.signalLevel).not.toBe("HIGH");
  });

  it("spearmanCorrelation of identical vectors is 1", () => {
    expect(spearmanCorrelation([1, 2, 3, 4], [1, 2, 3, 4])).toBeCloseTo(1, 5);
  });
});

describe("runTimeAnomalyAnalysis", () => {
  it("produces an insufficient-data result rather than an accusation when data is missing", () => {
    const signals = runTimeAnomalyAnalysis({
      lifecycle: { startedAtMs: START, submittedAtMs: null },
      answeredQuestionCount: 0,
      activityEvents: [],
    });
    expect(signals).toHaveLength(1);
    expect(signals[0].signalType).toBe("INSUFFICIENT_TIMING_DATA");
  });

  it("runs normally with sufficient data and no anomalies", () => {
    const signals = runTimeAnomalyAnalysis({
      lifecycle: { startedAtMs: START, submittedAtMs: START + 20 * 60_000 },
      answeredQuestionCount: 5,
      activityEvents: [saveEvent("q1", START + 60_000, 100, 100)],
    });
    expect(signals.every((s) => s.signalType !== "INSUFFICIENT_TIMING_DATA")).toBe(true);
  });
});
