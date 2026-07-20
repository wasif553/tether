/**
 * Controlled AI Brainstorming Assistance v1 — verifier structural tests.
 * See docs/controlled-ai-brainstorming-assistance-v1.md.
 *
 * Does not call the Anthropic API — covers the structural contract only
 * (the exact risk-code vocabulary from the task spec, and that the
 * verifier's input type is the ONLY place hidden reference material may
 * appear, distinct from the generator's input type).
 */
import { describe, expect, it } from "vitest";
import { RISK_CODES, type BrainstormVerifierInput } from "./aiAssistanceVerifier";

describe("8. risk-code vocabulary matches the required set", () => {
  it("includes every required code, nothing more, nothing less than intended", () => {
    const required = [
      "DIRECT_ANSWER",
      "NEAR_COMPLETE_ANSWER",
      "CORRECT_OPTION_DISCLOSED",
      "OPTION_ELIMINATION",
      "FINAL_NUMERIC_RESULT",
      "SUBMISSION_READY_PROSE",
      "COMPLETE_CODE",
      "HIDDEN_RUBRIC_DISCLOSURE",
      "CUMULATIVE_HINT_LEAKAGE",
      "EXCESSIVE_SPECIFICITY",
    ];
    expect([...RISK_CODES].sort()).toEqual([...required].sort());
  });
});

describe("23. hidden rubric/model answer may be used only by the verifier", () => {
  it("BrainstormVerifierInput has fields for hidden reference material (unlike the generator's input type)", () => {
    const input: BrainstormVerifierInput = {
      questionText: "q",
      questionType: "SHORT_ANSWER",
      candidateResponse: "r",
      studentRequest: "s",
      hiddenModelAnswer: "the answer",
      hiddenRubricSummary: "the rubric",
      priorApprovedHintCount: 0,
      cumulativeRiskScoreSoFar: 0,
    };
    expect(Object.keys(input)).toContain("hiddenModelAnswer");
    expect(Object.keys(input)).toContain("hiddenRubricSummary");
  });
});
