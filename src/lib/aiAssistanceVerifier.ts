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
import {
  callWithTransientRetry,
  classifyProviderError,
  type AiProviderErrorCategory,
  type ProviderCallAttemptLog,
} from "@/lib/aiAssistanceProviderError";

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

/** `category` defaults to "UNKNOWN" only for the handful of call sites that construct this error directly in tests — every real throw site below always supplies a real classification. */
export class AiAssistanceVerificationError extends Error {
  readonly category: AiProviderErrorCategory;
  constructor(message: string, category: AiProviderErrorCategory = "UNKNOWN") {
    super(message);
    this.category = category;
  }
}

export type FastVerifierDecision =
  | { kind: "REJECT"; result: BrainstormVerifierResult }
  | { kind: "DEFER" };

const DIRECT_ANSWER_PATTERNS = [
  // Concept-explanation quality follow-up — the optional "to this/the
  // question" clause was added after finding "The answer to this
  // question is @decorator." slipped past this pattern (it required
  // "answer" to be immediately followed by "is", with nothing in
  // between) — a real gap in the direct-answer fast-check, not a
  // weakening: still requires the same qualifier+answer+is structure.
  // Architectural simplification follow-up — also allow an optional
  // "full/complete/whole" between the qualifier and "answer", found
  // missing "Yes, your full answer is correct." (a confirmation of a
  // stated final answer).
  /\b(?:the|your|correct|final)\s+(?:full\s+|complete\s+|whole\s+)?answer(?:\s+to\s+(?:this|the)\s+question)?\s+(?:is|would be|should be)\b/i,
  /\b(?:therefore|thus|hence)\s+(?:the\s+)?(?:answer|result)\s+(?:is|=)\b/i,
  /\b(?:the\s+)?correct\s+(?:option|choice)\s+(?:is|would be)\b/i,
  /\byou\s+should\s+(?:choose|select|answer)\b/i,
  // Architectural simplification follow-up — "The output is [1, 2, 3,
  // 4]." names a computed VALUE, not a general concept, so it's a
  // direct-answer disclosure like the others above. Deliberately narrow:
  // only fires when "output/result is" is immediately followed by
  // something that reads as a literal value (bracket/brace/quote/digit/
  // minus sign) — "the output is a tuple" (explaining a TYPE, not a
  // value) must still defer to the semantic verifier, not be
  // deterministically rejected here.
  /\bthe\s+(?:output|result)\s+is\s*[[{('"-]|\bthe\s+(?:output|result)\s+is\s+\d/i,
];

const OPTION_DISCLOSURE_PATTERNS = [
  /\b(?:option|choice)\s*[A-Z0-9]\s+(?:is|looks|seems|would be)\s+(?:correct|right|best)\b/i,
  /\b(?:eliminate|rule out)\s+(?:option|choice)\s*[A-Z0-9]\b/i,
  // Architectural simplification follow-up — "Yes, B is correct." names
  // the option letter directly without the word "option"/"choice",
  // which the two patterns above require. MCQ-only (see
  // fastVerifyBrainstormResponse's questionType guard), and requires an
  // uppercase single letter (conventional MCQ option style) to avoid
  // matching ordinary lowercase words.
  /\b[A-D]\s+is\s+correct\b/,
];

const CODE_DISCLOSURE_PATTERNS = [
  /```[\s\S]*```/,
  /(?:^|\n)\s*(?:def|function|class)\s+\w+/i,
  /(?:^|\n)\s*(?:return|console\.log|print)\s*\(/i,
];


function normaliseForComparison(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.+-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function leaksHiddenReference(candidate: string, hiddenReference?: string | null): boolean {
  if (!hiddenReference) return false;

  const candidateNormalised = normaliseForComparison(candidate);
  const hiddenNormalised = normaliseForComparison(hiddenReference);

  if (hiddenNormalised.length >= 4 && candidateNormalised.includes(hiddenNormalised)) {
    return true;
  }

  const hiddenNumbers = hiddenNormalised.match(/[-+]?\d+(?:\.\d+)?/g) ?? [];
  return (
    hiddenNumbers.length > 0 &&
    /\b(?:answer|result|equals?|gives?|therefore|thus|hence)\b/i.test(candidate) &&
    hiddenNumbers.some((value) => candidateNormalised.includes(value))
  );
}

/**
 * Fast deterministic first stage for the independent verifier.
 *
 * It is deliberately asymmetric:
 * - obvious leakage is rejected immediately;
 * - only a narrow class of short, question-led Socratic hints is approved locally;
 * - everything else defers to the existing independent Anthropic verifier.
 *
 * This removes the second remote model call from clearly-safe first/second hints
 * without making uncertain semantic cases fail open.
 */
export function fastVerifyBrainstormResponse(input: BrainstormVerifierInput): FastVerifierDecision {
  const candidate = input.candidateResponse.trim();

  if (
    DIRECT_ANSWER_PATTERNS.some((pattern) => pattern.test(candidate)) ||
    leaksHiddenReference(candidate, input.hiddenModelAnswer)
  ) {
    return {
      kind: "REJECT",
      result: {
        allowed: false,
        riskScore: 0.95,
        riskCodes: ["DIRECT_ANSWER"],
        reason: "Deterministic guard detected direct-answer or hidden-answer disclosure.",
      },
    };
  }

  if (
    input.questionType === "MULTIPLE_CHOICE" &&
    OPTION_DISCLOSURE_PATTERNS.some((pattern) => pattern.test(candidate))
  ) {
    return {
      kind: "REJECT",
      result: {
        allowed: false,
        riskScore: 0.95,
        riskCodes: ["CORRECT_OPTION_DISCLOSED"],
        reason: "Deterministic guard detected option-specific guidance.",
      },
    };
  }

  if (CODE_DISCLOSURE_PATTERNS.some((pattern) => pattern.test(candidate))) {
    return {
      kind: "REJECT",
      result: {
        allowed: false,
        riskScore: 0.9,
        riskCodes: ["COMPLETE_CODE"],
        reason: "Deterministic guard detected code-like answer content.",
      },
    };
  }

  // Deterministic checks are fail-closed only: they may reject obvious
  // leakage immediately, but they NEVER approve a response for display.
  // Every candidate that is not rejected here still goes through the
  // independent semantic verifier below.
  return { kind: "DEFER" };
}

/**
 * Architectural simplification follow-up — `reason` deliberately has NO
 * upper bound in the model-facing schema. It is an internal audit note
 * (never shown to the student), and a long-but-valid safety
 * justification must never itself invalidate an otherwise-correct
 * verdict — a prior version capped this at 400 chars, which meant a
 * verbose (but entirely valid) `reason` string failed schema validation
 * and the WHOLE interaction fell to the deterministic fallback, even
 * when the model's `allowed` judgment was itself correct. Length is
 * enforced separately, AFTER parsing succeeds — see
 * MAX_VERIFIER_REASON_CHARACTERS below and its use in
 * verifyBrainstormResponse.
 */
const verifierResultSchema = z.object({
  allowed: z.boolean(),
  riskScore: z.number().min(0).max(1),
  riskCodes: z.array(z.enum(RISK_CODES)),
  reason: z.string().min(1),
});

/** Applied only AFTER a verdict has already parsed and validated successfully — never part of the parse/validate step itself (see verifierResultSchema's own doc comment). */
export const MAX_VERIFIER_REASON_CHARACTERS = 400;

/**
 * Architectural simplification follow-up — replaces the prior broad,
 * accumulated "too specific / excessive detail / relevance" style
 * judgment with a single narrow question. Four successive rounds of
 * patches each added another carve-out to that broader framing, and
 * repeated live Preview testing kept finding new false-positive
 * rejections of genuinely safe teaching content — evidence that the
 * broader framing itself, not any one missing carve-out, was the
 * problem. This prompt asks ONLY whether the candidate discloses,
 * confirms, or completes the graded final answer; teaching content is
 * categorically safe regardless of how detailed or how relevant to the
 * active question it is.
 */
function buildSystemPrompt(): string {
  return [
    "You are a strict, independent safety verifier for an exam brainstorming assistant — a restricted tutor. You do not generate help yourself — you only judge whether a CANDIDATE RESPONSE, already drafted by another system, is safe to show a student during a live exam.",
    "",
    "Ask exactly ONE question: does this candidate response STATE, CONFIRM, TRIVIALLY IMPLY, or PROVIDE A SUBMISSION-READY VERSION of the graded final answer for the ACTIVE question? That is the only thing that makes a response unsafe.",
    "",
    "A response is UNSAFE (allowed=false) only if it does ANY of the following:",
    "- states or clearly implies the correct final answer, or gets the student all the way there (DIRECT_ANSWER / NEAR_COMPLETE_ANSWER)",
    "- states, confirms, ranks, or eliminates the correct multiple-choice option (CORRECT_OPTION_DISCLOSED / OPTION_ELIMINATION)",
    "- gives the final numeric result, or performs the last substitution/computation step for the student (FINAL_NUMERIC_RESULT)",
    "- is a complete, submission-ready essay/prose response the student could paste directly as their final answer (SUBMISSION_READY_PROSE)",
    "- is complete, working code that directly answers the assessed question (COMPLETE_CODE)",
    "- discloses or paraphrases the rubric/marking scheme/model answer text you were given as hidden reference material (HIDDEN_RUBRIC_DISCLOSURE)",
    "",
    "TEACHING CONTENT IS SAFE, EVEN WHEN HIGHLY RELEVANT TO THE ACTIVE QUESTION. Relevance to the question is NEVER by itself a reason to reject. All of the following are SAFE, including when the active question is directly about them:",
    '- "*args collects extra positional arguments into a tuple, while **kwargs collects extra keyword arguments into a dictionary."',
    '- "x is a list because square brackets create a list."',
    '- "append() mutates an existing list in place."',
    '- "A list is mutable while a tuple is immutable."',
    '- "A decorator is a callable that wraps another function to modify or extend its behaviour."',
    '- "Classification predicts categories, while regression predicts numeric values."',
    "Contrast with what actually IS unsafe — resolving the active question itself, not merely teaching its subject matter:",
    '- "The correct option is B."',
    "- \"The output is (1, 2, (3, 4), {'x': 10}).\"",
    '- "The answer is def."',
    '- "Yes, B is correct." / "Yes, your final answer is correct."',
    "",
    "For an open-response question (essay/short-answer), teaching and substantial explanation are SAFE — reject only when the candidate becomes a complete, submission-ready version of the student's final assessed response, never merely because it is thorough or detailed.",
    "",
    "A candidate that corrects a student's mistaken claim (for example \"Not quite — a tuple is not a row\") or acknowledges the student is looking in the right area, WITHOUT stating the actual final answer/option/result, is SAFE. A candidate that answers \"yes\"/\"correct\"/\"that's right\" (or equivalent agreement) to a student's own fully-stated final answer, option, or result IS unsafe, even when phrased as agreement rather than a fresh statement.",
    "",
    "Judge ONLY the candidate response text — never the student's own request wording. A student's request may legitimately contain words like \"answer\", \"solve\", \"result\", or \"help\" while asking for guidance or method, not disclosure.",
    "If it is genuinely unclear whether the candidate crosses the line, prefer allowed=true with a moderately higher riskScore over an outright rejection.",
    "",
    "You ARE given the hidden model answer and/or rubric summary (when available) purely so you can judge disclosure accurately — never quote them back in your reason field.",
    "",
    "Respond with ONLY a JSON object — no markdown, no preamble:",
    '{ "allowed": boolean, "riskScore": number (0-1), "riskCodes": string[], "reason": string }',
    "riskCodes must only use these exact values: " + RISK_CODES.join(", "),
    "riskScore reflects how close the response comes to violating the rule even when allowed=true (0 = completely safe, 1 = essentially the answer).",
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
/** Intermittent-failure follow-up — see the identical note on aiAssistanceGenerator.ts's own ANTHROPIC_MAX_RETRIES. */
export const ANTHROPIC_MAX_RETRIES = 0;
/** Intermittent-failure follow-up — see the identical note on aiAssistanceGenerator.ts's own AI_ASSISTANCE_GENERATOR_MAX_ATTEMPTS. */
export const AI_ASSISTANCE_VERIFIER_MAX_ATTEMPTS = 3;

/**
 * Independent verifier model. The generator can use Sonnet while the
 * safety-screening call uses the lower-latency Haiku model.
 */
export const ANTHROPIC_BRAINSTORM_VERIFIER_MODEL_DEFAULT = "claude-haiku-4-5-20251001";

export function getAnthropicBrainstormVerifierModel(): string {
  return (
    process.env.ANTHROPIC_BRAINSTORM_VERIFIER_MODEL?.trim() ||
    ANTHROPIC_BRAINSTORM_VERIFIER_MODEL_DEFAULT
  );
}

function getClient(): Anthropic {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new AiAssistanceVerificationError("Missing required environment variable: ANTHROPIC_API_KEY", "CONFIG_MISSING");
  }
  cachedClient = new Anthropic({ apiKey, timeout: ANTHROPIC_TIMEOUT_MS, maxRetries: ANTHROPIC_MAX_RETRIES });
  return cachedClient;
}

/**
 * Optional diagnostics hook (intermittent-failure follow-up) — see the
 * identical GenerateBrainstormDiagnostics in aiAssistanceGenerator.ts.
 */
export type VerifyBrainstormDiagnostics = { onAttempt?: (log: ProviderCallAttemptLog) => void };

export async function verifyBrainstormResponse(
  input: BrainstormVerifierInput,
  diagnostics?: VerifyBrainstormDiagnostics,
): Promise<BrainstormVerifierResult> {
  const fastDecision = fastVerifyBrainstormResponse(input);
  if (fastDecision.kind === "REJECT") {
    return fastDecision.result;
  }

  const client = getClient();

  let response;
  try {
    response = await callWithTransientRetry(
      () =>
        client.messages.create({
          model: getAnthropicBrainstormVerifierModel(),
          max_tokens: 220,
          temperature: 0,
          system: buildSystemPrompt(),
          messages: [{ role: "user", content: buildUserPrompt(input) }],
        }),
      { maxAttempts: AI_ASSISTANCE_VERIFIER_MAX_ATTEMPTS, onAttempt: diagnostics?.onAttempt },
    );
  } catch (err) {
    // Never include the caught error's own message — see the identical
    // note in aiAssistanceGenerator.ts. A verifier failure is at least
    // as sensitive to sanitise as a generator one, since the SDK error
    // could in principle echo back request content — the classification
    // category alone (never the message) is safe to log/persist.
    throw new AiAssistanceVerificationError("Anthropic API request failed", classifyProviderError(err));
  }

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new AiAssistanceVerificationError("Anthropic response did not contain a text block", "PARSE_ERROR");
  }

  const cleaned = stripMarkdownFences(textBlock.text);

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(cleaned);
  } catch {
    // Do not include the raw model text or the parser's own message —
    // both could contain a snippet of the (potentially unsafe) candidate
    // content the verifier was judging.
    throw new AiAssistanceVerificationError("Failed to parse verifier output as JSON", "PARSE_ERROR");
  }

  // Also structurally rejects an unknown/invented risk code (Part 1 —
  // "the verifier returns an unknown risk code") via the z.enum(RISK_CODES)
  // array element schema: any code outside the fixed RISK_CODES list
  // fails validation here exactly like any other malformed payload, so
  // it hits the same fail-closed path rather than being silently
  // accepted or crashing later.
  const validated = verifierResultSchema.safeParse(parsedJson);
  if (!validated.success) {
    throw new AiAssistanceVerificationError("Verifier output did not match the expected schema", "SCHEMA_ERROR");
  }

  // Truncate ONLY here, after a successful parse+validate — never as
  // part of the schema itself (see verifierResultSchema's doc comment).
  // A long-but-valid `reason` must never invalidate the verdict it
  // belongs to; this only bounds what gets persisted/logged afterward.
  return {
    ...validated.data,
    reason:
      validated.data.reason.length > MAX_VERIFIER_REASON_CHARACTERS
        ? validated.data.reason.slice(0, MAX_VERIFIER_REASON_CHARACTERS)
        : validated.data.reason,
  };
}
