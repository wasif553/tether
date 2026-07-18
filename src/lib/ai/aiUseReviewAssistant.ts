/**
 * AI-Use Answer Review v1 — Layer B (optional AI-assisted analysis). See
 * docs/ai-use-answer-review-v1.md and src/lib/aiUseReview.ts (Layer A,
 * deterministic).
 *
 * THIS IS NOT AN AI DETECTOR. The model is explicitly instructed never to
 * determine whether AI wrote the answer, never to infer misconduct, and
 * never to return a probability. It only identifies observable answer
 * characteristics as explainable review signals. Output is validated
 * against a strict schema and re-checked against the banned-wording list
 * in src/lib/aiUseReview.ts before it is ever used — an invalid or
 * banned-wording response is rejected outright (never sanitised into
 * something that could look authoritative).
 *
 * Privacy: the payload sent to the provider contains only an anonymous
 * submission reference plus bounded question/answer text — never a
 * student name, email, student id, camera evidence, institution secret,
 * or (in v1) the correct answer.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { SIGNAL_LEVELS, SIGNAL_TYPES, containsBannedWording } from "@/lib/aiUseReview";

export class AiUseReviewAssistError extends Error {}
export class AiUseReviewAssistNotConfiguredError extends AiUseReviewAssistError {
  constructor() {
    super("AI-assisted review is not configured.");
  }
}

// ---------------------------------------------------------------------------
// Bounded payload limits — see Part 15 (Performance limits).
// ---------------------------------------------------------------------------

export const MAX_ITEMS_PER_ASSIST_REQUEST = 12;
export const MAX_CHARS_PER_QUESTION = 800;
export const MAX_CHARS_PER_ANSWER = 2000;
export const MAX_TOTAL_PAYLOAD_CHARS = 20_000;
export const ASSIST_REQUEST_TIMEOUT_MS = 20_000;

export type AiUseReviewAssistInputItem = {
  questionId: string;
  questionText: string;
  answerText: string;
};

export type AiUseReviewAssistInput = {
  /** Opaque per-run reference — never a student name/email/id. */
  anonymousSubmissionRef: string;
  items: AiUseReviewAssistInputItem[];
};

const assistSignalSchema = z.object({
  type: z.enum(SIGNAL_TYPES),
  level: z.enum(SIGNAL_LEVELS),
  reason: z.string().min(1).max(1000),
  evidence: z.array(z.string().max(300)).max(10),
  limitation: z.string().min(1).max(500),
  /** Which supplied item this signal concerns — validated against the request's own question ids. */
  questionId: z.string().min(1),
});

export const aiUseReviewAssistResultSchema = z.object({
  signals: z.array(assistSignalSchema).max(20),
  overallLevel: z.enum(SIGNAL_LEVELS),
  reviewRecommended: z.boolean(),
});

export type AiUseReviewAssistResult = z.infer<typeof aiUseReviewAssistResultSchema>;

// ---------------------------------------------------------------------------
// Truncation — bounded, but the truncation itself is always recorded so a
// partial analysis is never silently presented as complete (Part 15).
// ---------------------------------------------------------------------------

function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

export function buildBoundedAssistInput(input: AiUseReviewAssistInput): {
  bounded: AiUseReviewAssistInput;
  truncatedQuestionIds: string[];
  itemsOmittedCount: number;
} {
  const truncatedQuestionIds: string[] = [];
  const limitedItems = input.items.slice(0, MAX_ITEMS_PER_ASSIST_REQUEST);
  const itemsOmittedCount = input.items.length - limitedItems.length;

  let runningChars = 0;
  const bounded: AiUseReviewAssistInputItem[] = [];
  for (const item of limitedItems) {
    const q = truncate(item.questionText, MAX_CHARS_PER_QUESTION);
    const a = truncate(item.answerText, MAX_CHARS_PER_ANSWER);
    if (q.truncated || a.truncated) truncatedQuestionIds.push(item.questionId);
    const itemChars = q.text.length + a.text.length;
    if (runningChars + itemChars > MAX_TOTAL_PAYLOAD_CHARS) break;
    runningChars += itemChars;
    bounded.push({ questionId: item.questionId, questionText: q.text, answerText: a.text });
  }

  return {
    bounded: { anonymousSubmissionRef: input.anonymousSubmissionRef, items: bounded },
    truncatedQuestionIds,
    itemsOmittedCount: itemsOmittedCount + (limitedItems.length - bounded.length),
  };
}

