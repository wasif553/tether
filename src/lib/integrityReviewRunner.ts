/**
 * Evidence Review Workflow v1 — server-only orchestration. See
 * docs/evidence-review-workflow-v1.md.
 *
 * Touches Prisma, so this must never be imported from a "use client"
 * component. Wires the pure modules (src/lib/examPolicy.ts,
 * src/lib/integrityReview.ts, src/lib/combinedReviewRecommendation.ts)
 * to the database. Every write here is either a lecturer's explicit
 * review decision, a freeform comment, or an audited status-history
 * entry — nothing here ever changes a grade, blocks marks release, or
 * creates an OralVerification record automatically.
 */
import { prisma } from "@/lib/prisma";
import { createPlatformAuditLog } from "@/lib/platformAdmin";
import { labelForEventType } from "@/lib/integrityEventLabels";
import {
  classifyIntegritySignalForPolicy,
  integrityEventPolicyToRecommendationSignal,
  type ExamPolicySnapshot,
  type IntegritySignalForPolicy,
} from "@/lib/examPolicy";
import {
  computeSubmissionReviewSummary,
  deriveCommentAuthorRoleAndType,
  EVIDENCE_REVIEW_STATUS_LABELS,
  isValidEvidenceReviewStatus,
  type EvidenceReviewStatus,
} from "@/lib/integrityReview";
import { calculateCombinedReviewRecommendation, type CombinedSignalInput } from "@/lib/combinedReviewRecommendation";

type ReviewerRole = "LECTURER" | "PLATFORM_ADMIN";

function parseSnapshot(raw: unknown): ExamPolicySnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  return raw as ExamPolicySnapshot;
}

/**
 * Loads a submission's full integrity-review view: the policy snapshot
 * (or explicit "unavailable" for legacy attempts), every integrity
 * event with its policy interpretation, review status, reviewer,
 * comments, and status history, plus a submission-level summary and an
 * explainable recommendation. Never returns evidence storage keys, raw
 * IPs, or session/device hashes — only display-safe fields.
 */
