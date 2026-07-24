/**
 * Answer-Development Provenance v1 — pure checkpoint-decision engine,
 * retention rules, and derived process observations. See
 * docs/answer-development-provenance-v1.md and Parts 4/9/11 of the spec.
 *
 * Pure, dependency-free, deterministic: no Prisma, no Next.js. THIS IS
 * PROCESS EVIDENCE, NOT A MISCONDUCT DETECTOR — every observation here is
 * a descriptive process category ("possible concern", "needs lecturer
 * review"), never a violation label ("AI generated", "copied answer",
 * "cheating", "misconduct"). No observation may automatically alter
 * grades, flag misconduct, require oral verification, or change
 * submission status.
 */
import { z } from "zod";
import { diffAnswerText, type DiffResult } from "@/lib/answerDevelopmentDiff";
import type { AnswerProvenancePolicy } from "@/lib/answerProvenancePolicy";
import {
  MEANINGFUL_TEXT_MIN_NON_WHITESPACE_CHARS,
  LARGE_PASTE_MIN_INSERTED_CHARS,
  SUBSTANTIAL_EDIT_MIN_CHARS_CHANGED,
  SUBSTANTIAL_EDIT_MIN_RATIO,
  LARGE_DELETION_MIN_CHARS_REMOVED,
  LARGE_DELETION_MIN_RATIO,
  MAJOR_REWRITE_MIN_RATIO,
  PASTED_TEXT_SUBSTANTIALLY_REPLACED_MIN_RATIO,
} from "@/lib/answerDevelopmentThresholds";

// ---------------------------------------------------------------------------
// Validated string values (schema stores plain strings, per the
// SubmissionSimilarityAnalysis convention — these arrays are the validators).
// ---------------------------------------------------------------------------

export const CHANGE_TYPES = [
  "INITIAL_TEXT",
  "PERIODIC_CHECKPOINT",
  "SUBSTANTIAL_EDIT",
  "POST_PASTE_CHECKPOINT",
  "PRE_SUBMISSION_CHECKPOINT",
  "FINAL_SUBMISSION",
  "MANUAL_STUDENT_CHECKPOINT",
] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];
export function isValidChangeType(value: string): value is ChangeType {
  return (CHANGE_TYPES as readonly string[]).includes(value);
}

/**
 * Retention tiers (Part 11 hardening) — `answerVersionMaximumPerQuestion`
 * is a REAL, enforced total-storage bound per question, not just a limit
 * on routine periodic checkpoints. Every changeType falls into exactly
 * one tier:
 *
 * - EXEMPT: never suppressed, never counted against the developmental
 *   budget below. INITIAL_TEXT can only ever exist once per question (it
 *   is only created when no prior version exists, so it always fires at
 *   developmentalCount === 0); FINAL_SUBMISSION can only ever exist once
 *   per question (created exactly once, at actual exam submission). Both
 *   are therefore inherently bounded to exactly one row each — "exempt"
 *   does not mean "unbounded," it means "structurally can't repeat."
 * - HIGH priority (preferentially retained): SUBSTANTIAL_EDIT,
 *   POST_PASTE_CHECKPOINT. Allowed up to the full developmental budget.
 * - LOW priority (suppressed first): PERIODIC_CHECKPOINT (covers both
 *   plain periodic AND navigation-triggered checkpoints — both use this
 *   changeType, see decideCheckpoint), MANUAL_STUDENT_CHECKPOINT (manual
 *   checkpoints cannot bypass the limit), PRE_SUBMISSION_CHECKPOINT.
 *   Bounded to a SMALLER sub-budget so low-priority activity can never
 *   crowd out room for high-priority checkpoints.
 *
 * See computeCapacityLimits() for the exact numbers, and
 * shouldSuppressForCapacity() for the decision function.
 */
