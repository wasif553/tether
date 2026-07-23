import { describe, it, expect } from "vitest";
import { runCohortCollusionEngine, CohortCollusionCohortTooLargeError, type CohortCollusionEngineInput } from "./cohortCollusionAnalysis";
import { MAX_COLLUSION_ANALYSIS_SUBMISSIONS } from "./cohortCollusionThresholds";

function emptyInput(submissions: Array<{ id: string; studentId: string }>): CohortCollusionEngineInput {
  return {
    submissions,
    effectiveQuestionIdsBySubmission: new Map(),
    questionsById: new Map(),
    answersBySubmission: new Map(),
    answerContentStatsByQuestion: new Map(),
    wrongAnswerStatsByQuestion: new Map(),
    activityEventsBySubmission: new Map(),
    progressionPointsBySubmission: new Map(),
    mcqEventsBySubmissionQuestion: new Map(),
    networkObservationsBySubmission: new Map(),
    sessionsBySubmission: new Map(),
    priorRecordsByStudentPair: new Map(),
  };
}

describe("runCohortCollusionEngine", () => {
  it("returns INSUFFICIENT_DATA for fewer than 3 submissions", () => {
    const result = runCohortCollusionEngine(emptyInput([{ id: "s1", studentId: "u1" }, { id: "s2", studentId: "u2" }]));
    expect(result.status).toBe("INSUFFICIENT_DATA");
    expect(result.clusters).toHaveLength(0);
    expect(result.overallReviewLevel).toBe("NONE");
  });

  it("throws CohortCollusionCohortTooLargeError above the documented cap", () => {
    const submissions = Array.from({ length: MAX_COLLUSION_ANALYSIS_SUBMISSIONS + 1 }, (_, i) => ({ id: `s${i}`, studentId: `u${i}` }));
    expect(() => runCohortCollusionEngine(emptyInput(submissions))).toThrow(CohortCollusionCohortTooLargeError);
  });

  it("returns COMPLETE with zero clusters when there is no correlated evidence at all", () => {
    const submissions = [
      { id: "s1", studentId: "u1" },
      { id: "s2", studentId: "u2" },
      { id: "s3", studentId: "u3" },
    ];
    const result = runCohortCollusionEngine(emptyInput(submissions));
    expect(result.status).toBe("COMPLETE");
    expect(result.clusterCount).toBe(0);
    expect(result.overallReviewLevel).toBe("NONE");
  });

  it("never mutates its input (pure function guarantee — no Prisma, no side effects)", () => {
    const submissions = [
      { id: "s1", studentId: "u1" },
      { id: "s2", studentId: "u2" },
      { id: "s3", studentId: "u3" },
    ];
    const input = emptyInput(submissions);
    const snapshotBefore = JSON.stringify(input.submissions);
    runCohortCollusionEngine(input);
    expect(JSON.stringify(input.submissions)).toBe(snapshotBefore);
  });
});
