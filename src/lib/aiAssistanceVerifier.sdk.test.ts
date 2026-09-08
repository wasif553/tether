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
 * second, independently hard-coded literal), and that the verifier now
 * consumes Anthropic's provider-native structured output
 * (client.messages.parse + output_config.format) rather than manually
 * parsing free-form JSON text — see aiAssistanceVerifier.ts.
 *
 * mockCreate stands in for the raw provider call only, exactly like
 * before. messages.parse is reimplemented here using the SDK's OWN real
 * parseMessage (@anthropic-ai/sdk/lib/parser.js) — the same function the
 * real, unmocked client.messages.parse() calls internally — so
 * output_config.format (built by the real, unmocked zodOutputFormat) is
 * exercised for real: a schema-valid mockCreate response really does
 * produce response.parsed_output, and a schema-invalid one really does
 * throw the same way the live SDK does. Only the network call itself is
 * faked.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseMessage } from "@anthropic-ai/sdk/lib/parser.js";

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

// Intermittent-failure follow-up — importOriginal keeps the SDK's real
// error classes (RateLimitError, InternalServerError, ...) available for
// constructing realistic thrown errors below, while still replacing only
// the `default` client class with the mock (never a real network call).
vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  class MockAnthropic {
    messages = {
      create: mockCreate,
      // production code (aiAssistanceVerifier.ts) calls
      // client.messages.parse(params) with no second argument — matching
      // that exactly here (rather than forwarding an extra `undefined`)
      // keeps mockCreate's recorded call args identical to the pre-
      // structured-output mock, so the existing "message shape sent to
      // Anthropic" assertions below don't need to know about `.parse` at
      // all.
      parse: (params: unknown) =>
        mockCreate(params).then((message: unknown) => parseMessage(message as never, params as never, {} as never)),
    };
  }
  return { ...actual, default: MockAnthropic };
});

const {
  verifyBrainstormResponse,
  ANTHROPIC_BRAINSTORM_VERIFIER_MODEL_DEFAULT,
  AiAssistanceVerificationError,
  AI_ASSISTANCE_VERIFIER_MAX_ATTEMPTS,
  RISK_CODES,
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

  it("includes the hidden model answer only in the user content, and only when supplied", async () => {
    mockCreate.mockResolvedValue(textResponse(validVerifierJson()));

    await verifyBrainstormResponse({ ...baseInput, hiddenModelAnswer: "Evaporation, condensation, precipitation." });

    const call = mockCreate.mock.calls[0][0];
    expect(call.messages[0].content).toContain("Evaporation, condensation, precipitation.");
    expect(call.system).not.toContain("Evaporation, condensation, precipitation.");
  });
});

// Live-defect regression coverage — the deployed verifier was calling
// client.messages.create(), asking Claude in the PROMPT to return JSON,
// then hand-parsing response text (extract text block -> strip markdown
// fences -> JSON.parse -> zod validate). A provider response that was
// valid JSON but didn't exactly match verifierResultSchema (or wasn't
// JSON at all) produced SCHEMA_ERROR/PARSE_ERROR, which the runner
// retried once more and then surfaced as the generic FALLBACK — observed
// on both Preview and the 84452cc Production deployment. This section
// proves the verifier no longer depends on manually parsing free-form
// text at all: it consumes response.parsed_output from a
// client.messages.parse(...) call whose output_config.format is the
// SAME verifierResultSchema, via Anthropic's provider-native structured
// outputs (@anthropic-ai/sdk/helpers/zod's zodOutputFormat) — while still
// never trusting parsed_output blindly (verifierResultSchema.safeParse
// runs again on it, fail-closed exactly as before a schema mismatch).
describe("structured output transport (live-defect regression)", () => {
  it("1. requests structured output — output_config.format is present, not free-form JSON-in-the-prompt parsing", async () => {
    mockCreate.mockResolvedValue(textResponse(validVerifierJson()));

    await verifyBrainstormResponse(baseInput);

    const call = mockCreate.mock.calls[0][0];
    expect(call.output_config).toBeDefined();
    expect(call.output_config.format).toBeDefined();
    expect(call.output_config.format.type).toBe("json_schema");
    expect(typeof call.output_config.format.parse).toBe("function");
  });

  it("2. output_config.format's JSON schema is derived from verifierResultSchema — the same allowed/riskScore/riskCodes/reason fields and risk-code vocabulary", async () => {
    mockCreate.mockResolvedValue(textResponse(validVerifierJson()));

    await verifyBrainstormResponse(baseInput);

    const { schema } = mockCreate.mock.calls[0][0].output_config.format;
    expect(Object.keys(schema.properties).sort()).toEqual(["allowed", "reason", "riskCodes", "riskScore"]);
    for (const code of RISK_CODES) {
      expect(JSON.stringify(schema)).toContain(code);
    }
  });
});