export const EXEMPT_CHANGE_TYPES: ReadonlySet<ChangeType> = new Set(["INITIAL_TEXT", "FINAL_SUBMISSION"]);
export const HIGH_PRIORITY_CHANGE_TYPES: ReadonlySet<ChangeType> = new Set(["SUBSTANTIAL_EDIT", "POST_PASTE_CHECKPOINT"]);
export const LOW_PRIORITY_CHANGE_TYPES: ReadonlySet<ChangeType> = new Set([
  "PERIODIC_CHECKPOINT",
  "MANUAL_STUDENT_CHECKPOINT",
  "PRE_SUBMISSION_CHECKPOINT",
]);

/** @deprecated kept only as an alias for EXEMPT_CHANGE_TYPES — prefer the tier constants above, which reflect the real (non-bypassable) capacity model. */
export const ALWAYS_PRESERVED_CHANGE_TYPES = EXEMPT_CHANGE_TYPES;

/** At most this fraction of the developmental budget (see computeCapacityLimits) may ever be consumed by LOW-priority change types — guarantees headroom for HIGH-priority checkpoints even under sustained periodic/manual/pre-submission activity. */
export const LOW_PRIORITY_BUDGET_SHARE = 0.5;

export const CHECKPOINT_SOURCES = ["AUTOSAVE", "TIMER", "PASTE", "NAVIGATION", "SUBMISSION", "STUDENT_ACTION"] as const;
export type CheckpointSource = (typeof CHECKPOINT_SOURCES)[number];
export function isValidCheckpointSource(value: string): value is CheckpointSource {
  return (CHECKPOINT_SOURCES as readonly string[]).includes(value);
}

export const DEVELOPMENT_EVENT_TYPES = [
  "FIRST_KEYSTROKE",
  "FIRST_MEANINGFUL_TEXT",
  "SUBSTANTIAL_EDIT",
  "LARGE_DELETION",
  "MAJOR_REWRITE",
  "PASTE_ATTEMPT_BLOCKED",
  "PASTE_INSERTED",
  "PASTED_TEXT_SUBSTANTIALLY_REPLACED",
  "OUTLINE_CREATED",
  "OUTLINE_UPDATED",
  "CALCULATION_WORKING_CREATED",
  "CALCULATION_WORKING_UPDATED",
  "CODE_WORKING_CREATED",
  "CODE_WORKING_UPDATED",
  "CODE_RUN_REQUESTED",
  "CODE_RUN_COMPLETED",
  "CODE_RUN_FAILED",
  "TEST_RUN_COMPLETED",
  "SOURCE_DECLARATION_CREATED",
  "SOURCE_DECLARATION_UPDATED",
  "FINAL_ANSWER_SUBMITTED",
] as const;
export type DevelopmentEventType = (typeof DEVELOPMENT_EVENT_TYPES)[number];
export function isValidDevelopmentEventType(value: string): value is DevelopmentEventType {
  return (DEVELOPMENT_EVENT_TYPES as readonly string[]).includes(value);
}

/** INFORMATIONAL | CONTEXT | REVIEW_CONTEXT — never MISCONDUCT/VIOLATION. No event is itself labelled misconduct (Part 2). */
export const EVENT_LEVELS = ["INFORMATIONAL", "CONTEXT", "REVIEW_CONTEXT"] as const;
export type EventLevel = (typeof EVENT_LEVELS)[number];
export function isValidEventLevel(value: string): value is EventLevel {
  return (EVENT_LEVELS as readonly string[]).includes(value);
}

/** Default event level for each event type — REVIEW_CONTEXT only for the paste/rewrite-pattern events that a lecturer timeline highlights; everything else is routine. */
export const DEFAULT_EVENT_LEVEL_FOR_TYPE: Record<DevelopmentEventType, EventLevel> = {
  FIRST_KEYSTROKE: "INFORMATIONAL",
  FIRST_MEANINGFUL_TEXT: "INFORMATIONAL",
  SUBSTANTIAL_EDIT: "CONTEXT",
  LARGE_DELETION: "CONTEXT",
  MAJOR_REWRITE: "REVIEW_CONTEXT",
  PASTE_ATTEMPT_BLOCKED: "INFORMATIONAL",
  PASTE_INSERTED: "CONTEXT",
  PASTED_TEXT_SUBSTANTIALLY_REPLACED: "REVIEW_CONTEXT",
  OUTLINE_CREATED: "INFORMATIONAL",
  OUTLINE_UPDATED: "INFORMATIONAL",
  CALCULATION_WORKING_CREATED: "INFORMATIONAL",
  CALCULATION_WORKING_UPDATED: "INFORMATIONAL",
  CODE_WORKING_CREATED: "INFORMATIONAL",
  CODE_WORKING_UPDATED: "INFORMATIONAL",
  CODE_RUN_REQUESTED: "INFORMATIONAL",
  CODE_RUN_COMPLETED: "INFORMATIONAL",
  CODE_RUN_FAILED: "INFORMATIONAL",
  TEST_RUN_COMPLETED: "INFORMATIONAL",
  SOURCE_DECLARATION_CREATED: "CONTEXT",
  SOURCE_DECLARATION_UPDATED: "CONTEXT",
  FINAL_ANSWER_SUBMITTED: "INFORMATIONAL",
};