export async function buildIntegrityReview(submissionId: string) {
  const submission = await prisma.submission.findUniqueOrThrow({
    where: { id: submissionId },
    select: {
      id: true,
      status: true,
      examPolicySnapshotJson: true,
      integrityEvents: {
        orderBy: { occurredAt: "desc" },
        include: {
          evidenceAsset: { select: { id: true, contentType: true, byteSize: true, capturedAt: true } },
          reviewedBy: { select: { name: true } },
          resolvedBy: { select: { name: true } },
          comments: {
            orderBy: { createdAt: "asc" },
            include: { author: { select: { name: true } } },
          },
          statusHistory: {
            orderBy: { createdAt: "asc" },
            include: { changedBy: { select: { name: true } } },
          },
        },
      },
    },
  });

  const policySnapshot = parseSnapshot(submission.examPolicySnapshotJson);

  // Occurrence counts per event type across the whole submission — used
  // only to distinguish a single incident from a repeated pattern (Part
  // 9's "repeated focus loss" nuance).
  const occurrenceCounts = new Map<string, number>();
  for (const e of submission.integrityEvents) {
    occurrenceCounts.set(e.eventType, (occurrenceCounts.get(e.eventType) ?? 0) + 1);
  }

  const evidenceSignals: CombinedSignalInput[] = [];
  const events = submission.integrityEvents.map((e) => {
    const signalForPolicy: IntegritySignalForPolicy = {
      eventType: e.eventType,
      severity: e.severity,
      occurrenceCountInSubmission: occurrenceCounts.get(e.eventType) ?? 1,
    };
    const policyInterpretation = classifyIntegritySignalForPolicy(
      signalForPolicy,
      policySnapshot
        ? {
            calculatorAllowed: policySnapshot.calculatorAllowed,
            notesAllowed: policySnapshot.notesAllowed,
            internetAllowed: policySnapshot.internetAllowed,
            aiToolsAllowed: policySnapshot.aiToolsAllowed,
          }
        : null,
    );
    const recSignal = integrityEventPolicyToRecommendationSignal(e.eventType, policyInterpretation);
    if (recSignal) evidenceSignals.push(recSignal);

    const reviewStatus = isValidEvidenceReviewStatus(e.reviewStatus) ? e.reviewStatus : "NEEDS_REVIEW";

    return {
      id: e.id,
      eventType: e.eventType,
      eventLabel: labelForEventType(e.eventType),
      severity: e.severity,
      message: e.message,
      occurredAt: e.occurredAt.toISOString(),
      evidenceFrame: e.evidenceAsset
        ? {
            id: e.evidenceAsset.id,
            contentType: e.evidenceAsset.contentType,
            byteSize: e.evidenceAsset.byteSize,
            capturedAt: e.evidenceAsset.capturedAt.toISOString(),
          }
        : null,
      policyInterpretation,
      reviewStatus,
      reviewStatusLabel: EVIDENCE_REVIEW_STATUS_LABELS[reviewStatus],
      reviewedAt: e.reviewedAt?.toISOString() ?? null,
      reviewedByName: e.reviewedBy?.name ?? null,
      reviewNote: e.reviewNote,
      // Legacy resolve-route fields — preserved, never fabricated, never removed.
      legacyResolvedAt: e.resolvedAt?.toISOString() ?? null,
      legacyResolvedByName: e.resolvedBy?.name ?? null,
      legacyResolutionNote: e.resolutionNote,
      comments: e.comments.map((c) => ({
        id: c.id,
        comment: c.comment,
        authorName: c.author.name,
        authorRole: c.authorRole,
        commentType: c.commentType,
        createdAt: c.createdAt.toISOString(),
      })),
      statusHistory: e.statusHistory.map((h) => ({
        id: h.id,
        fromStatus: h.fromStatus,
        toStatus: h.toStatus,
        changedByName: h.changedBy.name,
        changedByRole: h.changedByRole,
        reason: h.reason,
        createdAt: h.createdAt.toISOString(),
      })),
    };
  });

  const evidenceFrameCount = events.filter((e) => e.evidenceFrame != null).length;

  const lastActivityCandidates: string[] = [];
  for (const e of submission.integrityEvents) {
    if (e.reviewedAt) lastActivityCandidates.push(e.reviewedAt.toISOString());
    for (const c of e.comments) lastActivityCandidates.push(c.createdAt.toISOString());
    for (const h of e.statusHistory) lastActivityCandidates.push(h.createdAt.toISOString());
  }
  lastActivityCandidates.sort();
  const lastReviewActivityAt = lastActivityCandidates.length > 0 ? lastActivityCandidates[lastActivityCandidates.length - 1] : null;
  const lastReviewer =
    [...submission.integrityEvents]
      .filter((e) => e.reviewedAt)
      .sort((a, b) => (a.reviewedAt! < b.reviewedAt! ? 1 : -1))[0]?.reviewedBy?.name ?? null;

  const summary = computeSubmissionReviewSummary({
    eventStatuses: events.map((e) => e.reviewStatus as EvidenceReviewStatus),
    evidenceFrameCount,
    lastReviewActivityAt,
    lastReviewerName: lastReviewer,
  });

  const recommendation = calculateCombinedReviewRecommendation(evidenceSignals, {
    examMode: policySnapshot?.examMode,
  });

  return {
    submissionId: submission.id,
    status: submission.status,
    policy: policySnapshot
      ? {
          available: true,
          examMode: policySnapshot.examMode,
          calculatorAllowed: policySnapshot.calculatorAllowed,
          notesAllowed: policySnapshot.notesAllowed,
          internetAllowed: policySnapshot.internetAllowed,
          aiToolsAllowed: policySnapshot.aiToolsAllowed,
          secureControls: policySnapshot.derivedProfile.expectedSecureControls,
        }
      : { available: false, message: "Policy snapshot unavailable for this legacy attempt." },
    events,
    summary,
    recommendation,
  };
}

export type IntegrityReview = Awaited<ReturnType<typeof buildIntegrityReview>>;

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

type EventForReview = {
  id: string;
  reviewStatus: string;
  submissionId: string;
  examId: string;
  submission: { exam: { institutionId: string | null } };
};

