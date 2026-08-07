import { describe, it, expect } from "vitest";
import { studentDashboardGroup, isStudentHistoryItem, type StudentDashboardExamLike } from "./studentDashboardGrouping";

function exam(overrides: Partial<StudentDashboardExamLike> = {}): StudentDashboardExamLike {
  return {
    availability: "open",
    canStartAttempt: true,
    submission: null,
    ...overrides,
  };
}

describe("studentDashboardGroup", () => {
  it("[1] an in-progress submission is always actionRequired, regardless of availability", () => {
    expect(studentDashboardGroup(exam({ submission: { status: "IN_PROGRESS" } }))).toBe("actionRequired");
    expect(studentDashboardGroup(exam({ availability: "closed", submission: { status: "IN_PROGRESS" } }))).toBe("actionRequired");
  });

  it("an open, startable exam with no submission is availableNow", () => {
    expect(studentDashboardGroup(exam({ availability: "open", canStartAttempt: true, submission: null }))).toBe("availableNow");
  });

  it("an open exam with remaining attempts after a SUBMITTED attempt is availableNow, not completed", () => {
    expect(studentDashboardGroup(exam({ availability: "open", canStartAttempt: true, submission: { status: "SUBMITTED" } }))).toBe("availableNow");
  });

  it("[2] an upcoming exam is upcoming", () => {
    expect(studentDashboardGroup(exam({ availability: "upcoming", canStartAttempt: false }))).toBe("upcoming");
  });

  it("a closed exam with a submission is completed, even if canStartAttempt would otherwise be true", () => {
    // canStartAttempt does not itself factor in availability (see the API
    // route's own comment) — a closed exam must still resolve to
    // completed, matching the existing UI's own start-button gating
    // (availability === "open" && canStartAttempt).
    expect(studentDashboardGroup(exam({ availability: "closed", canStartAttempt: true, submission: { status: "SUBMITTED" } }))).toBe("completed");
  });

  it("an open exam with no remaining attempts (canStartAttempt false) and a finalized submission is completed", () => {
    expect(studentDashboardGroup(exam({ availability: "open", canStartAttempt: false, submission: { status: "GRADED" } }))).toBe("completed");
  });

  it("[6] a completed exam never resolves to an actionable group (no inappropriate start CTA)", () => {
    for (const status of ["SUBMITTED", "GRADED"] as const) {
      const group = studentDashboardGroup(exam({ availability: "closed", canStartAttempt: false, submission: { status } }));
      expect(group).not.toBe("actionRequired");
      expect(group).not.toBe("availableNow");
    }
  });
});

describe("isStudentHistoryItem", () => {
  it("matches exactly the 'completed' group", () => {
    const completedExam = exam({ availability: "closed", canStartAttempt: false, submission: { status: "GRADED" } });
    const actionableExam = exam({ availability: "open", canStartAttempt: true });
    expect(isStudentHistoryItem(completedExam)).toBe(true);
    expect(isStudentHistoryItem(actionableExam)).toBe(false);
  });
});
