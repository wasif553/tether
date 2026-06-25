import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

export interface RubricCriterion {
  criterion: string;
  description: string;
  maxMarks: number;
}

export interface EssayMarkingInput {
  subject: string;
  question: string;
  rubric: RubricCriterion[];
  totalMarks: number;
  studentResponse: string;
}

export interface CriterionScore {
  criterion: string;
  score: number;
  maxMarks: number;
  justification: string;
}

export interface EssayMarkingResult {
  criteriaScores: CriterionScore[];
  totalScore: number;
  totalMaxMarks: number;
  overallFeedback: string;
  strengths: string[];
  areasForImprovement: string[];
  confidence: "HIGH" | "MEDIUM" | "LOW";
}

export class EssayMarkingError extends Error {}

const TOTAL_SCORE_TOLERANCE = 0.01;

const criterionScoreSchema = z
  .object({
    criterion: z.string().min(1),
    score: z.number(),
    maxMarks: z.number(),
    justification: z.string().min(1),
  })
  .superRefine((c, ctx) => {
    if (c.score < 0 || c.score > c.maxMarks) {
      ctx.addIssue({
        code: "custom",
        message: `score must be between 0 and maxMarks (${c.maxMarks})`,
        path: ["score"],
      });
    }
  });

export const essayMarkingResultSchema = z
  .object({
    criteriaScores: z.array(criterionScoreSchema).min(1),
    totalScore: z.number(),
    totalMaxMarks: z.number(),
    overallFeedback: z.string().min(1),
    strengths: z.array(z.string()),
    areasForImprovement: z.array(z.string()),
    confidence: z.enum(["HIGH", "MEDIUM", "LOW"]),
  })
  .superRefine((result, ctx) => {
    const sum = result.criteriaScores.reduce((acc, c) => acc + c.score, 0);
    if (Math.abs(sum - result.totalScore) > TOTAL_SCORE_TOLERANCE) {
      ctx.addIssue({
        code: "custom",
        message: `totalScore (${result.totalScore}) must equal the sum of criteriaScores[].score (${sum})`,
        path: ["totalScore"],
      });
    }
  });

function buildSystemPrompt(subject: string): string {
  return `You are an expert academic marker for ${subject}. Mark the student response strictly according to the rubric provided. Be consistent, fair, and evidence-based. Never award marks that are not justified by the rubric criteria.`;
}

function buildUserPrompt(input: EssayMarkingInput): string {
  const { question, rubric, totalMarks, studentResponse } = input;

  const rubricLines = rubric.map(
    (r, i) => `${i + 1}. ${r.criterion} — ${r.description} — max ${r.maxMarks} marks`,
  );

  return [
    `Question: ${question}`,
    "",
    "Rubric:",
    ...rubricLines,
    "",
    `Total marks available: ${totalMarks}`,
    "",
    "Student response:",
    studentResponse,
    "",
    "Respond with ONLY a JSON object — no markdown, no preamble:",
    "{",
    "  criteriaScores: [{criterion, score, maxMarks, justification}],",
    "  totalScore: number,",
    "  totalMaxMarks: number,",
    "  overallFeedback: string,",
    "  strengths: string[],",
    "  areasForImprovement: string[],",
    '  confidence: "HIGH" | "MEDIUM" | "LOW"',
    "}",
    "",
    "Rules:",
    "- score for each criterion must be between 0 and maxMarks",
    "- totalScore must equal sum of all criteriaScores[].score",
    "- justification must reference specific evidence from the response",
    "- confidence HIGH = response clearly maps to rubric, MEDIUM = some ambiguity, LOW = very short/off-topic response",
  ].join("\n");
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
    throw new EssayMarkingError("Missing required environment variable: ANTHROPIC_API_KEY");
  }
  cachedClient = new Anthropic({ apiKey });
  return cachedClient;
}

export async function markEssay(input: EssayMarkingInput): Promise<EssayMarkingResult> {
  const client = getClient();

  let response;
  try {
    response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      temperature: 0,
      system: buildSystemPrompt(input.subject),
      messages: [{ role: "user", content: buildUserPrompt(input) }],
    });
  } catch (err) {
    throw new EssayMarkingError(`Anthropic API request failed: ${(err as Error).message}`);
  }

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new EssayMarkingError("Anthropic response did not contain a text block");
  }

  const cleaned = stripMarkdownFences(textBlock.text);

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(cleaned);
  } catch (err) {
    throw new EssayMarkingError(`Failed to parse model output as JSON: ${(err as Error).message}`);
  }

  const validated = essayMarkingResultSchema.safeParse(parsedJson);
  if (!validated.success) {
    throw new EssayMarkingError(
      `Model output did not match the expected essay marking schema: ${validated.error.message}`,
    );
  }

  return validated.data;
}
