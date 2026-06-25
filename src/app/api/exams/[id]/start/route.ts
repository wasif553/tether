import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const exam = await prisma.exam.findUnique({ where: { id } });
  if (!exam || !exam.published) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const now = new Date();
  if (exam.startsAt && now < exam.startsAt) {
    return NextResponse.json({ error: "Exam has not started yet" }, { status: 403 });
  }
  if (exam.endsAt && now > exam.endsAt) {
    return NextResponse.json({ error: "Exam window has closed" }, { status: 403 });
  }

  const existing = await prisma.submission.findUnique({
    where: { examId_studentId: { examId: id, studentId: session.user.id } },
  });
  if (existing) return NextResponse.json(existing);

  const submission = await prisma.submission.create({
    data: { examId: id, studentId: session.user.id },
  });

  return NextResponse.json(submission, { status: 201 });
}

export const dynamic = "force-dynamic";
