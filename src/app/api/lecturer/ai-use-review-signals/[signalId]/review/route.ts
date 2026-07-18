/**
 * AI-Use Answer Review v1 — see docs/ai-use-answer-review-v1.md.
 *
 * PATCH /api/lecturer/ai-use-review-signals/[signalId]/review — records a
 * lecturer's review decision on one AI-use review signal. The decision is
 * a human judgment ("Reviewed — no concern" / "Concern remains" /
 * "Escalated" / "Resolved") — never an automatic finding, and it never
 * changes any grade or triggers oral verification by itself. Every change
 * is audited.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { assertSameInstitution, institutionErrorResponse, isPlatformAdmin } from "@/lib/institutionScope";
import { createPlatformAuditLog } from "@/lib/platformAdmin";
import { REVIEW_STATUSES } from "@/lib/aiUseReview";

const reviewSchema = z.object({
  reviewStatus: z.enum(REVIEW_STATUSES),
  reviewNote: z.string().max(2000).optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ signalId: string }> }) {
  const session = await auth();
  if (!session || (session.user.role !== "LECTURER" && session.user.role !== "PLATFORM_ADMIN")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { signalId } = await params;
  const signal = await prisma.aiUseReviewSignal.findUnique({
    where: { id: signalId },
    include: { analysis: { include: { exam: { select: { id: true, createdById: true, institutionId: true } } } } },
  });
  if (!signal) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const exam = signal.analysis.exam;
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

  const updated = await prisma.aiUseReviewSignal.update({
    where: { id: signalId },
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
    action: "AI_USE_REVIEW_SIGNAL_REVIEW_UPDATED",
    targetType: "AiUseReviewSignal",
    targetId: signalId,
    institutionId: exam.institutionId,
    metadata: {
      examId: exam.id,
      submissionId: signal.analysis.submissionId,
      oldStatus: signal.reviewStatus,
      newStatus: parsed.data.reviewStatus,
    },
  }).catch(() => {});

  return NextResponse.json(updated);
}

export const dynamic = "force-dynamic";
