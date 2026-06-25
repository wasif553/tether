import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { pushGradeToCanvas } from "@/lib/lti/gradePassback";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const submission = await prisma.submission.findUnique({
    where: { id },
    include: { exam: true },
  });

  if (!submission || submission.exam.createdById !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const result = await pushGradeToCanvas(id, { force: true });

  const passback = await prisma.canvasGradePassback.findUnique({ where: { submissionId: id } });
  const status = passback
    ? {
        status: passback.status,
        scoreGiven: passback.scoreGiven,
        scoreMaximum: passback.scoreMaximum,
        sentAt: passback.sentAt,
        attemptedAt: passback.attemptedAt,
        errorMessage: passback.errorMessage,
      }
    : null;

  if ("skipped" in result && result.skipped) {
    return NextResponse.json({ success: false, message: result.reason, status });
  }

  if (result.success) {
    return NextResponse.json({ success: true, message: "Grade pushed to Canvas.", status });
  }

  return NextResponse.json({
    success: false,
    message: `Failed to push grade to Canvas: ${result.error}`,
    status,
  });
}

export const dynamic = "force-dynamic";
