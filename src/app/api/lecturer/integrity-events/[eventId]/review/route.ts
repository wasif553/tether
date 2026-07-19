/**
 * Evidence Review Workflow v1 — see docs/evidence-review-workflow-v1.md.
 *
 * PATCH /api/lecturer/integrity-events/[eventId]/review — records a
 * lecturer's review decision on one integrity event (NEEDS_REVIEW is the
 * default; this route moves it to REVIEWED_NO_CONCERN /
 * REVIEWED_CONCERN_REMAINS / ESCALATED / RESOLVED). Every transition
 * creates an immutable IntegrityReviewStatusHistory row and an audit log
 * entry. Never changes a grade, never blocks marks release, never
 * creates an OralVerification record (that stays an explicit, separate
 * lecturer action).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { assertSameInstitution, institutionErrorResponse, isPlatformAdmin } from "@/lib/institutionScope";
import { EVIDENCE_REVIEW_STATUSES } from "@/lib/integrityReview";
import { applyIntegrityEventReview } from "@/lib/integrityReviewRunner";

const reviewSchema = z.object({
  reviewStatus: z.enum(EVIDENCE_REVIEW_STATUSES),
  reviewNote: z.string().max(2000).optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const session = await auth();
  if (!session || (session.user.role !== "LECTURER" && session.user.role !== "PLATFORM_ADMIN")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { eventId } = await params;
  const event = await prisma.integrityEvent.findUnique({
    where: { id: eventId },
    include: { exam: { select: { id: true, createdById: true, institutionId: true } }, submission: { select: { examId: true } } },
  });
  if (!event) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!isPlatformAdmin(session) && event.exam.createdById !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  try {
    assertSameInstitution(session, event.exam.institutionId);
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

  const updated = await applyIntegrityEventReview(
    {
      id: event.id,
      reviewStatus: event.reviewStatus,
      submissionId: event.submissionId,
      examId: event.examId,
      submission: { exam: { institutionId: event.exam.institutionId } },
    },
    session.user.id,
    session.user.role as "LECTURER" | "PLATFORM_ADMIN",
    parsed.data.reviewStatus,
    parsed.data.reviewNote,
  );

  return NextResponse.json(updated);
}

export const dynamic = "force-dynamic";
