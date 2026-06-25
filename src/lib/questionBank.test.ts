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
    });
  });

  it("parses optionsJson into an array matching Question.options' shape", () => {
    const data = mapBankQuestionToQuestionData(
      {
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
});
