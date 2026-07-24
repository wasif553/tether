/**
 * Answer-Development Provenance v1 — pure policy module. See
 * docs/answer-development-provenance-v1.md.
 *
 * Pure, dependency-free, deterministic: no Prisma, no Next.js, no
 * browser APIs. Defines the immutable per-attempt policy snapshot shape
 * (mirroring src/lib/screenSharePolicy.ts / src/lib/aiAssistancePolicy.ts),
 * server-side bounds, and enable/limit decisions. THIS IS PROCESS
 * EVIDENCE, NOT A MISCONDUCT DETECTOR — nothing here computes or
 * contributes to a misconduct/risk score.
 */
import type { SecureExamSettings } from "@/lib/secureExam";
import {
  DEFAULT_ANSWER_VERSION_INTERVAL_SECONDS,
  MIN_ANSWER_VERSION_INTERVAL_SECONDS,
  MAX_ANSWER_VERSION_INTERVAL_SECONDS,
  DEFAULT_ANSWER_VERSION_MINIMUM_CHARACTER_CHANGE,
  MIN_ANSWER_VERSION_MINIMUM_CHARACTER_CHANGE,
  MAX_ANSWER_VERSION_MINIMUM_CHARACTER_CHANGE,
  DEFAULT_ANSWER_VERSION_MAXIMUM_PER_QUESTION,
  MIN_ANSWER_VERSION_MAXIMUM_PER_QUESTION,
  MAX_ANSWER_VERSION_MAXIMUM_PER_QUESTION,
  CHECKPOINT_RATE_LIMIT_MAX_REQUESTS,
  CHECKPOINT_RATE_LIMIT_WINDOW_MS,
  DEVELOPMENT_EVENT_RATE_LIMIT_MAX_REQUESTS,
  DEVELOPMENT_EVENT_RATE_LIMIT_WINDOW_MS,
} from "@/lib/answerDevelopmentThresholds";

export const ANSWER_PROVENANCE_POLICY_VERSION = "v1.0";
/** Bumped only if the snapshot's shape changes in a way old snapshots can't be read as. */
export const ANSWER_PROVENANCE_SNAPSHOT_SCHEMA_VERSION = 1;

export type AnswerProvenanceMode = "OFF" | "BASIC" | "DETAILED";

// ---------------------------------------------------------------------------
// Server-side bounds — the single source of truth other than the matching
// min/max on the zod schema in secureExam.ts (both source their numbers
// from src/lib/answerDevelopmentThresholds.ts). Any lecturer- or client-
// supplied value outside these is clamped, never trusted verbatim.
// ---------------------------------------------------------------------------

export function clampAnswerVersionIntervalSeconds(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_ANSWER_VERSION_INTERVAL_SECONDS;
  return Math.min(MAX_ANSWER_VERSION_INTERVAL_SECONDS, Math.max(MIN_ANSWER_VERSION_INTERVAL_SECONDS, Math.round(value)));
}

export function clampAnswerVersionMinimumCharacterChange(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_ANSWER_VERSION_MINIMUM_CHARACTER_CHANGE;
  return Math.min(
    MAX_ANSWER_VERSION_MINIMUM_CHARACTER_CHANGE,
    Math.max(MIN_ANSWER_VERSION_MINIMUM_CHARACTER_CHANGE, Math.round(value)),
  );
}

export function clampAnswerVersionMaximumPerQuestion(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_ANSWER_VERSION_MAXIMUM_PER_QUESTION;
  return Math.min(MAX_ANSWER_VERSION_MAXIMUM_PER_QUESTION, Math.max(MIN_ANSWER_VERSION_MAXIMUM_PER_QUESTION, Math.round(value)));
}

// ---------------------------------------------------------------------------
// Policy snapshot (Part 1)
// ---------------------------------------------------------------------------

export type AnswerProvenancePolicy = {
  schemaVersion: number;
  policyVersion: string;
  mode: AnswerProvenanceMode;
  versionIntervalSeconds: number;
  versionMinimumCharacterChange: number;
  versionMaximumPerQuestion: number;
  capturePasteMetadata: boolean;
  captureDeletionRewriteMetadata: boolean;
  // Workspace/source-declaration fields are only ever true when mode is
  // DETAILED — see the DETAILED-only gating applied in both
  // buildAnswerProvenancePolicySnapshot and parseAnswerProvenancePolicy
  // below (Part 5: "In addition to BASIC mode, optionally show
  // lecturer-enabled tabs" — these tabs/behaviours do not exist in BASIC).
  enableOutlineWorkspace: boolean;
  enableCalculationWorkspace: boolean;
  enableCodeWorkspace: boolean;
  captureCodeRunHistory: boolean;
  requireAiSourceDeclaration: boolean;
  allowStudentDevelopmentReview: boolean;
  /** ISO-8601 timestamp this snapshot was built — part of the immutable record itself (Part 1), not just implied by Submission.createdAt. */
  createdAt: string;
};

