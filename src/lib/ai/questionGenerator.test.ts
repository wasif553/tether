/**
 * AI question-generation schema follow-up. See
 * src/lib/ai/questionGenerator.ts's own doc comments for the root cause
 * this exists to cover: generated output being rejected by
 * generatedQuestionsSchema ("MCQ correctAnswer must be one of A/B/C/D",
 * "Invalid input: expected array, received null" for options).
 *
 * Mocks @anthropic-ai/sdk directly (same pattern as
 * src/lib/ai/essayMarker.test.ts) — never calls the real Anthropic API.
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
  generateQuestions,
  allocateDifficultyCounts,
  generatedQuestionsSchema,
  AIGenerationError,
  ANTHROPIC_QUESTION_GENERATOR_MODEL_DEFAULT,
  getAnthropicQuestionGeneratorModel,
} = await import("./questionGenerator");
type QuestionKind = "MCQ" | "SHORT_ANSWER" | "ESSAY";

function textResponse(text: string) {
  return { content: [{ type: "text", text }] };
}

function wrapped(questions: unknown[]) {
  return textResponse(JSON.stringify({ questions }));
}

const validMcq = {
  type: "MCQ",
  body: "Which keyword starts a Python function definition?",
  options: ["class", "def", "func", "lambda"],
  correctAnswer: "B",
  difficulty: "easy",
  explanation: "Python functions are declared with `def`.",
};

const validShortAnswer = {
  type: "SHORT_ANSWER",
  body: "What keyword defines a function in Python?",
  options: [],
  correctAnswer: "def",
  difficulty: "medium",
  explanation: "Tests recall of the def keyword.",
};

const validEssay = {
  type: "ESSAY",
  body: "Discuss recursion vs iteration.",
  options: [],
  correctAnswer: "Should cover call-stack overhead, readability, and base cases.",
  difficulty: "hard",
  explanation: "Tests conceptual understanding.",
};

const baseInput = {
  sourceMaterial: "Python fundamentals: variables, loops, functions, classes.",
  subject: "Python programming",
  totalCount: 3,
  difficulty: { easy: 34, medium: 33, hard: 33 },
  types: ["MCQ", "SHORT_ANSWER", "ESSAY"] as QuestionKind[],
};

beforeAll(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
});

afterEach(() => {
  mockCreate.mockReset();
  delete process.env.ANTHROPIC_QUESTION_GENERATOR_MODEL;
});

// ---------------------------------------------------------------------------
// Model configuration (Part 12)
// ---------------------------------------------------------------------------

describe("model configuration", () => {
  it("calls the SDK with the default (Sonnet 5) model when ANTHROPIC_QUESTION_GENERATOR_MODEL is not set", async () => {
    mockCreate.mockResolvedValue(wrapped([validMcq, validShortAnswer, validEssay]));
    await generateQuestions(baseInput);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: ANTHROPIC_QUESTION_GENERATOR_MODEL_DEFAULT }));
  });

  it("respects ANTHROPIC_QUESTION_GENERATOR_MODEL, its own dedicated env var — never sharing/forcing the Brainstorm model config", async () => {
    process.env.ANTHROPIC_QUESTION_GENERATOR_MODEL = "claude-question-gen-custom-1";
    mockCreate.mockResolvedValue(wrapped([validMcq]));
    await generateQuestions({ ...baseInput, types: ["MCQ"] });
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-question-gen-custom-1" }));
    expect(getAnthropicQuestionGeneratorModel()).toBe("claude-question-gen-custom-1");
  });

  it("requests structured output via output_config with a json_schema format", async () => {
    mockCreate.mockResolvedValue(wrapped([validMcq]));
    await generateQuestions({ ...baseInput, types: ["MCQ"] });
    const call = mockCreate.mock.calls[0][0];
    expect(call.output_config?.format?.type).toBe("json_schema");
    expect(call.output_config?.format?.schema).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Difficulty allocation (Part 10) — deterministic rounding
// ---------------------------------------------------------------------------

describe("allocateDifficultyCounts", () => {
  it("resolves the exact task example: count 10, easy 25%, medium 40%, hard 35% -> 3/4/3", () => {
    expect(allocateDifficultyCounts(10, { easy: 25, medium: 40, hard: 35 })).toEqual({ easy: 3, medium: 4, hard: 3 });
  });

  it("always sums to totalCount across a wide range of counts and splits", () => {
    const splits = [
      { easy: 100, medium: 0, hard: 0 },
      { easy: 0, medium: 100, hard: 0 },
      { easy: 34, medium: 33, hard: 33 },
      { easy: 1, medium: 1, hard: 98 },
      { easy: 33, medium: 34, hard: 33 },
      { easy: 20, medium: 20, hard: 60 },
    ];
    for (let count = 1; count <= 50; count++) {
      for (const split of splits) {
        const allocation = allocateDifficultyCounts(count, split);
        expect(allocation.easy + allocation.medium + allocation.hard).toBe(count);
        expect(allocation.easy).toBeGreaterThanOrEqual(0);
        expect(allocation.medium).toBeGreaterThanOrEqual(0);
        expect(allocation.hard).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("is deterministic — the exact same input always produces the exact same allocation", () => {
    const a = allocateDifficultyCounts(7, { easy: 33, medium: 33, hard: 34 });
    const b = allocateDifficultyCounts(7, { easy: 33, medium: 33, hard: 34 });
    expect(a).toEqual(b);
  });

  it("a tied fractional remainder resolves in the fixed [easy, medium, hard] order", () => {
    // count=3, easy 33%/medium 33%/hard 34%: exact shares [0.99, 0.99, 1.02],
    // base [0, 0, 1] (sum 1), remainder 2 -> easy and medium are tied at
    // 0.99 and both receive one of the two remaining units (in that
    // order), hard's base share already covers its own unit.
    expect(allocateDifficultyCounts(3, { easy: 33, medium: 33, hard: 34 })).toEqual({ easy: 1, medium: 1, hard: 1 });
  });
});

// ---------------------------------------------------------------------------
// MCQ correctAnswer normalization (Part 5)
// ---------------------------------------------------------------------------

describe("MCQ correctAnswer normalization", () => {
  it("accepts an already-valid A/B/C/D unchanged", async () => {
    mockCreate.mockResolvedValue(wrapped([validMcq]));
    const result = await generateQuestions({ ...baseInput, types: ["MCQ"] });
    expect(result.questions[0].correctAnswer).toBe("B");
  });

  it('normalizes "Option A" to "A"', async () => {
    mockCreate.mockResolvedValue(wrapped([{ ...validMcq, correctAnswer: "Option B" }]));
    const result = await generateQuestions({ ...baseInput, types: ["MCQ"] });
    expect(result.producedCount).toBe(1);
    expect(result.questions[0].correctAnswer).toBe("B");
  });

  it('normalizes lowercase "b" to "B"', async () => {
    mockCreate.mockResolvedValue(wrapped([{ ...validMcq, correctAnswer: "b" }]));
    const result = await generateQuestions({ ...baseInput, types: ["MCQ"] });
    expect(result.producedCount).toBe(1);
    expect(result.questions[0].correctAnswer).toBe("B");
  });

  it('normalizes "B." (trailing punctuation) to "B"', async () => {
    mockCreate.mockResolvedValue(wrapped([{ ...validMcq, correctAnswer: "B." }]));
    const result = await generateQuestions({ ...baseInput, types: ["MCQ"] });
    expect(result.producedCount).toBe(1);
    expect(result.questions[0].correctAnswer).toBe("B");
  });

  it("normalizes the exact text of one option to its letter", async () => {
    mockCreate.mockResolvedValue(wrapped([{ ...validMcq, correctAnswer: "def" }])); // exact text of options[1]
    const result = await generateQuestions({ ...baseInput, types: ["MCQ"] });
    expect(result.producedCount).toBe(1);
    expect(result.questions[0].correctAnswer).toBe("B");
  });

  it("never guesses an ambiguous answer — ultimately rejected (no repair available), producing 0 questions", async () => {
    // "the answer is definitely correct" matches no option and no letter pattern.
    mockCreate
      .mockResolvedValueOnce(wrapped([{ ...validMcq, correctAnswer: "the answer is definitely correct" }]))
      .mockResolvedValueOnce(wrapped([{ ...validMcq, correctAnswer: "still ambiguous" }])); // repair also fails
    const result = await generateQuestions({ ...baseInput, types: ["MCQ"] });
    expect(result.producedCount).toBe(0);
    expect(mockCreate).toHaveBeenCalledTimes(2); // initial + one bounded repair attempt, never more
  });

  it("rejects (and does not repair-guess) fewer than four options", async () => {
    mockCreate
      .mockResolvedValueOnce(wrapped([{ ...validMcq, options: ["class", "def", "func"] }]))
      .mockResolvedValueOnce(wrapped([{ ...validMcq, options: ["class", "def", "func"] }]));
    const result = await generateQuestions({ ...baseInput, types: ["MCQ"] });
    expect(result.producedCount).toBe(0);
  });

  it("rejects more than four options", async () => {
    mockCreate
      .mockResolvedValueOnce(wrapped([{ ...validMcq, options: ["class", "def", "func", "lambda", "extra"] }]))
      .mockResolvedValueOnce(wrapped([{ ...validMcq, options: ["class", "def", "func", "lambda", "extra"] }]));
    const result = await generateQuestions({ ...baseInput, types: ["MCQ"] });
    expect(result.producedCount).toBe(0);
  });

  it("options: null for MCQ is never fabricated — stays invalid unless a repair call supplies real options", async () => {
    mockCreate
      .mockResolvedValueOnce(wrapped([{ ...validMcq, options: null }]))
      .mockResolvedValueOnce(wrapped([validMcq])); // repair supplies real options
    const result = await generateQuestions({ ...baseInput, types: ["MCQ"] });
    expect(result.producedCount).toBe(1);
    expect(result.questions[0].options).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// SHORT_ANSWER / ESSAY options normalization (Part 5)
// ---------------------------------------------------------------------------

describe("SHORT_ANSWER / ESSAY options normalization", () => {
  it("options: null normalizes to [] and is accepted — the literal root cause of the reported failure", async () => {
    mockCreate.mockResolvedValue(wrapped([{ ...validShortAnswer, options: null }]));
    const result = await generateQuestions({ ...baseInput, types: ["SHORT_ANSWER"] });
    expect(result.producedCount).toBe(1);
    expect(result.questions[0].options).toEqual([]);
    expect(mockCreate).toHaveBeenCalledTimes(1); // no repair needed at all
  });

  it("options: null for ESSAY also normalizes to []", async () => {
    mockCreate.mockResolvedValue(wrapped([{ ...validEssay, options: null }]));
    const result = await generateQuestions({ ...baseInput, types: ["ESSAY"] });
    expect(result.producedCount).toBe(1);
    expect(result.questions[0].options).toEqual([]);
  });

  it("a genuinely empty options array is accepted unchanged", async () => {
    mockCreate.mockResolvedValue(wrapped([validShortAnswer]));
    const result = await generateQuestions({ ...baseInput, types: ["SHORT_ANSWER"] });
    expect(result.producedCount).toBe(1);
    expect(result.questions[0].options).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// generatedQuestionsSchema — the exact same schema bulk-import re-validates
// against (Part 2 — one canonical contract, never a parallel schema)
// ---------------------------------------------------------------------------

describe("generatedQuestionsSchema — the shared canonical contract", () => {
  it("accepts a valid MCQ/SHORT_ANSWER/ESSAY mix", () => {
    expect(generatedQuestionsSchema.safeParse([validMcq, validShortAnswer, validEssay]).success).toBe(true);
  });

  it("rejects options: null (the exact bug report) — this is why normalization must run before this schema, not instead of it", () => {
    expect(generatedQuestionsSchema.safeParse([{ ...validShortAnswer, options: null }]).success).toBe(false);
  });

  it('rejects an MCQ correctAnswer that is not exactly "A"/"B"/"C"/"D" (the exact bug report)', () => {
    expect(generatedQuestionsSchema.safeParse([{ ...validMcq, correctAnswer: "Option B" }]).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End-to-end generation orchestration
// ---------------------------------------------------------------------------

describe("generateQuestions orchestration", () => {
  it("a fully valid first response needs no repair call at all", async () => {
    mockCreate.mockResolvedValue(wrapped([validMcq, validShortAnswer, validEssay]));
    const result = await generateQuestions(baseInput);
    expect(result.producedCount).toBe(3);
    expect(result.failedCount).toBe(0);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("an invalid first response that a repair call successfully fixes counts as fully produced", async () => {
    // "the correct choice" matches no safe-normalization pattern (not a
    // bare letter, not "Option X", not the exact text of any option) —
    // this genuinely requires the repair call, unlike the normalizable
    // variants covered above.
    mockCreate
      .mockResolvedValueOnce(wrapped([{ ...validMcq, correctAnswer: "the correct choice" }, validShortAnswer]))
      .mockResolvedValueOnce(wrapped([validMcq])); // repair fixes the one invalid item
    const result = await generateQuestions({ ...baseInput, totalCount: 2, types: ["MCQ", "SHORT_ANSWER"] });
    expect(result.producedCount).toBe(2);
    expect(result.failedCount).toBe(0);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("an invalid first response whose repair also fails to validate reports a clean partial count, never throwing", async () => {
    mockCreate
      .mockResolvedValueOnce(wrapped([validMcq, { ...validShortAnswer, correctAnswer: undefined, body: "" }]))
      .mockResolvedValueOnce(wrapped([{ ...validShortAnswer, body: "" }])); // repair still invalid (empty body)
    const result = await generateQuestions({ ...baseInput, totalCount: 2, types: ["MCQ", "SHORT_ANSWER"] });
    expect(result.requestedCount).toBe(2);
    expect(result.producedCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.questions[0].type).toBe("MCQ");
  });

  it("a repair call that itself throws (transport failure) still returns whatever was valid from the first attempt, never throwing", async () => {
    mockCreate
      .mockResolvedValueOnce(wrapped([validMcq, { ...validShortAnswer, options: "not-an-array" }]))
      .mockRejectedValueOnce(new Error("network down"));
    const result = await generateQuestions({ ...baseInput, totalCount: 2, types: ["MCQ", "SHORT_ANSWER"] });
    expect(result.producedCount).toBe(1);
    expect(result.failedCount).toBe(1);
  });

  it("requested count is exactly respected when the model returns exactly that many valid questions", async () => {
    mockCreate.mockResolvedValue(wrapped([validMcq, validMcq, validMcq, validMcq, validMcq]));
    const result = await generateQuestions({ ...baseInput, totalCount: 5, types: ["MCQ"] });
    expect(result.requestedCount).toBe(5);
    expect(result.producedCount).toBe(5);
  });

  it("the prompt states the exact requested count and the exact per-difficulty allocation, never a raw percentage the model must approximate", async () => {
    mockCreate.mockResolvedValue(wrapped([validMcq]));
    await generateQuestions({ ...baseInput, totalCount: 10, difficulty: { easy: 25, medium: 40, hard: 35 }, types: ["MCQ"] });
    const call = mockCreate.mock.calls[0][0];
    expect(call.messages[0].content).toContain("exactly 10 exam questions");
    expect(call.messages[0].content).toContain("easy: 3, medium: 4, hard: 3");
  });

  it("an unselected question type returned by the model is rejected, not silently kept", async () => {
    mockCreate
      .mockResolvedValueOnce(wrapped([validEssay])) // ESSAY was never requested below
      .mockResolvedValueOnce(wrapped([validEssay])); // repair still returns the wrong type
    const result = await generateQuestions({ ...baseInput, totalCount: 1, types: ["MCQ"] });
    expect(result.producedCount).toBe(0);
  });

  it("an unselected type IS accepted once repaired into an allowed type", async () => {
    mockCreate
      .mockResolvedValueOnce(wrapped([validEssay])) // ESSAY was never requested
      .mockResolvedValueOnce(wrapped([validMcq])); // repair returns an allowed MCQ instead
    const result = await generateQuestions({ ...baseInput, totalCount: 1, types: ["MCQ"] });
    expect(result.producedCount).toBe(1);
    expect(result.questions[0].type).toBe("MCQ");
  });

  it("a hard transport failure on the FIRST call throws AIGenerationError — nothing to normalize/validate/repair at all", async () => {
    mockCreate.mockRejectedValue(new Error("connection reset"));
    await expect(generateQuestions(baseInput)).rejects.toBeInstanceOf(AIGenerationError);
  });

  it("completely unparseable JSON on the first call throws AIGenerationError", async () => {
    mockCreate.mockResolvedValue(textResponse("not json at all"));
    await expect(generateQuestions(baseInput)).rejects.toBeInstanceOf(AIGenerationError);
  });

  it("a well-formed JSON response missing the questions array entirely throws AIGenerationError", async () => {
    mockCreate.mockResolvedValue(textResponse(JSON.stringify({ notQuestions: [] })));
    await expect(generateQuestions(baseInput)).rejects.toBeInstanceOf(AIGenerationError);
  });

  it("still accepts a bare JSON array (defensive fallback) if the model ignores the { questions: [...] } wrapper instruction", async () => {
    mockCreate.mockResolvedValue(textResponse(JSON.stringify([validMcq])));
    const result = await generateQuestions({ ...baseInput, types: ["MCQ"] });
    expect(result.producedCount).toBe(1);
  });

  it("strips markdown fences before parsing", async () => {
    mockCreate.mockResolvedValue(textResponse("```json\n" + JSON.stringify({ questions: [validMcq] }) + "\n```"));
    const result = await generateQuestions({ ...baseInput, types: ["MCQ"] });
    expect(result.producedCount).toBe(1);
  });
});
