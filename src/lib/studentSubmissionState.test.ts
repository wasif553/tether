import { describe, it, expect } from "vitest";
import { resolveStudentSubmissionState, isStartableState, hasReadOnlySubmissionView } from "./studentSubmissionState";

describe("resolveStudentSubmissionState", () => {
  it("no submission + exam available -> AVAILABLE_TO_START", () => {
    expect(
      resolveStudentSubmissionState({ submission: null, marksReleased: false, availability: "open", canStartAttempt: true }),
    ).toBe("AVAILABLE_TO_START");
  });

  it("no submission + not startable (e.g. attempts exhausted or closed) -> CLOSED_NO_ATTEMPT", () => {
    expect(
      resolveStudentSubmissionState({ submission: null, marksReleased: false, availability: "open", canStartAttempt: false }),
    ).toBe("CLOSED_NO_ATTEMPT");
    expect(
      resolveStudentSubmissionState({ submission: null, marksReleased: false, availability: "upcoming", canStartAttempt: false }),
    ).toBe("CLOSED_NO_ATTEMPT");
  });

  it("IN_PROGRESS submission -> IN_PROGRESS, regardless of other fields", () => {
    expect(
      resolveStudentSubmissionState({
        submission: { status: "IN_PROGRESS" },
        marksReleased: true,
        availability: "closed",
        canStartAttempt: false,
      }),
    ).toBe("IN_PROGRESS");
  });

  it("SUBMITTED submission -> SUBMITTED_RESULTS_PENDING, never a startable state", () => {
    const state = resolveStudentSubmissionState({
      submission: { status: "SUBMITTED" },
      marksReleased: false,
      availability: "closed",
      canStartAttempt: false,
    });
    expect(state).toBe("SUBMITTED_RESULTS_PENDING");
    expect(isStartableState(state)).toBe(false);
    expect(hasReadOnlySubmissionView(state)).toBe(true);
  });

  it("GRADED + marksReleased false -> GRADED_NOT_RELEASED", () => {
    const state = resolveStudentSubmissionState({
      submission: { status: "GRADED" },
      marksReleased: false,
      availability: "closed",
      canStartAttempt: false,
    });
    expect(state).toBe("GRADED_NOT_RELEASED");
    expect(isStartableState(state)).toBe(false);
  });

  it("GRADED + marksReleased true -> RESULTS_RELEASED", () => {
    const state = resolveStudentSubmissionState({
      submission: { status: "GRADED" },
      marksReleased: true,
      availability: "closed",
      canStartAttempt: false,
    });
    expect(state).toBe("RESULTS_RELEASED");
    expect(isStartableState(state)).toBe(false);
    expect(hasReadOnlySubmissionView(state)).toBe(true);
  });

  it("release is derived ONLY from marksReleased, never inferred from status alone — a GRADED submission with marksReleased omitted-as-false never reads as released", () => {
    const state = resolveStudentSubmissionState({
      submission: { status: "GRADED" },
      marksReleased: false,
      availability: "open",
      canStartAttempt: true,
    });
    expect(state).toBe("GRADED_NOT_RELEASED");
  });
});

describe("isStartableState / hasReadOnlySubmissionView", () => {
  it("only AVAILABLE_TO_START and IN_PROGRESS are ever startable", () => {
    expect(isStartableState("AVAILABLE_TO_START")).toBe(true);
    expect(isStartableState("IN_PROGRESS")).toBe(true);
    expect(isStartableState("SUBMITTED_RESULTS_PENDING")).toBe(false);
    expect(isStartableState("GRADED_NOT_RELEASED")).toBe(false);
    expect(isStartableState("RESULTS_RELEASED")).toBe(false);
    expect(isStartableState("CLOSED_NO_ATTEMPT")).toBe(false);
  });

  it("only the three completed-submission states have a read-only view", () => {
    expect(hasReadOnlySubmissionView("SUBMITTED_RESULTS_PENDING")).toBe(true);
    expect(hasReadOnlySubmissionView("GRADED_NOT_RELEASED")).toBe(true);
    expect(hasReadOnlySubmissionView("RESULTS_RELEASED")).toBe(true);
    expect(hasReadOnlySubmissionView("AVAILABLE_TO_START")).toBe(false);
    expect(hasReadOnlySubmissionView("IN_PROGRESS")).toBe(false);
    expect(hasReadOnlySubmissionView("CLOSED_NO_ATTEMPT")).toBe(false);
  });
});
