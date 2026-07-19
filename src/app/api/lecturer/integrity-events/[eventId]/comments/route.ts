/**
 * Evidence Review Workflow v1 — see docs/evidence-review-workflow-v1.md.
 *
 * POST /api/lecturer/integrity-events/[eventId]/comments — records one
 * freeform reviewer comment. authorRole/commentType are always derived
 * SERVER-SIDE from the authenticated session — the client never supplies
 * a role or comment type. This repo has no separate marker role, so a
 * PLATFORM_ADMIN's comment is REVIEWER_COMMENT and a LECTURER's is
 * LECTURER_COMMENT (see src/lib/integrityReview.ts).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { assertSameInstitution, institutionErrorResponse, isPlatformAdmin } from "@/lib/institutionScope";
import { addIntegrityReviewComment } from "@/lib/integrityReviewRunner";

const commentSchema = z.object({
  comment: z.string().min(1).max(4000),
});

export async function POST(
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
    include: { exam: { select: { id: true, createdById: true, institutionId: true } } },
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
  const parsed = commentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const created = await addIntegrityReviewComment(
    {
      id: event.id,
      reviewStatus: event.reviewStatus,
      submissionId: event.submissionId,
      examId: event.examId,
      submission: { exam: { institutionId: event.exam.institutionId } },
    },
    session.user.id,
    session.user.role as "LECTURER" | "PLATFORM_ADMIN",
    parsed.data.comment,
  );

  return NextResponse.json(created, { status: 201 });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const session = await auth();
  if (!session || (session.user.role !== "LECTURER" && session.user.role !== "PLATFORM_ADMIN")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { eventId } = await params;
  const event = await prisma.integrityEvent.findUnique({
    where: { id: eventId },
    include: { exam: { select: { createdById: true, institutionId: true } } },
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

  const comments = await prisma.integrityReviewComment.findMany({
    where: { integrityEventId: eventId },
    orderBy: { createdAt: "asc" },
    include: { author: { select: { name: true } } },
  });

  return NextResponse.json(
    comments.map((c) => ({
      id: c.id,
      comment: c.comment,
      authorName: c.author.name,
      authorRole: c.authorRole,
      commentType: c.commentType,
      createdAt: c.createdAt.toISOString(),
    })),
  );
}

export const dynamic = "force-dynamic";
