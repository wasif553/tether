/**
 * Controlled AI Brainstorming Assistance v1 — pure policy module. See
 * docs/controlled-ai-brainstorming-assistance-v1.md.
 *
 * Pure, dependency-free, deterministic: no Prisma, no Next.js, no
 * Anthropic SDK. Defines the immutable per-attempt policy snapshot shape
 * (mirroring src/lib/examPolicy.ts's buildExamPolicySnapshot pattern),
 * prompt/attempt limit checks, the cumulative-hint ladder, and the
 * request-length bound. This is an ALLOWED assessment resource, not an
 * integrity violation — nothing here computes or contributes to a
 * misconduct/risk score.
 */
import type { SecureExamSettings, AiAssistanceMode } from "@/lib/secureExam";

export const AI_ASSISTANCE_POLICY_VERSION = "v1.0";
/** Bumped only if the snapshot's shape changes in a way old snapshots can't be read as. */
export const AI_ASSISTANCE_SNAPSHOT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Policy snapshot (Part 3)
// ---------------------------------------------------------------------------

export type AiAssistancePolicy = {
  schemaVersion: number;
  policyVersion: string;
  mode: AiAssistanceMode;
  maxPromptsPerQuestion: number;
  maxPromptsPerAttempt: number;
  maxResponseCharacters: number;
  allowConceptExplanations: boolean;
  allowAnswerPlanning: boolean;
  allowReasoningFeedback: boolean;
  allowProgrammingConceptHelp: boolean;
};

export type RelevantAiAssistanceSettings = Pick<
  SecureExamSettings,
  | "aiAssistanceMode"
  | "aiAssistanceMaxPromptsPerQuestion"
  | "aiAssistanceMaxPromptsPerAttempt"
  | "aiAssistanceMaxResponseCharacters"
  | "aiAssistanceAllowConceptExplanations"
  | "aiAssistanceAllowAnswerPlanning"
  | "aiAssistanceAllowReasoningFeedback"
  | "aiAssistanceAllowProgrammingConceptHelp"
>;

/**
 * Builds the effective policy from CURRENT exam settings. Called once, at
 * attempt start, to produce the immutable snapshot
 * (Submission.aiAssistancePolicySnapshotJson) — never called again for an
 * in-progress attempt, and never used directly by request-time decisions
 * (those must read the stored snapshot via parseAiAssistancePolicy below).
 */
export function buildAiAssistancePolicySnapshot(settings: RelevantAiAssistanceSettings): AiAssistancePolicy {
  return {
    schemaVersion: AI_ASSISTANCE_SNAPSHOT_SCHEMA_VERSION,
    policyVersion: AI_ASSISTANCE_POLICY_VERSION,
    mode: settings.aiAssistanceMode,
    maxPromptsPerQuestion: settings.aiAssistanceMaxPromptsPerQuestion,
    maxPromptsPerAttempt: settings.aiAssistanceMaxPromptsPerAttempt,
    maxResponseCharacters: settings.aiAssistanceMaxResponseCharacters,
    allowConceptExplanations: settings.aiAssistanceAllowConceptExplanations,
    allowAnswerPlanning: settings.aiAssistanceAllowAnswerPlanning,
    allowReasoningFeedback: settings.aiAssistanceAllowReasoningFeedback,
    allowProgrammingConceptHelp: settings.aiAssistanceAllowProgrammingConceptHelp,
  };
}

export const DISABLED_AI_ASSISTANCE_POLICY: AiAssistancePolicy = {
  schemaVersion: AI_ASSISTANCE_SNAPSHOT_SCHEMA_VERSION,
  policyVersion: AI_ASSISTANCE_POLICY_VERSION,
  mode: "DISABLED",
  maxPromptsPerQuestion: 0,
  maxPromptsPerAttempt: 0,
  maxResponseCharacters: 0,
  allowConceptExplanations: false,
  allowAnswerPlanning: false,
  allowReasoningFeedback: false,
  allowProgrammingConceptHelp: false,
};

