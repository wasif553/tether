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
  requestMode: "GENERIC_HELP" as const,
  priorApprovedHintCount: 0,
  cumulativeRiskScoreSoFar: 0,
  priorApprovedResponses: [] as string[],
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

  // Guidance-vs-final-answer misclassification follow-up — the verifier
  // judges only the CANDIDATE RESPONSE, never the student's own request
  // wording, so a guidance request that happens to contain "answer"
  // isn't mistaken for disclosure. Preserved through the architectural
  // simplification below.
  it("clarifies that only the candidate response (never the student's own request wording) can trigger an unsafe verdict", async () => {
    mockCreate.mockResolvedValue(textResponse(validVerifierJson()));

    await verifyBrainstormResponse(baseInput);

    const call = mockCreate.mock.calls[0][0];
    expect(call.system).toContain("Judge ONLY the candidate response text");
    expect(call.system).toContain("guidance or method, not disclosure");
  });

  // Architectural simplification follow-up — replaces the prior broad,
  // accumulated "too specific / excessive detail / relevance" style
  // judgment (patched incrementally across four rounds) with a single
  // narrow question: does the candidate disclose/confirm/complete the
  // graded final answer? EXCESSIVE_SPECIFICITY and "relevance" are no
  // longer presented as independent LLM rejection criteria at all.
  it("asks the single narrow disclosure question, not a broad specificity/relevance judgment", async () => {
    mockCreate.mockResolvedValue(textResponse(validVerifierJson()));

    await verifyBrainstormResponse(baseInput);

    const call = mockCreate.mock.calls[0][0];
    expect(call.system).toContain(
      "Ask exactly ONE question: does this candidate response STATE, CONFIRM, TRIVIALLY IMPLY, or PROVIDE A SUBMISSION-READY VERSION of the graded final answer",
    );
    // EXCESSIVE_SPECIFICITY remains a valid (unused-in-practice) riskCode
    // for schema/storage backward-compatibility — see RISK_CODES — but
    // must no longer be PRESENTED to the model as something to judge.
    expect(call.system).not.toContain("far more specific/detailed than a Socratic brainstorming hint should be");
    expect(call.system).not.toContain("is exactly the kind of help this assistant should give");
  });

  it("states plainly that relevance to the question is never itself a reason to reject teaching content", async () => {
    mockCreate.mockResolvedValue(textResponse(validVerifierJson()));

    await verifyBrainstormResponse(baseInput);

    const call = mockCreate.mock.calls[0][0];
    expect(call.system).toContain("TEACHING CONTENT IS SAFE, EVEN WHEN HIGHLY RELEVANT TO THE ACTIVE QUESTION");
    expect(call.system).toContain("Relevance to the question is NEVER by itself a reason to reject");
  });

  it("gives concrete SAFE examples (concept facts relevant to the question) and contrastive UNSAFE examples (resolving the question)", async () => {
    mockCreate.mockResolvedValue(textResponse(validVerifierJson()));

    await verifyBrainstormResponse(baseInput);

    const call = mockCreate.mock.calls[0][0];
    expect(call.system).toContain("*args collects extra positional arguments into a tuple");
    expect(call.system).toContain("A list is mutable while a tuple is immutable.");
    expect(call.system).toContain("x is a list because square brackets create a list.");
    expect(call.system).toContain("The correct option is B.");
    expect(call.system).toContain("The answer is def.");
  });

  it("allows teaching/substantial explanation for open-response questions, rejecting only a submission-ready final response", async () => {
    mockCreate.mockResolvedValue(textResponse(validVerifierJson()));

    await verifyBrainstormResponse(baseInput);

    const call = mockCreate.mock.calls[0][0];
    expect(call.system).toContain("For an open-response question (essay/short-answer), teaching and substantial explanation are SAFE");
    expect(call.system).toContain("reject only when the candidate becomes a complete, submission-ready version of the student's final assessed response");
  });

  // Misconception/concept-check follow-up — the verifier's prompt didn't
  // distinguish "corrects a wrong claim" from "confirms a stated final
  // answer", risking an over-cautious rejection of legitimate corrective
  // guidance (e.g. "Not quite — a tuple is not a row"). Preserved through
  // the architectural simplification above.
  it("clarifies that correcting a misconception is safe, but confirming a student's stated final answer is not", async () => {
    mockCreate.mockResolvedValue(textResponse(validVerifierJson()));

    await verifyBrainstormResponse(baseInput);

    const call = mockCreate.mock.calls[0][0];
    expect(call.system).toContain("corrects a student's mistaken claim");
    expect(call.system).toContain("even when phrased as agreement rather than a fresh statement");
  });

  it("includes the hidden model answer only in the user content, and only when supplied", async () => {
    mockCreate.mockResolvedValue(textResponse(validVerifierJson()));

    await verifyBrainstormResponse({ ...baseInput, hiddenModelAnswer: "Evaporation, condensation, precipitation." });

    const call = mockCreate.mock.calls[0][0];
    expect(call.messages[0].content).toContain("Evaporation, condensation, precipitation.");
    expect(call.system).not.toContain("Evaporation, condensation, precipitation.");
  });

  // Cumulative answer-assembly follow-up — a SECOND, narrower safety
  // question for open-response questions only: does this candidate,
  // combined with prior approved guidance for the SAME question, now
  // substantially assemble what the question requires? Deliberately NOT
  // a return to the removed "too specific/detailed" framing.
  it("adds the open-response cumulative-completion question, distinct from the removed excessive-specificity framing", async () => {
    mockCreate.mockResolvedValue(textResponse(validVerifierJson()));

    await verifyBrainstormResponse(baseInput);

    const call = mockCreate.mock.calls[0][0];
    expect(call.system).toContain("For SHORT_ANSWER and ESSAY questions specifically (never for MULTIPLE_CHOICE");
    expect(call.system).toContain("SUBMISSION_READY_COMPLETION");
    expect(call.system).toContain("CUMULATIVE_RESPONSE_COMPLETION");
    expect(call.system).toContain("This is NOT the same as 'too detailed' or 'too specific'");
  });

  it("includes the actual text of prior approved responses for this question, only in the user content", async () => {
    mockCreate.mockResolvedValue(textResponse(validVerifierJson()));

    await verifyBrainstormResponse({
      ...baseInput,
      priorApprovedResponses: ["Tuples cannot be modified after creation.", "Lists can be modified after creation."],
    });

    const call = mockCreate.mock.calls[0][0];
    expect(call.messages[0].content).toContain("Prior approved responses for this SAME question");
    expect(call.messages[0].content).toContain("1. Tuples cannot be modified after creation.");
    expect(call.messages[0].content).toContain("2. Lists can be modified after creation.");
    expect(call.system).not.toContain("Tuples cannot be modified after creation.");
  });

  it("omits the prior-approved-responses section entirely when this is the question's first interaction", async () => {
    mockCreate.mockResolvedValue(textResponse(validVerifierJson()));

    await verifyBrainstormResponse({ ...baseInput, priorApprovedResponses: [] });

    const call = mockCreate.mock.calls[0][0];
    expect(call.messages[0].content).not.toContain("Prior approved responses for this SAME question");
  });
});

