/**
 * Controlled AI Brainstorming Assistance v1 — verifier SDK-call tests.
 * See docs/controlled-ai-brainstorming-assistance-v1.md.
 *
 * Mocks @anthropic-ai/sdk directly (same pattern as
 * src/lib/ai/essayMarker.test.ts / aiAssistanceGenerator.sdk.test.ts) —
 * never calls the real Anthropic API. Covers what
 * aiAssistanceVerifier.test.ts (structural-only) does not: the actual
 * model/message shape sent to the SDK, that the model is resolved from
 * the same ANTHROPIC_BRAINSTORM_MODEL config the generator uses (not a
 * second, independently hard-coded literal), and correct parsing of the
 * verifier's structured JSON output.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = { create: mockCreate };
  }
  return { default: MockAnthropic };
});

const { verifyBrainstormResponse } = await import("./aiAssistanceVerifier");
const { ANTHROPIC_BRAINSTORM_MODEL_DEFAULT } = await import("./aiAssistanceGenerator");

function textResponse(text: string) {
  return { content: [{ type: "text", text }] };
}

function validVerifierJson(overrides: Partial<Record<string, unknown>> = {}) {
  return JSON.stringify({
    allowed: true,
    riskScore: 0.1,
    riskCodes: [],
    reason: "Safe, general guidance only.",
    ...overrides,
  });
}

const baseInput = {
  questionText: "Explain the water cycle.",
  questionType: "SHORT_ANSWER" as const,
  candidateResponse: "What stages might water move through as it heats and cools?",
  studentRequest: "Can you help me understand this question?",
  priorApprovedHintCount: 0,
  cumulativeRiskScoreSoFar: 0,
};

beforeAll(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
});

afterEach(() => {
  mockCreate.mockReset();
  delete process.env.ANTHROPIC_BRAINSTORM_MODEL;
});

describe("model configuration", () => {
  it("calls the SDK with the same brainstorm model default the generator uses", async () => {
    mockCreate.mockResolvedValue(textResponse(validVerifierJson()));

    await verifyBrainstormResponse(baseInput);

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: ANTHROPIC_BRAINSTORM_MODEL_DEFAULT }));
  });

  it("respects ANTHROPIC_BRAINSTORM_MODEL — never a second, independently hard-coded literal", async () => {
    process.env.ANTHROPIC_BRAINSTORM_MODEL = "claude-brainstorm-custom-1";
    mockCreate.mockResolvedValue(textResponse(validVerifierJson()));

    await verifyBrainstormResponse(baseInput);

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-brainstorm-custom-1" }));
  });
});

describe("message shape sent to Anthropic", () => {
  it("sends the verifier policy via the `system` field, and exactly one user-role message", async () => {
    mockCreate.mockResolvedValue(textResponse(validVerifierJson()));

    await verifyBrainstormResponse(baseInput);

    const call = mockCreate.mock.calls[0][0];
    expect(typeof call.system).toBe("string");
    expect(call.system).toContain("independent safety verifier");
    expect(call.messages).toHaveLength(1);
    expect(call.messages[0].role).toBe("user");
  });

  it("includes the hidden model answer only in the user content, and only when supplied", async () => {
    mockCreate.mockResolvedValue(textResponse(validVerifierJson()));

    await verifyBrainstormResponse({ ...baseInput, hiddenModelAnswer: "Evaporation, condensation, precipitation." });

    const call = mockCreate.mock.calls[0][0];
    expect(call.messages[0].content).toContain("Evaporation, condensation, precipitation.");
    expect(call.system).not.toContain("Evaporation, condensation, precipitation.");
  });
});

describe("response parsing", () => {
  it("parses a well-formed JSON verdict", async () => {
    mockCreate.mockResolvedValue(textResponse(validVerifierJson({ allowed: false, riskScore: 0.8, riskCodes: ["DIRECT_ANSWER"] })));

    const result = await verifyBrainstormResponse(baseInput);

    expect(result.allowed).toBe(false);
    expect(result.riskScore).toBe(0.8);
    expect(result.riskCodes).toEqual(["DIRECT_ANSWER"]);
  });

  it("strips markdown fences before parsing", async () => {
    mockCreate.mockResolvedValue(textResponse("```json\n" + validVerifierJson() + "\n```"));

    const result = await verifyBrainstormResponse(baseInput);

    expect(result.allowed).toBe(true);
  });
});
