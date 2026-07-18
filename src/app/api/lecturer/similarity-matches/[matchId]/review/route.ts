/**
 * Answer Similarity Review v1 — see docs/answer-similarity-review-v1.md.
 *
 * PATCH /api/lecturer/similarity-matches/[matchId]/review — records a
 * lecturer's review decision on one flagged match. The decision is a
 * human judgment ("Reviewed — no concern" / "Concern remains" /
 * "Escalated" / "Resolved") — never an automatic finding, and it never
 * changes any grade. Every change is audited.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { assertSameInstitution, institutionErrorResponse, isPlatformAdmin } from "@/lib/institutionScope";
import { createPlatformAuditLog } from "@/lib/platformAdmin";
import { SIMILARITY_REVIEW_STATUSES } from "@/lib/answerSimilarity";

const reviewSchema = z.object({
  reviewStatus: z.enum(SIMILARITY_REVIEW_STATUSES),
  reviewNote: z.string().max(2000).optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ matchId: string }> },
) {
  const session = await auth();
  if (!session || (session.user.role !== "LECTURER" && session.user.role !== "PLATFORM_ADMIN")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { matchId } = await params;
  const match = await prisma.submissionSimilarityMatch.findUnique({
    where: { id: matchId },
    include: { analysis: { include: { exam: { select: { id: true, createdById: true, institutionId: true } } } } },
  });
  if (!match) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const exam = match.analysis.exam;
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

  const body = await req.json().catch(() => ({}));
  const parsed = reviewSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const updated = await prisma.submissionSimilarityMatch.update({
    where: { id: matchId },
    data: {
      reviewStatus: parsed.data.reviewStatus,
      reviewNote: parsed.data.reviewNote ?? null,
      reviewedAt: new Date(),
      reviewedById: session.user.id,
    },
    select: { id: true, reviewStatus: true, reviewNote: true, reviewedAt: true },
  });

  // Audited — old/new status only, never the student's answer text.
  createPlatformAuditLog({
    actorId: session.user.id,
    action: "SIMILARITY_MATCH_REVIEW_UPDATED",
    targetType: "SubmissionSimilarityMatch",
    targetId: matchId,
    institutionId: exam.institutionId,
    metadata: {
      examId: exam.id,
      submissionIds: [match.sourceSubmissionId, match.comparedSubmissionId],
      oldStatus: match.reviewStatus,
      newStatus: parsed.data.reviewStatus,
    },
  }).catch(() => {});

  return NextResponse.json(updated);
}

export const dynamic = "force-dynamic";