/**
 * Reads back a stored snapshot (Submission.aiAssistancePolicySnapshotJson).
 * A null/malformed/missing snapshot is ALWAYS treated as DISABLED — never
 * silently active, and never re-derived from the exam's current (possibly
 * since-changed) settings. This is the one function every request-time
 * decision must go through.
 */
export function parseAiAssistancePolicy(raw: unknown): AiAssistancePolicy {
  if (raw == null || typeof raw !== "object") return { ...DISABLED_AI_ASSISTANCE_POLICY };
  const obj = raw as Record<string, unknown>;
  const mode = obj.mode === "BRAINSTORM_ONLY" ? "BRAINSTORM_ONLY" : "DISABLED";
  if (mode === "DISABLED") return { ...DISABLED_AI_ASSISTANCE_POLICY };
  return {
    schemaVersion: typeof obj.schemaVersion === "number" ? obj.schemaVersion : AI_ASSISTANCE_SNAPSHOT_SCHEMA_VERSION,
    policyVersion: typeof obj.policyVersion === "string" ? obj.policyVersion : AI_ASSISTANCE_POLICY_VERSION,
    mode,
    maxPromptsPerQuestion: positiveIntOr(obj.maxPromptsPerQuestion, 3),
    maxPromptsPerAttempt: positiveIntOr(obj.maxPromptsPerAttempt, 10),
    maxResponseCharacters: positiveIntOr(obj.maxResponseCharacters, 800),
    allowConceptExplanations: obj.allowConceptExplanations !== false,
    allowAnswerPlanning: obj.allowAnswerPlanning !== false,
    allowReasoningFeedback: obj.allowReasoningFeedback !== false,
    allowProgrammingConceptHelp: obj.allowProgrammingConceptHelp !== false,
  };
}

function positiveIntOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

export function isAiAssistanceEnabled(policy: Pick<AiAssistancePolicy, "mode">): boolean {
  return policy.mode === "BRAINSTORM_ONLY";
}

// ---------------------------------------------------------------------------
// Prompt/attempt limits (Part 5)
// ---------------------------------------------------------------------------

export function hasReachedQuestionPromptLimit(
  promptsAlreadyUsedForQuestion: number,
  policy: Pick<AiAssistancePolicy, "maxPromptsPerQuestion">,
): boolean {
  return promptsAlreadyUsedForQuestion >= policy.maxPromptsPerQuestion;
}

export function hasReachedAttemptPromptLimit(
  promptsAlreadyUsedForAttempt: number,
  policy: Pick<AiAssistancePolicy, "maxPromptsPerAttempt">,
): boolean {
  return promptsAlreadyUsedForAttempt >= policy.maxPromptsPerAttempt;
}

// ---------------------------------------------------------------------------
// Request length bound (Part 5/15) — a fixed technical ceiling on the
// STUDENT'S prompt, independent of and much larger than the lecturer-
// configurable response character limit above (which bounds the
// ASSISTANT's output, not the student's input).
// ---------------------------------------------------------------------------

export const MAX_STUDENT_PROMPT_CHARACTERS = 1_000;

export function isStudentPromptLengthValid(prompt: string, maxChars: number = MAX_STUDENT_PROMPT_CHARACTERS): boolean {
  const trimmed = prompt.trim();
  return trimmed.length > 0 && trimmed.length <= maxChars;
}

// ---------------------------------------------------------------------------
// Rate limiting (Part 5/15) — no rate-limiting utility exists elsewhere in
// this repo to reuse (checked: no throttle/cooldown/windowMs helper for
// server routes), so this is a new, minimal, dependency-free sliding-
// window check driven by the caller's own recent-request timestamps
// (queried from AiAssistanceInteraction.createdAt — see
// src/lib/aiAssistanceRunner.ts — never in-memory process state, which
// would not be safe across multiple server instances).
// ---------------------------------------------------------------------------

