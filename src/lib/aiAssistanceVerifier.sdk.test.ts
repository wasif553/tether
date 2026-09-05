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
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

// Intermittent-failure follow-up — importOriginal keeps the SDK's real
// error classes (RateLimitError, InternalServerError, ...) available for
// constructing realistic thrown errors below, while still replacing only
// the `default` client class with the mock (never a real network call).
vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  class MockAnthropic {
    messages = { create: mockCreate };
  }
  return { ...actual, default: MockAnthropic };
});

const {
  verifyBrainstormResponse,
  ANTHROPIC_BRAINSTORM_VERIFIER_MODEL_DEFAULT,
  AiAssistanceVerificationError,
  AI_ASSISTANCE_VERIFIER_MAX_ATTEMPTS,
} = await import("./aiAssistanceVerifier");
const { InternalServerError, RateLimitError } = await import("@anthropic-ai/sdk");

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
  delete process.env.ANTHROPIC_BRAINSTORM_VERIFIER_MODEL;
});

describe("model configuration", () => {
  it("uses the dedicated low-latency verifier model by default", async () => {
    mockCreate.mockResolvedValue(textResponse(validVerifierJson()));

    await verifyBrainstormResponse(baseInput);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: ANTHROPIC_BRAINSTORM_VERIFIER_MODEL_DEFAULT }),
    );
  });

  it("respects ANTHROPIC_BRAINSTORM_VERIFIER_MODEL", async () => {
    process.env.ANTHROPIC_BRAINSTORM_VERIFIER_MODEL = "claude-verifier-custom-1";
    mockCreate.mockResolvedValue(textResponse(validVerifierJson()));

    await verifyBrainstormResponse(baseInput);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-verifier-custom-1" }),
    );
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

  // Guidance-vs-final-answer misclassification follow-up — the fallback
  // refusal students hit for legitimate guidance requests (e.g. "Can you
  // suggest how to get the answer?") traced to this verifier: its prompt
  // didn't tell the model that the STUDENT'S own wording is not what's
  // being judged, only the candidate response is — so a guidance request
  // that happens to contain "answer" risked being read as evidence the
  // candidate response was unsafe. This clarifying instruction fixes that
  // without weakening any UNSAFE criterion.
  it("clarifies that only the candidate response (never the student's own request wording) can trigger an unsafe verdict", async () => {
    mockCreate.mockResolvedValue(textResponse(validVerifierJson()));

    await verifyBrainstormResponse(baseInput);

    const call = mockCreate.mock.calls[0][0];
    expect(call.system).toContain("Judge ONLY the candidate response text");
    expect(call.system).toContain("guidance or method, not disclosure");
  });

  // Misconception/concept-check follow-up — the verifier's prompt didn't
  // distinguish "corrects a wrong claim" from "confirms a stated final
  // answer", risking an over-cautious rejection of legitimate corrective
  // guidance (e.g. "Not quite — a tuple is not a row").
  it("clarifies that correcting a misconception is safe, but confirming a student's stated final answer is not", async () => {
    mockCreate.mockResolvedValue(textResponse(validVerifierJson()));

    await verifyBrainstormResponse(baseInput);

    const call = mockCreate.mock.calls[0][0];
    expect(call.system).toContain("corrects a student's mistaken claim");
    expect(call.system).toContain("even when phrased as agreement rather than as a fresh statement");
  });

  // Concept-explanation quality follow-up — a substantive, accurate
  // explanation of a general concept/syntax/terminology (e.g. what
  // *args/**kwargs do in Python) was at risk of being rejected as
  // EXCESSIVE_SPECIFICITY purely for being detailed, even though it never
  // touched the actual question's answer. This clarifies the criterion is
  // about answer-specific reasoning, not general subject-matter teaching.
  it("clarifies that thorough concept/syntax/terminology explanation is not EXCESSIVE_SPECIFICITY by itself", async () => {
    mockCreate.mockResolvedValue(textResponse(validVerifierJson()));

    await verifyBrainstormResponse(baseInput);

    const call = mockCreate.mock.calls[0][0];
    expect(call.system).toContain("EXCESSIVE_SPECIFICITY concerns answer-specific reasoning steps for the ACTUAL question, not general subject-matter teaching");
    expect(call.system).toContain("is NOT excessive specificity by itself");
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

// Intermittent-failure follow-up — see the identical describe block in
// aiAssistanceGenerator.sdk.test.ts. The verifier is retried with the
// same bounded, classified, backed-off policy as the generator — an
// intermittent Brainstorm failure caused by a transient verifier-side
// 429/529/timeout is exactly the "sometimes works, sometimes doesn't"
// symptom this whole follow-up investigates, and section 5 of the task
// (verifier fail-closed behaviour) specifically depends on the verifier's
// OWN failure being distinguishable from a genuine safety rejection —
// see aiAssistanceRunner.ts's stage-aware GenerateVerifyOutcome.
describe("intermittent-failure follow-up — transient-error retry with backoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a transient 529 overloaded error and succeeds on the second attempt, reporting both attempts via onAttempt", async () => {
    const overloaded = new InternalServerError(529, {}, "529 Overloaded", new Headers(), "overloaded_error");
    mockCreate.mockRejectedValueOnce(overloaded).mockResolvedValueOnce(textResponse(validVerifierJson()));
    const attempts: unknown[] = [];

    const promise = verifyBrainstormResponse(baseInput, { onAttempt: (log) => attempts.push(log) });
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toMatchObject({ allowed: true });
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(attempts).toEqual([
      { attempt: 1, outcome: "OVERLOADED", durationMs: expect.any(Number) },
      { attempt: 2, outcome: "SUCCESS", durationMs: expect.any(Number) },
    ]);
  });

  it("stops retrying after AI_ASSISTANCE_VERIFIER_MAX_ATTEMPTS and throws AiAssistanceVerificationError with the last attempt's category — a persistent provider outage still fails, but does not hang", async () => {
    const rateLimited = new RateLimitError(429, {}, "429", new Headers(), "rate_limit_error");
    mockCreate.mockRejectedValue(rateLimited);

    const promise = verifyBrainstormResponse(baseInput);
    const typeAssertion = expect(promise).rejects.toBeInstanceOf(AiAssistanceVerificationError);
    const categoryAssertion = expect(promise).rejects.toMatchObject({ category: "RATE_LIMITED" });
    await vi.runAllTimersAsync();
    await typeAssertion;
    await categoryAssertion;

    expect(mockCreate).toHaveBeenCalledTimes(AI_ASSISTANCE_VERIFIER_MAX_ATTEMPTS);
  });

  it("classifies malformed verifier output distinctly: non-JSON text as PARSE_ERROR, and JSON that fails the result schema as SCHEMA_ERROR — neither is retried", async () => {
    mockCreate.mockResolvedValueOnce(textResponse("not json at all"));
    const promise1 = verifyBrainstormResponse(baseInput);
    await expect(promise1).rejects.toMatchObject({ category: "PARSE_ERROR" });
    expect(mockCreate).toHaveBeenCalledTimes(1);

    mockCreate.mockReset();
    mockCreate.mockResolvedValueOnce(textResponse(JSON.stringify({ allowed: true, riskScore: 2, riskCodes: [], reason: "ok" })));
    const promise2 = verifyBrainstormResponse(baseInput);
    await expect(promise2).rejects.toMatchObject({ category: "SCHEMA_ERROR" });
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});
