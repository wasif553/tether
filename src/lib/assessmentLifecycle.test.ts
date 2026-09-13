import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attemptsRemaining,
  canAcceptSubmit,
  canCreateAttempt,
  canStudentViewMarks,
  isFinalizedSubmissionStatus,
  nextAttemptNumber,
  remainingSeconds,
  resolveSubmissionTimingPolicy,
  shouldAutoSubmit,
  shouldRunExamTimer,
  shouldServerBackstopFinalize,
  submissionDeadline,
  isActiveSubmission,
  isVoidedSubmission,
  isSubmittedSubmission,
  countsTowardAttemptLimit,
  isAcademicAttempt,
  isGradableSubmission,
  academicAttemptOrdinal,
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

describe("Auto-submit server-backstop v1 — shouldServerBackstopFinalize", () => {
  const deadline = new Date("2026-01-01T10:00:00.000Z");

  it("A — uses now >= deadline, not now > deadline: eligible at the EXACT deadline instant, not only after it", () => {
    expect(
      shouldServerBackstopFinalize({ status: "IN_PROGRESS", now: new Date(deadline.getTime()), deadline, autoSubmitOnTimerEnd: true }),
    ).toBe(true);
    expect(
      shouldServerBackstopFinalize({ status: "IN_PROGRESS", now: new Date(deadline.getTime() + 1), deadline, autoSubmitOnTimerEnd: true }),
    ).toBe(true);
    expect(
      shouldServerBackstopFinalize({ status: "IN_PROGRESS", now: new Date(deadline.getTime() - 1), deadline, autoSubmitOnTimerEnd: true }),
    ).toBe(false);
  });

  it("M — autoSubmitOnTimerEnd=false is never touched by the backstop, however overdue", () => {
    expect(
      shouldServerBackstopFinalize({
        status: "IN_PROGRESS",
        now: new Date(deadline.getTime() + 365 * 24 * 60 * 60 * 1000),
        deadline,
        autoSubmitOnTimerEnd: false,
      }),
    ).toBe(false);
  });

  it("N — takes no allowLateSubmit parameter at all: allowLateSubmit=true (a human may submit late) can never, by itself, cause the server to auto-finalize on the caller's behalf — only autoSubmitOnTimerEnd governs that", () => {
    // The predicate's own signature proves this structurally (no
    // allowLateSubmit field exists to pass), but this test pins the
    // intended real-world configuration explicitly: an exam that permits
    // late manual submission without ever auto-closing it for the
    // student must never be finalized by this predicate.
    expect(
      shouldServerBackstopFinalize({ status: "IN_PROGRESS", now: new Date(deadline.getTime() + 1), deadline, autoSubmitOnTimerEnd: false }),
    ).toBe(false);
  });

  it("only ever applies to a still-IN_PROGRESS attempt", () => {
    expect(
      shouldServerBackstopFinalize({ status: "SUBMITTED", now: new Date(deadline.getTime() + 1), deadline, autoSubmitOnTimerEnd: true }),
    ).toBe(false);
    expect(
      shouldServerBackstopFinalize({ status: "GRADED", now: new Date(deadline.getTime() + 1), deadline, autoSubmitOnTimerEnd: true }),
    ).toBe(false);
  });
});

