/**
 * Evidence Review Workflow v1 — see docs/evidence-review-workflow-v1.md.
 *
 * POST /api/lecturer/submissions/[id]/integrity-review/bulk-no-concern —
 * the ONLY bulk review action supported (Part 18). Marks an explicit,
 * client-selected set of this submission's integrity events as
 * "Reviewed — no concern". Never supports bulk escalation, concern-
 * remains, resolution, or oral verification — those always require a
 * per-event decision. Creates one IntegrityReviewStatusHistory row and
 * one audit entry per event.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { assertSameInstitution, institutionErrorResponse, isPlatformAdmin } from "@/lib/institutionScope";
import { bulkMarkNoConcern } from "@/lib/integrityReviewRunner";

const bulkSchema = z.object({
  eventIds: z.array(z.string().min(1)).min(1).max(200),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session || (session.user.role !== "LECTURER" && session.user.role !== "PLATFORM_ADMIN")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const submission = await prisma.submission.findUnique({
    where: { id },
    select: { examId: true, exam: { select: { createdById: true, institutionId: true } } },
  });
  if (!submission) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!isPlatformAdmin(session) && submission.exam.createdById !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  try {
    assertSameInstitution(session, submission.exam.institutionId);
  } catch (err) {
    const response = institutionErrorResponse(err);
    if (response) return response;
    throw err;
  }

  const body = await req.json().catch(() => ({}));
  const parsed = bulkSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  // Only events that actually belong to THIS submission are ever
  // touched — a client-supplied id list is never trusted blindly.
  const events = await prisma.integrityEvent.findMany({
    where: { id: { in: parsed.data.eventIds }, submissionId: id },
    select: { id: true, reviewStatus: true, submissionId: true, examId: true },
  });

  const results = await bulkMarkNoConcern(
    events.map((e) => ({ ...e, submission: { exam: { institutionId: submission.exam.institutionId } } })),
    session.user.id,
    session.user.role as "LECTURER" | "PLATFORM_ADMIN",
  );

  return NextResponse.json({ updated: results.length });
}

export const dynamic = "force-dynamic";
