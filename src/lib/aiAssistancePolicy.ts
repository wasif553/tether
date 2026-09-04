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
// Interaction status lifecycle (hardening v1.1) — six explicit states. See
// the AiAssistanceInteraction.status column comment in prisma/schema.prisma
// for what each one means and why REGENERATED_APPROVED was folded into
// APPROVED + a separate wasRegenerated flag instead of staying a seventh
// status value.
// ---------------------------------------------------------------------------

export const AI_ASSISTANCE_INTERACTION_STATUSES = [
  "RESERVED",
  "APPROVED",
  "BLOCKED",
  "FALLBACK",
  "FAILED",
] as const;
export type AiAssistanceInteractionStatus = (typeof AI_ASSISTANCE_INTERACTION_STATUSES)[number];

/** Every one of these is a genuinely terminal outcome — RESERVED is the only non-terminal status. */
export const TERMINAL_AI_ASSISTANCE_STATUSES = ["APPROVED", "BLOCKED", "FALLBACK", "FAILED"] as const;

/**
 * A RESERVED row this old was almost certainly left behind by a crashed or
 * timed-out server invocation (the whole reserve→generate→verify→finalize
 * sequence runs synchronously within one request — see
 * src/lib/aiAssistanceRunner.ts) rather than a request that is still
 * genuinely in flight. Used by the lecturer review and duplicate-request
 * detection so a RESERVED row can never appear as a silently-forever-
 * pending state (Part 4 — "RESERVED records cannot remain permanently
 * misleading"). Comfortably above the generator/verifier's own bounded
 * ANTHROPIC_TIMEOUT_MS (see aiAssistanceGenerator.ts/aiAssistanceVerifier.ts)
 * times two attempts, plus request overhead.
 */
export const STALE_RESERVATION_MS = 90_000;

export function isStaleReservation(createdAt: Date, now: number = Date.now()): boolean {
  return now - createdAt.getTime() > STALE_RESERVATION_MS;
}

/** The deterministic, always-safe fallback (Part 9) — never generated text, never model output of any kind. Deliberately two parts (a conceptual cue, then a focused question) — see isWeakSocraticOnlyResponse below: this exact text must never itself read as a bare Socratic question. */
export const AI_ASSISTANCE_FALLBACK_RESPONSE =
  "I cannot provide that part of the answer. Start by identifying the main concept being assessed and " +
  "the specific property or distinction the question is testing. What information in the question appears " +
  "most relevant to that concept?";

// ---------------------------------------------------------------------------
// Response-quality guard (Brainstorm hint-quality pass) — a normal
// (non-rejected-for-safety) candidate response can still be USELESS: a
// bare Socratic question with no actual hint, e.g. "What do you think?"
// or "Which one do you think it is?". That is a distinct failure mode
// from anything the safety verifier (aiAssistanceVerifier.ts) checks —
// this is about response QUALITY, not risk — so it is checked separately
// here, purely deterministically (no extra model call), by the runner
// AFTER a candidate has already passed the safety verifier. A response
// flagged here is treated exactly like a safety rejection: one
// regeneration attempt (this time explicitly asked to add substance),
// then the deterministic fallback.
// ---------------------------------------------------------------------------

/**
 * Bare/generic Socratic phrasings that must never stand alone as an
 * entire substantive response. Matched only against a response that is
 * ALSO just one sentence (see isWeakSocraticOnlyResponse) — the same
 * phrase appearing as a follow-up AFTER real guidance is fine and
 * expected (see the module doc comment above and Part 2 of the product
 * spec: "may appear AFTER meaningful guidance, but not as the whole
 * substantive response").
 */
