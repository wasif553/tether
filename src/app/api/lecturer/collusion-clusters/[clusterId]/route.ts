/**
 * Cohort-Level Collusion Detection and Integrity Graph v1 — see
 * docs/cohort-collusion-graph-v1.md.
 *
 * GET /api/lecturer/collusion-clusters/[clusterId] — the cluster-detail
 * view: members (with real student identities — this whole route is
 * lecturer-only, so no anonymisation is needed here; the optional graph
 * widget may anonymise its own display), pairwise edges, the signal-
 * family matrix, and review history. Lecturer (exam owner, via the
 * cluster's analysis's exam) or platform admin, same institution.
 * Students always receive 401/403. Never returns a raw IP address,
 * device token, browser-session token, or correct answer.
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { assertSameInstitution, institutionErrorResponse, isPlatformAdmin } from "@/lib/institutionScope";
import { CONCERN_LEVEL_LABELS, CLUSTER_REVIEW_STATUS_LABELS, type ConcernLevel, type ClusterReviewStatus } from "@/lib/cohortCollusionAnalysis";

async function findClusterForPermissionCheck(clusterId: string) {
  return prisma.collusionCluster.findUnique({
    where: { id: clusterId },
    include: {
      analysis: { select: { id: true, examId: true, exam: { select: { id: true, title: true, createdById: true, institutionId: true } } } },
      reviewedBy: { select: { name: true } },
      members: {
        include: {
          submission: {
            select: {
              id: true,
              attemptNumber: true,
              student: { select: { id: true, name: true, email: true, institutionStudentId: true } },
            },
          },
        },
      },
    },
  });
}

export async function GET(_req: Request, { params }: { params: Promise<{ clusterId: string }> }) {
  const session = await auth();
  if (!session || (session.user.role !== "LECTURER" && session.user.role !== "PLATFORM_ADMIN")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { clusterId } = await params;
  const cluster = await findClusterForPermissionCheck(clusterId);
  if (!cluster) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const exam = cluster.analysis.exam;
  if (!isPlatformAdmin(session) && exam.createdById !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  try {
    assertSameInstitution(session, exam.institutionId);
  } catch (err) {
    const response = institutionErrorResponse(err);
    if (response) return response;
    throw err;
  }

  const memberSubmissionIds = cluster.members.map((m) => m.submissionId);
  const edges = await prisma.collusionPairEdge.findMany({
    where: {
      analysisId: cluster.analysisId,
      sourceSubmissionId: { in: memberSubmissionIds },
      comparedSubmissionId: { in: memberSubmissionIds },
    },
    include: {
      signals: true,
      sourceSubmission: { select: { id: true, student: { select: { id: true, name: true } } } },
      comparedSubmission: { select: { id: true, student: { select: { id: true, name: true } } } },
    },
    orderBy: { createdAt: "asc" },
  });

  // Oral verification status for each member — surfaces the EXISTING
  // workflow's state here rather than duplicating it; creating a new
  // request still goes through the existing
  // POST /api/lecturer/submissions/[id]/oral-verification route.
  const oralVerifications = await prisma.oralVerification.findMany({
    where: { submissionId: { in: memberSubmissionIds } },
    orderBy: { createdAt: "desc" },
    select: { submissionId: true, status: true, reason: true, createdAt: true },
  });
  const oralVerificationBySubmission = new Map<string, { status: string; reason: string; createdAt: Date }>();
  for (const ov of oralVerifications) {
    if (!oralVerificationBySubmission.has(ov.submissionId)) {
      oralVerificationBySubmission.set(ov.submissionId, { status: ov.status, reason: ov.reason, createdAt: ov.createdAt });
    }
  }

  return NextResponse.json({
    cluster: {
      id: cluster.id,
      examId: exam.id,
      examTitle: exam.title,
      clusterKey: cluster.clusterKey,
      memberCount: cluster.memberCount,
      independentFamilyCount: cluster.independentFamilyCount,
      edgeCount: cluster.edgeCount,
      concernLevel: cluster.concernLevel,
      concernLevelLabel: CONCERN_LEVEL_LABELS[cluster.concernLevel as ConcernLevel] ?? cluster.concernLevel,
      reviewStatus: cluster.reviewStatus,
      reviewStatusLabel: CLUSTER_REVIEW_STATUS_LABELS[cluster.reviewStatus as ClusterReviewStatus] ?? cluster.reviewStatus,
      reviewedAt: cluster.reviewedAt,
      reviewedByName: cluster.reviewedBy?.name ?? null,
      reviewNote: cluster.reviewNote,
      summary: cluster.summaryJson,
      members: cluster.members.map((m) => ({
        submissionId: m.submissionId,
        attemptNumber: m.submission.attemptNumber,
        studentId: m.submission.student.id,
        studentName: m.submission.student.name,
        studentEmail: m.submission.student.email,
        institutionStudentId: m.submission.student.institutionStudentId,
        supportingEdgeCount: m.supportingEdgeCount,
        independentFamilyCount: m.independentFamilyCount,
        memberScore: m.memberScore,
        oralVerification: oralVerificationBySubmission.get(m.submissionId) ?? null,
      })),
      edges: edges.map((e) => ({
        id: e.id,
        sourceSubmissionId: e.sourceSubmissionId,
        comparedSubmissionId: e.comparedSubmissionId,
        sourceStudentName: e.sourceSubmission.student.name,
        comparedStudentName: e.comparedSubmission.student.name,
        combinedScore: e.combinedScore,
        independentFamilyCount: e.independentFamilyCount,
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
