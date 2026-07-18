/**
 * AI-Use Answer Review v1 — see docs/ai-use-answer-review-v1.md.
 *
 * POST /api/lecturer/submissions/[id]/ai-use-review — runs (or re-runs)
 * AI-use review analysis for one submission. Lecturer-triggered and
 * synchronous in v1 (this repo has no queue/worker). Layer A
 * (deterministic) always runs; Layer B (optional AI-assisted) only runs
 * when the Anthropic API key is configured, and its failure never blocks
 * completion or affects the submission.
 *
 * GET — returns the analysis and its signals. Lecturer (exam owner) or
 * platform admin, same institution. Students always receive 401/403.
 * Never returns correct answers, full answer text beyond what a signal's
 * evidence excerpt needs, or any AI probability/likelihood score.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import type { Session } from "next-auth";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import type { Submission } from "@/generated/prisma/client";
import { assertSameInstitution, institutionErrorResponse, isPlatformAdmin } from "@/lib/institutionScope";
import { createPlatformAuditLog } from "@/lib/platformAdmin";
import {
  REVIEW_STATUS_LABELS,
  SIGNAL_TYPE_HEADLINES,
  SIGNAL_TYPE_LABELS,
  RECOMMENDATION_LABELS,
  type ReviewStatus,
} from "@/lib/aiUseReview";
import { runAiUseReviewForSubmission, AiUseReviewCohortTooLargeError } from "@/lib/aiUseReviewRunner";

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

const postBodySchema = z.object({ force: z.boolean().optional() }).optional();

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const permission = await requireSubmissionPermission(id);
  if ("response" in permission) return permission.response;
  const { session, submission } = permission;

  const rawBody = await req.json().catch(() => undefined);
  const parsedBody = postBodySchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return NextResponse.json({ error: parsedBody.error.flatten() }, { status: 400 });
  }

  createPlatformAuditLog({
    actorId: session.user.id,
    action: "AI_USE_REVIEW_ANALYSIS_STARTED",
    targetType: "Submission",
    targetId: id,
    institutionId: submission.exam.institutionId,
    metadata: { examId: submission.exam.id },
  }).catch(() => {});

  try {
    const analysisId = await runAiUseReviewForSubmission(id, session.user.id);

    const analysis = await prisma.aiUseReviewAnalysis.findUnique({ where: { id: analysisId } });
    const aiAssisted = (analysis?.summaryJson as Record<string, unknown> | null)?.aiAssisted as
      | { status: string }
      | undefined;

    createPlatformAuditLog({
      actorId: session.user.id,
      action: aiAssisted?.status === "COMPLETE" ? "AI_USE_REVIEW_AI_ASSISTED_ANALYSIS_COMPLETED" : "AI_USE_REVIEW_DETERMINISTIC_ANALYSIS_COMPLETED",
      targetType: "AiUseReviewAnalysis",
      targetId: analysisId,
      institutionId: submission.exam.institutionId,
      metadata: { examId: submission.exam.id, submissionId: id, provider: analysis?.provider },
    }).catch(() => {});

    if (aiAssisted?.status === "FAILED") {
      createPlatformAuditLog({
        actorId: session.user.id,
        action: "AI_USE_REVIEW_AI_ASSISTED_ANALYSIS_FAILED",
        targetType: "AiUseReviewAnalysis",
        targetId: analysisId,
        institutionId: submission.exam.institutionId,
        metadata: { examId: submission.exam.id, submissionId: id },
      }).catch(() => {});
    }

    return NextResponse.json({ ok: true, analysisId });
  } catch (err) {
    if (err instanceof AiUseReviewCohortTooLargeError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    console.error("AI-use review analysis failed", err);
    return NextResponse.json(
      { error: "AI-use review analysis failed. This submission's grade and status are unaffected — you can retry." },
      { status: 500 },
    );
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const permission = await requireSubmissionPermission(id);
  if ("response" in permission) return permission.response;

  const analysis = await prisma.aiUseReviewAnalysis.findUnique({
    where: { submissionId: id },
    include: {
      signals: {
        orderBy: { createdAt: "asc" },
        include: {
          question: { select: { id: true, text: true, order: true } },
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
      overallSignalLevel: analysis.overallSignalLevel,
      provider: analysis.provider,
      modelIdentifier: analysis.modelIdentifier,
      algorithmVersion: analysis.algorithmVersion,
      analysedAt: analysis.analysedAt,
      failureCode: analysis.failureCode,
      recommendation: analysis.recommendation,
      recommendationLabel: RECOMMENDATION_LABELS[analysis.recommendation as keyof typeof RECOMMENDATION_LABELS] ?? analysis.recommendation,
      reasonCodes: analysis.reasonCodesJson,
      summary: analysis.summaryJson,
      signals: analysis.signals.map((s) => ({
        id: s.id,
        signalType: s.signalType,
        headline: SIGNAL_TYPE_HEADLINES[s.signalType as keyof typeof SIGNAL_TYPE_HEADLINES] ?? "AI-use review signal",
        label: SIGNAL_TYPE_LABELS[s.signalType as keyof typeof SIGNAL_TYPE_LABELS] ?? s.signalType,
        signalLevel: s.signalLevel,
        explanation: s.explanation,
        evidence: s.evidenceJson,
        question: s.question ? { id: s.question.id, order: s.question.order, text: s.question.text } : null,
        reviewStatus: s.reviewStatus,
        reviewStatusLabel: REVIEW_STATUS_LABELS[s.reviewStatus as ReviewStatus] ?? s.reviewStatus,
        reviewedAt: s.reviewedAt,
        reviewedByName: s.reviewedBy?.name ?? null,
        reviewNote: s.reviewNote,
      })),
    },
  });
}

export const dynamic = "force-dynamic";
