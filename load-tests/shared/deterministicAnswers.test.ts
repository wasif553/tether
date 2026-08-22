import { describe, it, expect } from "vitest";
import {
  FIXTURE_QUESTION_COUNT,
  FIXTURE_MCQ_COUNT,
  FIXTURE_SHORT_ANSWER_COUNT,
  isMcqIndex,
  MCQ_OPTIONS,
  mcqCorrectOption,
  deterministicResponseFor,
  expectedResponseFor,
  buildFixtureQuestionDefinitions,
} from "./deterministicAnswers.mjs";

describe("fixture shape", () => {
  it("is 20 questions: 12 MCQ then 8 short-answer, in that order", () => {
    expect(FIXTURE_QUESTION_COUNT).toBe(20);
    expect(FIXTURE_MCQ_COUNT).toBe(12);
    expect(FIXTURE_SHORT_ANSWER_COUNT).toBe(8);
    const defs = buildFixtureQuestionDefinitions();
    expect(defs).toHaveLength(20);
    expect(defs.slice(0, 12).every((q) => q.type === "MULTIPLE_CHOICE")).toBe(true);
    expect(defs.slice(12).every((q) => q.type === "SHORT_ANSWER")).toBe(true);
  });

  it("isMcqIndex matches the 12/8 boundary exactly", () => {
    expect(isMcqIndex(0)).toBe(true);
    expect(isMcqIndex(11)).toBe(true);
    expect(isMcqIndex(12)).toBe(false);
    expect(isMcqIndex(19)).toBe(false);
  });

  it("every MCQ question definition's correctAnswer is one of MCQ_OPTIONS and matches mcqCorrectOption", () => {
    const defs = buildFixtureQuestionDefinitions();
    for (let i = 0; i < 12; i++) {
      expect(MCQ_OPTIONS).toContain(defs[i].correctAnswer);
      expect(defs[i].correctAnswer).toBe(mcqCorrectOption(i));
    }
  });

  it("mcqCorrectOption cycles through all 4 options rather than always picking the same slot", () => {
    const seen = new Set();
    for (let i = 0; i < 12; i++) seen.add(mcqCorrectOption(i));
    expect(seen.size).toBe(4);
  });
});

describe("deterministicResponseFor / expectedResponseFor", () => {
  it("MCQ response is always the objectively correct option", () => {
    for (let i = 0; i < 12; i++) {
      const response = deterministicResponseFor({ runId: "LT-run1", studentIndex: 5, questionIndex: i });
      expect(response).toBe(mcqCorrectOption(i));
    }
  });

  it("short-answer response embeds runId, studentIndex, and questionIndex verbatim", () => {
    const response = deterministicResponseFor({ runId: "LT-abc123", studentIndex: 42, questionIndex: 15 });
    expect(response).toBe("LT-LT-abc123-S42-Q15");
    expect(response).toContain("LT-abc123");
    expect(response).toContain("S42");
    expect(response).toContain("Q15");
  });

  it("expectedResponseFor reproduces the exact same value deterministicResponseFor produced — a verification script never needs shared in-memory state", () => {
    const runId = "LT-verify-check";
    for (const studentIndex of [0, 1, 499]) {
      for (const questionIndex of [0, 11, 12, 19]) {
        expect(expectedResponseFor(runId, studentIndex, questionIndex)).toBe(
          deterministicResponseFor({ runId, studentIndex, questionIndex }),
        );
      }
    }
  });

  it("two different students answering the same short-answer question never produce the same response text — a cross-student mixup is always detectable by response text alone", () => {
    const a = deterministicResponseFor({ runId: "LT-run1", studentIndex: 1, questionIndex: 12 });
    const b = deterministicResponseFor({ runId: "LT-run1", studentIndex: 2, questionIndex: 12 });
    expect(a).not.toBe(b);
  });

  it("the same student's answers to two different short-answer questions never produce the same response text — a wrong-question association is always detectable by response text alone", () => {
    const a = deterministicResponseFor({ runId: "LT-run1", studentIndex: 1, questionIndex: 12 });
    const b = deterministicResponseFor({ runId: "LT-run1", studentIndex: 1, questionIndex: 13 });
    expect(a).not.toBe(b);
  });

  it("two different runs never collide for the same student/question — repeated runs against the same environment stay distinguishable", () => {
    const a = deterministicResponseFor({ runId: "LT-run1", studentIndex: 1, questionIndex: 12 });
    const b = deterministicResponseFor({ runId: "LT-run2", studentIndex: 1, questionIndex: 12 });
    expect(a).not.toBe(b);
  });
});
