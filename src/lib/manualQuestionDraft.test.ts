import { describe, expect, it } from "vitest";
import {
  createEmptyManualDraft,
  normalizeManualDraft,
  validateManualDraft,
  type ManualQuestionDraft,
} from "./manualQuestionDraft";

function draft(overrides: Partial<ManualQuestionDraft> = {}): ManualQuestionDraft {
  return { ...createEmptyManualDraft(), ...overrides };
}

describe("createEmptyManualDraft", () => {
  it("1. produces a default MCQ draft with four empty option slots and 1 point", () => {
    const d = createEmptyManualDraft();
    expect(d.type).toBe("MULTIPLE_CHOICE");
    expect(d.text).toBe("");
    expect(d.options).toEqual(["", "", "", ""]);
    expect(d.points).toBe(1);
  });
});

describe("validateManualDraft", () => {
  it("requires question text", () => {
    const errors = validateManualDraft(draft({ text: "" }));
    expect(errors).toContain("Question text is required.");
  });

  it("7. MCQ validation: requires at least two options and a matching correct answer", () => {
    const noOptions = validateManualDraft(
      draft({ type: "MULTIPLE_CHOICE", text: "Q", options: ["", "", "", ""], correctAnswer: "" }),
    );
    expect(noOptions).toContain("MCQ questions require at least two options.");
    expect(noOptions).toContain("Correct answer is required for MCQ questions.");

    const mismatchedAnswer = validateManualDraft(
      draft({
        type: "MULTIPLE_CHOICE",
        text: "Q",
        options: ["A", "B", "", ""],
        correctAnswer: "C",
      }),
    );
    expect(mismatchedAnswer).toContain("Correct answer must match one of the options.");

    const valid = validateManualDraft(
      draft({
        type: "MULTIPLE_CHOICE",
        text: "Q",
        options: ["A", "B", "", ""],
        correctAnswer: "B",
      }),
    );
    expect(valid).toEqual([]);
  });

  it("8. short-answer/essay validation: never requires MCQ-only fields", () => {
    const shortAnswer = validateManualDraft(
      draft({ type: "SHORT_ANSWER", text: "Define X.", options: ["", "", "", ""], correctAnswer: "" }),
    );
    expect(shortAnswer).toEqual([]);

    const essay = validateManualDraft(
      draft({ type: "ESSAY", text: "Discuss Y.", options: ["", "", "", ""], correctAnswer: "" }),
    );
    expect(essay).toEqual([]);
  });

  it("points must be a positive whole number", () => {
    expect(validateManualDraft(draft({ type: "ESSAY", text: "Q", points: 0 }))).toContain(
      "Points must be greater than 0.",
    );
    expect(validateManualDraft(draft({ type: "ESSAY", text: "Q", points: -1 }))).toContain(
      "Points must be greater than 0.",
    );
    expect(validateManualDraft(draft({ type: "ESSAY", text: "Q", points: 1.5 }))).toContain(
      "Points must be greater than 0.",
    );
    expect(validateManualDraft(draft({ type: "ESSAY", text: "Q", points: 3 }))).toEqual([]);
  });
});

describe("normalizeManualDraft", () => {
  it("drops empty option slots and trims text for MCQ", () => {
    const normalized = normalizeManualDraft(
      draft({
        type: "MULTIPLE_CHOICE",
        text: "  What is 2+2?  ",
        options: ["3", "4", "", ""],
        correctAnswer: "4",
        points: 2,
      }),
    );
    expect(normalized).toEqual({
      type: "MULTIPLE_CHOICE",
      text: "What is 2+2?",
      options: ["3", "4"],
      correctAnswer: "4",
      points: 2,
    });
  });

  it("never carries a correctAnswer for essay questions", () => {
    const normalized = normalizeManualDraft(
      draft({ type: "ESSAY", text: "Discuss.", correctAnswer: "should be ignored", points: 5 }),
    );
    expect(normalized.correctAnswer).toBeNull();
    expect(normalized.options).toEqual([]);
  });

  it("keeps an optional correctAnswer for short-answer questions", () => {
    const withAnswer = normalizeManualDraft(
      draft({ type: "SHORT_ANSWER", text: "Define X.", correctAnswer: "definition", points: 3 }),
    );
    expect(withAnswer.correctAnswer).toBe("definition");

    const withoutAnswer = normalizeManualDraft(
      draft({ type: "SHORT_ANSWER", text: "Define X.", correctAnswer: "", points: 3 }),
    );
    expect(withoutAnswer.correctAnswer).toBeNull();
  });
});
