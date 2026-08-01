import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { institutionWhere, institutionErrorResponse } from "@/lib/institutionScope";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  let exam;
  try {
    exam = await prisma.exam.findFirst({
      where: { id, createdById: session.user.id, ...institutionWhere(session) },
    });
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
  if (!exam) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const submissions = await prisma.submission.findMany({
    where: { examId: id },
    include: {
      student: { select: { id: true, name: true, email: true } },
      gradePassback: { select: { status: true } },
    },
    orderBy: { startedAt: "desc" },
  });

  // Tether System Check and Exam Readiness v1 — see
  // docs/tether-system-check-v1.md, "Reporting/audit". Neutral,
  // non-invasive lecturer visibility: only overallStatus, checkedAt, and
  // clientVersion per student — never camera/microphone permission
  // details or any other device information. The record is per-STUDENT
  // (not per-exam), so this is each student's most recent check
  // regardless of which exam it was run for.
  const studentIds = [...new Set(submissions.map((s) => s.student.id))];
  const latestChecks =
    studentIds.length > 0
      ? await prisma.tetherSystemCheckRun.findMany({
          where: { userId: { in: studentIds } },
          orderBy: { checkedAt: "desc" },
          select: { userId: true, overallStatus: true, checkedAt: true, clientVersion: true },
        })
      : [];
  const latestCheckByStudent = new Map<string, { overallStatus: string; checkedAt: Date; clientVersion: string | null }>();
  for (const check of latestChecks) {
    if (!latestCheckByStudent.has(check.userId)) {
      latestCheckByStudent.set(check.userId, { overallStatus: check.overallStatus, checkedAt: check.checkedAt, clientVersion: check.clientVersion });
    }
  }

  return NextResponse.json(
    submissions.map((s) => ({
      ...s,
      attemptNumber: s.attemptNumber,
      canvasStatus: s.gradePassback?.status ?? null,
      gradePassback: undefined,
      systemCheck: latestCheckByStudent.get(s.student.id) ?? null,
    })),
  );
}

export const dynamic = "force-dynamic";
