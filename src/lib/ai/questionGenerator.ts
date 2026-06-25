import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

export type QuestionKind = "MCQ" | "SHORT_ANSWER" | "ESSAY";
export type DifficultyLevel = "easy" | "medium" | "hard";

export interface GenerateQuestionsInput {
  sourceMaterial: string;
  subject: string;
  totalCount: number;
  difficulty: { easy: number; medium: number; hard: number };
  types: QuestionKind[];
  existingQuestions?: string[];
}

export interface GeneratedQuestion {
  type: QuestionKind;
  body: string;
  options?: string[];
  correctAnswer?: string;
  difficulty: DifficultyLevel;
  explanation: string;
}

export class AIGenerationError extends Error {}

const generatedQuestionSchema = z
  .object({
    type: z.enum(["MCQ", "SHORT_ANSWER", "ESSAY"]),
    body: z.string().min(1),
    options: z.array(z.string()).optional(),
    correctAnswer: z.string().optional(),
    difficulty: z.enum(["easy", "medium", "hard"]),
    explanation: z.string().min(1),
  })
  .superRefine((q, ctx) => {
    if (q.type === "MCQ") {
      if (!q.options || q.options.length !== 4) {
        ctx.addIssue({
          code: "custom",
          message: "MCQ questions must have exactly 4 options",
          path: ["options"],
        });
      }
      if (!q.correctAnswer || !["A", "B", "C", "D"].includes(q.correctAnswer)) {
        ctx.addIssue({
          code: "custom",
          message: 'MCQ correctAnswer must be one of "A", "B", "C", "D"',
          path: ["correctAnswer"],
        });
      }
    }
  });

export const generatedQuestionsSchema = z.array(generatedQuestionSchema);

function buildSystemPrompt(subject: string): string {
  return `You are an expert assessment designer specializing in ${subject}. You write clear, unambiguous exam questions that accurately test understanding of source material. You always respond with strictly valid JSON and nothing else.`;
}

function buildUserPrompt(input: GenerateQuestionsInput): string {
  const { sourceMaterial, totalCount, difficulty, types, existingQuestions } = input;

  const lines = [
    `Generate ${totalCount} exam questions from this material.`,
    `Mix: ${difficulty.easy}% easy, ${difficulty.medium}% medium, ${difficulty.hard}% hard.`,
    `Types requested: ${types.join(", ")}.`,
    "Return ONLY a JSON array — no markdown, no preamble.",
    "Each item: { type, body, options, correctAnswer, difficulty, explanation }",
    "For MCQ: options must be exactly 4 strings labelled A-D.",
    "For SHORT_ANSWER: correctAnswer is a model answer (1-2 sentences).",
    "For ESSAY: no correctAnswer needed.",
  ];

  if (existingQuestions && existingQuestions.length > 0) {
    lines.push(`Avoid these existing questions: ${existingQuestions.join(" | ")}`);
  }

  lines.push("", "Source material:", sourceMaterial);

  return lines.join("\n");
}

function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

let cachedClient: Anthropic | undefined;

function getClient(): Anthropic {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new AIGenerationError("Missing required environment variable: ANTHROPIC_API_KEY");
  }
  cachedClient = new Anthropic({ apiKey });
  return cachedClient;
}

export async function generateQuestions(
  input: GenerateQuestionsInput,
): Promise<GeneratedQuestion[]> {
  const client = getClient();

  let response;
  try {
    response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      temperature: 0,
      system: buildSystemPrompt(input.subject),
      messages: [{ role: "user", content: buildUserPrompt(input) }],
    });
  } catch (err) {
    throw new AIGenerationError(`Anthropic API request failed: ${(err as Error).message}`);
  }

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new AIGenerationError("Anthropic response did not contain a text block");
  }

  const cleaned = stripMarkdownFences(textBlock.text);

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(cleaned);
  } catch (err) {
    throw new AIGenerationError(`Failed to parse model output as JSON: ${(err as Error).message}`);
  }

  const validated = generatedQuestionsSchema.safeParse(parsedJson);
  if (!validated.success) {
    throw new AIGenerationError(
      `Model output did not match the expected question schema: ${validated.error.message}`,
    );
  }

  return validated.data;
}
