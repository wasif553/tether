/**
 * Controlled AI Brainstorming Assistance v1 — runner tests (generator/
 * verifier mocked, no Anthropic API call, no Prisma). See
 * docs/controlled-ai-brainstorming-assistance-v1.md.
 *
 * Covers the generate -> verify composition in isolation:
 * attemptGenerateAndVerify is the one function in aiAssistanceRunner.ts
 * that touches neither Prisma nor auth, so it can be tested directly with
 * the generator/verifier modules mocked — a real, non-trivial guarantee
 * that generator output is never treated as safe without passing through
 * the verifier first, AND that every provider/parsing failure mode
 * resolves to a safe "error" outcome rather than propagating an
 * exception the caller would have to remember to catch.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./aiAssistanceGenerator", () => ({
  generateBrainstormResponse: vi.fn(),
  // Intermittent-failure follow-up — mirrors the real class's `category`
  // field (see aiAssistanceGenerator.ts) so attemptGenerateAndVerify's
  // stage-aware classification can be tested here without needing the
  // real Anthropic-SDK-backed module.
  AiAssistanceGenerationError: class AiAssistanceGenerationError extends Error {
    category: string;
    constructor(message: string, category = "UNKNOWN") {
      super(message);
      this.category = category;
    }
  },
}));
vi.mock("./aiAssistanceVerifier", () => ({
  verifyBrainstormResponse: vi.fn(),
  AiAssistanceVerificationError: class AiAssistanceVerificationError extends Error {
    category: string;
    constructor(message: string, category = "UNKNOWN") {
      super(message);
      this.category = category;
    }
  },
}));

import { generateBrainstormResponse, AiAssistanceGenerationError } from "./aiAssistanceGenerator";
import { verifyBrainstormResponse, AiAssistanceVerificationError } from "./aiAssistanceVerifier";
import { attemptGenerateAndVerify, rejectionRegenerationHint } from "./aiAssistanceRunner";

const mockedGenerate = vi.mocked(generateBrainstormResponse);
const mockedVerify = vi.mocked(verifyBrainstormResponse);

const baseGeneratorInput = {
  questionText: "What causes inflation?",
  questionType: "ESSAY" as const,
  policy: {
    allowConceptExplanations: true,
    allowAnswerPlanning: true,
    allowReasoningFeedback: true,
    allowProgrammingConceptHelp: true,
    maxResponseCharacters: 800,
  },
  studentRequest: "Can you help me understand this?",
  requestMode: "GENERIC_HELP" as const,
  priorApprovedInteractions: [],
  hintLadderLevel: 1,
};

const baseQuestion = { text: "What causes inflation?", type: "ESSAY", correctAnswer: null };
const basePolicy = { maxResponseCharacters: 800 };

beforeEach(() => {
  mockedGenerate.mockReset();
  mockedVerify.mockReset();
});

describe("10. generator output is never treated as safe without verification", () => {
  it("a candidate the verifier allows is returned as approved", async () => {
    mockedGenerate.mockResolvedValue("Consider what happens to prices when money supply grows faster than output.");
    mockedVerify.mockResolvedValue({ allowed: true, riskScore: 0.1, riskCodes: [], reason: "safe" });

    const result = await attemptGenerateAndVerify({
      generatorInput: baseGeneratorInput,
      question: baseQuestion,
      policy: basePolicy,
      studentPrompt: "help",
      approvedCountForQuestion: 0,
      cumulativeSoFar: 0,
    });

    expect(result.kind).toBe("approved");
    if (result.kind === "approved") expect(result.response).toContain("money supply");
  });

  it("a candidate the verifier rejects is NEVER returned as approved, and its text never appears anywhere in the result", async () => {
    mockedGenerate.mockResolvedValue("The answer is exactly 42.");
    mockedVerify.mockResolvedValue({
      allowed: false,
      riskScore: 0.95,
      riskCodes: ["DIRECT_ANSWER"],
      reason: "unsafe",
    });

    const result = await attemptGenerateAndVerify({
      generatorInput: baseGeneratorInput,
      question: baseQuestion,
      policy: basePolicy,
      studentPrompt: "give me the answer",
      approvedCountForQuestion: 0,
      cumulativeSoFar: 0,
    });

    expect(result.kind).toBe("rejected");
    expect(JSON.stringify(result)).not.toContain("42");
    if (result.kind === "rejected") expect(result.riskCodes).toContain("DIRECT_ANSWER");
  });
});

describe("1/4/5/6/7/8. fail-closed: every provider/parsing failure resolves to 'error', never an exception", () => {
  it("4/5. generator throwing (missing API key, timeout, transport failure) resolves to 'error'", async () => {
    mockedGenerate.mockRejectedValue(new AiAssistanceGenerationError("Anthropic API request failed", "SERVER_ERROR"));

    const result = await attemptGenerateAndVerify({
      generatorInput: baseGeneratorInput,
      question: baseQuestion,
      policy: basePolicy,
      studentPrompt: "help",
      approvedCountForQuestion: 0,
      cumulativeSoFar: 0,
    });

    expect(result.kind).toBe("error");
    expect(mockedVerify).not.toHaveBeenCalled();
    // Intermittent-failure follow-up — a generator failure is tagged
    // stage "generator" with the classified category preserved, so
    // runAiAssistanceRequest can tell it apart from a verifier failure
    // (see the "stage-aware" describe block below).
    if (result.kind === "error") {
      expect(result.stage).toBe("generator");
      expect(result.category).toBe("SERVER_ERROR");
    }
  });

  it("6. malformed/empty generator output (surfaced as a thrown error by the generator itself) resolves to 'error'", async () => {
    mockedGenerate.mockRejectedValue(new AiAssistanceGenerationError("Anthropic returned an empty response"));

    const result = await attemptGenerateAndVerify({
      generatorInput: baseGeneratorInput,
      question: baseQuestion,
      policy: basePolicy,
      studentPrompt: "help",
      approvedCountForQuestion: 0,
      cumulativeSoFar: 0,
    });

    expect(result.kind).toBe("error");
  });

  it("7/8. verifier throwing (malformed JSON, unknown risk code, schema mismatch) resolves to 'error', not a crash", async () => {
    mockedGenerate.mockResolvedValue("A candidate response.");
    mockedVerify.mockRejectedValue(new AiAssistanceVerificationError("Verifier output did not match the expected schema", "SCHEMA_ERROR"));

    const result = await attemptGenerateAndVerify({
      generatorInput: baseGeneratorInput,
      question: baseQuestion,
      policy: basePolicy,
      studentPrompt: "help",
      approvedCountForQuestion: 0,
      cumulativeSoFar: 0,
    });

    expect(result.kind).toBe("error");
    // Intermittent-failure follow-up — distinct from a generator failure:
    // the candidate WAS produced, only the safety check itself failed.
    if (result.kind === "error") {
      expect(result.stage).toBe("verifier");
      expect(result.category).toBe("SCHEMA_ERROR");
    }
  });

  it("a thrown error never contains the raw candidate text (nothing to leak — the result carries no text field at all)", async () => {
    mockedGenerate.mockResolvedValue("some candidate text");
    mockedVerify.mockRejectedValue(new Error("boom"));

    const result = await attemptGenerateAndVerify({
      generatorInput: baseGeneratorInput,
      question: baseQuestion,
      policy: basePolicy,
      studentPrompt: "help",
      approvedCountForQuestion: 0,
      cumulativeSoFar: 0,
    });

    expect(JSON.stringify(result)).not.toContain("some candidate text");
    // Intermittent-failure follow-up — a plain (unclassified) thrown
    // error is never mistaken for a specific category; it degrades to
    // UNKNOWN rather than a guessed/incorrect classification.
    if (result.kind === "error") expect(result.category).toBe("UNKNOWN");
  });
});

// Intermittent-failure follow-up — proves attemptGenerateAndVerify itself
// (not just the underlying generator/verifier modules, covered by their
// own *.sdk.test.ts files) correctly threads the diagnostics callback
// through to both calls and reports per-stage timing, regardless of
// outcome. src/lib/aiAssistanceRunner.ts's runAiAssistanceRequest uses
// exactly this diagnostics shape to build its one-line-per-interaction
// log (see logAiAssistanceDiagnostics), gated off in production.
describe("intermittent-failure follow-up — diagnostics threading", () => {
  it("an approved outcome carries generator+verifier diagnostics with non-negative timings", async () => {
    mockedGenerate.mockImplementation(async (_input, diagnostics) => {
      diagnostics?.onAttempt?.({ attempt: 1, outcome: "SUCCESS", durationMs: 5 });
      return "A safe hint.";
    });
    mockedVerify.mockImplementation(async (_input, diagnostics) => {
      diagnostics?.onAttempt?.({ attempt: 1, outcome: "SUCCESS", durationMs: 3 });
      return { allowed: true, riskScore: 0.1, riskCodes: [], reason: "safe" };
    });

    const result = await attemptGenerateAndVerify({
      generatorInput: baseGeneratorInput,
      question: baseQuestion,
      policy: basePolicy,
      studentPrompt: "help",
      approvedCountForQuestion: 0,
      cumulativeSoFar: 0,
    });

    expect(result.kind).toBe("approved");
    expect(result.diagnostics.generator.attempts).toEqual([{ attempt: 1, outcome: "SUCCESS", durationMs: 5 }]);
    expect(result.diagnostics.verifier.attempts).toEqual([{ attempt: 1, outcome: "SUCCESS", durationMs: 3 }]);
    expect(result.diagnostics.generator.ranMs).toBeGreaterThanOrEqual(0);
    expect(result.diagnostics.verifier.ranMs).toBeGreaterThanOrEqual(0);
  });

  it("a generator failure carries generator attempts but an EMPTY verifier stage — the verifier never ran at all", async () => {
    mockedGenerate.mockImplementation(async (_input, diagnostics) => {
      diagnostics?.onAttempt?.({ attempt: 1, outcome: "OVERLOADED", durationMs: 10 });
      diagnostics?.onAttempt?.({ attempt: 2, outcome: "OVERLOADED", durationMs: 12 });
      throw new AiAssistanceGenerationError("Anthropic API request failed", "OVERLOADED");
    });

    const result = await attemptGenerateAndVerify({
      generatorInput: baseGeneratorInput,
      question: baseQuestion,
      policy: basePolicy,
      studentPrompt: "help",
      approvedCountForQuestion: 0,
      cumulativeSoFar: 0,
    });

    expect(result.kind).toBe("error");
    expect(result.diagnostics.generator.attempts).toHaveLength(2);
    expect(result.diagnostics.verifier.attempts).toEqual([]);
    expect(mockedVerify).not.toHaveBeenCalled();
  });
});

describe("21. server-side response-length enforcement (Part 9) — never truncated, treated as rejected", () => {
  it("a verifier-approved candidate longer than the policy limit is NOT approved", async () => {
    const longResponse = "x".repeat(50);
    mockedGenerate.mockResolvedValue(longResponse);
    mockedVerify.mockResolvedValue({ allowed: true, riskScore: 0.1, riskCodes: [], reason: "safe but long" });

    const result = await attemptGenerateAndVerify({
      generatorInput: baseGeneratorInput,
      question: baseQuestion,
      policy: { maxResponseCharacters: 10 },
      studentPrompt: "help",
      approvedCountForQuestion: 0,
      cumulativeSoFar: 0,
    });

    expect(result.kind).toBe("rejected");
    // Never truncated and returned — a rejected outcome carries no response text at all.
    expect(JSON.stringify(result)).not.toContain(longResponse);
  });

  it("a verifier-approved candidate within the policy limit is approved unchanged", async () => {
    const shortResponse = "A short hint.";
    mockedGenerate.mockResolvedValue(shortResponse);
    mockedVerify.mockResolvedValue({ allowed: true, riskScore: 0.1, riskCodes: [], reason: "safe" });

    const result = await attemptGenerateAndVerify({
      generatorInput: baseGeneratorInput,
      question: baseQuestion,
      policy: { maxResponseCharacters: 800 },
      studentPrompt: "help",
      approvedCountForQuestion: 0,
      cumulativeSoFar: 0,
    });

    expect(result.kind).toBe("approved");
    if (result.kind === "approved") expect(result.response).toBe(shortResponse);
  });
});

describe("20. cumulative override forces rejection even when the verifier alone says allowed", () => {
  it("a mild candidate is still rejected once cumulative risk crosses the leakage threshold", async () => {
    mockedGenerate.mockResolvedValue("A mild hint.");
    mockedVerify.mockResolvedValue({ allowed: true, riskScore: 0.5, riskCodes: [], reason: "mild" });

    const result = await attemptGenerateAndVerify({
      generatorInput: baseGeneratorInput,
      question: baseQuestion,
      policy: basePolicy,
      studentPrompt: "another hint please",
      approvedCountForQuestion: 3,
      cumulativeSoFar: 1.5, // already close to CUMULATIVE_HINT_LEAKAGE_THRESHOLD (1.6)
    });

    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") expect(result.riskCodes).toContain("CUMULATIVE_HINT_LEAKAGE");
  });

  it("the same mild candidate is allowed when cumulative risk is still low", async () => {
    mockedGenerate.mockResolvedValue("A mild hint.");
    mockedVerify.mockResolvedValue({ allowed: true, riskScore: 0.1, riskCodes: [], reason: "mild" });

    const result = await attemptGenerateAndVerify({
      generatorInput: baseGeneratorInput,
      question: baseQuestion,
      policy: basePolicy,
      studentPrompt: "a hint please",
      approvedCountForQuestion: 0,
      cumulativeSoFar: 0,
    });

    expect(result.kind).toBe("approved");
  });
});

describe("15/16. verifier receives hidden reference material the generator never saw", () => {
  it("passes question.correctAnswer to the verifier as hiddenModelAnswer", async () => {
    mockedGenerate.mockResolvedValue("A hint.");
    mockedVerify.mockResolvedValue({ allowed: true, riskScore: 0, riskCodes: [], reason: "ok" });

    await attemptGenerateAndVerify({
      generatorInput: baseGeneratorInput,
      question: { ...baseQuestion, correctAnswer: "Paris" },
      policy: basePolicy,
      studentPrompt: "help",
      approvedCountForQuestion: 0,
      cumulativeSoFar: 0,
    });

    // Intermittent-failure follow-up — both calls now also receive an
    // optional second `{ onAttempt }` diagnostics argument (see
    // aiAssistanceGenerator.ts/aiAssistanceVerifier.ts); matched loosely
    // here since this test is about the FIRST (input) argument only.
    expect(mockedVerify).toHaveBeenCalledWith(expect.objectContaining({ hiddenModelAnswer: "Paris" }), expect.anything());
    // ...and the generator call never received it — generateBrainstormResponse's
    // own type signature has no field for it, enforced structurally (see
    // aiAssistanceGenerator.test.ts).
    expect(mockedGenerate).toHaveBeenCalledWith(expect.not.objectContaining({ correctAnswer: expect.anything() }), expect.anything());
  });

  it("caps an over-length hidden model answer before sending it to the verifier (Part 9 payload bound)", async () => {
    mockedGenerate.mockResolvedValue("A hint.");
    mockedVerify.mockResolvedValue({ allowed: true, riskScore: 0, riskCodes: [], reason: "ok" });

    const veryLongAnswer = "a".repeat(5_000);
    await attemptGenerateAndVerify({
      generatorInput: baseGeneratorInput,
      question: { ...baseQuestion, correctAnswer: veryLongAnswer },
      policy: basePolicy,
      studentPrompt: "help",
      approvedCountForQuestion: 0,
      cumulativeSoFar: 0,
    });

    const call = mockedVerify.mock.calls[0][0];
    expect(call.hiddenModelAnswer!.length).toBeLessThan(veryLongAnswer.length);
  });
});

// Concept-explanation quality follow-up — the runner's targeted
// regeneration instruction (section 1/5 of the follow-up: WHY the
// previous candidate was rejected, not just "be more conservative").
// Pure mapping, no Prisma/Anthropic involved.
describe("rejectionRegenerationHint — targeted regeneration instruction from the rejection reason", () => {
  const diagnostics = { generator: { attempts: [], ranMs: 0 }, verifier: { attempts: [], ranMs: 0 } };

  it("describes a single risk code in plain language", () => {
    const hint = rejectionRegenerationHint({ kind: "rejected", riskScore: 0.9, riskCodes: ["DIRECT_ANSWER"], reason: "too close to the answer", diagnostics });
    expect(hint).toContain("it stated or clearly implied the final answer");
  });

  it("joins multiple risk codes into one instruction", () => {
    const hint = rejectionRegenerationHint({
      kind: "rejected",
      riskScore: 0.9,
      riskCodes: ["CORRECT_OPTION_DISCLOSED", "OPTION_ELIMINATION"],
      reason: "disclosed the option",
      diagnostics,
    });
    expect(hint).toContain("it identified or implied which option is correct");
    expect(hint).toContain("it ruled options in or out");
  });

  it("gives a length-specific instruction when the rejection carries no risk codes (verifier allowed it, but it was too long)", () => {
    const hint = rejectionRegenerationHint({ kind: "rejected", riskScore: 0, riskCodes: [], reason: "allowed but over length", diagnostics });
    expect(hint).toContain("too long");
  });

  it("still permits concept/syntax/terminology explanation in the regeneration instruction — this is not the old blanket 'be more conservative' line", () => {
    const hint = rejectionRegenerationHint({ kind: "rejected", riskScore: 0.9, riskCodes: ["EXCESSIVE_SPECIFICITY"], reason: "too specific", diagnostics });
    expect(hint).toContain("you may still explain relevant concepts, syntax, or terminology");
  });

  // Cumulative answer-assembly follow-up.
  it("describes SUBMISSION_READY_COMPLETION and CUMULATIVE_RESPONSE_COMPLETION distinctly", () => {
    const singleTurn = rejectionRegenerationHint({
      kind: "rejected",
      riskScore: 0.9,
      riskCodes: ["SUBMISSION_READY_COMPLETION"],
      reason: "completed the comparison alone",
      diagnostics,
    });
    expect(singleTurn).toContain("it supplied enough content to substantially complete the assessed response on its own");

    const cumulative = rejectionRegenerationHint({
      kind: "rejected",
      riskScore: 0.9,
      riskCodes: ["CUMULATIVE_RESPONSE_COMPLETION"],
      reason: "completed combined with prior guidance",
      diagnostics,
    });
    expect(cumulative).toContain("combined with earlier approved guidance for this question it substantially completed the assessed response");
  });

  it("returns null for a provider/verifier ERROR outcome (nothing specific to say — caller falls back to the generic stricter line)", () => {
    expect(rejectionRegenerationHint({ kind: "error", stage: "verifier", category: "UNKNOWN", diagnostics })).toBeNull();
    expect(rejectionRegenerationHint({ kind: "error", stage: "generator", category: "TIMEOUT", diagnostics })).toBeNull();
  });

  it("returns null for an approved outcome (defensive — never actually called this way by the runner)", () => {
    expect(rejectionRegenerationHint({ kind: "approved", response: "ok", riskScore: 0, riskCodes: [], diagnostics })).toBeNull();
  });
});
