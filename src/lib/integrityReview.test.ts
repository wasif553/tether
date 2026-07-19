/**
 * Evidence Review Workflow v1 — pure tests. See
 * docs/evidence-review-workflow-v1.md and src/lib/integrityReview.ts.
 */
import { describe, expect, it } from "vitest";
import {
  isValidEvidenceReviewStatus,
  EVIDENCE_REVIEW_STATUS_LABELS,
  deriveCommentAuthorRoleAndType,
  computeSubmissionReviewSummary,
} from "./integrityReview";

describe("isValidEvidenceReviewStatus", () => {
  it("accepts the five documented statuses", () => {
    expect(isValidEvidenceReviewStatus("NEEDS_REVIEW")).toBe(true);
    expect(isValidEvidenceReviewStatus("REVIEWED_NO_CONCERN")).toBe(true);
    expect(isValidEvidenceReviewStatus("REVIEWED_CONCERN_REMAINS")).toBe(true);
    expect(isValidEvidenceReviewStatus("ESCALATED")).toBe(true);
    expect(isValidEvidenceReviewStatus("RESOLVED")).toBe(true);
    expect(isValidEvidenceReviewStatus("BOGUS")).toBe(false);
  });
});

describe("required wording", () => {
  it("uses the exact required labels", () => {
    expect(EVIDENCE_REVIEW_STATUS_LABELS.NEEDS_REVIEW).toBe("Needs review");
    expect(EVIDENCE_REVIEW_STATUS_LABELS.REVIEWED_NO_CONCERN).toBe("Reviewed — no concern");
    expect(EVIDENCE_REVIEW_STATUS_LABELS.REVIEWED_CONCERN_REMAINS).toBe("Reviewed — concern remains");
    expect(EVIDENCE_REVIEW_STATUS_LABELS.ESCALATED).toBe("Escalated");
    expect(EVIDENCE_REVIEW_STATUS_LABELS.RESOLVED).toBe("Resolved");
  });
});

describe("7/8. reviewer name and role are server-derived, client cannot impersonate", () => {
  it("LECTURER role maps to LECTURER_COMMENT", () => {
    expect(deriveCommentAuthorRoleAndType("LECTURER")).toEqual({ authorRole: "LECTURER", commentType: "LECTURER_COMMENT" });
  });

  it("PLATFORM_ADMIN role maps to REVIEWER_COMMENT (no marker identity invented)", () => {
    expect(deriveCommentAuthorRoleAndType("PLATFORM_ADMIN")).toEqual({ authorRole: "PLATFORM_ADMIN", commentType: "REVIEWER_COMMENT" });
  });
});

describe("computeSubmissionReviewSummary", () => {
  it("1. defaults to NEEDS_REVIEW overall when a reviewable event needs review", () => {
    const summary = computeSubmissionReviewSummary({
      eventStatuses: ["NEEDS_REVIEW"],
      evidenceFrameCount: 0,
      lastReviewActivityAt: null,
      lastReviewerName: null,
    });
    expect(summary.overallReviewStatus).toBe("NEEDS_REVIEW");
    expect(summary.needsReviewCount).toBe(1);
  });

  it("escalated takes priority over everything else", () => {
    const summary = computeSubmissionReviewSummary({
      eventStatuses: ["NEEDS_REVIEW", "REVIEWED_CONCERN_REMAINS", "ESCALATED"],
      evidenceFrameCount: 2,
      lastReviewActivityAt: "2026-07-18T10:00:00.000Z",
      lastReviewerName: "Dr Jane Smith",
    });
    expect(summary.overallReviewStatus).toBe("ESCALATED");
  });

  it("concern-remains takes priority over needs-review", () => {
    const summary = computeSubmissionReviewSummary({
      eventStatuses: ["NEEDS_REVIEW", "REVIEWED_CONCERN_REMAINS"],
      evidenceFrameCount: 0,
      lastReviewActivityAt: null,
      lastReviewerName: null,
    });
    expect(summary.overallReviewStatus).toBe("REVIEWED_CONCERN_REMAINS");
  });

  it("all reviewed with no concern gives REVIEWED_NO_CONCERN overall", () => {
    const summary = computeSubmissionReviewSummary({
      eventStatuses: ["REVIEWED_NO_CONCERN", "REVIEWED_NO_CONCERN"],
      evidenceFrameCount: 1,
      lastReviewActivityAt: "2026-07-18T10:00:00.000Z",
      lastReviewerName: "Dr Jane Smith",
    });
    expect(summary.overallReviewStatus).toBe("REVIEWED_NO_CONCERN");
  });

  it("does not mark the entire submission resolved because one event was individually resolved", () => {
    const summary = computeSubmissionReviewSummary({
      eventStatuses: ["RESOLVED", "NEEDS_REVIEW"],
      evidenceFrameCount: 0,
      lastReviewActivityAt: null,
      lastReviewerName: null,
    });
    expect(summary.overallReviewStatus).not.toBe("RESOLVED");
    expect(summary.overallReviewStatus).toBe("NEEDS_REVIEW");
  });

  it("every event individually resolved still does not auto-close the submission overall", () => {
    const summary = computeSubmissionReviewSummary({
      eventStatuses: ["RESOLVED", "RESOLVED"],
      evidenceFrameCount: 0,
      lastReviewActivityAt: null,
      lastReviewerName: null,
    });
    expect(summary.overallReviewStatus).not.toBe("RESOLVED");
  });

  it("an explicit whole-submission close sets RESOLVED overall", () => {
    const summary = computeSubmissionReviewSummary({
      eventStatuses: ["REVIEWED_NO_CONCERN"],
      evidenceFrameCount: 0,
      lastReviewActivityAt: null,
      lastReviewerName: null,
      submissionReviewExplicitlyClosed: true,
    });
    expect(summary.overallReviewStatus).toBe("RESOLVED");
  });
});