export const DISABLED_ANSWER_PROVENANCE_POLICY: AnswerProvenancePolicy = {
  schemaVersion: ANSWER_PROVENANCE_SNAPSHOT_SCHEMA_VERSION,
  policyVersion: ANSWER_PROVENANCE_POLICY_VERSION,
  mode: "OFF",
  versionIntervalSeconds: DEFAULT_ANSWER_VERSION_INTERVAL_SECONDS,
  versionMinimumCharacterChange: DEFAULT_ANSWER_VERSION_MINIMUM_CHARACTER_CHANGE,
  versionMaximumPerQuestion: 0,
  capturePasteMetadata: false,
  captureDeletionRewriteMetadata: false,
  enableOutlineWorkspace: false,
  enableCalculationWorkspace: false,
  enableCodeWorkspace: false,
  captureCodeRunHistory: false,
  requireAiSourceDeclaration: false,
  allowStudentDevelopmentReview: false,
  createdAt: new Date(0).toISOString(),
};

export type RelevantAnswerProvenanceSettings = Pick<
  SecureExamSettings,
  | "answerProvenanceMode"
  | "answerVersionIntervalSeconds"
  | "answerVersionMinimumCharacterChange"
  | "answerVersionMaximumPerQuestion"
  | "capturePasteMetadata"
  | "captureDeletionRewriteMetadata"
  | "enableOutlineWorkspace"
  | "enableCalculationWorkspace"
  | "enableCodeWorkspace"
  | "captureCodeRunHistory"
  | "requireAiSourceDeclaration"
  | "allowStudentDevelopmentReview"
>;

/** Workspace/source-declaration fields only ever take effect in DETAILED mode — applied identically at build time and at parse time. */
function gateDetailedOnlyFields(
  mode: AnswerProvenanceMode,
  fields: Pick<
    AnswerProvenancePolicy,
    "enableOutlineWorkspace" | "enableCalculationWorkspace" | "enableCodeWorkspace" | "captureCodeRunHistory" | "requireAiSourceDeclaration"
  >,
): Pick<
  AnswerProvenancePolicy,
  "enableOutlineWorkspace" | "enableCalculationWorkspace" | "enableCodeWorkspace" | "captureCodeRunHistory" | "requireAiSourceDeclaration"
> {
  if (mode === "DETAILED") return fields;
  return {
    enableOutlineWorkspace: false,
    enableCalculationWorkspace: false,
    enableCodeWorkspace: false,
    captureCodeRunHistory: false,
    requireAiSourceDeclaration: false,
  };
}

/**
 * Builds the effective policy from CURRENT exam settings. Called once, at
 * attempt start, to produce the immutable snapshot
 * (Submission.answerProvenancePolicySnapshotJson) — never called again
 * for an in-progress attempt; request-time decisions must read the
 * stored snapshot via parseAnswerProvenancePolicy below.
 */
export function buildAnswerProvenancePolicySnapshot(
  settings: RelevantAnswerProvenanceSettings,
  builtAt: Date = new Date(),
): AnswerProvenancePolicy {
  if (settings.answerProvenanceMode === "OFF") {
    return { ...DISABLED_ANSWER_PROVENANCE_POLICY, createdAt: builtAt.toISOString() };
  }
  const detailedOnly = gateDetailedOnlyFields(settings.answerProvenanceMode, {
    enableOutlineWorkspace: settings.enableOutlineWorkspace,
    enableCalculationWorkspace: settings.enableCalculationWorkspace,
    enableCodeWorkspace: settings.enableCodeWorkspace,
    captureCodeRunHistory: settings.captureCodeRunHistory,
    requireAiSourceDeclaration: settings.requireAiSourceDeclaration,
  });
  return {
    schemaVersion: ANSWER_PROVENANCE_SNAPSHOT_SCHEMA_VERSION,
    policyVersion: ANSWER_PROVENANCE_POLICY_VERSION,
    mode: settings.answerProvenanceMode,
    versionIntervalSeconds: clampAnswerVersionIntervalSeconds(settings.answerVersionIntervalSeconds),
    versionMinimumCharacterChange: clampAnswerVersionMinimumCharacterChange(settings.answerVersionMinimumCharacterChange),
    versionMaximumPerQuestion: clampAnswerVersionMaximumPerQuestion(settings.answerVersionMaximumPerQuestion),
    capturePasteMetadata: settings.capturePasteMetadata,
    captureDeletionRewriteMetadata: settings.captureDeletionRewriteMetadata,
    ...detailedOnly,
    allowStudentDevelopmentReview: settings.allowStudentDevelopmentReview,
    createdAt: builtAt.toISOString(),
  };
}

/**
 * Reads back a stored snapshot
 * (Submission.answerProvenancePolicySnapshotJson). A null/malformed/
 * missing snapshot is ALWAYS treated as OFF — never silently active, and
 * never re-derived from the exam's current (possibly since-changed)
 * settings. This is the one function every request-time decision must
 * go through.
 */
