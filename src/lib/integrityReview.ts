/**
 * Evidence Review Workflow v1 — pure status/label/summary module. See
 * docs/evidence-review-workflow-v1.md.
 *
 * Pure, dependency-free: no Prisma, no Next.js. Every status here is a
 * REVIEW SIGNAL for a human lecturer — never an automatic misconduct
 * finding, never a grade input, never a block on marks release.
 */

export const EVIDENCE_REVIEW_STATUSES = [
  "NEEDS_REVIEW",
  "REVIEWED_NO_CONCERN",
  "REVIEWED_CONCERN_REMAINS",
  "ESCALATED",
  "RESOLVED",
] as const;
export type EvidenceReviewStatus = (typeof EVIDENCE_REVIEW_STATUSES)[number];

export function isValidEvidenceReviewStatus(value: string): value is EvidenceReviewStatus {
  return (EVIDENCE_REVIEW_STATUSES as readonly string[]).includes(value);
}

/** Required exact wording — see the task's "Required wording" list. Never "Cheating detected"/"Proof of misconduct"/"Guilty". */
export const EVIDENCE_REVIEW_STATUS_LABELS: Record<EvidenceReviewStatus, string> = {
  NEEDS_REVIEW: "Needs review",
  REVIEWED_NO_CONCERN: "Reviewed — no concern",
  REVIEWED_CONCERN_REMAINS: "Reviewed — concern remains",
  ESCALATED: "Escalated",
  RESOLVED: "Resolved",
};

export const INTEGRITY_COMMENT_TYPES = ["REVIEWER_COMMENT", "LECTURER_COMMENT", "MARKER_COMMENT", "DECISION_NOTE"] as const;
export type IntegrityCommentType = (typeof INTEGRITY_COMMENT_TYPES)[number];

/**
 * Derives comment author role/type SERVER-SIDE from the authenticated
 * session role only — never accepts a role or commentType from the
 * client. This app has no separate marker role/assignment (see
 * prisma/schema.prisma's Role enum), so PLATFORM_ADMIN falls back to the
 * generic REVIEWER_COMMENT rather than inventing a MARKER identity;
 * LECTURER is a real, existing role, so it gets its own comment type.
 */
export function deriveCommentAuthorRoleAndType(
  sessionRole: "LECTURER" | "PLATFORM_ADMIN",
): { authorRole: "LECTURER" | "PLATFORM_ADMIN"; commentType: "LECTURER_COMMENT" | "REVIEWER_COMMENT" } {
  return sessionRole === "LECTURER"
    ? { authorRole: "LECTURER", commentType: "LECTURER_COMMENT" }
    : { authorRole: "PLATFORM_ADMIN", commentType: "REVIEWER_COMMENT" };
}

// ---------------------------------------------------------------------------
// Part 14 — submission-level review summary
// ---------------------------------------------------------------------------

export type SubmissionReviewSummaryInput = {
  /** One entry per reviewable IntegrityEvent recorded on this submission. */
  eventStatuses: EvidenceReviewStatus[];
  evidenceFrameCount: number;
  lastReviewActivityAt: string | null;
  lastReviewerName: string | null;
  /**
   * Only true when a lecturer has taken an explicit, separate
   * "close this submission's review" action — never derived merely
   * because every individual event happens to be RESOLVED (Part 14:
   * "Do not mark the entire submission resolved because one event was
   * resolved"). No route in v1 sets this; reserved for a future explicit
   * close-out action.
   */
  submissionReviewExplicitlyClosed?: boolean;
};

export type SubmissionReviewSummary = {
  overallReviewStatus: EvidenceReviewStatus;
  needsReviewCount: number;
  reviewedNoConcernCount: number;
  concernRemainsCount: number;
  escalatedCount: number;
  resolvedCount: number;
  evidenceFrameCount: number;
  lastReviewActivityAt: string | null;
  lastReviewer: string | null;
};

export function computeSubmissionReviewSummary(input: SubmissionReviewSummaryInput): SubmissionReviewSummary {
  const counts = {
    needsReviewCount: 0,
    reviewedNoConcernCount: 0,
    concernRemainsCount: 0,
    escalatedCount: 0,
    resolvedCount: 0,
  };
  for (const status of input.eventStatuses) {
    switch (status) {
      case "NEEDS_REVIEW":
        counts.needsReviewCount++;
        break;
      case "REVIEWED_NO_CONCERN":
        counts.reviewedNoConcernCount++;
        break;
      case "REVIEWED_CONCERN_REMAINS":
        counts.concernRemainsCount++;
        break;
      case "ESCALATED":
        counts.escalatedCount++;
        break;
      case "RESOLVED":
        counts.resolvedCount++;
        break;
    }
  }

  let overallReviewStatus: EvidenceReviewStatus;
  if (input.submissionReviewExplicitlyClosed) {
    overallReviewStatus = "RESOLVED";
  } else if (counts.escalatedCount > 0) {
    overallReviewStatus = "ESCALATED";
  } else if (counts.concernRemainsCount > 0) {
    overallReviewStatus = "REVIEWED_CONCERN_REMAINS";
  } else if (counts.needsReviewCount > 0) {
    overallReviewStatus = "NEEDS_REVIEW";
  } else {
    // Every event is either REVIEWED_NO_CONCERN or (individually)
    // RESOLVED, or there are no reviewable events at all — none of
    // those states, individually or combined, imply the whole
    // submission's review is closed.
    overallReviewStatus = "REVIEWED_NO_CONCERN";
  }

  return {
    overallReviewStatus,
    ...counts,
    evidenceFrameCount: input.evidenceFrameCount,
    lastReviewActivityAt: input.lastReviewActivityAt,
    lastReviewer: input.lastReviewerName,
  };
}
