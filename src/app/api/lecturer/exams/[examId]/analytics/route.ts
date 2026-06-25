import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { calculateExamAnalytics, ExamNotFoundError } from "@/lib/analytics";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ examId: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { examId } = await params;

  const exam = await prisma.exam.findUnique({ where: { id: examId } });
  if (!exam) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (exam.createdById !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const analytics = await calculateExamAnalytics(examId);
    return NextResponse.json(analytics);
  } catch (err) {
    if (err instanceof ExamNotFoundError) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    console.error("Failed to calculate exam analytics", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export const dynamic = "force-dynamic";
