import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const { mockCreate } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = { create: mockCreate };
  }
  return { default: MockAnthropic };
});

const { markEssay, EssayMarkingError } = await import("./essayMarker");

function textResponse(text: string) {
  return { content: [{ type: "text", text }] };
}

const baseInput = {
  subject: "Biology",
  question: "Explain photosynthesis.",
  rubric: [
    { criterion: "Content & accuracy", description: "Covers key concepts", maxMarks: 6 },
    { criterion: "Clarity & structure", description: "Well organised", maxMarks: 4 },
  ],
  totalMarks: 10,
  studentResponse: "Photosynthesis converts light energy into chemical energy.",
};

beforeAll(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
});

afterEach(() => {
  mockCreate.mockReset();
});

describe("markEssay", () => {
  it("parses and validates a well-formed response", async () => {
    const valid = {
      criteriaScores: [
        { criterion: "Content & accuracy", score: 5, maxMarks: 6, justification: "Mentions light energy conversion." },
        { criterion: "Clarity & structure", score: 3, maxMarks: 4, justification: "Concise but could expand." },
      ],
      totalScore: 8,
      totalMaxMarks: 10,
      overallFeedback: "Good grasp of the core concept.",
      strengths: ["Correctly identifies energy conversion"],
      areasForImprovement: ["Could mention chlorophyll and chloroplasts"],
      confidence: "HIGH",
    };
    mockCreate.mockResolvedValue(textResponse(JSON.stringify(valid)));

    const result = await markEssay(baseInput);

    expect(result.totalScore).toBe(8);
    expect(result.confidence).toBe("HIGH");
    expect(result.criteriaScores).toHaveLength(2);
  });

  it("rejects a response where totalScore does not match the sum of criteria scores", async () => {
    const mismatched = {
      criteriaScores: [
        { criterion: "Content & accuracy", score: 5, maxMarks: 6, justification: "x" },
        { criterion: "Clarity & structure", score: 3, maxMarks: 4, justification: "y" },
      ],
      totalScore: 100,
      totalMaxMarks: 10,
      overallFeedback: "x",
      strengths: [],
      areasForImprovement: [],
      confidence: "HIGH",
    };
    mockCreate.mockResolvedValue(textResponse(JSON.stringify(mismatched)));

    await expect(markEssay(baseInput)).rejects.toThrow(EssayMarkingError);
  });

  it("rejects a response missing the confidence field", async () => {
    const missingConfidence = {
      criteriaScores: [{ criterion: "Content & accuracy", score: 5, maxMarks: 6, justification: "x" }],
      totalScore: 5,
      totalMaxMarks: 10,
      overallFeedback: "x",
      strengths: [],
      areasForImprovement: [],
    };
    mockCreate.mockResolvedValue(textResponse(JSON.stringify(missingConfidence)));

    await expect(markEssay(baseInput)).rejects.toThrow(EssayMarkingError);
  });

  it("strips markdown fences before parsing", async () => {
    const valid = {
      criteriaScores: [{ criterion: "Content & accuracy", score: 6, maxMarks: 6, justification: "x" }],
      totalScore: 6,
      totalMaxMarks: 10,
      overallFeedback: "x",
      strengths: [],
      areasForImprovement: [],
      confidence: "MEDIUM",
    };
    mockCreate.mockResolvedValue(textResponse("```json\n" + JSON.stringify(valid) + "\n```"));

    const result = await markEssay(baseInput);

    expect(result.totalScore).toBe(6);
    expect(result.confidence).toBe("MEDIUM");
  });

  it("returns a LOW confidence result for an empty student response", async () => {
    const lowConfidence = {
      criteriaScores: [
        { criterion: "Content & accuracy", score: 0, maxMarks: 6, justification: "No content provided." },
        { criterion: "Clarity & structure", score: 0, maxMarks: 4, justification: "Response is empty." },
      ],
      totalScore: 0,
      totalMaxMarks: 10,
      overallFeedback: "No response was submitted, so no marks can be awarded.",
      strengths: [],
      areasForImprovement: ["Submit a response addressing the question"],
      confidence: "LOW",
    };
    mockCreate.mockResolvedValue(textResponse(JSON.stringify(lowConfidence)));

    const result = await markEssay({ ...baseInput, studentResponse: "" });

    expect(result.confidence).toBe("LOW");
    expect(result.totalScore).toBe(0);
  });
});
