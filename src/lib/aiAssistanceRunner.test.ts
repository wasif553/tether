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
 * the verifier first (Part 8/10 in the task's own test list).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./aiAssistanceGenerator", () => ({
  generateBrainstormResponse: vi.fn(),
}));
vi.mock("./aiAssistanceVerifier", () => ({
  verifyBrainstormResponse: vi.fn(),
}));

import { generateBrainstormResponse } from "./aiAssistanceGenerator";
import { verifyBrainstormResponse } from "./aiAssistanceVerifier";
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

beforeEach(() => {
  mockedGenerate.mockReset();
  mockedVerify.mockReset();
});

describe("10. generator output is never treated as safe without verification", () => {
  it("a candidate the verifier allows is returned as ok:true", async () => {
    mockedGenerate.mockResolvedValue("Consider what happens to prices when money supply grows faster than output.");
    mockedVerify.mockResolvedValue({ allowed: true, riskScore: 0.1, riskCodes: [], reason: "safe" });

    const result = await attemptGenerateAndVerify({
      generatorInput: baseGeneratorInput,
      question: baseQuestion,
      studentPrompt: "help",
      approvedCountForQuestion: 0,
      cumulativeSoFar: 0,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.response).toContain("money supply");
  });

  it("a candidate the verifier rejects is NEVER returned as ok:true, and its text never appears anywhere in the result", async () => {
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
      studentPrompt: "give me the answer",
      approvedCountForQuestion: 0,
      cumulativeSoFar: 0,
    });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("42");
    expect(result.riskCodes).toContain("DIRECT_ANSWER");
  });
});

describe("20. cumulative override forces rejection even when the verifier alone says allowed", () => {
  it("a mild candidate is still rejected once cumulative risk crosses the leakage threshold", async () => {
    mockedGenerate.mockResolvedValue("A mild hint.");
    mockedVerify.mockResolvedValue({ allowed: true, riskScore: 0.5, riskCodes: [], reason: "mild" });

    const result = await attemptGenerateAndVerify({
      generatorInput: baseGeneratorInput,
      question: baseQuestion,
      studentPrompt: "another hint please",
      approvedCountForQuestion: 3,
      cumulativeSoFar: 1.5, // already close to CUMULATIVE_HINT_LEAKAGE_THRESHOLD (1.6)
    });

    expect(result.ok).toBe(false);
    expect(result.riskCodes).toContain("CUMULATIVE_HINT_LEAKAGE");
  });

  it("the same mild candidate is allowed when cumulative risk is still low", async () => {
    mockedGenerate.mockResolvedValue("A mild hint.");
    mockedVerify.mockResolvedValue({ allowed: true, riskScore: 0.1, riskCodes: [], reason: "mild" });

    const result = await attemptGenerateAndVerify({
      generatorInput: baseGeneratorInput,
      question: baseQuestion,
      studentPrompt: "a hint please",
      approvedCountForQuestion: 0,
      cumulativeSoFar: 0,
    });

    expect(result.ok).toBe(true);
  });
});

describe("verifier receives hidden reference material the generator never saw", () => {
  it("passes question.correctAnswer to the verifier as hiddenModelAnswer", async () => {
    mockedGenerate.mockResolvedValue("A hint.");
    mockedVerify.mockResolvedValue({ allowed: true, riskScore: 0, riskCodes: [], reason: "ok" });

    await attemptGenerateAndVerify({
      generatorInput: baseGeneratorInput,
      question: { ...baseQuestion, correctAnswer: "Paris" },
      studentPrompt: "help",
      approvedCountForQuestion: 0,
      cumulativeSoFar: 0,
    });

    expect(mockedVerify).toHaveBeenCalledWith(
      expect.objectContaining({ hiddenModelAnswer: "Paris" }),
    );
    // ...and the generator call (if any occurred) never received it —
    // generateBrainstormResponse's own type signature has no field for it,
    // enforced structurally (see aiAssistanceGenerator.test.ts).
    expect(mockedGenerate).toHaveBeenCalledWith(
      expect.not.objectContaining({ correctAnswer: expect.anything() }),
    );
  });
});