// ---------------------------------------------------------------------------
// Discriminated event-metadata schemas (Part 4 privacy hardening) — each
// event type has its OWN strict schema, not arbitrary JSON. `.strict()`
// rejects any unrecognised key outright, so a client can never smuggle a
// raw clipboard-text field, keystroke sequence, or any other field a
// given event type was never meant to carry. In particular:
// PASTE_ATTEMPT_BLOCKED and PASTE_INSERTED both only ever accept small
// numeric counts (never text); FIRST_KEYSTROKE accepts NO fields at all
// (Part 3 — "capture first-keystroke as a timestamp only," and the
// timestamp itself is always serverReceivedAt, never client-supplied
// metadata).
// ---------------------------------------------------------------------------

const emptyMetadataSchema = z.object({}).strict();
const versionedMetadataSchema = z.object({ version: z.number().int().positive().optional() }).strict();
const exitStatusMetadataSchema = z.object({ exitStatus: z.string().max(50).optional() }).strict();

export const DEVELOPMENT_EVENT_METADATA_SCHEMAS: Record<DevelopmentEventType, z.ZodTypeAny> = {
  FIRST_KEYSTROKE: emptyMetadataSchema,
  FIRST_MEANINGFUL_TEXT: emptyMetadataSchema,
  SUBSTANTIAL_EDIT: z
    .object({ charactersAdded: z.number().int().nonnegative().optional(), charactersRemoved: z.number().int().nonnegative().optional() })
    .strict(),
  LARGE_DELETION: z.object({ charactersRemoved: z.number().int().nonnegative().optional() }).strict(),
  MAJOR_REWRITE: z.object({ replacedRatio: z.number().min(0).max(1).optional() }).strict(),
  // Deliberately NO text/content field of any kind — a blocked paste
  // never stores clipboard contents (Part 3).
  PASTE_ATTEMPT_BLOCKED: z.object({ attemptedInsertedChars: z.number().int().nonnegative().optional() }).strict(),
  // Only size/count metadata — the actual inserted text is never stored
  // here (it lives, naturally, in the resulting AnswerDevelopmentVersion
  // checkpoint text, never duplicated into event metadata).
  PASTE_INSERTED: z
    .object({
      insertedChars: z.number().int().nonnegative(),
      replacedSelectionLength: z.number().int().nonnegative().optional(),
      resultingLength: z.number().int().nonnegative().optional(),
    })
    .strict(),
  PASTED_TEXT_SUBSTANTIALLY_REPLACED: z
    .object({ pastedLength: z.number().int().nonnegative().optional(), replacedRatio: z.number().min(0).max(1).optional() })
    .strict(),
  OUTLINE_CREATED: emptyMetadataSchema,
  OUTLINE_UPDATED: versionedMetadataSchema,
  CALCULATION_WORKING_CREATED: emptyMetadataSchema,
  CALCULATION_WORKING_UPDATED: versionedMetadataSchema,
  CODE_WORKING_CREATED: emptyMetadataSchema,
  CODE_WORKING_UPDATED: versionedMetadataSchema,
  CODE_RUN_REQUESTED: exitStatusMetadataSchema,
  CODE_RUN_COMPLETED: exitStatusMetadataSchema,
  CODE_RUN_FAILED: exitStatusMetadataSchema,
  TEST_RUN_COMPLETED: z
    .object({ testsRun: z.number().int().nonnegative().optional(), testsPassed: z.number().int().nonnegative().optional() })
    .strict(),
  SOURCE_DECLARATION_CREATED: z.object({ artifactType: z.string().max(50).optional(), version: z.number().int().positive().optional() }).strict(),
  SOURCE_DECLARATION_UPDATED: z.object({ artifactType: z.string().max(50).optional(), version: z.number().int().positive().optional() }).strict(),
  FINAL_ANSWER_SUBMITTED: z.object({ finalCheckpointOutcome: z.string().max(50).optional() }).strict(),
};

