import { describe, it, expect } from "vitest";
import { computeAnswerContentSignals, buildQuestionShingleDocFrequency, looksCodeLike, looksCalculationLike } from "./answerContent";

describe("computeAnswerContentSignals", () => {
  it("discounts question wording so shared boilerplate alone never creates a signal", () => {
    const questionText =
      "Explain in detail how photosynthesis converts light energy into chemical energy within plant cells during the day";
    const stats = buildQuestionShingleDocFrequency([questionText, questionText, questionText]);
    // Both responses are literally just the question restated — no original content at all.
    const signals = computeAnswerContentSignals(
      { responseA: questionText, responseB: questionText, questionText },
      stats,
    );
    expect(signals).toHaveLength(0);
  });

  it("uncommon matching code structure can create a CODE_STRUCTURE_SIMILARITY signal", () => {
    const codeA =
      "function calculateTotal(items) { let total = 0; for (let i = 0; i < items.length; i++) { total += items[i].price; } return total; }";
    const codeB =
      "function calculateTotal(items) { let total = 0; for (let i = 0; i < items.length; i++) { total += items[i].price; } return total; }";
    const stats = buildQuestionShingleDocFrequency([codeA, "def other(): return 1", "x = 1"]);
    const signals = computeAnswerContentSignals({ responseA: codeA, responseB: codeB }, stats);
    expect(signals.some((s) => s.signalType === "CODE_STRUCTURE_SIMILARITY" || s.signalType === "IDENTICAL_NONTRIVIAL_RESPONSE")).toBe(true);
  });

  it("looksCodeLike / looksCalculationLike heuristics", () => {
    expect(looksCodeLike("function foo() { return 1; }")).toBe(true);
    expect(looksCodeLike("The mitochondria is the powerhouse of the cell")).toBe(false);
    expect(looksCalculationLike("2 + 2 * (3 - 1) = 6")).toBe(true);
    expect(looksCalculationLike("the answer is clearly six")).toBe(false);
  });

  it("rare shared phrasing (not present in most of the cohort) can produce UNUSUAL_PHRASE_MATCH", () => {
    const common = "The process involves several distinct steps that occur over time in living organisms";
    const rareShared = "the unusual glowing purple crystalline structure emerges spontaneously overnight";
    const stats = buildQuestionShingleDocFrequency([common, common, common, common, rareShared, rareShared]);
    const signals = computeAnswerContentSignals({ responseA: rareShared, responseB: rareShared }, stats);
    expect(signals.length).toBeGreaterThan(0);
  });
});
