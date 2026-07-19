/**
 * Backward-compatible legacy resolve route — see
 * docs/evidence-review-workflow-v1.md ("Backward-compatible resolve
 * route"). Preserved for existing UI/tests exactly as before (same
 * request/response shape, same LECTURER-only check), and internally
 * mapped into the new 5-state workflow: it now ALSO sets reviewStatus to
 * RESOLVED and creates an IntegrityReviewStatusHistory entry, so an
 * event resolved through this legacy route shows up consistently in the
 * new evidence-review UI. resolvedAt/resolvedById/resolutionNote are
 * untouched in shape — no historical resolution information is ever
 * removed.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isPlatformAdmin, assertSameInstitution, institutionErrorResponse } from "@/lib/institutionScope";
import { createPlatformAuditLog } from "@/lib/platformAdmin";

const resolveSchema = z.object({
  resolutionNote: z.string().min(1),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { eventId } = await params;
  const event = await prisma.integrityEvent.findUnique({
    where: { id: eventId },
    include: { exam: true },
  });

  if (!event) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!isPlatformAdmin(session) && event.exam.createdById !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    assertSameInstitution(session, event.exam.institutionId);
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const body = await req.json();
  const parsed = resolveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const now = new Date();
  const previousReviewStatus = event.reviewStatus;
  const [updated] = await prisma.$transaction([
    prisma.integrityEvent.update({
      where: { id: eventId },
      data: {
        resolvedAt: now,
        resolvedById: session.user.id,
        resolutionNote: parsed.data.resolutionNote,
        // Keep the new 5-state workflow consistent with legacy resolutions.
        reviewStatus: "RESOLVED",
        reviewedAt: now,
        reviewedById: session.user.id,
        reviewNote: parsed.data.resolutionNote,
      },
    }),
    prisma.integrityReviewStatusHistory.create({
      data: {
        integrityEventId: eventId,
        submissionId: event.submissionId,
        fromStatus: previousReviewStatus,
        toStatus: "RESOLVED",
        changedById: session.user.id,
        changedByRole: session.user.role,
        reason: parsed.data.resolutionNote,
      },
    }),
  ]);

  createPlatformAuditLog({
    actorId: session.user.id,
    action: "INTEGRITY_EVENT_RESOLVED",
    targetType: "IntegrityEvent",
    targetId: eventId,
    institutionId: event.exam.institutionId,
    metadata: { examId: event.examId, submissionId: event.submissionId, oldStatus: previousReviewStatus, newStatus: "RESOLVED", legacyRoute: true },
  }).catch(() => {});

  return NextResponse.json(updated);
}

export const dynamic = "force-dynamic";