export type DevelopmentEventMetadataValidation =
  | { success: true; data: Record<string, unknown> }
  | { success: false; error: string };

/**
 * The one place event metadata is ever validated against its event
 * type's own discriminated strict schema — called from BOTH the event
 * route (primary enforcement, rejects with 400) and, defensively, the
 * runner itself (never trusts a single application-level check alone).
 */
export function validateDevelopmentEventMetadata(eventType: DevelopmentEventType, metadata: unknown): DevelopmentEventMetadataValidation {
  const schema = DEVELOPMENT_EVENT_METADATA_SCHEMAS[eventType];
  const result = schema.safeParse(metadata ?? {});
  if (!result.success) {
    return { success: false, error: result.error.issues.map((i) => i.message).join("; ") };
  }
  return { success: true, data: result.data as Record<string, unknown> };
}

export const ARTIFACT_TYPES = ["OUTLINE", "CALCULATION_WORKING", "CODE_WORKING", "AI_SOURCE_DECLARATION", "GENERAL_SOURCE_DECLARATION"] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];
export function isValidArtifactType(value: string): value is ArtifactType {
  return (ARTIFACT_TYPES as readonly string[]).includes(value);
}
/** Artifact types that are attempt-level (Submission-scoped), not tied to any single question — see prisma/schema.prisma AnswerDevelopmentArtifact comment. */
export const ATTEMPT_LEVEL_ARTIFACT_TYPES: ReadonlySet<ArtifactType> = new Set(["AI_SOURCE_DECLARATION", "GENERAL_SOURCE_DECLARATION"]);

// ---------------------------------------------------------------------------
// Meaningful-text / change classification (Part 4)
// ---------------------------------------------------------------------------

export function nonWhitespaceLength(text: string): number {
  return text.replace(/\s+/g, "").length;
}

export function isMeaningfulText(text: string): boolean {
  return nonWhitespaceLength(text) >= MEANINGFUL_TEXT_MIN_NON_WHITESPACE_CHARS;
}

export function isLargePaste(insertedChars: number): boolean {
  return insertedChars >= LARGE_PASTE_MIN_INSERTED_CHARS;
}

