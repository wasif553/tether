/**
 * Controlled AI Brainstorming Assistance v1 — independent response
 * verifier. See docs/controlled-ai-brainstorming-assistance-v1.md.
 *
 * Server-only. A SEPARATE service from the generator
 * (src/lib/aiAssistanceGenerator.ts) — different system prompt, different
 * (and wider) input, called with its own Anthropic request. Generator
 * output is NEVER returned to a student without passing through this
 * verifier first (enforced by src/lib/aiAssistanceRunner.ts, the only
 * caller of both). The verifier's own structured output is never shown to
 * the student directly either — only used to decide whether the
 * candidate response may be shown.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { BrainstormQuestionType } from "@/lib/aiAssistanceGenerator";
import { boundedHiddenReference } from "@/lib/aiAssistancePolicy";

export const RISK_CODES = [
  "DIRECT_ANSWER",
  "NEAR_COMPLETE_ANSWER",
  "CORRECT_OPTION_DISCLOSED",
  "OPTION_ELIMINATION",
  "FINAL_NUMERIC_RESULT",
  "SUBMISSION_READY_PROSE",
  "COMPLETE_CODE",
  "HIDDEN_RUBRIC_DISCLOSURE",
  "CUMULATIVE_HINT_LEAKAGE",
  "EXCESSIVE_SPECIFICITY",
] as const;
export type RiskCode = (typeof RISK_CODES)[number];

export type BrainstormVerifierInput = {
  questionText: string;
  questionType: BrainstormQuestionType;
  candidateResponse: string;
  studentRequest: string;
  /** Present only when the question actually has one on record — never fabricated. */
  hiddenModelAnswer?: string | null;
  hiddenRubricSummary?: string | null;
  /** How many hints have already been approved for this question — the verifier must weigh disclosure cumulatively, not just against this one candidate. */
  priorApprovedHintCount: number;
  /** Running sum of riskScore across every previously-approved interaction for this question (Part 10). */
  cumulativeRiskScoreSoFar: number;
};

export type BrainstormVerifierResult = {
  allowed: boolean;
  riskScore: number;
  riskCodes: RiskCode[];
  reason: string;
};

export class AiAssistanceVerificationError extends Error {}

const verifierResultSchema = z.object({
  allowed: z.boolean(),
  riskScore: z.number().min(0).max(1),
  riskCodes: z.array(z.enum(RISK_CODES)),
  reason: z.string().min(1).max(400),
});

function buildSystemPrompt(): string {
  return [
    "You are a strict, independent safety verifier for an exam brainstorming assistant. You do not generate help yourself — you only judge whether a CANDIDATE RESPONSE, already drafted by another system, is safe to show a student during a live exam.",
    "",
    "A response is UNSAFE (allowed=false) if it does ANY of the following, even partially or by strong implication:",
    "- states or clearly implies the correct answer, or gets a student most of the way there (DIRECT_ANSWER / NEAR_COMPLETE_ANSWER)",
    "- states, implies, ranks, or eliminates any multiple-choice option, including narrowing down to 2 options (CORRECT_OPTION_DISCLOSED / OPTION_ELIMINATION)",
    "- gives a final numeric result, or performs the last substitution/computation step for the student (FINAL_NUMERIC_RESULT)",
    "- contains prose specific and complete enough that the student could paste it directly into their submission (SUBMISSION_READY_PROSE)",
    "- contains a complete function, complete algorithm, or code that would pass the assessment's hidden tests as-is (COMPLETE_CODE)",
    "- discloses or paraphrases the rubric/marking scheme/model answer text you were given as hidden reference material (HIDDEN_RUBRIC_DISCLOSURE)",
    "- combined with the hint count/cumulative history you're given, would let the student reconstruct the answer piece-by-piece even though this one message looks mild on its own (CUMULATIVE_HINT_LEAKAGE)",
    "- is simply far more specific/detailed than a Socratic brainstorming hint should be for this stage (EXCESSIVE_SPECIFICITY)",
    "",
    "You ARE given the hidden model answer and/or rubric summary (when available) purely so you can judge disclosure accurately — never quote them back in your reason field.",
    "",
    "Respond with ONLY a JSON object — no markdown, no preamble:",
    '{ "allowed": boolean, "riskScore": number (0-1), "riskCodes": string[], "reason": string }',
    "riskCodes must only use these exact values: " + RISK_CODES.join(", "),
    "riskScore reflects how close the response comes to violating the rules even when allowed=true (0 = completely safe, 1 = essentially the answer).",
    "reason is a short internal note for audit logs — never quote the hidden model answer/rubric in it, and never write anything intended to be shown to the student.",
  ].join("\n");
}