/** Applies one reviewer decision, creates a history entry, and audits. Never touches marks/grade/OralVerification. */
export async function applyIntegrityEventReview(
  event: EventForReview,
  actorId: string,
  actorRole: ReviewerRole,
  newStatus: EvidenceReviewStatus,
  reviewNote: string | undefined,
) {
  const now = new Date();
  const [updated] = await prisma.$transaction([
    prisma.integrityEvent.update({
      where: { id: event.id },
      data: { reviewStatus: newStatus, reviewedAt: now, reviewedById: actorId, reviewNote: reviewNote ?? null },
      select: { id: true, reviewStatus: true, reviewedAt: true, reviewNote: true },
    }),
    prisma.integrityReviewStatusHistory.create({
      data: {
        integrityEventId: event.id,
        submissionId: event.submissionId,
        fromStatus: event.reviewStatus,
        toStatus: newStatus,
        changedById: actorId,
        changedByRole: actorRole,
        reason: reviewNote ?? null,
      },
    }),
  ]);

  const auditAction =
    newStatus === "ESCALATED" ? "INTEGRITY_EVENT_ESCALATED" : newStatus === "RESOLVED" ? "INTEGRITY_EVENT_RESOLVED" : "EVIDENCE_REVIEW_STATUS_CHANGED";
  createPlatformAuditLog({
    actorId,
    action: auditAction,
    targetType: "IntegrityEvent",
    targetId: event.id,
    institutionId: event.submission.exam.institutionId,
    metadata: {
      examId: event.examId,
      submissionId: event.submissionId,
      oldStatus: event.reviewStatus,
      newStatus,
      actorRole,
    },
  }).catch(() => {});

  return updated;
}

/** Records one freeform reviewer comment. authorRole/commentType are always server-derived — never client-supplied. */
export async function addIntegrityReviewComment(
  event: EventForReview,
  actorId: string,
  actorRole: ReviewerRole,
  comment: string,
) {
  const { authorRole, commentType } = deriveCommentAuthorRoleAndType(actorRole);
  const created = await prisma.integrityReviewComment.create({
    data: {
      integrityEventId: event.id,
      submissionId: event.submissionId,
      authorId: actorId,
      authorRole,
      commentType,
      comment,
    },
    include: { author: { select: { name: true } } },
  });

  createPlatformAuditLog({
    actorId,
    action: "EVIDENCE_REVIEW_COMMENT_ADDED",
    targetType: "IntegrityEvent",
    targetId: event.id,
    institutionId: event.submission.exam.institutionId,
    metadata: { examId: event.examId, submissionId: event.submissionId, commentType },
  }).catch(() => {});

  return {
    id: created.id,
    comment: created.comment,
    authorName: created.author.name,
    authorRole: created.authorRole,
    commentType: created.commentType,
    createdAt: created.createdAt.toISOString(),
  };
}

/**
 * Bulk "Reviewed — no concern" ONLY — see Part 18. Never supports
 * escalation, concern-remains, resolution, or oral verification in bulk.
 * One IntegrityReviewStatusHistory row per event, plus one audit entry
 * per event (small bulk sizes in practice — a lecturer's own submission
 * events — so per-event audit rows stay proportionate).
 */
export async function bulkMarkNoConcern(
  events: EventForReview[],
  actorId: string,
  actorRole: ReviewerRole,
) {
  const now = new Date();
  const results = [];
  for (const event of events) {
    const [updated] = await prisma.$transaction([
      prisma.integrityEvent.update({
        where: { id: event.id },
        data: { reviewStatus: "REVIEWED_NO_CONCERN", reviewedAt: now, reviewedById: actorId },
        select: { id: true, reviewStatus: true },
      }),
      prisma.integrityReviewStatusHistory.create({
        data: {
          integrityEventId: event.id,
          submissionId: event.submissionId,
          fromStatus: event.reviewStatus,
          toStatus: "REVIEWED_NO_CONCERN",
          changedById: actorId,
          changedByRole: actorRole,
          reason: "Bulk review — no concern",
        },
      }),
    ]);
    results.push(updated);
    createPlatformAuditLog({
      actorId,
      action: "EVIDENCE_REVIEW_BULK_NO_CONCERN",
      targetType: "IntegrityEvent",
      targetId: event.id,
      institutionId: event.submission.exam.institutionId,
      metadata: { examId: event.examId, submissionId: event.submissionId, oldStatus: event.reviewStatus, newStatus: "REVIEWED_NO_CONCERN" },
    }).catch(() => {});
  }
  return results;
}

/**
 * Called once at attempt start (see POST /api/exams/[id]/start) — kept
 * here only as the documented single source of truth for the audit
 * action names Part 19 requires; the actual snapshot build call lives in
 * the start route itself via buildExamPolicySnapshot.
 */
export const EXAM_POLICY_AUDIT_ACTIONS = {
  ACKNOWLEDGED: "EXAM_POLICY_ACKNOWLEDGED",
  SNAPSHOT_CREATED: "EXAM_POLICY_SNAPSHOT_CREATED",
} as const;
