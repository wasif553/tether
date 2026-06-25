import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { pushGradeToCanvas } from "@/lib/lti/gradePassback";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const submission = await prisma.submission.findUnique({
    where: { id },
    include: { exam: { include: { questions: true } }, answers: true },
  });

  if (!submission || submission.studentId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (submission.status !== "IN_PROGRESS") {
    return NextResponse.json(submission);
  }

  const answersByQuestion = new Map(submission.answers.map((a) => [a.questionId, a]));

  let autoScore = 0;
  let hasEssay = false;

  for (const question of submission.exam.questions) {
    if (question.type === "ESSAY") {
      hasEssay = true;
      continue;
    }

    const answer = answersByQuestion.get(question.id);
    const correct =
      !!answer?.response &&
      !!question.correctAnswer &&
      answer.response.trim().toLowerCase() === question.correctAnswer.trim().toLowerCase();
    const score = correct ? question.points : 0;
    autoScore += score;

    if (answer) {
      await prisma.answer.update({
        where: { id: answer.id },
        data: { score, isCorrect: correct },
      });
    } else {
      await prisma.answer.create({
        data: { submissionId: id, questionId: question.id, score, isCorrect: correct },
      });
    }
  }

  const now = new Date();
  const updated = await prisma.submission.update({
    where: { id },
    data: {
      status: hasEssay ? "SUBMITTED" : "GRADED",
      submittedAt: now,
      gradedAt: hasEssay ? null : now,
      totalScore: hasEssay ? null : autoScore,
    },
  });

  if (!hasEssay) {
    pushGradeToCanvas(id).catch(console.error);
  }

  return NextResponse.json(updated);
}

export const dynamic = "force-dynamic";