/** Normalises purely for the "is this actually different" comparison (whitespace-insensitive) — never used for what gets STORED, which is always the verbatim responseText. */
export function normalizeForChangeComparison(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export type ChangeClassification = {
  isSubstantialEdit: boolean;
  isLargeDeletion: boolean;
  isMajorRewrite: boolean;
};

/** Classifies a diff against the centralised thresholds — descriptive categories, never a risk score (Part 4). */
export function classifyChange(diff: Pick<DiffResult, "charactersAdded" | "charactersRemoved" | "changeRatio" | "removedRatio">): ChangeClassification {
  return {
    isSubstantialEdit:
      diff.charactersAdded + diff.charactersRemoved >= SUBSTANTIAL_EDIT_MIN_CHARS_CHANGED || diff.changeRatio >= SUBSTANTIAL_EDIT_MIN_RATIO,
    isLargeDeletion: diff.charactersRemoved >= LARGE_DELETION_MIN_CHARS_REMOVED || diff.removedRatio >= LARGE_DELETION_MIN_RATIO,
    isMajorRewrite: diff.removedRatio >= MAJOR_REWRITE_MIN_RATIO,
  };
}

export function isPastedTextSubstantiallyReplaced(replacedRatio: number): boolean {
  return replacedRatio >= PASTED_TEXT_SUBSTANTIALLY_REPLACED_MIN_RATIO;
}

// ---------------------------------------------------------------------------
// Checkpoint decision (Part 4) — the single function every checkpoint-
// creating code path must go through. Diffing happens once per call, at
// the checkpoint boundary, never per keystroke.
// ---------------------------------------------------------------------------

export type CheckpointDecisionInput = {
  /** Null/empty means no prior checkpoint exists for this question yet. */
  priorText: string | null;
  currentText: string;
  policy: Pick<AnswerProvenancePolicy, "versionIntervalSeconds" | "versionMinimumCharacterChange">;
  requestedSource: CheckpointSource;
  /** Server-timestamp of the most recent checkpoint for this question, or null if none. */
  lastCheckpointAtMs: number | null;
  nowMs: number;
  /** Only meaningful when requestedSource === "PASTE" — characters inserted by this specific paste action. */
  pasteInsertedChars?: number;
  isFinalSubmission?: boolean;
  isManualCheckpoint?: boolean;
};

export type CheckpointDecision = {
  shouldCreate: boolean;
  changeType: ChangeType | null;
  diff: DiffResult;
  classification: ChangeClassification;
  reasonCode: string;
};

export function decideCheckpoint(input: CheckpointDecisionInput): CheckpointDecision {
  const priorText = input.priorText ?? "";
  const diff = diffAnswerText(priorText, input.currentText);
  const classification = classifyChange(diff);
  const unchanged = normalizeForChangeComparison(priorText) === normalizeForChangeComparison(input.currentText);

  // Final submission ALWAYS produces a checkpoint (Part 4 rule 8, Part 2
  // "always preserve ... FINAL_SUBMISSION") — even if nothing changed
  // since the last checkpoint, so a lecturer always has a definitive
  // "this is what was submitted" row.
  if (input.isFinalSubmission) {
    return { shouldCreate: true, changeType: "FINAL_SUBMISSION", diff, classification, reasonCode: "FINAL_SUBMISSION" };
  }

  if (unchanged) {
    return { shouldCreate: false, changeType: null, diff, classification, reasonCode: "UNCHANGED" };
  }

  const priorExists = priorText.trim().length > 0;
  if (!priorExists) {
    if (!isMeaningfulText(input.currentText)) {
      return { shouldCreate: false, changeType: null, diff, classification, reasonCode: "NOT_YET_MEANINGFUL" };
    }
    return { shouldCreate: true, changeType: "INITIAL_TEXT", diff, classification, reasonCode: "FIRST_MEANINGFUL_TEXT" };
  }

  if (input.isManualCheckpoint) {
    return { shouldCreate: true, changeType: "MANUAL_STUDENT_CHECKPOINT", diff, classification, reasonCode: "MANUAL_STUDENT_CHECKPOINT" };
  }

  if (input.requestedSource === "PASTE" && isLargePaste(input.pasteInsertedChars ?? diff.charactersAdded)) {
    return { shouldCreate: true, changeType: "POST_PASTE_CHECKPOINT", diff, classification, reasonCode: "LARGE_PASTE" };
  }

  if (classification.isSubstantialEdit) {
    return { shouldCreate: true, changeType: "SUBSTANTIAL_EDIT", diff, classification, reasonCode: "SUBSTANTIAL_EDIT" };
  }

  if (input.requestedSource === "SUBMISSION") {
    return { shouldCreate: true, changeType: "PRE_SUBMISSION_CHECKPOINT", diff, classification, reasonCode: "PRE_SUBMISSION_CHECKPOINT" };
  }

  if (input.requestedSource === "NAVIGATION") {
    return { shouldCreate: true, changeType: "PERIODIC_CHECKPOINT", diff, classification, reasonCode: "NAVIGATION_AWAY" };
  }

  if (input.requestedSource === "TIMER" || input.requestedSource === "AUTOSAVE") {
    const intervalElapsed =
      input.lastCheckpointAtMs == null || input.nowMs - input.lastCheckpointAtMs >= input.policy.versionIntervalSeconds * 1000;
    const enoughChange = diff.charactersAdded + diff.charactersRemoved >= input.policy.versionMinimumCharacterChange;
    if (intervalElapsed && enoughChange) {
      return { shouldCreate: true, changeType: "PERIODIC_CHECKPOINT", diff, classification, reasonCode: "PERIODIC_INTERVAL" };
    }
  }

  return { shouldCreate: false, changeType: null, diff, classification, reasonCode: "NOT_ENOUGH_CHANGE_YET" };
}

export type CapacityLimits = {
  /** The effective hard maximum for TOTAL developmental (non-exempt) rows for one question — always `versionMaximumPerQuestion - 1`, i.e. the configured maximum MINUS the one slot permanently reserved for the eventual FINAL_SUBMISSION row. */
  developmentalMax: number;
  /** The smaller sub-budget LOW-priority change types (periodic/navigation, manual, pre-submission) are held to — always <= developmentalMax, guaranteeing headroom for HIGH-priority (substantial-edit/paste) checkpoints. */
  lowPriorityMax: number;
};

/**
 * Computes the effective, enforced capacity limits from the policy's
 * configured `versionMaximumPerQuestion` (Part 11 hardening — "clearly
 * document the effective hard maximum and reserved final slot"):
 *
 *   effective hard maximum (total rows ever stored for one question)
 *     = versionMaximumPerQuestion
 *   reserved final slot
 *     = exactly 1 (never consumed by any developmental checkpoint)
 *   developmental budget (INITIAL_TEXT + every non-exempt checkpoint)
 *     = versionMaximumPerQuestion - 1
 *   low-priority sub-budget (periodic/navigation + manual + pre-submission)
 *     = floor(developmental budget * LOW_PRIORITY_BUDGET_SHARE)
 *
 * A question can therefore never accumulate more than
 * `versionMaximumPerQuestion` AnswerDevelopmentVersion rows in total:
 * at most `developmentalMax` developmental rows (INITIAL_TEXT counts as
 * the first of these, consumed naturally at count 0) plus exactly one
 * FINAL_SUBMISSION row, which is always guaranteed room because it is
 * never counted against or blocked by the developmental budget.
 */
export function computeCapacityLimits(policy: Pick<AnswerProvenancePolicy, "versionMaximumPerQuestion">): CapacityLimits {
  const developmentalMax = Math.max(1, policy.versionMaximumPerQuestion - 1);
  const lowPriorityMax = Math.max(1, Math.floor(developmentalMax * LOW_PRIORITY_BUDGET_SHARE));
  return { developmentalMax, lowPriorityMax };
}

export type CapacityCounts = {
  /** Count of existing rows for this question with a non-exempt changeType (i.e. everything except INITIAL_TEXT/FINAL_SUBMISSION). */
  developmentalCount: number;
  /** Count of existing rows for this question with a LOW-priority changeType (subset of developmentalCount). */
  lowPriorityCount: number;
};

/**
 * Part 11 hardening — a REAL, enforced total-storage bound, not just a
 * limit on routine periodic checkpoints:
 *
 * - EXEMPT change types (INITIAL_TEXT, FINAL_SUBMISSION) are never
 *   suppressed — each can only ever occur once per question regardless.
 * - Once `developmentalCount` reaches `developmentalMax`, EVERY
 *   non-exempt changeType is suppressed, including SUBSTANTIAL_EDIT and
 *   POST_PASTE_CHECKPOINT — "repeated paste checkpoints"/"repeated
 *   substantial edits" cannot grow without bound.
 * - Below that hard ceiling, LOW-priority change types (periodic/
 *   navigation, manual, pre-submission — "manual checkpoints cannot
 *   bypass the limit") are ADDITIONALLY capped at the smaller
 *   `lowPriorityMax`, so they are suppressed well before HIGH-priority
 *   checkpoints ever would be — "preferentially retain
 *   POST_PASTE_CHECKPOINT and SUBSTANTIAL_EDIT."
 *
 * Never renumbers or deletes any existing row — this function only ever
 * decides whether a NEW row gets created; a suppressed attempt simply
 * never consumes a version number.
 */
export function shouldSuppressForCapacity(
  changeType: ChangeType,
  counts: CapacityCounts,
  policy: Pick<AnswerProvenancePolicy, "versionMaximumPerQuestion">,
): boolean {
  if (EXEMPT_CHANGE_TYPES.has(changeType)) return false;
  const limits = computeCapacityLimits(policy);
  if (counts.developmentalCount >= limits.developmentalMax) return true;
  if (LOW_PRIORITY_CHANGE_TYPES.has(changeType)) {
    return counts.lowPriorityCount >= limits.lowPriorityMax;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Derived process observations (Part 9) — deterministic, contextual
// descriptions for lecturer review. Never AI-generated/copied-answer/
// cheating/misconduct labels; no observation automatically alters grades,
// flags misconduct, requires oral verification, or changes submission
// status — those remain exclusively human decisions.
// ---------------------------------------------------------------------------

export const OBSERVATION_CODES = [
  "LARGE_PASTE_THEN_REWRITE",
  "LARGE_PASTE_RETAINED",
  "MAJOR_LATE_REWRITE",
  "MINIMAL_DEVELOPMENT_DATA",
  "GRADUAL_DEVELOPMENT",
  "OUTLINE_PRECEDED_FINAL_RESPONSE",
  "WORKING_PRECEDED_FINAL_RESPONSE",
  "MULTIPLE_SUBSTANTIAL_REVISIONS",
  "SOURCE_DECLARATION_PRESENT",
  "SOURCE_DECLARATION_MISSING",
  "CODE_TEST_ITERATION_PRESENT",
] as const;
export type ObservationCode = (typeof OBSERVATION_CODES)[number];

export const OBSERVATION_RECOMMENDATIONS = [
  "NO_IMMEDIATE_ACTION",
  "LECTURER_REVIEW",
  "COMPARE_WITH_SIMILARITY_EVIDENCE",
  "ORAL_VERIFICATION_MAY_ASSIST",
] as const;
export type ObservationRecommendation = (typeof OBSERVATION_RECOMMENDATIONS)[number];

export type ProcessObservation = {
  code: ObservationCode;
  recommendation: ObservationRecommendation;
  explanation: string;
};

export type PasteRetentionSummary = { insertedChars: number; replacedRatio: number | null };

export type ObservationInput = {
  versionCount: number;
  substantialEditCount: number;
  pasteEvents: PasteRetentionSummary[];
  /** True when an outline artifact's createdAt predates first meaningful final-answer text. */
  outlinePrecededFinalResponse: boolean;
  /** True when a calculation/code working artifact's createdAt predates first meaningful final-answer text. */
  workingPrecededFinalResponse: boolean;
  /** True when the largest single change ratio occurred within the final short window before submission. */
  majorLateRewriteRatio: number | null;
  requireAiSourceDeclaration: boolean;
  hasSourceDeclaration: boolean;
  hasCodeTestIteration: boolean;
};

/** Minimum development rows before "gradual development" is a meaningful description rather than noise. */
export const GRADUAL_DEVELOPMENT_MIN_VERSIONS = 4;
export const MULTIPLE_SUBSTANTIAL_REVISIONS_MIN_COUNT = 3;
export const MINIMAL_DEVELOPMENT_DATA_MAX_VERSIONS = 1;

export function computeProcessObservations(input: ObservationInput): ProcessObservation[] {
  const observations: ProcessObservation[] = [];

  if (input.versionCount <= MINIMAL_DEVELOPMENT_DATA_MAX_VERSIONS) {
    observations.push({
      code: "MINIMAL_DEVELOPMENT_DATA",
      recommendation: "NO_IMMEDIATE_ACTION",
      explanation:
        "Little or no intermediate development history was captured for this response. This can result from a late start, connectivity or autosave gaps, or simply a short answer — it is not itself evidence of anything.",
    });
  } else if (input.versionCount >= GRADUAL_DEVELOPMENT_MIN_VERSIONS) {
    observations.push({
      code: "GRADUAL_DEVELOPMENT",
      recommendation: "NO_IMMEDIATE_ACTION",
      explanation: `The response developed across ${input.versionCount} recorded checkpoints.`,
    });
  }

  for (const paste of input.pasteEvents) {
    if (paste.replacedRatio == null) continue;
    if (isPastedTextSubstantiallyReplaced(paste.replacedRatio)) {
      observations.push({
        code: "LARGE_PASTE_THEN_REWRITE",
        recommendation: "NO_IMMEDIATE_ACTION",
        explanation: `A ${paste.insertedChars}-character paste was later substantially rewritten by the student.`,
      });
    } else {
      observations.push({
        code: "LARGE_PASTE_RETAINED",
        recommendation: "COMPARE_WITH_SIMILARITY_EVIDENCE",
        explanation: `A ${paste.insertedChars}-character paste remains largely present in the final response. Pasted material may have a legitimate source (own prior notes, permitted reference material).`,
      });
    }
  }

  if (input.majorLateRewriteRatio != null && input.majorLateRewriteRatio >= MAJOR_REWRITE_MIN_RATIO) {
    observations.push({
      code: "MAJOR_LATE_REWRITE",
      recommendation: "LECTURER_REVIEW",
      explanation: "A large portion of the response was rewritten shortly before submission. Late revisions can have many legitimate explanations, including proofreading or a change of approach.",
    });
  }

  if (input.substantialEditCount >= MULTIPLE_SUBSTANTIAL_REVISIONS_MIN_COUNT) {
    observations.push({
      code: "MULTIPLE_SUBSTANTIAL_REVISIONS",
      recommendation: "NO_IMMEDIATE_ACTION",
      explanation: `${input.substantialEditCount} substantial edits were recorded for this response.`,
    });
  }

  if (input.outlinePrecededFinalResponse) {
    observations.push({
      code: "OUTLINE_PRECEDED_FINAL_RESPONSE",
      recommendation: "NO_IMMEDIATE_ACTION",
      explanation: "An outline was created before the final response text.",
    });
  }
  if (input.workingPrecededFinalResponse) {
    observations.push({
      code: "WORKING_PRECEDED_FINAL_RESPONSE",
      recommendation: "NO_IMMEDIATE_ACTION",
      explanation: "Working (calculation or code) was recorded before the final response text.",
    });
  }

  if (input.hasSourceDeclaration) {
    observations.push({
      code: "SOURCE_DECLARATION_PRESENT",
      recommendation: "NO_IMMEDIATE_ACTION",
      explanation: "A source/AI-use declaration was provided for this attempt.",
    });
  } else if (!input.requireAiSourceDeclaration) {
    // Only surfaced when a declaration was optional — when it was
    // required, the submission route itself blocks finalisation until one
    // exists (Part 5/6), so this code never appears in that case.
    observations.push({
      code: "SOURCE_DECLARATION_MISSING",
      recommendation: "NO_IMMEDIATE_ACTION",
      explanation: "No source/AI-use declaration was provided. A declaration was not required for this exam.",
    });
  }

  if (input.hasCodeTestIteration) {
    observations.push({
      code: "CODE_TEST_ITERATION_PRESENT",
      recommendation: "NO_IMMEDIATE_ACTION",
      explanation: "Iterative code/test activity was recorded for this response.",
    });
  }

  return observations;
}

// ---------------------------------------------------------------------------
// Serialisation helpers (Part 6/8) — a student sees their OWN raw
// checkpoints/events but never derived lecturer-only observations; a
// lecturer sees the full explainable picture but never raw hashes beyond
// what's needed to display change size.
// ---------------------------------------------------------------------------

export type VersionRecordLike = {
  id: string;
  versionNumber: number;
  responseLength: number;
  changeType: string;
  source: string;
  serverReceivedAt: Date | string;
};

/** Student-safe view of their own checkpoints — never exposes lecturer-only derived observations, never a raw hash. */
export function toStudentSafeVersionSummary(v: VersionRecordLike) {
  return {
    id: v.id,
    versionNumber: v.versionNumber,
    responseLength: v.responseLength,
    changeType: v.changeType,
    source: v.source,
    serverReceivedAt: v.serverReceivedAt,
  };
}
