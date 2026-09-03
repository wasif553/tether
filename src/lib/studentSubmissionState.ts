/**
 * Fix student completed-submission results flow — see
 * docs/student-released-results-flow-v1.md.
 *
 * Pure, dependency-free student-facing submission state resolver. The
 * ONE place that decides, from Submission.status + exam-level
 * marksReleasedAt + exam availability, what a student should be told and
 * which action (if any) they should be offered — so this decision is
 * never re-derived ad hoc in a component. Deliberately narrower than
 * (and layered on top of, not competing with) studentDashboardGrouping.ts's
 * studentDashboardGroup(), which decides dashboard SECTION placement
 * (actionRequired/availableNow/upcoming/completed); this resolver decides
 * the finer-grained state *within* a completed submission, plus the two
 * "can still start" cases, using the exact same six states the product
 * spec names.
 *
 * Critical invariant (the actual bug this whole feature fixes): SUBMITTED
 * and GRADED are both "this attempt is over" states. Neither one, nor any
 * state derived from them, is ever "startable" — a caller must never use
 * this resolver's output to route toward the exam-start/attempt-taking
 * flow for a submission in one of those statuses.
 */

export type StudentSubmissionState =
  | "AVAILABLE_TO_START"
  | "IN_PROGRESS"
  | "SUBMITTED_RESULTS_PENDING"
  | "GRADED_NOT_RELEASED"
  | "RESULTS_RELEASED"
  | "CLOSED_NO_ATTEMPT";

export type StudentSubmissionStateInput = {
  submission: { status: "IN_PROGRESS" | "SUBMITTED" | "GRADED" } | null;
  /** Exam.marksReleasedAt != null — never inferred from Submission.status alone. */
  marksReleased: boolean;
  availability: "open" | "upcoming" | "closed";
  canStartAttempt: boolean;
};

export function resolveStudentSubmissionState(exam: StudentSubmissionStateInput): StudentSubmissionState {
  if (exam.submission?.status === "IN_PROGRESS") return "IN_PROGRESS";
  if (exam.submission?.status === "SUBMITTED") return "SUBMITTED_RESULTS_PENDING";
  if (exam.submission?.status === "GRADED") return exam.marksReleased ? "RESULTS_RELEASED" : "GRADED_NOT_RELEASED";
  if (exam.availability === "open" && exam.canStartAttempt) return "AVAILABLE_TO_START";
  return "CLOSED_NO_ATTEMPT";
}

/** True for every state where re-entering the exam-start/attempt-taking flow is ever appropriate. False for every completed-submission state, by construction. */
export function isStartableState(state: StudentSubmissionState): boolean {
  return state === "AVAILABLE_TO_START" || state === "IN_PROGRESS";
}

/** True for every state a read-only results/submission page can meaningfully render. */
export function hasReadOnlySubmissionView(state: StudentSubmissionState): boolean {
  return state === "SUBMITTED_RESULTS_PENDING" || state === "GRADED_NOT_RELEASED" || state === "RESULTS_RELEASED";
}

export const STUDENT_SUBMISSION_STATE_LABEL: Record<StudentSubmissionState, string> = {
  AVAILABLE_TO_START: "Upcoming",
  IN_PROGRESS: "In progress",
  SUBMITTED_RESULTS_PENDING: "Submitted",
  GRADED_NOT_RELEASED: "Graded",
  RESULTS_RELEASED: "Results released",
  CLOSED_NO_ATTEMPT: "Closed",
};
