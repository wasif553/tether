/**
 * Answer Similarity Review v1 — see docs/answer-similarity-review-v1.md.
 *
 * POST /api/lecturer/exams/[examId]/similarity-analysis — runs (or
 * re-runs) similarity analysis for the exam's submitted cohort.
 * Lecturer-triggered and synchronous in v1 (this repo has no queue/
 * worker); cohort size is hard-capped — see MAX_ANALYSIS_SUBMISSIONS in
 * src/lib/similarityAnalysisRunner.ts.
 *
 * GET — returns the analysis, its matches, and per-pair
 * recommendations. Lecturer (exam owner) or platform admin, same
 * institution. Never returns correct answers, storage keys, or full
 * unrelated submissions — matched excerpts are capped to the relevant
 * passage by the pure engine before they're ever persisted.
 */
import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import type { Exam } from "@/generated/prisma/client";
import { assertSameInstitution, institutionErrorResponse, isPlatformAdmin } from "@/lib/institutionScope";
import { createPlatformAuditLog } from "@/lib/platformAdmin";
import { SIMILARITY_REVIEW_STATUS_LABELS, type SimilarityReviewStatus } from "@/lib/answerSimilarity";
import { runSimilarityAnalysisForExam, SimilarityCohortTooLargeError } from "@/lib/similarityAnalysisRunner";

type SimilarityPermission =
  | { response: NextResponse }
  | { session: Session; exam: Exam };

async function requireSimilarityPermission(examId: string): Promise<SimilarityPermission> {
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

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ examId: string }> },
): Promise<NextResponse> {
  const { examId } = await params;
  const permission = await requireSimilarityPermission(examId);
  if ("response" in permission) return permission.response;

  createPlatformAuditLog({
    actorId: permission.session.user.id,
    action: "SIMILARITY_ANALYSIS_STARTED",
    targetType: "Exam",
    targetId: examId,
    institutionId: permission.exam.institutionId,
  }).catch(() => {});

  try {
    const analysisId = await runSimilarityAnalysisForExam(examId);
    createPlatformAuditLog({
      actorId: permission.session.user.id,
      action: "SIMILARITY_ANALYSIS_COMPLETED",
      targetType: "SubmissionSimilarityAnalysis",
      targetId: analysisId,
      institutionId: permission.exam.institutionId,
      metadata: { examId },
    }).catch(() => {});
    return NextResponse.json({ ok: true, analysisId });
  } catch (err) {
    if (err instanceof SimilarityCohortTooLargeError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    console.error("Similarity analysis failed", err);
    return NextResponse.json(
      { error: "Similarity analysis failed. The exam's submissions are unaffected — you can retry." },
      { status: 500 },
    );
  }
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ examId: string }> },
) {
  const { examId } = await params;
  const permission = await requireSimilarityPermission(examId);
  if ("response" in permission) return permission.response;

  const analysis = await prisma.submissionSimilarityAnalysis.findFirst({
    where: { examId },
    orderBy: { createdAt: "asc" },
    include: {
      matches: {
        orderBy: { createdAt: "asc" },
        include: {
          question: { select: { id: true, text: true, order: true } },
          sourceSubmission: {
            select: { id: true, attemptNumber: true, student: { select: { name: true, email: true } } },
          },
          comparedSubmission: {
            select: { id: true, attemptNumber: true, student: { select: { name: true, email: true } } },
          },
          reviewedBy: { select: { name: true } },
        },
      },
    },
  });

  if (!analysis) return NextResponse.json({ analysis: null });

  return NextResponse.json({
    analysis: {
      id: analysis.id,
      status: analysis.status,
      overallRisk: analysis.overallRisk,
      analysedAt: analysis.analysedAt,
      algorithmVersion: analysis.algorithmVersion,
      summary: analysis.summaryJson,
      matches: analysis.matches.map((m) => ({
        id: m.id,
        signalType: m.signalType,
        score: m.score,
        // Explainable detail only — the pure engine already limited any
        // excerpt to the relevant passage; correctAnswer never enters
        // matchedDetailJson at all (see detectSameWrongMcqPattern).
        detail: m.matchedDetailJson,
        question: m.question ? { id: m.question.id, order: m.question.order, text: m.question.text } : null,
        sourceSubmission: m.sourceSubmission,
        comparedSubmission: m.comparedSubmission,
        reviewStatus: m.reviewStatus,
        reviewStatusLabel:
          SIMILARITY_REVIEW_STATUS_LABELS[m.reviewStatus as SimilarityReviewStatus] ?? m.reviewStatus,
        reviewedAt: m.reviewedAt,
        reviewedByName: m.reviewedBy?.name ?? null,
        reviewNote: m.reviewNote,
      })),
    },
  });
}

export const dynamic = "force-dynamic";
