import { describe, expect, it } from "vitest";
import {
  attemptsRemaining,
  canAcceptSubmit,
  canCreateAttempt,
  canStudentViewMarks,
  nextAttemptNumber,
  remainingSeconds,
  shouldAutoSubmit,
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
      }),
    ).toBe(true);
    expect(
      shouldAutoSubmit({
        status: "IN_PROGRESS",
        remainingSecs: 0,
        autoSubmitOnTimerEnd: true,
        alreadyTriggered: true,
      }),
    ).toBe(false);
    expect(
      shouldAutoSubmit({
        status: "GRADED",
        remainingSecs: 0,
        autoSubmitOnTimerEnd: true,
        alreadyTriggered: false,
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

