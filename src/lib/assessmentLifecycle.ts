import type { SecureExamSettings } from "@/lib/secureExam";

export function submissionDeadline(startedAt: Date, durationMins: number): Date {
  return new Date(startedAt.getTime() + durationMins * 60_000);
}

export function remainingSeconds(deadline: Date, now: Date = new Date()): number {
  return Math.max(0, Math.floor((deadline.getTime() - now.getTime()) / 1000));
}

export function shouldAutoSubmit(params: {
  status: string;
  remainingSecs: number | null;
  autoSubmitOnTimerEnd: boolean;
  alreadyTriggered: boolean;
}): boolean {
  return (
    params.status === "IN_PROGRESS" &&
    params.remainingSecs != null &&
    params.remainingSecs <= 0 &&
    params.autoSubmitOnTimerEnd &&
    !params.alreadyTriggered
  );
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

