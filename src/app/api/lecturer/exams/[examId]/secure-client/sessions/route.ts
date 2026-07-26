/**
 * Tether Secure Client Foundation v1 â€” see
 * docs/secure-client-foundation-seb-v1.md and Part 11 of the spec.
 *
 * GET /api/lecturer/exams/[id]/secure-client/sessions
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { assertSameInstitution, institutionErrorResponse, isPlatformAdmin } from "@/lib/institutionScope";

export async function GET(req: Request, { params }: { params: Promise<{ examId: string }> }) {
  const session = await auth();
  if (!session || (session.user.role !== "LECTURER" && session.user.role !== "PLATFORM_ADMIN")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { examId: id } = await params;

  const exam = await prisma.exam.findUnique({ where: { id }, select: { createdById: true, institutionId: true } });
  if (!exam || (!isPlatformAdmin(session) && exam.createdById !== session.user.id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  try {
    assertSameInstitution(session, exam.institutionId);
  } catch (err) {
    const response = institutionErrorResponse(err);
    if (response) return response;
    throw err;
  }

  const url = new URL(req.url);
  const filter = url.searchParams.get("status");

  const sessions = await prisma.secureClientSession.findMany({
    where: { examId: id, ...(filter ? { status: filter } : {}) },
    orderBy: { startedAt: "desc" },
    include: {
      _count: { select: { events: { where: { eventLevel: "REVIEW_CONTEXT" } } } },
    },
  });

  const studentIds = [...new Set(sessions.map((s) => s.studentId))];
  const students = await prisma.user.findMany({ where: { id: { in: studentIds } }, select: { id: true, name: true } });
  const studentNameById = new Map(students.map((s) => [s.id, s.name]));

  return NextResponse.json({
    sessions: sessions.map((s) => ({
      id: s.id,
      studentName: studentNameById.get(s.studentId) ?? "Unknown",
      submissionId: s.submissionId,
      clientType: s.clientType,
      status: s.status,
      verificationStatus: s.verificationStatus,
      startedAt: s.startedAt,
      lastHeartbeatAt: s.lastHeartbeatAt,
      interruptedAt: s.interruptedAt,
      recoveredAt: s.recoveredAt,
      reviewContextEventCount: s._count.events,
    })),
  });
}

export const dynamic = "force-dynamic";
