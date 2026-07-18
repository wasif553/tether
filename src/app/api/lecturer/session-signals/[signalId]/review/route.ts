/**
 * Exam Session Binding v1 — see docs/exam-session-binding-v1.md.
 *
 * PATCH /api/lecturer/session-signals/[signalId]/review — records a
 * lecturer's review decision on one session-integrity signal. Never an
 * automatic finding, never changes a grade, never itself creates an
 * OralVerification record (that always requires the separate explicit
 * "Require oral verification" action). Every change is audited.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { assertSameInstitution, institutionErrorResponse, isPlatformAdmin } from "@/lib/institutionScope";
import { createPlatformAuditLog } from "@/lib/platformAdmin";
import { SESSION_REVIEW_STATUSES } from "@/lib/sessionIntegrity";

const reviewSchema = z.object({
  reviewStatus: z.enum(SESSION_REVIEW_STATUSES),
  reviewNote: z.string().max(2000).optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ signalId: string }> }) {
  const session = await auth();
  if (!session || (session.user.role !== "LECTURER" && session.user.role !== "PLATFORM_ADMIN")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { signalId } = await params;
  const signal = await prisma.sessionIntegritySignal.findUnique({
    where: { id: signalId },
    include: { submission: { include: { exam: { select: { id: true, createdById: true, institutionId: true } } } } },
  });
  if (!signal) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const exam = signal.submission.exam;
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

  const updated = await prisma.sessionIntegritySignal.update({
    where: { id: signalId },
    data: {
      reviewStatus: parsed.data.reviewStatus,
      reviewNote: parsed.data.reviewNote ?? null,
      reviewedAt: new Date(),
      reviewedById: session.user.id,
    },
    select: { id: true, reviewStatus: true, reviewNote: true, reviewedAt: true },
  });

  createPlatformAuditLog({
    actorId: session.user.id,
    action: "SESSION_SIGNAL_REVIEW_UPDATED",
    targetType: "SessionIntegritySignal",
    targetId: signalId,
    institutionId: exam.institutionId,
    metadata: { examId: exam.id, submissionId: signal.submissionId, oldStatus: signal.reviewStatus, newStatus: parsed.data.reviewStatus },
  }).catch(() => {});

  return NextResponse.json(updated);
}

export const dynamic = "force-dynamic";
