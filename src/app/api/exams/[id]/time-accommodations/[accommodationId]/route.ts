/**
 * Individual Exam Timing & Accommodations v1 — see
 * src/lib/examTimeAccommodation.ts and
 * docs/exam-time-accommodations-v1.md.
 *
 * DELETE /api/exams/[id]/time-accommodations/[accommodationId] — remove
 *   an accommodation. Never modifies any existing attempt — a removed
 *   accommodation only affects a FUTURE attempt (see
 *   POST /api/exams/[id]/start, which resolves the accommodation fresh
 *   for each new attempt).
 *
 * Lecturer (owner of the exam) only — never reachable by a student.
 * Editing an existing accommodation's adjustment reuses
 * POST /api/exams/[id]/time-accommodations (upsert, keyed by student) —
 * see that route for create/update.
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { institutionWhere, institutionErrorResponse, requireInstitutionId } from "@/lib/institutionScope";
import { createPlatformAuditLog } from "@/lib/platformAdmin";

async function getOwnedAccommodation(
  examId: string,
  accommodationId: string,
  lecturerId: string,
  session: Parameters<typeof institutionWhere>[0],
) {
  return prisma.examTimeAccommodation.findFirst({
    where: { id: accommodationId, examId, exam: { createdById: lecturerId, ...institutionWhere(session) } },
  });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; accommodationId: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { id, accommodationId } = await params;
    const accommodation = await getOwnedAccommodation(id, accommodationId, session.user.id, session);
    if (!accommodation) return NextResponse.json({ error: "Not found" }, { status: 404 });

    await prisma.examTimeAccommodation.delete({ where: { id: accommodationId } });

    const institutionId = requireInstitutionId(session);
    createPlatformAuditLog({
      actorId: session.user.id,
      action: "EXAM_TIME_ACCOMMODATION_REMOVED",
      targetType: "ExamTimeAccommodation",
      targetId: accommodationId,
      institutionId,
      metadata: {
        examId: id,
        studentId: accommodation.studentId,
        adjustmentMode: accommodation.adjustmentMode,
        adjustmentValue: accommodation.adjustmentValue,
      },
    }).catch(() => {});

    return NextResponse.json({ ok: true });
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export const dynamic = "force-dynamic";