// Grounded-cumulative-safety follow-up (section 17) — requestMode
// (already computed for the generator — see aiAssistanceRequestMode.ts)
// is now threaded into the verifier too, purely as calibration context.
// It must reach the user-facing content for every mode, and the fixed
// per-mode calibration text must be present in the system prompt
// regardless of which mode a given call used (it is not duplicated per
// call — it's part of the one fixed policy prompt).
describe("grounded cumulative-safety follow-up — request mode reaches the verifier", () => {
  it.each([
    "CONCEPT_EXPLANATION",
    "APPROACH_GUIDANCE",
    "MISCONCEPTION_CHECK",
    "GUIDING_QUESTION",
    "ANSWER_CONFIRMATION",
    "GENERIC_HELP",
  ] as const)("includes requestMode %s in the user content, and the system prompt's calibration text", async (requestMode) => {
    mockCreate.mockResolvedValue(textResponse(validVerifierJson()));

    await verifyBrainstormResponse({ ...baseInput, requestMode });

    const call = mockCreate.mock.calls[0][0];
    expect(call.messages[0].content).toContain(
      `Request mode (calibration only — see system prompt; never a safety bypass): ${requestMode}`,
    );
    expect(call.system).toContain("CONCEPT_EXPLANATION: a focused explanation of the requested concept is presumptively legitimate");
    expect(call.system).toContain("ANSWER_CONFIRMATION: keep the strict confirmation protection above");
  });

  it("request mode calibrates framing but is never presented as a bypass of the disclosure/completion rules", async () => {
    mockCreate.mockResolvedValue(textResponse(validVerifierJson()));

    await verifyBrainstormResponse({ ...baseInput, requestMode: "CONCEPT_EXPLANATION" });

    const call = mockCreate.mock.calls[0][0];
    expect(call.system).toContain("it never changes whether the disclosure/completion rules above apply");
  });
});