export const AI_ASSISTANCE_RATE_LIMIT_MAX_REQUESTS = 3;
export const AI_ASSISTANCE_RATE_LIMIT_WINDOW_MS = 20_000;

export function isWithinRateLimit(
  recentRequestTimestampsMs: number[],
  nowMs: number,
  maxRequests: number = AI_ASSISTANCE_RATE_LIMIT_MAX_REQUESTS,
  windowMs: number = AI_ASSISTANCE_RATE_LIMIT_WINDOW_MS,
): boolean {
  const cutoff = nowMs - windowMs;
  const withinWindow = recentRequestTimestampsMs.filter((t) => t >= cutoff);
  return withinWindow.length < maxRequests;
}

// ---------------------------------------------------------------------------
// Cumulative hint ladder (Part 10)
// ---------------------------------------------------------------------------

export const HINT_LADDER_LEVELS = [
  { level: 1, name: "CLARIFY_TASK", description: "Clarify the task" },
  { level: 2, name: "IDENTIFY_CONCEPTS", description: "Identify broad concepts" },
  { level: 3, name: "TARGETED_QUESTION", description: "Ask a targeted reasoning question" },
  { level: 4, name: "MISSING_STEP", description: "Identify one missing reasoning step" },
] as const;

export const MAX_HINT_LADDER_LEVEL = 4;

/**
 * The hint ladder level is driven by how many prompts have ALREADY been
 * approved for this question (not the raw prompt count, which would also
 * count blocked requests) — the Nth approved response for a question is
 * capped at level N, and never exceeds MAX_HINT_LADDER_LEVEL regardless of
 * how many more prompts remain within the per-question limit. This is the
 * generator's ceiling, not a guarantee — the verifier (Part 8) is the
 * actual enforcement point; the ladder only shapes what the generator is
 * asked to attempt.
 */
export function hintLadderLevelForApprovedCount(approvedResponsesForQuestion: number): number {
  return Math.min(MAX_HINT_LADDER_LEVEL, Math.max(1, approvedResponsesForQuestion + 1));
}

/**
 * Cumulative risk is a running sum of every approved interaction's own
 * riskScore for this question — never reset mid-attempt, never reduced.
 * A single interaction can be individually low-risk yet still trip
 * cumulative-hint-leakage protection once several of them stack up (Part
 * 10 — "the verifier must consider all previous approved responses, not
 * only the current candidate").
 */
export function nextCumulativeRiskScore(previousCumulativeRiskScore: number, newInteractionRiskScore: number): number {
  return previousCumulativeRiskScore + Math.max(0, newInteractionRiskScore);
}

/** Above this cumulative total, further hints for this question must escalate to a stricter (or the deterministic fallback) response, even if the current candidate alone looks safe. */
export const CUMULATIVE_HINT_LEAKAGE_THRESHOLD = 1.6;

export function isCumulativeHintLeakageRisk(
  cumulativeRiskScore: number,
  threshold: number = CUMULATIVE_HINT_LEAKAGE_THRESHOLD,
): boolean {
  return cumulativeRiskScore >= threshold;
}

// ---------------------------------------------------------------------------
// Interaction status (Part 4/9)
// ---------------------------------------------------------------------------

export const AI_ASSISTANCE_INTERACTION_STATUSES = [
  "BLOCKED",
  "APPROVED",
  "REGENERATED_APPROVED",
  "FALLBACK",
] as const;
export type AiAssistanceInteractionStatus = (typeof AI_ASSISTANCE_INTERACTION_STATUSES)[number];

/** The deterministic, always-safe fallback (Part 9) — never generated text, never model output of any kind. */
export const AI_ASSISTANCE_FALLBACK_RESPONSE =
  "I cannot provide that part of the answer. Start by identifying the main concept being assessed. " +
  "What information in the question appears most relevant to that concept?";
