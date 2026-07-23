/**
 * Cohort-Level Collusion Detection and Integrity Graph v1 — see
 * docs/cohort-collusion-graph-v1.md.
 *
 * POST /api/lecturer/exams/[id]/collusion-analysis — runs (or re-runs)
 * cohort collusion analysis for the exam's submitted cohort.
 * Lecturer-triggered and synchronous in v1, exactly like
 * similarity-analysis and timing-analysis; cohort size is hard-capped —
 * see MAX_COLLUSION_ANALYSIS_SUBMISSIONS in
 * src/lib/cohortCollusionThresholds.ts. Idempotent/safely reusable: a
 * repeated request reuses the same analysis row and never duplicates
 * lecturer review history on clusters — see
 * src/lib/cohortCollusionAnalysisRunner.ts.
 *
 * GET — returns the analysis, its clusters (with per-cluster signal-
 * family matrix and edges), and the pair edges. Lecturer (exam owner) or
 * platform admin, same institution — students always receive 401/403.
 * Never returns a raw IP address, device token, browser-session token, or
 * correct answer; every signal's evidenceJson is already minimal and
 * explainable by construction (see src/lib/cohortCollusion/*.ts).
 */
import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import type { Exam } from "@/generated/prisma/client";
import { assertSameInstitution, institutionErrorResponse, isPlatformAdmin } from "@/lib/institutionScope";
import { createPlatformAuditLog } from "@/lib/platformAdmin";
import { CONCERN_LEVEL_LABELS, CLUSTER_REVIEW_STATUS_LABELS, type ConcernLevel, type ClusterReviewStatus } from "@/lib/cohortCollusionAnalysis";
import { runCohortCollusionAnalysisForExam, CohortCollusionCohortTooLargeError } from "@/lib/cohortCollusionAnalysisRunner";

type CollusionPermission = { response: NextResponse } | { session: Session; exam: Exam };

async function requireCollusionPermission(examId: string): Promise<CollusionPermission> {
  const session = await auth();
  if (!session || (session.user.role !== "LECTURER" && session.user.role !== "PLATFORM_ADMIN")) {
    return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const exam = await prisma.exam.findUnique({ where: { id: examId } });
  if (!exam) return { response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  if (!isPlatformAdmin(session) && exam.createdById !== session.user.id) {
    return { response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }
  try {
    assertSameInstitution(session, exam.institutionId);
  } catch (err) {
    const response = institutionErrorResponse(err);
    if (response) return { response };
    throw err;
  }
  return { session, exam };
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  const permission = await requireCollusionPermission(id);
  if ("response" in permission) return permission.response;

  createPlatformAuditLog({
    actorId: permission.session.user.id,
    action: "COHORT_COLLUSION_ANALYSIS_STARTED",
    targetType: "Exam",
    targetId: id,
    institutionId: permission.exam.institutionId,
  }).catch(() => {});

  try {
    const analysisId = await runCohortCollusionAnalysisForExam(id, permission.session.user.id);
    createPlatformAuditLog({
      actorId: permission.session.user.id,
      action: "COHORT_COLLUSION_ANALYSIS_COMPLETED",
      targetType: "CohortCollusionAnalysis",
      targetId: analysisId,
      institutionId: permission.exam.institutionId,
      metadata: { examId: id },
    }).catch(() => {});
    return NextResponse.json({ ok: true, analysisId });
  } catch (err) {
    if (err instanceof CohortCollusionCohortTooLargeError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    console.error("Cohort collusion analysis failed", err);
    return NextResponse.json(
      { error: "Cohort collusion analysis failed. This exam's submissions and grades are unaffected — you can retry." },
      { status: 500 },
    );
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const permission = await requireCollusionPermission(id);
  if ("response" in permission) return permission.response;

  const analysis = await prisma.cohortCollusionAnalysis.findFirst({
    where: { examId: id },
    orderBy: { createdAt: "asc" },
    include: {
      requestedBy: { select: { name: true } },
      clusters: {
        orderBy: { createdAt: "asc" },
        include: {
          reviewedBy: { select: { name: true } },
          members: {
            include: {
              submission: {
                select: { id: true, attemptNumber: true, student: { select: { id: true, name: true, email: true } } },
              },
            },
          },
        },
      },
    },
  });

  if (!analysis) return NextResponse.json({ analysis: null });

  const edges = await prisma.collusionPairEdge.findMany({
    where: { analysisId: analysis.id },
    include: {
      signals: true,
      sourceSubmission: { select: { id: true, attemptNumber: true, student: { select: { id: true, name: true } } } },
      comparedSubmission: { select: { id: true, attemptNumber: true, student: { select: { id: true, name: true } } } },
    },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({
    analysis: {
      id: analysis.id,
      status: analysis.status,
      algorithmVersion: analysis.algorithmVersion,
      analysedAt: analysis.analysedAt,
      submissionCount: analysis.submissionCount,
      eligibleEdgeCount: analysis.eligibleEdgeCount,
      clusterCount: analysis.clusterCount,
      overallReviewLevel: analysis.overallReviewLevel,
      overallReviewLevelLabel: CONCERN_LEVEL_LABELS[analysis.overallReviewLevel as ConcernLevel] ?? analysis.overallReviewLevel,
      failureCode: analysis.failureCode,
      requestedByName: analysis.requestedBy?.name ?? null,
      summary: analysis.summaryJson,
      clusters: analysis.clusters.map((c) => ({
        id: c.id,
        clusterKey: c.clusterKey,
        memberCount: c.memberCount,
        independentFamilyCount: c.independentFamilyCount,
        edgeCount: c.edgeCount,
        concernLevel: c.concernLevel,
        concernLevelLabel: CONCERN_LEVEL_LABELS[c.concernLevel as ConcernLevel] ?? c.concernLevel,
        reviewStatus: c.reviewStatus,
        reviewStatusLabel: CLUSTER_REVIEW_STATUS_LABELS[c.reviewStatus as ClusterReviewStatus] ?? c.reviewStatus,
        reviewedAt: c.reviewedAt,
        reviewedByName: c.reviewedBy?.name ?? null,
        reviewNote: c.reviewNote,
        summary: c.summaryJson,
        members: c.members.map((m) => ({
          submissionId: m.submissionId,
          attemptNumber: m.submission.attemptNumber,
          studentId: m.submission.student.id,
          studentName: m.submission.student.name,
          studentEmail: m.submission.student.email,
          supportingEdgeCount: m.supportingEdgeCount,
          independentFamilyCount: m.independentFamilyCount,
          memberScore: m.memberScore,
        })),
      })),
      edges: edges.map((e) => ({
        id: e.id,
        sourceSubmissionId: e.sourceSubmissionId,
        comparedSubmissionId: e.comparedSubmissionId,
        sourceStudentName: e.sourceSubmission.student.name,
        comparedStudentName: e.comparedSubmission.student.name,
        combinedScore: e.combinedScore,
        independentFamilyCount: e.independentFamilyCount,
        eligibleForClustering: e.eligibleForClustering,
        familyScores: e.familyScoresJson,
        signals: e.signals.map((s) => ({
          signalFamily: s.signalFamily,
          signalType: s.signalType,
          score: s.score,
          confidence: s.confidence,
          explanation: s.explanation,
          evidence: s.evidenceJson,
        })),
      })),
    },
  });
}

export const dynamic = "force-dynamic";