// Grounded-cumulative-safety follow-up (sections 5/6/10) — the live
// false positive this whole follow-up fixes was traced to Check 2
// inventing an unstated marking rubric from the model's own subject
// knowledge. These confirm the three-level grounding hierarchy, the
// explicit prohibition on inventing a rubric, and the required worked
// examples are all actually present in the prompt sent to the model —
// not just described in this task's approved design.
describe("grounded cumulative-safety follow-up — assessment-context grounding hierarchy", () => {
  it("states the three-level grounding hierarchy and forbids inventing a rubric", async () => {
    mockCreate.mockResolvedValue(textResponse(validVerifierJson()));

    await verifyBrainstormResponse(baseInput);

    const call = mockCreate.mock.calls[0][0];
    expect(call.system).toContain("LEVEL 1 (highest confidence): explicit requirements literally stated in the question's own text");
    expect(call.system).toContain("LEVEL 2: a hidden model answer / marking guidance");
    expect(call.system).toContain(
      "LEVEL 3: if the question names no explicit requirements AND no hidden model answer/guidance is supplied below, there is NO grounded rubric available.",
    );
    expect(call.system).toContain("Do not silently decide the topic has some fixed number of 'canonical' comparison dimensions");
  });

  it("includes the D/E contrastive worked examples distinguishing grounded (Level 1) from ungrounded (Level 3) rejection", async () => {
    mockCreate.mockResolvedValue(textResponse(validVerifierJson()));

    await verifyBrainstormResponse(baseInput);

    const call = mockCreate.mock.calls[0][0];
    expect(call.system).toContain("Compare lists and tuples in terms of mutability, syntax and typical use cases");
    expect(call.system).toContain(
      "REJECT (CUMULATIVE_RESPONSE_COMPLETION) — grounded directly in the question's own literal wording, not inferred from subject knowledge",
    );
    expect(call.system).toContain(
      "Do NOT reject merely because mutability/syntax/use-case are common comparison dimensions you happen to know for this topic — that would be inventing a rubric",
    );
  });

  it("includes the narrow-vs-broad question contrast (worked examples B and C)", async () => {
    mockCreate.mockResolvedValue(textResponse(validVerifierJson()));

    await verifyBrainstormResponse(baseInput);

    const call = mockCreate.mock.calls[0][0];
    expect(call.system).toContain('"State ONE difference between a list and a tuple."');
    expect(call.system).toContain("this one established distinction now substantially supplies the entire requested answer");
  });

  it("includes the reassembly (Check 1, no novelty required) and safe-redirect worked examples", async () => {
    mockCreate.mockResolvedValue(textResponse(validVerifierJson()));

    await verifyBrainstormResponse(baseInput);

    const call = mockCreate.mock.calls[0][0];
    expect(call.system).toContain("Check 1 never requires novelty");
    expect(call.system).toContain("compare one feature at a time in your own response");
  });

  it("fail-closed at Level 3 defaults to ALLOW on rubric uncertainty, never REJECT out of caution", async () => {
    mockCreate.mockResolvedValue(textResponse(validVerifierJson()));

    await verifyBrainstormResponse(baseInput);

    const call = mockCreate.mock.calls[0][0];
    expect(call.system).toContain(
      "being unsure what an unstated rubric might contain is not evidence that the answer has been completed",
    );
    expect(call.system).toContain("never to reject out of caution about an invented structure");
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

  // Architectural simplification follow-up (section 5/21) — a genuine
  // bug: `reason` used to be capped at 400 chars IN the model-facing
  // schema, so a long-but-valid safety justification failed schema
  // validation and discarded an otherwise-correct verdict (SCHEMA_ERROR,
  // treated identically to a real safety failure). Fixed by removing the
  // upper bound from the schema itself and truncating only AFTER a
  // successful parse.
  it("accepts a valid verdict whose reason exceeds 400 characters — no SCHEMA_ERROR caused by reason length alone, and the verdict is truncated for storage, not discarded", async () => {
    const longReason = "This response teaches the concept thoroughly without disclosing the final answer. ".repeat(6);
    expect(longReason.length).toBeGreaterThan(400);
    mockCreate.mockResolvedValue(textResponse(validVerifierJson({ allowed: true, riskScore: 0.2, reason: longReason })));

    const result = await verifyBrainstormResponse(baseInput);

    expect(result.allowed).toBe(true);
    expect(result.reason.length).toBeLessThanOrEqual(400);
    expect(longReason.startsWith(result.reason)).toBe(true);
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
