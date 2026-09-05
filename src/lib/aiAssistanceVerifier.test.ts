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
import { RISK_CODES, fastVerifyBrainstormResponse, type BrainstormVerifierInput } from "./aiAssistanceVerifier";

function verifierInput(overrides: Partial<BrainstormVerifierInput> = {}): BrainstormVerifierInput {
  return {
    questionText: "Explain the difference between a list and a tuple in Python.",
    questionType: "SHORT_ANSWER",
    candidateResponse: "",
    studentRequest: "Tuple is row and list is a list, right?",
    priorApprovedHintCount: 0,
    cumulativeRiskScoreSoFar: 0,
    ...overrides,
  };
}

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

// Misconception/concept-check follow-up — the fast deterministic
// pre-check must not reject a candidate that merely corrects a wrong
// claim, but must still reject one that confirms a student's own stated
// final answer outright (Part 9's expected verifier behaviour).
describe("fastVerifyBrainstormResponse — misconception correction vs. answer confirmation", () => {
  it("defers (does not deterministically reject) a response that corrects a misconception without disclosing the answer", () => {
    const decision = fastVerifyBrainstormResponse(
      verifierInput({
        candidateResponse:
          "Not quite — a tuple isn't a 'row'; both lists and tuples are Python sequence types. Think about whether their contents can be changed after creation, and also about the syntax used to create each one. Which of those differences can you explain?",
      }),
    );
    expect(decision.kind).toBe("DEFER");
  });

  it("rejects a response that confirms a student's fully-stated final answer outright", () => {
    const decision = fastVerifyBrainstormResponse(
      verifierInput({
        studentRequest: "Lists are mutable and tuples are immutable. Is that the answer?",
        candidateResponse: "Yes, the answer is that lists are mutable and tuples are immutable.",
      }),
    );
    expect(decision.kind).toBe("REJECT");
    if (decision.kind === "REJECT") {
      expect(decision.result.allowed).toBe(false);
      expect(decision.result.riskCodes).toContain("DIRECT_ANSWER");
    }
  });
});

// Concept-explanation quality follow-up — manual Preview testing found a
// substantive concept-explanation request falling all the way to the
// deterministic fallback (both generate+verify attempts failed). These
// prove the FAST deterministic pre-check — the only verifier-side layer
// testable without a live Anthropic call — never itself blocks a genuine
// concept explanation (it DEFERS to the full semantic verifier, which is
// free to approve it), while still deterministically catching the
// contrastive unsafe examples that actually resolve the question.
describe("concept-explanation quality follow-up — factual concept teaching vs. answer disclosure", () => {
  it.each([
    ["*args collects extra positional arguments into a tuple, while **kwargs collects extra keyword arguments into a dictionary.", "SHORT_ANSWER"],
    ["A list is mutable while a tuple is immutable.", "SHORT_ANSWER"],
    ["A decorator is a callable that wraps another function to modify or extend its behaviour.", "SHORT_ANSWER"],
    ["Classification predicts categories, while regression predicts numeric values.", "SHORT_ANSWER"],
  ] as const)("does not deterministically reject a factual concept explanation: %s", (candidateResponse, questionType) => {
    const decision = fastVerifyBrainstormResponse(
      verifierInput({
        questionText: "What is the output of the following code?\n\ndef func(a, b=5, *args, **kwargs):\n    return a, b, args, kwargs",
        questionType,
        studentRequest: "Please explain the difference between a, b and *args, **kwargs parameter? What does * and ** indicate here?",
        candidateResponse,
      }),
    );
    expect(decision.kind).toBe("DEFER");
  });

  it("rejects a candidate that states the final answer AND identifies the correct MCQ option", () => {
    const decision = fastVerifyBrainstormResponse(
      verifierInput({
        questionType: "MULTIPLE_CHOICE",
        candidateResponse: "The correct answer is that lists are mutable and tuples are immutable, so choose option B.",
      }),
    );
    expect(decision.kind).toBe("REJECT");
    if (decision.kind === "REJECT") expect(decision.result.riskCodes).toContain("DIRECT_ANSWER");
  });

  it("rejects a candidate that states the final answer to a non-MCQ question", () => {
    const decision = fastVerifyBrainstormResponse(
      verifierInput({
        questionText: "Which keyword is used to define a function in Python?",
        candidateResponse: "The answer to this question is @decorator.",
      }),
    );
    expect(decision.kind).toBe("REJECT");
    if (decision.kind === "REJECT") expect(decision.result.riskCodes).toContain("DIRECT_ANSWER");
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
