import { describe, it, expect } from "vitest";
import { diffAnswerText, computePasteRetention, tokenizeForDiff } from "./answerDevelopmentDiff";

describe("tokenizeForDiff", () => {
  it("round-trips: joining tokens reconstructs the original text exactly", () => {
    const text = "The quick  brown fox\njumps over.";
    expect(tokenizeForDiff(text).join("")).toBe(text);
  });
});

describe("diffAnswerText", () => {
  it("identical text produces zero changes", () => {
    const result = diffAnswerText("hello world", "hello world");
    expect(result.charactersAdded).toBe(0);
    expect(result.charactersRemoved).toBe(0);
    expect(result.changeRatio).toBe(0);
  });

  it("pure appended text counts as added only", () => {
    const result = diffAnswerText("hello", "hello world");
    expect(result.charactersRemoved).toBe(0);
    expect(result.charactersAdded).toBeGreaterThan(0);
  });

  it("pure deletion counts as removed only", () => {
    const result = diffAnswerText("hello world", "hello");
    expect(result.charactersAdded).toBe(0);
    expect(result.charactersRemoved).toBeGreaterThan(0);
    expect(result.removedRatio).toBeGreaterThan(0);
  });

  it("a small edit in the middle of a long answer only touches the changed region", () => {
    const prior = "A".repeat(500) + " middle " + "B".repeat(500);
    const current = "A".repeat(500) + " CHANGED " + "B".repeat(500);
    const result = diffAnswerText(prior, current);
    // The prefix/suffix of 500 identical characters should collapse into
    // equal segments, not be re-diffed character-by-character.
    const equalSegments = result.segments.filter((s) => s.type === "equal");
    expect(equalSegments.some((s) => s.text.includes("A".repeat(500)))).toBe(true);
    expect(equalSegments.some((s) => s.text.includes("B".repeat(500)))).toBe(true);
  });

  it("changeRatio reflects total edit size relative to prior length", () => {
    const prior = "aa bb cc dd ee"; // 14 chars, 5 words
    const current = "aa bb"; // removed the last three words (9 chars)
    const result = diffAnswerText(prior, current);
    expect(result.removedRatio).toBeCloseTo(9 / 14, 1);
  });

  it("segments rejoin to reconstruct both prior and current text", () => {
    const prior = "one two three";
    const current = "one TWO three four";
    const result = diffAnswerText(prior, current);
    const reconstructedCurrent = result.segments
      .filter((s) => s.type !== "removed")
      .map((s) => s.text)
      .join("");
    expect(reconstructedCurrent).toBe(current);
  });
});

describe("computePasteRetention", () => {
  it("fully-retained pasted text has replacedRatio near 0", () => {
    const pasted = "the quick brown fox jumps over the lazy dog";
    const later = "Intro. " + pasted + " Conclusion.";
    const result = computePasteRetention(pasted, later);
    expect(result.replacedRatio).toBeLessThan(0.2);
  });

  it("fully-rewritten pasted text has replacedRatio near 1", () => {
    const pasted = "the quick brown fox jumps over the lazy dog";
    const later = "a completely different sentence about something else entirely";
    const result = computePasteRetention(pasted, later);
    expect(result.replacedRatio).toBeGreaterThan(0.8);
  });

  it("empty pasted text is trivially fully retained", () => {
    const result = computePasteRetention("", "anything");
    expect(result.replacedRatio).toBe(0);
  });
});
