import { describe, expect, it } from "vitest";
import {
  attemptsRemaining,
  canAcceptSubmit,
  canCreateAttempt,
  canStudentViewMarks,
  isFinalizedSubmissionStatus,
  nextAttemptNumber,
  remainingSeconds,
  shouldAutoSubmit,
  shouldRunExamTimer,
  submissionDeadline,
} from "./assessmentLifecycle";

describe("assessment lifecycle timer helpers", () => {
  it("calculates the submission deadline and remaining seconds", () => {
    const startedAt = new Date("2026-01-01T10:00:00.000Z");
    const deadline = submissionDeadline(startedAt, 30);
    expect(deadline.toISOString()).toBe("2026-01-01T10:30:00.000Z");
    expect(remainingSeconds(deadline, new Date("2026-01-01T10:29:10.000Z"))).toBe(50);
    expect(remainingSeconds(deadline, new Date("2026-01-01T10:31:00.000Z"))).toBe(0);
  });

  it("triggers auto-submit only once for an in-progress timed-out exam", () => {
    expect(
      shouldAutoSubmit({
        status: "IN_PROGRESS",
        remainingSecs: 0,
        autoSubmitOnTimerEnd: true,
        alreadyTriggered: false,
        terminal: false,
      }),
    ).toBe(true);
    expect(
      shouldAutoSubmit({
        status: "IN_PROGRESS",
        remainingSecs: 0,
        autoSubmitOnTimerEnd: true,
        alreadyTriggered: true,
        terminal: false,
      }),
    ).toBe(false);
    expect(
      shouldAutoSubmit({
        status: "GRADED",
        remainingSecs: 0,
        autoSubmitOnTimerEnd: true,
        alreadyTriggered: false,
        terminal: false,
      }),
    ).toBe(false);
    expect(
      shouldAutoSubmit({
        status: "IN_PROGRESS",
        remainingSecs: 0,
        autoSubmitOnTimerEnd: true,
        alreadyTriggered: false,
        terminal: true,
      }),
    ).toBe(false);
  });

  it("stops the timer after terminal submit handling", () => {
    expect(shouldRunExamTimer({ status: "IN_PROGRESS", terminal: false })).toBe(true);
    expect(shouldRunExamTimer({ status: "IN_PROGRESS", terminal: true })).toBe(false);
    expect(shouldRunExamTimer({ status: "SUBMITTED", terminal: false })).toBe(false);
    expect(isFinalizedSubmissionStatus("SUBMITTED")).toBe(true);
    expect(isFinalizedSubmissionStatus("GRADED")).toBe(true);
    expect(isFinalizedSubmissionStatus("IN_PROGRESS")).toBe(false);
  });

  it("does not retry auto-submit after a 409 conflict is treated as terminal", () => {
    const terminal = true;
    expect(shouldRunExamTimer({ status: "IN_PROGRESS", terminal })).toBe(false);
    expect(
      shouldAutoSubmit({
        status: "IN_PROGRESS",
        remainingSecs: 0,
        autoSubmitOnTimerEnd: true,
        alreadyTriggered: true,
        terminal,
      }),
    ).toBe(false);
  });

  it("treats already-finalized submit responses as terminal", () => {
    expect(isFinalizedSubmissionStatus("SUBMITTED")).toBe(true);
    expect(shouldRunExamTimer({ status: "SUBMITTED", terminal: true })).toBe(false);
    expect(
      shouldAutoSubmit({
        status: "SUBMITTED",
        remainingSecs: 0,
        autoSubmitOnTimerEnd: true,
        alreadyTriggered: true,
        terminal: true,
      }),
    ).toBe(false);
  });

  it("keeps manual late submissions blocked while accepting configured system auto-submit", () => {
    const deadline = new Date("2026-01-01T10:00:00.000Z");
    const now = new Date("2026-01-01T10:00:01.000Z");
    const settings = { allowLateSubmit: false, autoSubmitOnTimerEnd: true };

    expect(canAcceptSubmit({ now, deadline, settings, systemAutoSubmit: false })).toBe(false);
    expect(canAcceptSubmit({ now, deadline, settings, systemAutoSubmit: true })).toBe(true);
    expect(
      canAcceptSubmit({
        now,
        deadline,
        settings: { allowLateSubmit: false, autoSubmitOnTimerEnd: false },
        systemAutoSubmit: true,
      }),
    ).toBe(false);
  });

  it("allows normal manual submit before the deadline", () => {
    const deadline = new Date("2026-01-01T10:00:00.000Z");
    const now = new Date("2026-01-01T09:59:59.000Z");
    expect(
      canAcceptSubmit({
        now,
        deadline,
        settings: { allowLateSubmit: false, autoSubmitOnTimerEnd: true },
        systemAutoSubmit: false,
      }),
    ).toBe(true);
  });
});

describe("assessment lifecycle attempt helpers", () => {
  it("increments attempt numbers from existing attempts", () => {
    expect(nextAttemptNumber([])).toBe(1);
    expect(nextAttemptNumber([{ attemptNumber: 1 }, { attemptNumber: 3 }])).toBe(4);
  });

  it("enforces remaining attempt count", () => {
    expect(attemptsRemaining({ finalizedAttemptCount: 1, maxAttempts: 3 })).toBe(2);
    expect(canCreateAttempt({ finalizedAttemptCount: 2, maxAttempts: 2 })).toBe(false);
    expect(canCreateAttempt({ finalizedAttemptCount: 1, maxAttempts: 2 })).toBe(true);
  });
});

describe("assessment lifecycle marks release helper", () => {
  it("lets only the owning student see marks after release", () => {
    expect(
      canStudentViewMarks({
        role: "STUDENT",
        isOwner: true,
        marksReleasedAt: "2026-01-01T10:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      canStudentViewMarks({
        role: "STUDENT",
        isOwner: true,
        marksReleasedAt: null,
      }),
    ).toBe(false);
    expect(
      canStudentViewMarks({
        role: "STUDENT",
        isOwner: false,
        marksReleasedAt: "2026-01-01T10:00:00.000Z",
      }),
    ).toBe(false);
  });
});
