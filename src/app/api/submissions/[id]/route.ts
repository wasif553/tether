import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const submission = await prisma.submission.findUnique({
    where: { id },
    include: {
      exam: { include: { questions: { orderBy: { order: "asc" } } } },
      answers: true,
    },
  });

  if (!submission) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const isOwner = submission.studentId === session.user.id;
  const isExamOwner =
    session.user.role === "LECTURER" && submission.exam.createdById === session.user.id;
  if (!isOwner && !isExamOwner) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const deadline = new Date(
    submission.startedAt.getTime() + submission.exam.durationMins * 60_000,
  );

  const questions = submission.exam.questions.map((q) => ({
    id: q.id,
    type: q.type,
    text: q.text,
    options: q.options,
    points: q.points,
    order: q.order,
    correctAnswer: isExamOwner ? q.correctAnswer : undefined,
  }));

  return NextResponse.json({
    id: submission.id,
    status: submission.status,
    startedAt: submission.startedAt,
    submittedAt: submission.submittedAt,
    totalScore: submission.totalScore,
    deadline,
    exam: { id: submission.exam.id, title: submission.exam.title, questions },
    answers: submission.answers.map((a) => ({
      questionId: a.questionId,
      response: a.response,
      score: isOwner && submission.status !== "GRADED" ? undefined : a.score,
      feedback: isOwner && submission.status !== "GRADED" ? undefined : a.feedback,
    })),
  });
}

export const dynamic = "force-dynamic";
