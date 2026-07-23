import { describe, it, expect } from "vitest";
import { computeMcqSequenceSignals, computeSynchronisedMcqChangeSignal, type McqSharedQuestion, type McqChangeInput } from "./mcqPattern";
import { buildQuestionWrongAnswerFrequency } from "./rareMistake";

function commonCorrectStats() {
  return buildQuestionWrongAnswerFrequency(Array(20).fill({ normalizedResponse: "correct", isWrong: false }));
}
function rareWrongStats() {
  return buildQuestionWrongAnswerFrequency([
    { normalizedResponse: "rare wrong", isWrong: true },
    { normalizedResponse: "rare wrong", isWrong: true },
    ...Array(18).fill({ normalizedResponse: "correct", isWrong: false }),
  ]);
}

describe("computeMcqSequenceSignals", () => {
  it("shared CORRECT answers across many questions produce no signal (no meaningful concern)", () => {
    const stats = commonCorrectStats();
    const shared: McqSharedQuestion[] = Array.from({ length: 6 }, (_, i) => ({
      questionId: `q${i}`,
      responseA: "correct",
      responseB: "correct",
      correctAnswer: "correct",
      wrongAnswerStats: stats,
    }));
    expect(computeMcqSequenceSignals(shared)).toHaveLength(0);
  });

  it("fewer than the minimum shared questions never produces a signal", () => {
    const stats = rareWrongStats();
    const shared: McqSharedQuestion[] = [
      { questionId: "q1", responseA: "rare wrong", responseB: "rare wrong", correctAnswer: "correct", wrongAnswerStats: stats },
    ];
    expect(computeMcqSequenceSignals(shared)).toHaveLength(0);
  });

  it("rare matching wrong answers across enough shared questions produce a signal", () => {
    const stats = rareWrongStats();
    const shared: McqSharedQuestion[] = Array.from({ length: 6 }, (_, i) => ({
      questionId: `q${i}`,
      responseA: "rare wrong",
      responseB: "rare wrong",
      correctAnswer: "correct",
      wrongAnswerStats: stats,
    }));
    const signals = computeMcqSequenceSignals(shared);
    expect(signals.length).toBeGreaterThan(0);
    expect(["HIGH_MCQ_SEQUENCE_SIMILARITY", "MATCHING_RARE_WRONG_SEQUENCE"]).toContain(signals[0].signalType);
  });
});

describe("computeSynchronisedMcqChangeSignal", () => {
  const stats = rareWrongStats();

  function changeInput(questionId: string, atMsA: number, atMsB: number): McqChangeInput {
    return {
      questionId,
      eventsA: [
        { serverReceivedAtMs: atMsA - 5000, responseHash: "first" },
        { serverReceivedAtMs: atMsA, responseHash: "final" },
      ],
      eventsB: [
        { serverReceivedAtMs: atMsB - 5000, responseHash: "first" },
        { serverReceivedAtMs: atMsB, responseHash: "final" },
      ],
      finalResponseA: "rare wrong",
      finalResponseB: "rare wrong",
      correctAnswer: "correct",
      wrongAnswerStats: stats,
    };
  }

  it("a single synchronised change is not enough", () => {
    const signals = computeSynchronisedMcqChangeSignal([changeInput("q1", 100_000, 100_500)]);
    expect(signals).toHaveLength(0);
  });

  it("repeated synchronised changes across questions produce a signal", () => {
    const signals = computeSynchronisedMcqChangeSignal([
      changeInput("q1", 100_000, 100_500),
      changeInput("q2", 200_000, 200_800),
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0].signalType).toBe("SYNCHRONISED_MCQ_CHANGES");
  });

  it("no change at all (same hash every event) never fires", () => {
    const input: McqChangeInput = {
      questionId: "q1",
      eventsA: [{ serverReceivedAtMs: 1000, responseHash: "same" }],
      eventsB: [{ serverReceivedAtMs: 1000, responseHash: "same" }],
      finalResponseA: "rare wrong",
      finalResponseB: "rare wrong",
      correctAnswer: "correct",
      wrongAnswerStats: stats,
    };
    expect(computeSynchronisedMcqChangeSignal([input, input])).toHaveLength(0);
  });
});