const GENERIC_SOCRATIC_ONLY_PATTERNS: RegExp[] = [
  /^what do you think\??$/i,
  /^what('| i)?s your (thinking|reasoning|answer)\??$/i,
  /^which (one|option|answer) do you think (it is|is (correct|right))\??$/i,
  /^can you (reason (it|this) (out|through)|explain your (thinking|reasoning)|think it through)\??$/i,
  /^try again\.?$/i,
  /^have another (go|try)\.?$/i,
  /^think (it|this) through\.?$/i,
  /^what do you reckon\??$/i,
];

/** Splits on sentence-terminal punctuation followed by whitespace (or end of string) — a small, deterministic heuristic, not a full NLP sentence splitter. */
function splitIntoSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function isGenericSocraticOnlySentence(sentence: string): boolean {
  return GENERIC_SOCRATIC_ONLY_PATTERNS.some((pattern) => pattern.test(sentence.trim()));
}

/**
 * Above this length, a single-sentence response is never flagged purely
 * for being one sentence — every genuine bare-Socratic-question example
 * in the product spec ("What do you think?", "Which one do you think it
 * is?", "Can you reason through it?", "Try again.") is well under this,
 * while a real (if terse) single-sentence hint like "Consider what
 * happens to prices when money supply grows faster than output." is
 * comfortably over it. Keeps this guard narrow: it must never reject a
 * genuinely substantive short statement just because it has no second
 * sentence.
 */
const MAX_BARE_QUESTION_CHARACTERS = 80;

/**
 * True when a candidate response fails the "hint + question" structure
 * the product spec requires for a normal response (Part 2): a bare
 * generic Socratic question/imperative (or an empty/whitespace response)
 * with no other guidance anywhere in it. Deliberately narrow — it flags
 * the unambiguous "only a bare question" failure mode the spec's own
 * BAD examples describe, never a genuine (even if terse) substantive
 * statement, so a real single-sentence hint is never mistakenly
 * rejected. Judging whether a longer sentence is genuinely USEFUL (as
 * opposed to just non-generic-sounding filler) is exactly the kind of
 * semantic judgment the independent safety verifier already exists to
 * make on other axes; this deterministic guard's job is narrower and
 * cheaper: catch the obvious case without a second model call for every
 * response.
 */
export function isWeakSocraticOnlyResponse(response: string): boolean {
  const trimmed = response.trim();
  if (trimmed.length === 0) return true;

  const sentences = splitIntoSentences(trimmed);

  // Multiple sentences: weak only if EVERY one of them is itself a bare
  // generic prompt-to-think-again (e.g. "What do you think? Try
  // again.") — real guidance mixed in anywhere makes it acceptable.
  if (sentences.length > 1) {
    return sentences.every(isGenericSocraticOnlySentence);
  }

  // A single sentence: only flagged when it is SHORT and is either a
  // bare generic phrase outright, or simply a bare question with
  // nothing else — the direct, narrowly-scoped enforcement of "a
  // Socratic question alone should not normally be considered
  // sufficient guidance."
  if (trimmed.length > MAX_BARE_QUESTION_CHARACTERS) return false;
  return isGenericSocraticOnlySentence(trimmed) || trimmed.endsWith("?");
}

/** Shown to the student on a genuine provider/parsing failure (status FAILED) — distinct wording from the fallback above, since nothing was actually generated at all, safe/degraded or otherwise. */
export const AI_ASSISTANCE_UNAVAILABLE_MESSAGE =
  "The brainstorming assistant is temporarily unavailable. Please try again shortly.";

// ---------------------------------------------------------------------------
// Provider payload bounds (Part 9) — server-side, never relies on the
// model following an instruction or on the browser truncating anything.
// ---------------------------------------------------------------------------

/** Hard ceiling on hidden reference material (Question.correctAnswer text) sent to the verifier — lecturer-authored free text has no length limit enforced elsewhere in this app. */
export const MAX_HIDDEN_REFERENCE_CHARACTERS = 2_000;

export function boundedHiddenReference(text: string | null | undefined): string | null {
  if (!text) return null;
  return text.length > MAX_HIDDEN_REFERENCE_CHARACTERS ? text.slice(0, MAX_HIDDEN_REFERENCE_CHARACTERS) : text;
}

/**
 * Server-side response-length enforcement (Part 9) — checked AFTER
 * verification, never before (a too-long response might otherwise still
 * be safe content-wise, but must never be truncated — truncation can
 * change meaning, e.g. cut off a "but you should NOT do X" qualifier).
 * The caller (aiAssistanceRunner.ts) treats a too-long verified response
 * exactly like a failed verification: retry once, then the deterministic
 * fallback. Never truncated and returned.
 */
export function isApprovedResponseLengthValid(
  response: string,
  policy: Pick<AiAssistancePolicy, "maxResponseCharacters">,
): boolean {
  return response.length > 0 && response.length <= policy.maxResponseCharacters;
}
