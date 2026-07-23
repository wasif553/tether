import { describe, it, expect } from "vitest";
import { computeRareMistakeSignals, buildQuestionWrongAnswerFrequency } from "./rareMistake";

function statsFor(responses: Array<{ normalizedResponse: string; isWrong: boolean }>) {
  return buildQuestionWrongAnswerFrequency(responses);
}

describe("computeRareMistakeSignals", () => {
  it("a common mistake made by many students gets no signal at all", () => {
    // 10 students answered; 6 gave the same wrong answer "b" (60% — COMMON).
    const responses = [
      ...Array(6).fill({ normalizedResponse: "b", isWrong: true }),
      ...Array(4).fill({ normalizedResponse: "a", isWrong: false }),
    ];
    const stats = statsFor(responses);
    const signals = computeRareMistakeSignals(
      {
        questionId: "q1",
        questionType: "MULTIPLE_CHOICE",
        responseA: "b",
        responseB: "b",
        correctAnswer: "a",
        isCorrectA: false,
        isCorrectB: false,
      },
      stats,
    );
    expect(signals).toHaveLength(0);
  });

  it("a rare identical wrong answer (almost no one else) produces a strong signal", () => {
    const responses = [
      { normalizedResponse: "weird answer", isWrong: true },
      { normalizedResponse: "weird answer", isWrong: true },
      ...Array(18).fill({ normalizedResponse: "correct", isWrong: false }),
    ];
    const stats = statsFor(responses);
    const signals = computeRareMistakeSignals(
      {
        questionId: "q2",
        questionType: "SHORT_ANSWER",
        responseA: "weird answer",
        responseB: "weird answer",
        correctAnswer: "correct",
        isCorrectA: false,
        isCorrectB: false,
      },
      stats,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].signalType).toBe("IDENTICAL_RARE_WRONG_ANSWER");
    expect(signals[0].score).toBeGreaterThan(0.5);
  });

  it("never fires on a shared CORRECT answer", () => {
    const stats = statsFor([
      { normalizedResponse: "correct", isWrong: false },
      { normalizedResponse: "correct", isWrong: false },
    ]);
    const signals = computeRareMistakeSignals(
      {
        questionId: "q3",
        questionType: "MULTIPLE_CHOICE",
        responseA: "correct",
        responseB: "correct",
        correctAnswer: "correct",
        isCorrectA: true,
        isCorrectB: true,
      },
      stats,
    );
    expect(signals).toHaveLength(0);
  });

  it("MCQ questions produce MATCHING_RARE_MCQ_ERROR; non-MCQ produce IDENTICAL_RARE_WRONG_ANSWER", () => {
    const stats = statsFor([
      { normalizedResponse: "c", isWrong: true },
      { normalizedResponse: "c", isWrong: true },
      ...Array(18).fill({ normalizedResponse: "a", isWrong: false }),
    ]);
    const signals = computeRareMistakeSignals(
      { questionId: "q4", questionType: "MULTIPLE_CHOICE", responseA: "c", responseB: "c", correctAnswer: "a", isCorrectA: false, isCorrectB: false },
      stats,
    );
    expect(signals[0].signalType).toBe("MATCHING_RARE_MCQ_ERROR");
  });
});
