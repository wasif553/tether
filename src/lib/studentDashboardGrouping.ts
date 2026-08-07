/**
 * Pilot UI release readiness v1 — see
 * docs/tether-v1.7.2-pilot-release-readiness.md. Pure, dependency-free
 * derivation of which dashboard section a student's exam belongs in.
 * Deliberately the SINGLE source of truth for this decision — both
 * src/app/api/exams/available/route.ts (server-side history capping) and
 * src/app/student/page.tsx (client-side section grouping) import from
 * here, so the two can never silently drift apart (e.g. the server
 * capping a "closed" exam the client still thinks is actionable).
 *
 * Uses only fields the API already computes — no new lifecycle
 * semantics invented. Mirrors the dashboard's own pre-existing
 * start/continue button gating exactly: an exam is only ever
 * "actionable" here if the existing UI would actually offer a
 * start/continue action for it.
 */

export type StudentDashboardExamLike = {
  availability: "open" | "upcoming" | "closed";
  canStartAttempt: boolean;
  submission: { status: "IN_PROGRESS" | "SUBMITTED" | "GRADED" } | null;
};

export type StudentDashboardGroup = "actionRequired" | "availableNow" | "upcoming" | "completed";

export function studentDashboardGroup(exam: StudentDashboardExamLike): StudentDashboardGroup {
  if (exam.submission?.status === "IN_PROGRESS") return "actionRequired";
  if (exam.availability === "open" && exam.canStartAttempt) return "availableNow";
  if (exam.availability === "upcoming") return "upcoming";
  return "completed";
}

/** True for anything with no further student action possible — the "history" tail that gets capped server-side and shown as Recently Completed / Exam History client-side. */
export function isStudentHistoryItem(exam: StudentDashboardExamLike): boolean {
  return studentDashboardGroup(exam) === "completed";
}
