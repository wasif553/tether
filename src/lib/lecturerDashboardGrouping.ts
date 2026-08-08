/**
 * Pilot UI release readiness v1 — see
 * docs/tether-v1.7.2-pilot-release-readiness.md. Pure, dependency-free
 * derivation of a lecturer exam's availability status and dashboard
 * section. Single source of truth shared by src/app/api/exams/route.ts
 * (server-side closed-history capping) and src/app/lecturer/page.tsx
 * (client-side section grouping), so the two can never drift apart.
 *
 * Uses only fields that already exist on Exam (`published`,
 * `availableFrom`, `availableUntil`) plus the additive `needsReviewCount`
 * aggregate — no new lifecycle semantics invented, no Exam.status enum.
 */

export type LecturerDashboardExamLike = {
  published: boolean;
  availableFrom: string | Date | null;
  availableUntil: string | Date | null;
  needsReviewCount: number;
};

export type LecturerAvailabilityStatus = "Draft" | "Scheduled" | "Open" | "Closed";

export function lecturerAvailabilityStatus(exam: LecturerDashboardExamLike, now: Date = new Date()): LecturerAvailabilityStatus {
  if (!exam.published) return "Draft";
  if (exam.availableFrom && now < new Date(exam.availableFrom)) return "Scheduled";
  if (exam.availableUntil && now > new Date(exam.availableUntil)) return "Closed";
  return "Open";
}

export type LecturerDashboardGroup = "needsAttention" | "active" | "upcoming" | "draft" | "closed";

/** Mutually exclusive by priority — needsAttention wins regardless of the exam's own availability, since a closed exam can still have an outstanding integrity signal worth reviewing. */
export function lecturerDashboardGroup(exam: LecturerDashboardExamLike, now: Date = new Date()): LecturerDashboardGroup {
  if (exam.needsReviewCount > 0) return "needsAttention";
  const status = lecturerAvailabilityStatus(exam, now);
  if (status === "Open") return "active";
  if (status === "Scheduled") return "upcoming";
  if (status === "Draft") return "draft";
  return "closed";
}

/** True for the "closed" history tail — capped server-side, shown as Recent/Older examinations client-side. Never true for a needs-attention exam, even if it's also closed (still actionable). */
export function isLecturerClosedHistoryItem(exam: LecturerDashboardExamLike, now: Date = new Date()): boolean {
  return exam.needsReviewCount === 0 && lecturerAvailabilityStatus(exam, now) === "Closed";
}
