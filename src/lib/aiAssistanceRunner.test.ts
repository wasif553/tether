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
  AiAssistanceGenerationError: class AiAssistanceGenerationError extends Error {},
}));
vi.mock("./aiAssistanceVerifier", () => ({
  verifyBrainstormResponse: vi.fn(),
  AiAssistanceVerificationError: class AiAssistanceVerificationError extends Error {},
}));

import { generateBrainstormResponse, AiAssistanceGenerationError } from "./aiAssistanceGenerator";
import { verifyBrainstormResponse, AiAssistanceVerificationError } from "./aiAssistanceVerifier";
import { attemptGenerateAndVerify } from "./aiAssistanceRunner";

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
    mockedGenerate.mockRejectedValue(new AiAssistanceGenerationError("Anthropic API request failed"));

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
    mockedVerify.mockRejectedValue(new AiAssistanceVerificationError("Verifier output did not match the expected schema"));

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

    expect(mockedVerify).toHaveBeenCalledWith(expect.objectContaining({ hiddenModelAnswer: "Paris" }));
    // ...and the generator call never received it — generateBrainstormResponse's
    // own type signature has no field for it, enforced structurally (see
    // aiAssistanceGenerator.test.ts).
    expect(mockedGenerate).toHaveBeenCalledWith(expect.not.objectContaining({ correctAnswer: expect.anything() }));
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
