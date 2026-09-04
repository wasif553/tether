import { describe, it, expect } from "vitest";
import { formatPromptsRemainingLabel } from "./brainstormCounterDisplay";

describe("formatPromptsRemainingLabel", () => {
  it("states the value unambiguously as 'N of M remaining' — never a bare fraction", () => {
    expect(formatPromptsRemainingLabel(12, 15)).toBe("12 of 15 remaining");
    expect(formatPromptsRemainingLabel(2, 5)).toBe("2 of 5 remaining");
  });

  it("never mixes 'remaining' and 'used' semantics — the value passed in is always treated as remaining", () => {
    // 3 used out of 15 means 12 remaining — the label must say "12 of 15
    // remaining", not "3 of 15" (which would silently flip to "used").
    const remaining = 15 - 3;
    expect(formatPromptsRemainingLabel(remaining, 15)).toBe("12 of 15 remaining");
  });

  it("shows two independently-equal limits honestly rather than faking a difference", () => {
    // Section 3/4 — if a lecturer genuinely configures both the
    // per-question and per-attempt limit to the same value, and the
    // student has only used prompts on one question so far, both real,
    // independently-computed counters legitimately read the same. The
    // formatter's job is only to make each one unambiguous on its own,
    // never to force them apart.
    expect(formatPromptsRemainingLabel(12, 15)).toBe(formatPromptsRemainingLabel(12, 15));
  });

  it("renders a placeholder, not '0 of 0', when a value has not loaded yet", () => {
    expect(formatPromptsRemainingLabel(null, null)).toBe("–");
    expect(formatPromptsRemainingLabel(undefined, undefined)).toBe("–");
    expect(formatPromptsRemainingLabel(null, 15)).toBe("–");
    expect(formatPromptsRemainingLabel(12, null)).toBe("–");
  });

  it("handles the zero-remaining (exhausted) case unambiguously", () => {
    expect(formatPromptsRemainingLabel(0, 3)).toBe("0 of 3 remaining");
  });
});
