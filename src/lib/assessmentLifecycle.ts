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
