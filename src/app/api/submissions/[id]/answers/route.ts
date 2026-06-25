import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

const answerSchema = z.object({
  questionId: z.string(),
  response: z.string(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const submission = await prisma.submission.findUnique({
    where: { id },
    include: { exam: true },
  });

  if (!submission || submission.studentId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (submission.status !== "IN_PROGRESS") {
    return NextResponse.json({ error: "Submission already finalized" }, { status: 409 });
  }

  const deadline = new Date(
    submission.startedAt.getTime() + submission.exam.durationMins * 60_000,
  );
  if (new Date() > deadline) {
    return NextResponse.json({ error: "Time is up" }, { status: 409 });
  }

  const body = await req.json();
  const parsed = answerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { questionId, response } = parsed.data;

  const question = await prisma.question.findFirst({
    where: { id: questionId, examId: submission.examId },
  });
  if (!question) return NextResponse.json({ error: "Invalid question" }, { status: 400 });

  const answer = await prisma.answer.upsert({
    where: { submissionId_questionId: { submissionId: id, questionId } },
    update: { response },
    create: { submissionId: id, questionId, response },
  });

  return NextResponse.json({ questionId: answer.questionId, response: answer.response });
}

export const dynamic = "force-dynamic";
