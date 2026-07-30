/**
 * Mandatory Tether Delivery for Final Examinations.
 *
 * Product rule: every examination classified as a final examination must
 * run in Tether Secure Browser. Lecturers may still use Standard Web,
 * Monitored Web, or any other supported delivery mode for quizzes,
 * practice tests, formative assessments, and other non-final exams.
 *
 * Pure, dependency-free: no Prisma, no Next.js, no browser APIs.
 *
 * Reuses the existing Exam.secureSettings JSON column (see
 * src/lib/secureExam.ts) rather than a new Prisma column —
 * "assessment type" is a lecturer-configurable exam setting exactly
 * like deliveryMode/displayPolicy/examMode already stored there, so no
 * schema change or manual SQL migration is needed for this field. (No
 * OTHER suitable existing field represents this: examMode is about
 * permitted resources — closed/open book — not exam stakes/finality; no
 * exam-type/category/tag field exists anywhere in the current model.)
 */
import type { DeliveryMode, DisplayPolicy } from "@/lib/secureClientPolicy";

export const ASSESSMENT_TYPES = ["PRACTICE_OR_FORMATIVE", "QUIZ_OR_TEST", "MID_SEMESTER_EXAMINATION", "FINAL_EXAMINATION"] as const;
export type AssessmentType = (typeof ASSESSMENT_TYPES)[number];
export function isValidAssessmentType(value: string): value is AssessmentType {
  return (ASSESSMENT_TYPES as readonly string[]).includes(value);
}

/**
 * Lecturer-facing labels, in the exact order the setup UI presents them.
 * QUIZ_OR_TEST is the schema default (see secureExam.ts) — the safe,
 * non-disruptive choice for every exam that existed before this feature
 * shipped, since it never retroactively classifies a pre-existing exam
 * as a final examination.
 */
export const ASSESSMENT_TYPE_LABELS: Record<AssessmentType, string> = {
  PRACTICE_OR_FORMATIVE: "Practice or formative assessment",
  QUIZ_OR_TEST: "Quiz or test",
  MID_SEMESTER_EXAMINATION: "Mid-semester examination",
  FINAL_EXAMINATION: "Final examination",
};

/** The single invariant this whole feature exists to establish: assessmentType === FINAL_EXAMINATION implies the mandatory Tether policy below, full stop. */
export function assessmentTypeRequiresMandatoryTetherPolicy(assessmentType: AssessmentType): boolean {
  return assessmentType === "FINAL_EXAMINATION";
}

/**
 * The exact mandatory policy values for a final examination. allowedClientTypes=["TETHER_SECURE_CLIENT"]
 * and requireVerifiedClient=true are NOT listed here because neither is a
 * lecturer-configurable setting — both are already correctly DERIVED from
 * deliveryMode alone by buildSecureClientPolicySnapshot
 * (defaultAllowedClientTypesFor / deliveryModeRequiresSecureClient in
 * secureClientPolicy.ts), so forcing deliveryMode is sufficient to
 * guarantee them too.
 */
export const MANDATORY_FINAL_EXAMINATION_POLICY = {
  deliveryMode: "TETHER_CLIENT_REQUIRED" as DeliveryMode,
  displayPolicy: "SINGLE_DISPLAY_REQUIRED" as DisplayPolicy,
  requireDisplayCheck: true,
  secureClientMaximumDisplays: 1,
} as const;

export type FinalExaminationPolicyFields = {
  deliveryMode: DeliveryMode;
  displayPolicy: DisplayPolicy;
  requireDisplayCheck: boolean;
  secureClientMaximumDisplays: number;
};

/**
 * Normalises delivery/display settings to the mandatory policy whenever
 * assessmentType is FINAL_EXAMINATION — the "automatically normalise
 * during draft save" half of the recommended enforcement approach. A
 * complete no-op for every non-final assessment type, so existing
 * delivery-mode choices for quizzes/practice tests/mid-semester exams
 * are always preserved untouched. Every OTHER secure-exam setting
 * (camera, microphone/fullscreen, integrity evidence, autosave,
 * submission handling) is deliberately outside this function's scope —
 * it touches only the four fields the product rule mandates.
 */
export function applyMandatoryFinalExaminationPolicy<T extends FinalExaminationPolicyFields>(assessmentType: AssessmentType, settings: T): T {
  if (!assessmentTypeRequiresMandatoryTetherPolicy(assessmentType)) return settings;
  return { ...settings, ...MANDATORY_FINAL_EXAMINATION_POLICY };
}

/**
 * The "reject publication only if the final invariant still cannot be
 * established" half of the recommended enforcement approach — the
 * last-resort server-side gate used by the publish path and the student
 * start route. `effectiveDeliveryMode` must already be the
 * AVAILABILITY-RESOLVED value (resolveEffectiveDeliveryMode in
 * secureClientPolicy.ts), never the raw stored settings value, so this
 * correctly fails closed when Tether has become unavailable (e.g. the
 * TETHER_CLIENT_REQUIRED_DISABLED emergency kill switch) even though the
 * stored settings still nominally say TETHER_CLIENT_REQUIRED.
 */
export function isFinalExaminationPolicyEstablished(assessmentType: AssessmentType, effectiveDeliveryMode: DeliveryMode): boolean {
  if (!assessmentTypeRequiresMandatoryTetherPolicy(assessmentType)) return true;
  return effectiveDeliveryMode === "TETHER_CLIENT_REQUIRED";
}
