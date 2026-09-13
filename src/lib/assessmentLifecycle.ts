import type { SecureExamSettings } from "@/lib/secureExam";

export function submissionDeadline(startedAt: Date, durationMins: number): Date {
  return new Date(startedAt.getTime() + durationMins * 60_000);
}

/**
 * Freeze timing policy for active exam attempts — the timing-critical
 * subset of an attempt's immutable policy snapshot (see `timingPolicy` on
 * `ExamPolicySnapshot` in examPolicy.ts, captured once by
 * buildExamPolicySnapshot at POST /api/exams/[id]/start). Before this
 * existed, every reader of "is this submission still within its deadline"
 * (the submit route, the answers autosave route, the submissions GET
 * route, and the device-revocation guard) read `Exam.durationMins` /
 * `Exam.secureSettings` LIVE — meaning a lecturer editing duration,
 * allowLateSubmit, or autoSubmitOnTimerEnd on a published exam silently
 * changed the deadline/late-submit rules for every attempt already in
 * progress, including ones a student is actively taking. There was no
 * restriction anywhere (PATCH /api/exams/[id] has none) preventing this.
 */
export type ExamTimingPolicy = {
  durationMins: number;
  allowLateSubmit: boolean;
  autoSubmitOnTimerEnd: boolean;
};

/**
 * Resolves the AUTHORITATIVE, frozen timing policy for one submission:
 * the stored `examPolicySnapshotJson.timingPolicy` captured once at
 * attempt start, when present. Falls back to the exam's CURRENT
 * durationMins/secureSettings only for a submission whose snapshot
 * predates this field (missing/malformed `timingPolicy`) — the same
 * "null/missing means legacy behaviour, never re-derived from current
 * settings for an attempt that already has its own frozen snapshot"
 * pattern every other per-attempt snapshot in this codebase already uses
 * (examPolicySnapshotJson itself, aiAssistancePolicySnapshotJson,
 * screenSharePolicySnapshotJson, secureClientPolicySnapshotJson, ...).
 * Every attempt started after this was added always has a real
 * `timingPolicy`, so the fallback path is only ever exercised by
 * pre-existing rows. Lecturer edits to Exam.durationMins/secureSettings
 * after an attempt has started NEVER retroactively change what this
 * returns for THAT attempt — see PATCH /api/exams/[id], which applies to
 * future attempts only.
 */
export function resolveSubmissionTimingPolicy(params: {
  examPolicySnapshotJson: unknown;
  currentExamDurationMins: number;
  currentSecureSettings: Pick<SecureExamSettings, "allowLateSubmit" | "autoSubmitOnTimerEnd">;
}): ExamTimingPolicy {
  const raw = params.examPolicySnapshotJson;
  if (raw != null && typeof raw === "object" && "timingPolicy" in raw) {
    const timingPolicy = (raw as { timingPolicy?: unknown }).timingPolicy;
    if (timingPolicy != null && typeof timingPolicy === "object") {
      const candidate = timingPolicy as Record<string, unknown>;
      if (
        typeof candidate.durationMins === "number" &&
        typeof candidate.allowLateSubmit === "boolean" &&
        typeof candidate.autoSubmitOnTimerEnd === "boolean"
      ) {
        return {
          durationMins: candidate.durationMins,
          allowLateSubmit: candidate.allowLateSubmit,
          autoSubmitOnTimerEnd: candidate.autoSubmitOnTimerEnd,
        };
      }
    }
  }
  return {
    durationMins: params.currentExamDurationMins,
    allowLateSubmit: params.currentSecureSettings.allowLateSubmit,
    autoSubmitOnTimerEnd: params.currentSecureSettings.autoSubmitOnTimerEnd,
  };
}

export function remainingSeconds(deadline: Date, now: Date = new Date()): number {
  return Math.max(0, Math.floor((deadline.getTime() - now.getTime()) / 1000));
}

export function shouldAutoSubmit(params: {
  status: string;
  remainingSecs: number | null;
  autoSubmitOnTimerEnd: boolean;
  alreadyTriggered: boolean;
  terminal: boolean;
}): boolean {
  return (
    params.status === "IN_PROGRESS" &&
    params.remainingSecs != null &&
    params.remainingSecs <= 0 &&
    params.autoSubmitOnTimerEnd &&
    !params.alreadyTriggered &&
    !params.terminal
  );
}

export function shouldRunExamTimer(params: {
  status: string;
  terminal: boolean;
}): boolean {
  return params.status === "IN_PROGRESS" && !params.terminal;
}

export function isFinalizedSubmissionStatus(status: string): boolean {
  return status !== "IN_PROGRESS";
}