export function parseAnswerProvenancePolicy(raw: unknown): AnswerProvenancePolicy {
  if (raw == null || typeof raw !== "object") return { ...DISABLED_ANSWER_PROVENANCE_POLICY };
  const obj = raw as Record<string, unknown>;
  const mode: AnswerProvenanceMode = obj.mode === "DETAILED" ? "DETAILED" : obj.mode === "BASIC" ? "BASIC" : "OFF";
  if (mode === "OFF") return { ...DISABLED_ANSWER_PROVENANCE_POLICY };

  const detailedOnly = gateDetailedOnlyFields(mode, {
    enableOutlineWorkspace: obj.enableOutlineWorkspace === true,
    enableCalculationWorkspace: obj.enableCalculationWorkspace === true,
    enableCodeWorkspace: obj.enableCodeWorkspace === true,
    captureCodeRunHistory: obj.captureCodeRunHistory === true,
    requireAiSourceDeclaration: obj.requireAiSourceDeclaration === true,
  });

  return {
    schemaVersion: typeof obj.schemaVersion === "number" ? obj.schemaVersion : ANSWER_PROVENANCE_SNAPSHOT_SCHEMA_VERSION,
    policyVersion: typeof obj.policyVersion === "string" ? obj.policyVersion : ANSWER_PROVENANCE_POLICY_VERSION,
    mode,
    versionIntervalSeconds: clampAnswerVersionIntervalSeconds(
      typeof obj.versionIntervalSeconds === "number" ? obj.versionIntervalSeconds : DEFAULT_ANSWER_VERSION_INTERVAL_SECONDS,
    ),
    versionMinimumCharacterChange: clampAnswerVersionMinimumCharacterChange(
      typeof obj.versionMinimumCharacterChange === "number"
        ? obj.versionMinimumCharacterChange
        : DEFAULT_ANSWER_VERSION_MINIMUM_CHARACTER_CHANGE,
    ),
    versionMaximumPerQuestion: clampAnswerVersionMaximumPerQuestion(
      typeof obj.versionMaximumPerQuestion === "number" ? obj.versionMaximumPerQuestion : DEFAULT_ANSWER_VERSION_MAXIMUM_PER_QUESTION,
    ),
    capturePasteMetadata: obj.capturePasteMetadata !== false,
    captureDeletionRewriteMetadata: obj.captureDeletionRewriteMetadata !== false,
    ...detailedOnly,
    allowStudentDevelopmentReview: obj.allowStudentDevelopmentReview !== false,
    createdAt: typeof obj.createdAt === "string" ? obj.createdAt : new Date(0).toISOString(),
  };
}

export function isAnswerProvenanceEnabled(policy: Pick<AnswerProvenancePolicy, "mode">): boolean {
  return policy.mode !== "OFF";
}

export function isDetailedProvenanceMode(policy: Pick<AnswerProvenancePolicy, "mode">): boolean {
  return policy.mode === "DETAILED";
}

// ---------------------------------------------------------------------------
// Version-limit / interval decisions (Part 4/6)
// ---------------------------------------------------------------------------

export function hasReachedMaxVersionsForQuestion(
  existingVersionCount: number,
  policy: Pick<AnswerProvenancePolicy, "versionMaximumPerQuestion">,
): boolean {
  return existingVersionCount >= policy.versionMaximumPerQuestion;
}

export function isVersionIntervalElapsed(
  lastCheckpointAtMs: number | null,
  nowMs: number,
  policy: Pick<AnswerProvenancePolicy, "versionIntervalSeconds">,
): boolean {
  if (lastCheckpointAtMs == null) return true;
  return nowMs - lastCheckpointAtMs >= policy.versionIntervalSeconds * 1000;
}

// ---------------------------------------------------------------------------
// Rate limiting (Part 6) — same minimal, DB-timestamp-driven sliding-
// window pattern as src/lib/aiAssistancePolicy.ts / screenSharePolicy.ts.
// ---------------------------------------------------------------------------

export function isWithinCheckpointRateLimit(
  recentRequestTimestampsMs: number[],
  nowMs: number,
  maxRequests: number = CHECKPOINT_RATE_LIMIT_MAX_REQUESTS,
  windowMs: number = CHECKPOINT_RATE_LIMIT_WINDOW_MS,
): boolean {
  const cutoff = nowMs - windowMs;
  return recentRequestTimestampsMs.filter((t) => t >= cutoff).length < maxRequests;
}

export function isWithinDevelopmentEventRateLimit(
  recentRequestTimestampsMs: number[],
  nowMs: number,
  maxRequests: number = DEVELOPMENT_EVENT_RATE_LIMIT_MAX_REQUESTS,
  windowMs: number = DEVELOPMENT_EVENT_RATE_LIMIT_WINDOW_MS,
): boolean {
  const cutoff = nowMs - windowMs;
  return recentRequestTimestampsMs.filter((t) => t >= cutoff).length < maxRequests;
}
