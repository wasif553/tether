/**
 * Oral Verification Workflow v1 — see
 * docs/oral-verification-workflow-v1.md and
 * src/lib/oralVerificationQuestions.ts.
 *
 * Pure unit tests only — no Prisma/DB, no browser, no LLM.
 */
import { describe, expect, it } from "vitest";
import {
  extractImportantTerms,
  generateOralVerificationQuestions,
  isValidOralVerificationStatus,
  ORAL_VERIFICATION_STATUS_LABELS,
  ORAL_VERIFICATION_STUDENT_NOTICE,
} from "./oralVerificationQuestions";

describe("extractImportantTerms", () => {
  it("extracts distinctive, non-stopword terms", () => {
    const terms = extractImportantTerms(
      "Photosynthesis converts sunlight into chemical energy using chlorophyll in the chloroplast.",
    );
    expect(terms.length).toBeGreaterThan(0);
    expect(terms).not.toContain("the");
    expect(terms).not.toContain("into");
  });

  it("returns an empty array for empty/null answers", () => {
    expect(extractImportantTerms("")).toEqual([]);
    expect(extractImportantTerms(null)).toEqual([]);
  });

  it("never returns more than 3 terms", () => {
    const terms = extractImportantTerms(
      "photosynthesis chlorophyll chloroplast mitochondria respiration glucose oxygen carbon",
    );
    expect(terms.length).toBeLessThanOrEqual(3);
  });
});

describe("generateOralVerificationQuestions", () => {
  it("generates between 3 and 5 questions", () => {
    const questions = generateOralVerificationQuestions({
      questionNumber: 4,
      questionText: "Explain photosynthesis.",
      answerText: "Photosynthesis converts sunlight into chemical energy using chlorophyll.",
    });
    expect(questions.length).toBeGreaterThanOrEqual(3);
    expect(questions.length).toBeLessThanOrEqual(5);
  });

  it("questions reference the actual question number, grounding them in the student's real response", () => {
    const questions = generateOralVerificationQuestions({
      questionNumber: 7,
      questionText: "Explain photosynthesis.",
      answerText: "Photosynthesis converts sunlight into chemical energy.",
    });
    expect(questions.some((q) => q.includes("Question 7"))).toBe(true);
  });

  it("never includes a correct answer (the function is never given one)", () => {
    const questions = generateOralVerificationQuestions({
      questionNumber: 1,
      questionText: "What is 2+2?",
      answerText: "4",
    });
    expect(questions.join(" ")).not.toContain("correctAnswer");
  });

  it("still produces the minimum 3 questions even with an empty answer", () => {
    const questions = generateOralVerificationQuestions({
      questionNumber: 1,
      questionText: "Explain your reasoning.",
      answerText: "",
    });
    expect(questions.length).toBeGreaterThanOrEqual(3);
  });

  it("is deterministic — no LLM, same input always produces the same output", () => {
    const input = {
      questionNumber: 2,
      questionText: "Explain the water cycle.",
      answerText: "Evaporation, condensation, and precipitation cycle water through the atmosphere.",
    };
    expect(generateOralVerificationQuestions(input)).toEqual(generateOralVerificationQuestions(input));
  });
});

describe("isValidOralVerificationStatus / ORAL_VERIFICATION_STATUS_LABELS", () => {
  it("uses neutral wording throughout", () => {
    for (const label of Object.values(ORAL_VERIFICATION_STATUS_LABELS)) {
      const lower = label.toLowerCase();
      expect(lower).not.toContain("cheating");
      expect(lower).not.toContain("guilty");
      expect(lower).not.toContain("suspected");
    }
  });

  it("validates only the six known statuses", () => {
    expect(isValidOralVerificationStatus("REQUIRED")).toBe(true);
    expect(isValidOralVerificationStatus("NOT_A_STATUS")).toBe(false);
  });
});

describe("ORAL_VERIFICATION_STUDENT_NOTICE", () => {
  it("uses neutral wording, never an accusation", () => {
    expect(ORAL_VERIFICATION_STUDENT_NOTICE).toBe(
      "A follow-up academic discussion has been requested for this assessment.",
    );
    const lower = ORAL_VERIFICATION_STUDENT_NOTICE.toLowerCase();
    expect(lower).not.toContain("cheat");
    expect(lower).not.toContain("suspect");
  });
});
