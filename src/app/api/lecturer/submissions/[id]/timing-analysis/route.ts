/**
 * Time Anomaly Review v1 — see docs/time-anomaly-review-v1.md.
 *
 * POST /api/lecturer/submissions/[id]/timing-analysis — runs (or
 * re-runs) timing analysis for one submission, including the bounded
 * cross-submission timing-similarity comparison and the Part 12 combined
 * recommendation. Lecturer-triggered and synchronous in v1.
 *
 * GET — returns the analysis and its signals. Lecturer (exam owner) or
 * platform admin, same institution. Students always receive 401/403.
 * Never returns correct answers or any raw hash/IP/user-agent.
 */
import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import type { Submission } from "@/generated/prisma/client";
import { assertSameInstitution, institutionErrorResponse, isPlatformAdmin } from "@/lib/institutionScope";
import { createPlatformAuditLog } from "@/lib/platformAdmin";
import { TIMING_REVIEW_STATUS_LABELS, type TimingReviewStatus } from "@/lib/timeAnomalyDetection";
import { COMBINED_RECOMMENDATION_LABELS, type CombinedRecommendation } from "@/lib/combinedReviewRecommendation";
import { runTimingAnalysisForSubmission, TimingCohortTooLargeError } from "@/lib/timingAnalysisRunner";

function findSubmissionForPermissionCheck(submissionId: string) {
  return prisma.submission.findUnique({
    where: { id: submissionId },
    include: { exam: { select: { id: true, createdById: true, institutionId: true } } },
  });
}
type SubmissionWithExam = Submission & { exam: { id: string; createdById: string; institutionId: string | null } };
type SubmissionPermission = { response: NextResponse } | { session: Session; submission: SubmissionWithExam };

async function requireSubmissionPermission(submissionId: string): Promise<SubmissionPermission> {
  const session = await auth();
  if (!session || (session.user.role !== "LECTURER" && session.user.role !== "PLATFORM_ADMIN")) {
    return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const submission = await findSubmissionForPermissionCheck(submissionId);
  if (!submission) return { response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  if (!isPlatformAdmin(session) && submission.exam.createdById !== session.user.id) {
    return { response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }
  try {
    assertSameInstitution(session, submission.exam.institutionId);
  } catch (err) {
    const response = institutionErrorResponse(err);
    if (response) return { response };
    throw err;
  }
  return { session, submission };
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const permission = await requireSubmissionPermission(id);
  if ("response" in permission) return permission.response;
  const { session, submission } = permission;

  createPlatformAuditLog({
    actorId: session.user.id,
    action: "TIMING_ANALYSIS_STARTED",
    targetType: "Submission",
    targetId: id,
    institutionId: submission.exam.institutionId,
    metadata: { examId: submission.exam.id },
  }).catch(() => {});

  try {
    const analysisId = await runTimingAnalysisForSubmission(id, session.user.id);
    createPlatformAuditLog({
      actorId: session.user.id,
      action: "TIMING_ANALYSIS_COMPLETED",
      targetType: "TimingAnalysis",
      targetId: analysisId,
      institutionId: submission.exam.institutionId,
      metadata: { examId: submission.exam.id, submissionId: id },
    }).catch(() => {});
    return NextResponse.json({ ok: true, analysisId });
  } catch (err) {
    if (err instanceof TimingCohortTooLargeError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    console.error("Timing analysis failed", err);
    return NextResponse.json(
      { error: "Timing analysis failed. This submission's grade and status are unaffected — you can retry." },
      { status: 500 },
    );
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const permission = await requireSubmissionPermission(id);
  if ("response" in permission) return permission.response;

  const analysis = await prisma.timingAnalysis.findUnique({
    where: { submissionId: id },
    include: { signals: { orderBy: { createdAt: "asc" }, include: { reviewedBy: { select: { name: true } } } } },
  });

  if (!analysis) return NextResponse.json({ analysis: null });

  return NextResponse.json({
    analysis: {
      id: analysis.id,
      status: analysis.status,
      overallSignalLevel: analysis.overallSignalLevel,
      algorithmVersion: analysis.algorithmVersion,
      analysedAt: analysis.analysedAt,
      recommendation: analysis.recommendation,
      recommendationLabel: COMBINED_RECOMMENDATION_LABELS[analysis.recommendation as CombinedRecommendation] ?? analysis.recommendation,
      reasonCodes: analysis.reasonCodesJson,
      summary: analysis.summaryJson,
      signals: analysis.signals.map((s) => ({
        id: s.id,
        signalType: s.signalType,
        signalLevel: s.signalLevel,
        explanation: s.explanation,
        evidence: s.evidenceJson,
        reviewStatus: s.reviewStatus,
        reviewStatusLabel: TIMING_REVIEW_STATUS_LABELS[s.reviewStatus as TimingReviewStatus] ?? s.reviewStatus,
        reviewedAt: s.reviewedAt,
        reviewedByName: s.reviewedBy?.name ?? null,
        reviewNote: s.reviewNote,
      })),
    },
  });
}

export const dynamic = "force-dynamic";