// ---------------------------------------------------------------------------
// Prompting
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  "You review exam answer text for OBSERVABLE characteristics only, to support a human lecturer's academic review.",
  "You are NOT a plagiarism or AI-detection tool, and your output is never a final decision.",
  "Rules you must follow strictly:",
  "- Do not determine whether AI wrote the answer.",
  "- Do not infer academic misconduct.",
  "- Do not use writing quality alone as proof of anything.",
  "- Identify only observable answer characteristics: scenario application, whether explicit question requirements are addressed, unsupported specific claims, generic/shallow content, and style differences from the student's other supplied responses.",
  "- State uncertainty and plausible alternative explanations in every reason and limitation you write.",
  "- Never reveal, reconstruct, or hint at a correct answer — none is supplied to you.",
  "- Never output a percentage, probability, or likelihood that AI wrote anything.",
  "- Never use the words: AI-generated, AI detected, ChatGPT, cheating, guilty, misconduct, confirmed, proof.",
  "Respond with ONLY a JSON object — no markdown, no preamble.",
].join("\n");

function buildUserPrompt(input: AiUseReviewAssistInput): string {
  const lines = [
    `Anonymous submission reference: ${input.anonymousSubmissionRef}`,
    "",
    "Review the following question/answer pairs from one exam attempt. Compare answers to each other only for style ",
    "characteristics — never against any other student or historical data (none is supplied).",
    "",
  ];
  input.items.forEach((item, i) => {
    lines.push(`--- Item ${i + 1} (questionId: ${item.questionId}) ---`);
    lines.push(`Question: ${item.questionText}`);
    lines.push(`Answer: ${item.answerText}`);
    lines.push("");
  });
  lines.push(
    "Return ONLY a JSON object of this exact shape:",
    "{",
    '  "signals": [{ "type": one of ' + JSON.stringify(SIGNAL_TYPES) + ",",
    '    "level": one of ' + JSON.stringify(SIGNAL_LEVELS) + ',',
    '    "reason": string, "evidence": string[], "limitation": string, "questionId": string }],',
    '  "overallLevel": one of ' + JSON.stringify(SIGNAL_LEVELS) + ",",
    '  "reviewRecommended": boolean',
    "}",
    "Only include a signal when there is genuine observable evidence for it — an empty signals array is a valid and expected result.",
  );
  return lines.join("\n");
}

function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

let cachedClient: Anthropic | undefined;

export function isAiAssistConfigured(): boolean {
  return typeof process.env.ANTHROPIC_API_KEY === "string" && process.env.ANTHROPIC_API_KEY.length > 0;
}

function getClient(): Anthropic {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new AiUseReviewAssistNotConfiguredError();
  cachedClient = new Anthropic({ apiKey });
  return cachedClient;
}

/** Model identifier reported alongside results — never the API key. */
export const AI_USE_REVIEW_MODEL_IDENTIFIER = "claude-sonnet-4-6";

/**
 * Runs the optional AI-assisted analysis. Throws AiUseReviewAssistError
 * (or the NotConfigured subclass) on any failure — the caller must catch
 * this, preserve Layer-A deterministic results, and mark only the
 * AI-assisted component as failed (never the submission).
 */
export async function runAiUseReviewAssist(input: AiUseReviewAssistInput): Promise<AiUseReviewAssistResult> {
  const client = getClient();
  const { bounded } = buildBoundedAssistInput(input);
  const knownQuestionIds = new Set(bounded.items.map((i) => i.questionId));

  let response;
  try {
    response = await client.messages.create(
      {
        model: AI_USE_REVIEW_MODEL_IDENTIFIER,
        max_tokens: 2048,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserPrompt(bounded) }],
      },
      { timeout: ASSIST_REQUEST_TIMEOUT_MS },
    );
  } catch (err) {
    throw new AiUseReviewAssistError(`Anthropic API request failed: ${(err as Error).message}`);
  }

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new AiUseReviewAssistError("Anthropic response did not contain a text block");
  }

  const cleaned = stripMarkdownFences(textBlock.text);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(cleaned);
  } catch (err) {
    throw new AiUseReviewAssistError(`Failed to parse model output as JSON: ${(err as Error).message}`);
  }

  const validated = aiUseReviewAssistResultSchema.safeParse(parsedJson);
  if (!validated.success) {
    throw new AiUseReviewAssistError(`Model output did not match the expected schema: ${validated.error.message}`);
  }

  // Reject the whole response if it references an unknown question, or if
  // any free-text field contains banned accusatory/confirmatory wording —
  // never sanitise-and-keep, since a partially-cleaned accusatory signal
  // could still look authoritative to a lecturer.
  for (const signal of validated.data.signals) {
    if (!knownQuestionIds.has(signal.questionId)) {
      throw new AiUseReviewAssistError("Model output referenced a question that was not part of the request");
    }
    const fields = [signal.reason, signal.limitation, ...signal.evidence];
    if (fields.some((f) => containsBannedWording(f))) {
      throw new AiUseReviewAssistError("Model output contained banned wording and was rejected");
    }
  }

  return validated.data;
}