describe("Freeze timing policy for active exam attempts — resolveSubmissionTimingPolicy", () => {
  const currentSecureSettings = { allowLateSubmit: true, autoSubmitOnTimerEnd: false };

  it("prefers the frozen snapshot's timingPolicy over the exam's current live settings", () => {
    const result = resolveSubmissionTimingPolicy({
      examPolicySnapshotJson: { timingPolicy: { durationMins: 30, allowLateSubmit: false, autoSubmitOnTimerEnd: true } },
      currentExamDurationMins: 90,
      currentSecureSettings,
    });
    expect(result).toEqual({ durationMins: 30, allowLateSubmit: false, autoSubmitOnTimerEnd: true });
  });

  it("falls back to the exam's current live settings when the snapshot is null (legacy submission, predates this field)", () => {
    const result = resolveSubmissionTimingPolicy({
      examPolicySnapshotJson: null,
      currentExamDurationMins: 90,
      currentSecureSettings,
    });
    expect(result).toEqual({ durationMins: 90, allowLateSubmit: true, autoSubmitOnTimerEnd: false });
  });

  it("falls back when the snapshot exists but has no timingPolicy key at all (an older snapshot shape from before this field was added)", () => {
    const result = resolveSubmissionTimingPolicy({
      examPolicySnapshotJson: { examMode: "CUSTOM" },
      currentExamDurationMins: 90,
      currentSecureSettings,
    });
    expect(result).toEqual({ durationMins: 90, allowLateSubmit: true, autoSubmitOnTimerEnd: false });
  });

  it("falls back when timingPolicy is present but malformed (never trusts a partially-shaped value)", () => {
    const result = resolveSubmissionTimingPolicy({
      examPolicySnapshotJson: { timingPolicy: { durationMins: "not-a-number" } },
      currentExamDurationMins: 90,
      currentSecureSettings,
    });
    expect(result).toEqual({ durationMins: 90, allowLateSubmit: true, autoSubmitOnTimerEnd: false });
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

// ---------------------------------------------------------------------------
// VOIDED-attempt recovery v1 — see docs/voided-submission-recovery-v1.md.
//
// Semantic choice documented here (test item H): isFinalizedSubmissionStatus
// keeps meaning EXACTLY "not currently active" (still correct for
// shouldRunExamTimer/shouldAutoSubmit above — a VOIDED attempt has no live
// clock either, same as SUBMITTED/GRADED). The NEW predicates below answer
// two DIFFERENT questions that used to be conflated with that one:
//   - "does this consume a maxAttempts slot" (countsTowardAttemptLimit) —
//     false for VOIDED, even though isFinalizedSubmissionStatus is true.
//   - "is this a genuine academic result" (isAcademicAttempt) — likewise
//     false for VOIDED.
// A VOIDED attempt genuinely DID start (an operational fact some metrics,
// like analytics.ts's totalStudentsStarted, deliberately still count) but
// is never SUBMITTED/GRADED and never counts toward the limit — these
// tests are what prove VOIDED never silently inherits either behaviour
// merely because "it is not IN_PROGRESS".
// ---------------------------------------------------------------------------
describe("VOIDED-attempt lifecycle predicates", () => {
  it("isActiveSubmission is true only for IN_PROGRESS", () => {
    expect(isActiveSubmission("IN_PROGRESS")).toBe(true);
    expect(isActiveSubmission("SUBMITTED")).toBe(false);
    expect(isActiveSubmission("GRADED")).toBe(false);
    expect(isActiveSubmission("VOIDED")).toBe(false);
  });

  it("isVoidedSubmission is true only for VOIDED", () => {
    expect(isVoidedSubmission("VOIDED")).toBe(true);
    expect(isVoidedSubmission("IN_PROGRESS")).toBe(false);
    expect(isVoidedSubmission("SUBMITTED")).toBe(false);
    expect(isVoidedSubmission("GRADED")).toBe(false);
  });

  it("isSubmittedSubmission is true for SUBMITTED and GRADED, never IN_PROGRESS or VOIDED", () => {
    expect(isSubmittedSubmission("SUBMITTED")).toBe(true);
    expect(isSubmittedSubmission("GRADED")).toBe(true);
    expect(isSubmittedSubmission("IN_PROGRESS")).toBe(false);
    expect(isSubmittedSubmission("VOIDED")).toBe(false);
  });

  it("countsTowardAttemptLimit excludes VOIDED — the exact fix for the maxAttempts=1 + one voided row scenario", () => {
    expect(countsTowardAttemptLimit("SUBMITTED")).toBe(true);
    expect(countsTowardAttemptLimit("GRADED")).toBe(true);
    expect(countsTowardAttemptLimit("IN_PROGRESS")).toBe(false);
    expect(countsTowardAttemptLimit("VOIDED")).toBe(false);
    // Test item 5: maxAttempts=1 + one VOIDED row still permits a fresh attempt.
    const finalizedAttemptCount = [{ status: "VOIDED" }].filter((s) => countsTowardAttemptLimit(s.status)).length;
    expect(finalizedAttemptCount).toBe(0);
    expect(canCreateAttempt({ finalizedAttemptCount, maxAttempts: 1 })).toBe(true);
  });

  it("isAcademicAttempt excludes VOIDED — the genuine-completion denominator for analytics/exports", () => {
    expect(isAcademicAttempt("SUBMITTED")).toBe(true);
    expect(isAcademicAttempt("GRADED")).toBe(true);
    expect(isAcademicAttempt("VOIDED")).toBe(false);
    expect(isAcademicAttempt("IN_PROGRESS")).toBe(false);
  });

  it("isGradableSubmission is true only for SUBMITTED (not yet graded) — never GRADED-again, IN_PROGRESS, or VOIDED", () => {
    expect(isGradableSubmission("SUBMITTED")).toBe(true);
    expect(isGradableSubmission("GRADED")).toBe(false);
    expect(isGradableSubmission("IN_PROGRESS")).toBe(false);
    expect(isGradableSubmission("VOIDED")).toBe(false);
  });

  it("isFinalizedSubmissionStatus (kept for its timer-only callers) is still true for VOIDED — it answers 'is this still active', not 'does this count'", () => {
    expect(isFinalizedSubmissionStatus("VOIDED")).toBe(true);
    expect(shouldRunExamTimer({ status: "VOIDED", terminal: false })).toBe(false);
  });

  describe("academicAttemptOrdinal — the display fix for 'Attempt X of Y' (test items F/G)", () => {
    it("F: raw attemptNumber remains 2 after voiding attempt 1 (never renumbered)", () => {
      const allAttempts = [
        { attemptNumber: 1, status: "VOIDED" },
        { attemptNumber: 2, status: "IN_PROGRESS" },
      ];
      expect(allAttempts[1].attemptNumber).toBe(2); // never renumbered/reused
    });

    it("G: the fresh attempt's ordinal is 1, not 2 — this is what the student UI must render instead of raw attemptNumber, so it never shows 'Attempt 2 of 1'", () => {
      const allAttempts = [
        { attemptNumber: 1, status: "VOIDED" },
        { attemptNumber: 2, status: "IN_PROGRESS" },
      ];
      const ordinal = academicAttemptOrdinal({ attemptNumber: 2, allAttempts });
      expect(ordinal).toBe(1);
      // Exactly the scenario the task named: maxAttempts=1, ordinal 1 of 1 — never "2 of 1".
      expect(`Attempt ${ordinal} of 1`).toBe("Attempt 1 of 1");
      expect(`Attempt ${ordinal} of 1`).not.toBe("Attempt 2 of 1");
    });

    it("the voided attempt itself has ordinal 0 (excluded from its own count)", () => {
      const allAttempts = [
        { attemptNumber: 1, status: "VOIDED" },
        { attemptNumber: 2, status: "IN_PROGRESS" },
      ];
      expect(academicAttemptOrdinal({ attemptNumber: 1, allAttempts })).toBe(0);
    });

    it("with no voided attempts, ordinal equals attemptNumber exactly (no behaviour change for the ordinary case)", () => {
      const allAttempts = [
        { attemptNumber: 1, status: "GRADED" },
        { attemptNumber: 2, status: "IN_PROGRESS" },
      ];
      expect(academicAttemptOrdinal({ attemptNumber: 1, allAttempts })).toBe(1);
      expect(academicAttemptOrdinal({ attemptNumber: 2, allAttempts })).toBe(2);
    });

    it("multiple voided attempts before a fresh one still yield ordinal 1", () => {
      const allAttempts = [
        { attemptNumber: 1, status: "VOIDED" },
        { attemptNumber: 2, status: "VOIDED" },
        { attemptNumber: 3, status: "IN_PROGRESS" },
      ];
      expect(academicAttemptOrdinal({ attemptNumber: 3, allAttempts })).toBe(1);
    });
  });
});

describe("Auto-submit server-backstop v1 — live-client timer fires exactly once at zero (fake timers)", () => {
  // The exam-taking page's own timer effect (src/app/student/exams/[id]/page.tsx)
  // is a giant, deeply-integrated component with no existing render-based
  // test harness anywhere in this file (every existing test there is
  // source-text/structural, by established convention — see e.g. "the
  // submission handler's confirm/review-modal/autosubmit logic is
  // byte-for-byte unchanged from before this pass"). Rather than
  // introduce full component rendering (requiring extensive mocking of
  // window.sesLockdown, camera/getUserMedia, screen share, etc. — a large
  // undertaking disproportionate to what this test needs to prove), this
  // exercises the REAL pure functions that effect's own tick() calls,
  // under REAL fake timers advancing exactly the way setInterval(tick,
  // 1000) does — proving the auto-submit decision fires at the correct
  // instant and only once, which is what actually determines whether the
  // live client auto-submits. page.test.ts's own structural tests
  // separately pin that the component's effect calls exactly these
  // functions in this exact shape.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("mounted with time remaining: does not fire until the tick that first reads remainingSecs===0, then fires exactly once despite further ticks", () => {
    const startedAt = new Date("2026-01-01T10:00:00.000Z");
    vi.setSystemTime(startedAt);
    const deadline = submissionDeadline(startedAt, 1); // 60-second exam

    let autoSubmitCallCount = 0;
    let alreadyTriggered = false;
    const terminal = false;

    const tick = () => {
      const secs = remainingSeconds(deadline, new Date());
      if (secs === 0 && shouldAutoSubmit({ status: "IN_PROGRESS", remainingSecs: secs, autoSubmitOnTimerEnd: true, alreadyTriggered, terminal })) {
        alreadyTriggered = true;
        autoSubmitCallCount += 1;
      }
    };

    // Mirrors the effect's own `tick(); const interval = setInterval(tick, 1000);`.
    tick();
    const interval = setInterval(tick, 1000);

    // 30 seconds in: still time remaining, never fires.
    vi.advanceTimersByTime(30_000);
    expect(autoSubmitCallCount).toBe(0);

    // Crosses the exact deadline instant (60s after start).
    vi.advanceTimersByTime(30_000);
    expect(autoSubmitCallCount).toBe(1);

    // Several more ticks past zero — never fires a second time.
    vi.advanceTimersByTime(5_000);
    expect(autoSubmitCallCount).toBe(1);

    clearInterval(interval);
  });
});
