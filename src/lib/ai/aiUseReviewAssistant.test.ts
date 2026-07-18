/**
 * AI-Use Answer Review v1 — Layer B optional AI-assisted analysis tests.
 * See docs/ai-use-answer-review-v1.md and src/lib/ai/aiUseReviewAssistant.ts.
 *
 * No real network calls — the Anthropic SDK is mocked throughout.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = { create: mockCreate };
  }
  return { default: MockAnthropic };
});

const {
  runAiUseReviewAssist,
  isAiAssistConfigured,
  buildBoundedAssistInput,
  AiUseReviewAssistError,
  AiUseReviewAssistNotConfiguredError,
  MAX_ITEMS_PER_ASSIST_REQUEST,
  MAX_CHARS_PER_ANSWER,
} = await import("./aiUseReviewAssistant");

function textResponse(text: string) {
  return { content: [{ type: "text", text }] };
}

const baseInput = {
  anonymousSubmissionRef: "submission-ref-anon-1",
  items: [
    { questionId: "q1", questionText: "Explain least privilege for Acme Corp's admin accounts.", answerText: "Acme should grant only the access admins need day to day." },
  ],
};

afterEach(() => {
  mockCreate.mockReset();
  delete process.env.ANTHROPIC_API_KEY;
});

describe("isAiAssistConfigured / not-configured behaviour", () => {
  it("returns false and throws NotConfiguredError when no API key is set", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(isAiAssistConfigured()).toBe(false);
    await expect(runAiUseReviewAssist(baseInput)).rejects.toBeInstanceOf(AiUseReviewAssistNotConfiguredError);
  });
});

describe("runAiUseReviewAssist — configured", () => {
  beforeAll(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  it("accepts a valid structured response", async () => {
    const valid = {
      signals: [
        {
          type: "WEAK_SCENARIO_GROUNDING",
          level: "MEDIUM",
          reason: "The response does not reference the organisation named in the question.",
          evidence: ["No mention of Acme Corp"],
          limitation: "Alternative terminology may exist.",
          questionId: "q1",
        },
      ],
      overallLevel: "MEDIUM",
      reviewRecommended: true,
    };
    mockCreate.mockResolvedValue(textResponse(JSON.stringify(valid)));

    const result = await runAiUseReviewAssist(baseInput);
    expect(result.overallLevel).toBe("MEDIUM");
    expect(result.signals).toHaveLength(1);
  });

  it("rejects invalid JSON safely", async () => {
    mockCreate.mockResolvedValue(textResponse("not json at all"));
    await expect(runAiUseReviewAssist(baseInput)).rejects.toBeInstanceOf(AiUseReviewAssistError);
  });

  it("rejects a response missing required fields", async () => {
    mockCreate.mockResolvedValue(textResponse(JSON.stringify({ signals: [] })));
    await expect(runAiUseReviewAssist(baseInput)).rejects.toBeInstanceOf(AiUseReviewAssistError);
  });

  it("a provider error does not throw anything except AiUseReviewAssistError (never crashes the process)", async () => {
    mockCreate.mockRejectedValue(new Error("timeout"));
    await expect(runAiUseReviewAssist(baseInput)).rejects.toBeInstanceOf(AiUseReviewAssistError);
  });

  it("never accepts a response containing an AI probability/likelihood claim", async () => {
    const withProbability = {
      signals: [
        {
          type: "WEAK_SCENARIO_GROUNDING",
          level: "MEDIUM",
          reason: "There is an 87% probability of AI use in this response.",
          evidence: [],
          limitation: "None.",
          questionId: "q1",
        },
      ],
      overallLevel: "MEDIUM",
      reviewRecommended: true,
    };
    mockCreate.mockResolvedValue(textResponse(JSON.stringify(withProbability)));
    await expect(runAiUseReviewAssist(baseInput)).rejects.toBeInstanceOf(AiUseReviewAssistError);
  });

  it("rejects banned wording rather than silently keeping the signal", async () => {
    const banned = {
      signals: [
        {
          type: "GENERATED_RESPONSE_META_LANGUAGE",
          level: "HIGH",
          reason: "This is an AI-generated answer.",
          evidence: [],
          limitation: "None.",
          questionId: "q1",
        },
      ],
      overallLevel: "HIGH",
      reviewRecommended: true,
    };
    mockCreate.mockResolvedValue(textResponse(JSON.stringify(banned)));
    await expect(runAiUseReviewAssist(baseInput)).rejects.toBeInstanceOf(AiUseReviewAssistError);
  });

  it("rejects a signal referencing a question id outside the request", async () => {
    const unknownQuestion = {
      signals: [
        { type: "WEAK_SCENARIO_GROUNDING", level: "MEDIUM", reason: "x", evidence: [], limitation: "y", questionId: "unknown-question" },
      ],
      overallLevel: "MEDIUM",
      reviewRecommended: true,
    };
    mockCreate.mockResolvedValue(textResponse(JSON.stringify(unknownQuestion)));
    await expect(runAiUseReviewAssist(baseInput)).rejects.toBeInstanceOf(AiUseReviewAssistError);
  });

  it("never sends student identity in the request payload", async () => {
    mockCreate.mockResolvedValue(textResponse(JSON.stringify({ signals: [], overallLevel: "NONE", reviewRecommended: false })));
    await runAiUseReviewAssist(baseInput);
    const sentPrompt = JSON.stringify(mockCreate.mock.calls[0][0]);
    expect(sentPrompt).not.toMatch(/@/); // no email addresses
    expect(sentPrompt).not.toContain("studentId");
  });

  it("never sends a correct answer in the request payload", async () => {
    mockCreate.mockResolvedValue(textResponse(JSON.stringify({ signals: [], overallLevel: "NONE", reviewRecommended: false })));
    await runAiUseReviewAssist(baseInput);
    const sentPrompt = JSON.stringify(mockCreate.mock.calls[0][0]);
    expect(sentPrompt).not.toContain("correctAnswer");
  });
});

describe("buildBoundedAssistInput", () => {
  it("caps the number of items and per-answer length", () => {
    const items = Array.from({ length: MAX_ITEMS_PER_ASSIST_REQUEST + 5 }, (_, i) => ({
      questionId: `q${i}`,
      questionText: "Question text",
      answerText: "x".repeat(MAX_CHARS_PER_ANSWER + 500),
    }));
    const { bounded, truncatedQuestionIds, itemsOmittedCount } = buildBoundedAssistInput({
      anonymousSubmissionRef: "ref",
      items,
    });
    expect(bounded.items.length).toBeLessThanOrEqual(MAX_ITEMS_PER_ASSIST_REQUEST);
    expect(itemsOmittedCount).toBeGreaterThan(0);
    expect(truncatedQuestionIds.length).toBeGreaterThan(0);
    bounded.items.forEach((i) => expect(i.answerText.length).toBeLessThanOrEqual(MAX_CHARS_PER_ANSWER));
  });
});
