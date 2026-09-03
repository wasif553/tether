import { describe, expect, it } from "vitest";
import { bankQuestionInputSchema, mapBankQuestionToQuestionData } from "./questionBank";

describe("bankQuestionInputSchema", () => {
  it("accepts a valid MULTIPLE_CHOICE question", () => {
    const result = bankQuestionInputSchema.safeParse({
      type: "MULTIPLE_CHOICE",
      text: "2+2=?",
      optionsJson: JSON.stringify(["3", "4", "5"]),
      correctAnswer: "4",
      points: 2,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a MULTIPLE_CHOICE question missing optionsJson", () => {
    const result = bankQuestionInputSchema.safeParse({
      type: "MULTIPLE_CHOICE",
      text: "2+2=?",
      correctAnswer: "4",
      points: 2,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a MULTIPLE_CHOICE question missing correctAnswer", () => {
    const result = bankQuestionInputSchema.safeParse({
      type: "MULTIPLE_CHOICE",
      text: "2+2=?",
      optionsJson: JSON.stringify(["3", "4", "5"]),
      points: 2,
    });
    expect(result.success).toBe(false);
  });

  it("accepts an ESSAY question with no correctAnswer", () => {
    const result = bankQuestionInputSchema.safeParse({
      type: "ESSAY",
      text: "Discuss photosynthesis.",
      points: 5,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a SHORT_ANSWER question with a sample answer and no options", () => {
    const result = bankQuestionInputSchema.safeParse({
      type: "SHORT_ANSWER",
      text: "Name the powerhouse of the cell.",
      sampleAnswer: "Mitochondria",
      points: 1,
    });
    expect(result.success).toBe(true);
  });

  it("rejects points below 1", () => {
    const result = bankQuestionInputSchema.safeParse({
      type: "ESSAY",
      text: "x",
      points: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty text", () => {
    const result = bankQuestionInputSchema.safeParse({
      type: "ESSAY",
      text: "",
      points: 1,
    });
    expect(result.success).toBe(false);
  });
});

describe("mapBankQuestionToQuestionData", () => {
  it("copies text, type, correctAnswer, and points onto the Question shape", () => {
    const data = mapBankQuestionToQuestionData(
      {
        id: "bank-q-1",
        type: "SHORT_ANSWER",
        text: "Name the powerhouse of the cell.",
        optionsJson: null,
        correctAnswer: "Mitochondria",
        points: 3,
      },
      "exam-1",
      0,
    );

    expect(data).toEqual({
      examId: "exam-1",
      type: "SHORT_ANSWER",
      text: "Name the powerhouse of the cell.",
      options: undefined,
      correctAnswer: "Mitochondria",
      points: 3,
      order: 0,
      source: "QUESTION_BANK",
      sourceBankQuestionId: "bank-q-1",
    });
  });

  it("parses optionsJson into an array matching Question.options' shape", () => {
    const data = mapBankQuestionToQuestionData(
      {
        id: "bank-q-2",
        type: "MULTIPLE_CHOICE",
        text: "2+2=?",
        optionsJson: JSON.stringify(["3", "4", "5"]),
        correctAnswer: "4",
        points: 2,
      },
      "exam-1",
      1,
    );

    expect(data.options).toEqual(["3", "4", "5"]);
    expect(data.order).toBe(1);
  });

  it("Question Bank / Exam Pools redesign v1 — always stamps source QUESTION_BANK and the exact bank question id copied from, never a live reference to any of the bank question's OTHER (mutable) fields", () => {
    const data = mapBankQuestionToQuestionData(
      {
        id: "bank-q-3",
        type: "ESSAY",
        text: "Discuss photosynthesis.",
        optionsJson: null,
        correctAnswer: null,
        points: 5,
      },
      "exam-2",
      2,
    );

    expect(data.source).toBe("QUESTION_BANK");
    expect(data.sourceBankQuestionId).toBe("bank-q-3");
    // Everything else is copied BY VALUE — no nested relation object, no
    // reference the caller could accidentally mutate to affect the
    // BankQuestion row itself.
    expect(data.text).toBe("Discuss photosynthesis.");
    expect(data.correctAnswer).toBeUndefined();
  });
});
