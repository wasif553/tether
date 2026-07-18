/**
 * Oral Verification Workflow v1 — see
 * docs/oral-verification-workflow-v1.md.
 *
 * PATCH /api/lecturer/oral-verifications/[verificationId] — updates one
 * oral verification: status transitions (schedule / complete / cancel),
 * outcome, private lecturer notes, and lecturer-edited discussion
 * questions. Lecturer-only; every status change is audited (old/new
 * status, never answer text or lecturer notes in audit metadata).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { assertSameInstitution, institutionErrorResponse, isPlatformAdmin } from "@/lib/institutionScope";
import { createPlatformAuditLog } from "@/lib/platformAdmin";
import { ORAL_VERIFICATION_STATUSES } from "@/lib/oralVerificationQuestions";

const patchSchema = z.object({
  status: z.enum(ORAL_VERIFICATION_STATUSES).optional(),
  scheduledAt: z.string().datetime().nullable().optional(),
  outcome: z.string().max(2000).nullable().optional(),
  lecturerNotes: z.string().max(5000).nullable().optional(),
  questions: z.array(z.string().min(1).max(1000)).max(10).optional(),
});

const AUDIT_ACTION_BY_STATUS: Partial<Record<string, string>> = {
  SCHEDULED: "ORAL_VERIFICATION_SCHEDULED",
  COMPLETED_NO_CONCERN: "ORAL_VERIFICATION_COMPLETED",
  COMPLETED_CONCERN_REMAINS: "ORAL_VERIFICATION_COMPLETED",
  CANCELLED: "ORAL_VERIFICATION_CANCELLED",
};

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ verificationId: string }> },
) {
  const session = await auth();
  if (!session || (session.user.role !== "LECTURER" && session.user.role !== "PLATFORM_ADMIN")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { verificationId } = await params;
  const verification = await prisma.oralVerification.findUnique({
    where: { id: verificationId },
    include: {
      submission: { include: { exam: { select: { id: true, createdById: true, institutionId: true } } } },
    },
  });
  if (!verification) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const exam = verification.submission.exam;
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
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { status, scheduledAt, outcome, lecturerNotes, questions } = parsed.data;
  const completing = status === "COMPLETED_NO_CONCERN" || status === "COMPLETED_CONCERN_REMAINS";

  const updated = await prisma.oralVerification.update({
    where: { id: verificationId },
    data: {
      ...(status !== undefined ? { status } : {}),
      ...(scheduledAt !== undefined ? { scheduledAt: scheduledAt ? new Date(scheduledAt) : null } : {}),
      ...(outcome !== undefined ? { outcome } : {}),
      ...(lecturerNotes !== undefined ? { lecturerNotes } : {}),
      ...(questions !== undefined ? { generatedQuestionsJson: questions } : {}),
      ...(completing ? { completedAt: new Date(), completedById: session.user.id } : {}),
    },
  });

  if (status && status !== verification.status) {
    createPlatformAuditLog({
      actorId: session.user.id,
      action: AUDIT_ACTION_BY_STATUS[status] ?? "ORAL_VERIFICATION_UPDATED",
      targetType: "OralVerification",
      targetId: verificationId,
      institutionId: exam.institutionId,
      metadata: {
        examId: exam.id,
        submissionId: verification.submissionId,
        oldStatus: verification.status,
        newStatus: status,
      },
    }).catch(() => {});
  }

  return NextResponse.json(updated);
}

export const dynamic = "force-dynamic";