describe("response parsing", () => {
  it("3 & 5. parses a well-formed structured verdict into the same BrainstormVerifierResult values, allowed=false when schema-valid", async () => {
    mockCreate.mockResolvedValue(textResponse(validVerifierJson({ allowed: false, riskScore: 0.8, riskCodes: ["DIRECT_ANSWER"] })));

    const result = await verifyBrainstormResponse(baseInput);

    expect(result.allowed).toBe(false);
    expect(result.riskScore).toBe(0.8);
    expect(result.riskCodes).toEqual(["DIRECT_ANSWER"]);
    expect(result.reason).toBe("Safe, general guidance only.");
  });

  it("4. allowed=true remains allowed when schema-valid", async () => {
    mockCreate.mockResolvedValue(textResponse(validVerifierJson({ allowed: true, riskScore: 0.05, riskCodes: [] })));

    const result = await verifyBrainstormResponse(baseInput);

    expect(result.allowed).toBe(true);
    expect(result.riskCodes).toEqual([]);
  });
});

describe("fail-closed validation of structured output — never coerced, never accepted malformed (live-defect regression)", () => {
  it("7. an unknown/invented risk code cannot pass validation", async () => {
    mockCreate.mockResolvedValue(
      textResponse(JSON.stringify({ allowed: false, riskScore: 0.5, riskCodes: ["NOT_A_REAL_RISK_CODE"], reason: "x" })),
    );

    await expect(verifyBrainstormResponse(baseInput)).rejects.toMatchObject({ category: "SCHEMA_ERROR" });
  });

  it("8. a missing required field cannot pass validation", async () => {
    mockCreate.mockResolvedValue(textResponse(JSON.stringify({ allowed: true, riskScore: 0.1, riskCodes: [] })));

    await expect(verifyBrainstormResponse(baseInput)).rejects.toMatchObject({ category: "SCHEMA_ERROR" });
  });

  it("9. an out-of-range riskScore cannot pass validation", async () => {
    mockCreate.mockResolvedValue(textResponse(JSON.stringify({ allowed: true, riskScore: 2, riskCodes: [], reason: "ok" })));

    await expect(verifyBrainstormResponse(baseInput)).rejects.toMatchObject({ category: "SCHEMA_ERROR" });
  });

  it("10. a response with no parseable structured output (no text block) fails closed as SCHEMA_ERROR, never allowed=true", async () => {
    // e.g. the model stops for a reason that produces no text content block at all.
    mockCreate.mockResolvedValue({ content: [] });

    await expect(verifyBrainstormResponse(baseInput)).rejects.toMatchObject({
      category: "SCHEMA_ERROR",
      message: "Verifier structured output was unavailable",
    });
  });

  it("never falls back to allowed=true for any malformed structured output above", async () => {
    mockCreate.mockResolvedValue(
      textResponse(JSON.stringify({ allowed: false, riskScore: 0.5, riskCodes: ["NOT_A_REAL_RISK_CODE"], reason: "x" })),
    );
    await expect(verifyBrainstormResponse(baseInput)).rejects.toThrow();
  });
});

describe("12. deterministic fast rejection still behaves exactly as before structured output", () => {
  it("a direct-answer-pattern candidate is rejected by the local deterministic guard without ever calling the provider", async () => {
    const result = await verifyBrainstormResponse({
      ...baseInput,
      candidateResponse: "The correct answer is 42, therefore the answer is 42.",
    });

    expect(result.allowed).toBe(false);
    expect(result.riskCodes).toEqual(["DIRECT_ANSWER"]);
    expect(mockCreate).not.toHaveBeenCalled();
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

  it("classifies malformed structured output as SCHEMA_ERROR — non-JSON text and schema-invalid JSON alike — and neither is retried", async () => {
    // With structured output there is no longer a distinct "valid JSON
    // that just isn't parseable text" case — Anthropic's own
    // zodOutputFormat.parse() rejects non-JSON text and schema-invalid
    // JSON the same way (a plain AnthropicError, not an APIError), so
    // both collapse into the same fail-closed SCHEMA_ERROR category. See
    // the "fail-closed validation of structured output" describe block
    // above for the individual schema-violation cases.
    mockCreate.mockResolvedValueOnce(textResponse("not json at all"));
    const promise1 = verifyBrainstormResponse(baseInput);
    await expect(promise1).rejects.toMatchObject({ category: "SCHEMA_ERROR" });
    expect(mockCreate).toHaveBeenCalledTimes(1);

    mockCreate.mockReset();
    mockCreate.mockResolvedValueOnce(textResponse(JSON.stringify({ allowed: true, riskScore: 2, riskCodes: [], reason: "ok" })));
    const promise2 = verifyBrainstormResponse(baseInput);
    await expect(promise2).rejects.toMatchObject({ category: "SCHEMA_ERROR" });
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});