function buildUserPrompt(input: BrainstormVerifierInput): string {
  const lines = [
    `Question type: ${input.questionType}`,
    `Question: ${input.questionText}`,
    `Student's request: ${input.studentRequest}`,
    `Candidate response to judge: ${input.candidateResponse}`,
    `Hints already approved for this question: ${input.priorApprovedHintCount}`,
    `Cumulative risk score already accumulated for this question: ${input.cumulativeRiskScoreSoFar.toFixed(2)}`,
  ];
  // Bounded even though the runner already bounds these before calling
  // in (Part 9) — defense in depth against a future call site that
  // forgets to.
  const hiddenModelAnswer = boundedHiddenReference(input.hiddenModelAnswer);
  const hiddenRubricSummary = boundedHiddenReference(input.hiddenRubricSummary);
  if (hiddenModelAnswer) {
    lines.push(`Hidden model answer (reference only — never disclose): ${hiddenModelAnswer}`);
  }
  if (hiddenRubricSummary) {
    lines.push(`Hidden rubric summary (reference only — never disclose): ${hiddenRubricSummary}`);
  }
  return lines.join("\n");
}

function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

let cachedClient: Anthropic | undefined;

/** Bounded request timeout and retry count (Part 10 hardening) — see the matching constants in aiAssistanceGenerator.ts. */
export const ANTHROPIC_TIMEOUT_MS = 20_000;
export const ANTHROPIC_MAX_RETRIES = 1;

function getClient(): Anthropic {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new AiAssistanceVerificationError("Missing required environment variable: ANTHROPIC_API_KEY");
  }
  cachedClient = new Anthropic({ apiKey, timeout: ANTHROPIC_TIMEOUT_MS, maxRetries: ANTHROPIC_MAX_RETRIES });
  return cachedClient;
}

export async function verifyBrainstormResponse(input: BrainstormVerifierInput): Promise<BrainstormVerifierResult> {
  const client = getClient();

  let response;
  try {
    response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 512,
      temperature: 0,
      system: buildSystemPrompt(),
      messages: [{ role: "user", content: buildUserPrompt(input) }],
    });
  } catch {
    // Never include the caught error's own message — see the identical
    // note in aiAssistanceGenerator.ts. A verifier failure is at least
    // as sensitive to sanitise as a generator one, since the SDK error
    // could in principle echo back request content.
    throw new AiAssistanceVerificationError("Anthropic API request failed");
  }

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new AiAssistanceVerificationError("Anthropic response did not contain a text block");
  }

  const cleaned = stripMarkdownFences(textBlock.text);

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(cleaned);
  } catch {
    // Do not include the raw model text or the parser's own message —
    // both could contain a snippet of the (potentially unsafe) candidate
    // content the verifier was judging.
    throw new AiAssistanceVerificationError("Failed to parse verifier output as JSON");
  }

  // Also structurally rejects an unknown/invented risk code (Part 1 —
  // "the verifier returns an unknown risk code") via the z.enum(RISK_CODES)
  // array element schema: any code outside the fixed RISK_CODES list
  // fails validation here exactly like any other malformed payload, so
  // it hits the same fail-closed path rather than being silently
  // accepted or crashing later.
  const validated = verifierResultSchema.safeParse(parsedJson);
  if (!validated.success) {
    throw new AiAssistanceVerificationError("Verifier output did not match the expected schema");
  }

  return validated.data;
}
