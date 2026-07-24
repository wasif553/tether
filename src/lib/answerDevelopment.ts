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

/** Change types that are ALWAYS preserved, never suppressed by the per-question version cap (Part 11) — only PERIODIC_CHECKPOINT is ever capacity-limited. */
export const ALWAYS_PRESERVED_CHANGE_TYPES: ReadonlySet<ChangeType> = new Set([
  "INITIAL_TEXT",
  "SUBSTANTIAL_EDIT",
  "POST_PASTE_CHECKPOINT",
  "PRE_SUBMISSION_CHECKPOINT",
  "FINAL_SUBMISSION",
  "MANUAL_STUDENT_CHECKPOINT",
]);

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

/** Part 11 — capacity rule: ONLY routine periodic checkpoints are ever suppressed by the per-question maximum; every other change type is always preserved (never destructive deletion of existing rows — see docs "Known limitations"). */
export function shouldSuppressForCapacity(
  changeType: ChangeType,
  existingPeriodicCheckpointCount: number,
  policy: Pick<AnswerProvenancePolicy, "versionMaximumPerQuestion">,
): boolean {
  if (ALWAYS_PRESERVED_CHANGE_TYPES.has(changeType)) return false;
  return existingPeriodicCheckpointCount >= policy.versionMaximumPerQuestion;
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
