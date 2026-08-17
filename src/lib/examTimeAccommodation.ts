/**
 * Individual Exam Timing & Accommodations v1 (additive) — see
 * prisma/schema.prisma's ExamTimeAccommodation model and
 * docs/exam-time-accommodations-v1.md.
 *
 * This is the SINGLE SOURCE OF TRUTH for resolving a student's effective
 * exam duration from an optional time accommodation. Pure module — no
 * Prisma, no Next.js (matches src/lib/examPolicy.ts's own convention) —
 * so it is safe to import from both server routes and client components.
 *
 * Resolution happens ONCE, at the moment a NEW attempt starts (see
 * POST /api/exams/[id]/start), and the result is frozen into that
 * attempt's immutable examPolicySnapshotJson.timingPolicy.durationMins —
 * never re-read from here again for that attempt. Editing the standard
 * exam duration, editing an accommodation, or removing an accommodation
 * therefore only ever affects a FUTURE attempt.
 */

export const EXAM_TIME_ACCOMMODATION_MODES = ["PERCENT_EXTRA", "EXTRA_MINUTES", "TOTAL_DURATION"] as const;

export type ExamTimeAccommodationMode = (typeof EXAM_TIME_ACCOMMODATION_MODES)[number];

export const EXAM_TIME_ACCOMMODATION_MODE_LABELS: Record<ExamTimeAccommodationMode, string> = {
  PERCENT_EXTRA: "Percent extra",
  EXTRA_MINUTES: "Extra minutes",
  TOTAL_DURATION: "Custom total duration",
};

export type ExamTimeAccommodationAdjustment = {
  adjustmentMode: ExamTimeAccommodationMode;
  adjustmentValue: number;
};

/**
 * Immutable, frozen-at-attempt-start explainability metadata — answers
 * "what standard duration and accommodation produced this attempt's
 * duration?" without ever needing to re-read the (possibly since
 * changed/removed) ExamTimeAccommodation row. Deliberately data-minimal:
 * no diagnosis, reason, or any health/disability information — see the
 * model's own doc comment in prisma/schema.prisma.
 */
export type ExamTimeAccommodationSnapshot = {
  standardDurationMins: number;
  adjustmentMode: ExamTimeAccommodationMode;
  adjustmentValue: number;
  effectiveDurationMins: number;
};

export class InvalidExamTimeAccommodationError extends Error {}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

export function isValidExamTimeAccommodationMode(value: unknown): value is ExamTimeAccommodationMode {
  return typeof value === "string" && (EXAM_TIME_ACCOMMODATION_MODES as readonly string[]).includes(value);
}

/**
 * Validates a raw (possibly client-supplied) adjustment mode/value pair.
 * Rejects zero, negative, non-integer, non-finite, and unknown-mode
 * input. Throws InvalidExamTimeAccommodationError — callers at an API
 * boundary should catch this and return a 400, exactly like any other
 * Zod validation failure in this codebase.
 */
export function validateExamTimeAccommodationAdjustment(params: {
  adjustmentMode: unknown;
  adjustmentValue: unknown;
}): ExamTimeAccommodationAdjustment {
  if (!isValidExamTimeAccommodationMode(params.adjustmentMode)) {
    throw new InvalidExamTimeAccommodationError(
      `adjustmentMode must be one of ${EXAM_TIME_ACCOMMODATION_MODES.join(", ")}`,
    );
  }
  if (!isPositiveInteger(params.adjustmentValue)) {
    throw new InvalidExamTimeAccommodationError("adjustmentValue must be a positive integer");
  }
  return { adjustmentMode: params.adjustmentMode, adjustmentValue: params.adjustmentValue };
}

/**
 * Resolves the effective exam duration for one student from the exam's
 * standard duration and their (optional) time accommodation.
 *
 * Rules:
 * - No accommodation: effective = standard duration.
 * - PERCENT_EXTRA: effective = ceil(standard * (100 + value) / 100) —
 *   ceil so an approved accommodation is never shortened by rounding.
 * - EXTRA_MINUTES: effective = standard + value.
 * - TOTAL_DURATION: effective = max(standard, value) — an accommodation
 *   must NEVER reduce a student's duration below the standard exam
 *   duration, even if the exam's standard duration was increased after
 *   the accommodation's custom total was set (see
 *   docs/exam-time-accommodations-v1.md, "Why TOTAL_DURATION uses max()").
 *
 * Throws InvalidExamTimeAccommodationError for invalid input (zero/
 * negative/non-integer/non-finite values, unknown mode, or a resolved
 * result that would overflow/not be a finite positive integer) — never
 * silently clamps or guesses.
 */
export function resolveEffectiveExamDurationMins(params: {
  standardDurationMins: number;
  accommodation: ExamTimeAccommodationAdjustment | null;
}): number {
  if (!isPositiveInteger(params.standardDurationMins)) {
    throw new InvalidExamTimeAccommodationError("standardDurationMins must be a positive integer");
  }
  if (!params.accommodation) return params.standardDurationMins;

  const { adjustmentMode, adjustmentValue } = validateExamTimeAccommodationAdjustment(params.accommodation);
  const standard = params.standardDurationMins;

  let effective: number;
  switch (adjustmentMode) {
    case "PERCENT_EXTRA":
      effective = Math.ceil((standard * (100 + adjustmentValue)) / 100);
      break;
    case "EXTRA_MINUTES":
      effective = standard + adjustmentValue;
      break;
    case "TOTAL_DURATION":
      effective = Math.max(standard, adjustmentValue);
      break;
  }

  if (!Number.isFinite(effective) || !Number.isInteger(effective) || effective <= 0 || effective > Number.MAX_SAFE_INTEGER) {
    throw new InvalidExamTimeAccommodationError("Resolved effective duration is not a valid positive integer");
  }
  return effective;
}

/**
 * Builds the optional, backward-compatible snapshot metadata frozen
 * alongside timingPolicy at attempt start. Returns null when there is no
 * accommodation — existing/legacy snapshots without this field (or with
 * it null) continue to work unchanged; nothing reads this field for
 * enforcement, only for audit/explainability.
 */
export function buildExamTimeAccommodationSnapshot(params: {
  standardDurationMins: number;
  accommodation: ExamTimeAccommodationAdjustment | null;
}): ExamTimeAccommodationSnapshot | null {
  if (!params.accommodation) return null;
  const { adjustmentMode, adjustmentValue } = validateExamTimeAccommodationAdjustment(params.accommodation);
  return {
    standardDurationMins: params.standardDurationMins,
    adjustmentMode,
    adjustmentValue,
    effectiveDurationMins: resolveEffectiveExamDurationMins(params),
  };
}
