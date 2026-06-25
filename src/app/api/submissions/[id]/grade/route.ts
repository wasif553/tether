import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { pushGradeToCanvas } from "@/lib/lti/gradePassback";

const gradeSchema = z.object({
  answers: z.array(
    z.object({
      questionId: z.string(),
      score: z.number().int().min(0),
      feedback: z.string().optional(),
    }),
  ),
  finalize: z.boolean().default(false),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const submission = await prisma.submission.findUnique({
    where: { id },
    include: { exam: { include: { questions: true } } },
  });

  if (!submission || submission.exam.createdById !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (submission.status === "IN_PROGRESS") {
    return NextResponse.json({ error: "Student has not submitted yet" }, { status: 409 });
  }

  const body = await req.json();
  const parsed = gradeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const pointsByQuestion = new Map(submission.exam.questions.map((q) => [q.id, q.points]));

  for (const { questionId, score, feedback } of parsed.data.answers) {
    const maxPoints = pointsByQuestion.get(questionId);
    if (maxPoints == null) continue;
    const clampedScore = Math.min(score, maxPoints);
    const isCorrect = maxPoints > 0 ? clampedScore >= maxPoints : null;

    await prisma.answer.upsert({
      where: { submissionId_questionId: { submissionId: id, questionId } },
      update: { score: clampedScore, feedback, isCorrect },
      create: { submissionId: id, questionId, score: clampedScore, feedback, isCorrect },
    });
  }

  let updated = submission;
  if (parsed.data.finalize) {
    const allAnswers = await prisma.answer.findMany({ where: { submissionId: id } });
    const totalScore = allAnswers.reduce((sum, a) => sum + (a.score ?? 0), 0);
    updated = await prisma.submission.update({
      where: { id },
      data: { status: "GRADED", totalScore, gradedAt: new Date() },
      include: { exam: { include: { questions: true } } },
    });

    pushGradeToCanvas(id).catch(console.error);
  }

  return NextResponse.json(updated);
}

export const dynamic = "force-dynamic";
