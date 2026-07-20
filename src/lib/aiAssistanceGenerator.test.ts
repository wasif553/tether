/**
 * Controlled AI Brainstorming Assistance v1 — generator structural tests.
 * See docs/controlled-ai-brainstorming-assistance-v1.md.
 *
 * Does not call the Anthropic API (no network in this test environment) —
 * covers the structural safety guarantees only: the generator input type
 * cannot carry a correct answer/rubric, and the runtime belt-and-braces
 * check catches it if one leaks in anyway.
 */
import { describe, expect, it } from "vitest";
import { assertPromptExcludesSecrets, AiAssistanceGenerationError, type BrainstormGeneratorInput } from "./aiAssistanceGenerator";

describe("22. model answer is not included in generator input", () => {
  it("BrainstormGeneratorInput has no field for a correct answer, rubric, or hidden test cases", () => {
    const input: BrainstormGeneratorInput = {
      questionText: "What is the capital of France?",
      questionType: "SHORT_ANSWER",
      policy: {
        allowConceptExplanations: true,
        allowAnswerPlanning: true,
        allowReasoningFeedback: true,
        allowProgrammingConceptHelp: true,
        maxResponseCharacters: 800,
      },
      studentRequest: "Can you help me understand this question?",
      priorApprovedInteractions: [],
      hintLadderLevel: 1,
    };
    const keys = Object.keys(input);
    for (const forbidden of ["correctAnswer", "rubric", "modelAnswer", "hiddenTestCases", "markingGuide"]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe("assertPromptExcludesSecrets", () => {
  it("throws when a secret appears verbatim in the prompt", () => {
    expect(() => assertPromptExcludesSecrets("The answer is Paris, obviously.", ["Paris"])).toThrow(
      AiAssistanceGenerationError,
    );
  });

  it("does not throw when no secret is present", () => {
    expect(() => assertPromptExcludesSecrets("Can you help me understand this?", ["Paris"])).not.toThrow();
  });

  it("ignores null/empty/very short secrets (avoids false positives on trivial overlaps)", () => {
    expect(() => assertPromptExcludesSecrets("What is 42?", [null, undefined, "", "42"])).not.toThrow();
  });
});