// ---------------------------------------------------------------------------
// VOIDED-attempt recovery v1 — see docs/voided-submission-recovery-v1.md.
//
// isFinalizedSubmissionStatus above answers exactly one question ("is this
// attempt still actively running right now") and is still correct for its
// existing callers (shouldRunExamTimer/shouldAutoSubmit, both purely about
// whether a live clock applies). It was ALSO being reused, incorrectly, as
// a stand-in for "does this count as a real completed attempt" — which is
// wrong the moment a third, non-active, non-genuine status (VOIDED) exists:
// a voided attempt is not "still running", but it is equally not a genuine
// submitted/graded academic outcome. The predicates below give each of
// those two previously-conflated questions its own name, so a caller can
// never again accidentally answer "did the student really submit/complete
// this" by checking "is it not IN_PROGRESS".
// ---------------------------------------------------------------------------

/** True only while the attempt is genuinely live — the student can still interact with it. */
export function isActiveSubmission(status: string): boolean {
  return status === "IN_PROGRESS";
}

/** True only for a permanently voided attempt — see prisma/schema.prisma's own doc comment on SubmissionStatus.VOIDED for the full invariant list. */
export function isVoidedSubmission(status: string): boolean {
  return status === "VOIDED";
}

/** True for a genuinely finished, real submission — SUBMITTED (awaiting marking) or GRADED. Never true for IN_PROGRESS or VOIDED. */
export function isSubmittedSubmission(status: string): boolean {
  return status === "SUBMITTED" || status === "GRADED";
}

/**
 * Whether this attempt consumes one of the student's maxAttempts slots.
 * Only a genuine SUBMITTED/GRADED outcome does — a VOIDED attempt (by
 * definition, an attempt invalidated for a platform/technical reason
 * outside the student's control) never counts, and an IN_PROGRESS attempt
 * hasn't been decided yet. This is the ONE place POST /api/exams/[id]/start
 * and GET /api/exams/available must read for "how many attempts has this
 * student really used" — never isFinalizedSubmissionStatus.
 */
export function countsTowardAttemptLimit(status: string): boolean {
  return isSubmittedSubmission(status);
}

/**
 * Whether this attempt is a genuine academic outcome — the denominator for
 * completion rate, average/median/pass-rate score calculations, and any
 * "students who submitted" count. Identical to countsTowardAttemptLimit
 * today (both currently mean exactly "SUBMITTED or GRADED"), but kept as a
 * separately-named predicate because the two questions ("does this use up
 * an attempt slot" vs "is this a real result to grade/analyse") are
 * conceptually distinct and could diverge under a future status — callers
 * should read whichever name matches what they're actually asking, not
 * assume they're interchangeable just because they compute the same today.
 */
export function isAcademicAttempt(status: string): boolean {
  return isSubmittedSubmission(status);
}

/** Whether this attempt may still be manually graded or AI-marked. Only a SUBMITTED (not yet graded) row — never IN_PROGRESS, GRADED-again, or VOIDED. */
export function isGradableSubmission(status: string): boolean {
  return status === "SUBMITTED";
}

/**
 * The student-facing attempt ordinal for display — "Attempt X of maxAttempts"
 * — computed from the count of NON-VOIDED attempts up to and including this
 * one, never the raw database attemptNumber. attemptNumber is a permanent,
 * monotonic, audit-honest sequence (see nextAttemptNumber below) that is
 * NEVER renumbered or reused, so after voiding attempt 1 a fresh attempt
 * genuinely is attemptNumber 2 — displaying that raw number next to a
 * maxAttempts of 1 would misleadingly read "Attempt 2 of 1". This function
 * is what a caller should show instead: it counts only real (non-voided)
 * attempts, so the fresh attempt (attemptNumber 2, the first non-voided one)
 * correctly reports ordinal 1.
 */
export function academicAttemptOrdinal(params: {
  attemptNumber: number;
  allAttempts: Array<{ attemptNumber: number; status: string }>;
}): number {
  return params.allAttempts.filter((a) => !isVoidedSubmission(a.status) && a.attemptNumber <= params.attemptNumber).length;
}

export function canAcceptSubmit(params: {
  now: Date;
  deadline: Date;
  settings: Pick<SecureExamSettings, "allowLateSubmit" | "autoSubmitOnTimerEnd">;
  systemAutoSubmit: boolean;
}): boolean {
  if (params.now <= params.deadline) return true;
  if (params.settings.allowLateSubmit) return true;
  return params.systemAutoSubmit && params.settings.autoSubmitOnTimerEnd;
}

export function nextAttemptNumber(attempts: Array<{ attemptNumber: number }>): number {
  return attempts.reduce((max, attempt) => Math.max(max, attempt.attemptNumber), 0) + 1;
}

export function attemptsRemaining(params: {
  finalizedAttemptCount: number;
  maxAttempts: number;
}): number {
  return Math.max(0, params.maxAttempts - params.finalizedAttemptCount);
}

export function canCreateAttempt(params: {
  finalizedAttemptCount: number;
  maxAttempts: number;
}): boolean {
  return attemptsRemaining(params) > 0;
}

export function canStudentViewMarks(params: {
  role: string;
  isOwner: boolean;
  marksReleasedAt: Date | string | null | undefined;
}): boolean {
  return params.role === "STUDENT" && params.isOwner && params.marksReleasedAt != null;
}
