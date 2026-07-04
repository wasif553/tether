import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseSecureSettings } from "@/lib/secureExam";

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
      gradePassback: true,
      student: { select: { name: true, email: true, institutionStudentId: true } },
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

  const canvasPassback =
    isExamOwner && submission.gradePassback
      ? {
          status: submission.gradePassback.status,
          scoreGiven: submission.gradePassback.scoreGiven,
          scoreMaximum: submission.gradePassback.scoreMaximum,
          sentAt: submission.gradePassback.sentAt,
          attemptedAt: submission.gradePassback.attemptedAt,
          errorMessage: submission.gradePassback.errorMessage,
        }
      : null;

  return NextResponse.json({
    id: submission.id,
    status: submission.status,
    startedAt: submission.startedAt,
    submittedAt: submission.submittedAt,
    totalScore: submission.totalScore,
    deadline,
    canvasPassback,
    // Optional Student Verification v1 — see
    // docs/on-device-ai-integrity-detection-v1.md. Never includes
    // passwordHash or any other sensitive field.
    student: {
      name: submission.student.name,
      email: submission.student.email,
      institutionStudentId: submission.student.institutionStudentId,
    },
    exam: {
      id: submission.exam.id,
      title: submission.exam.title,
      questions,
      secureSettings: parseSecureSettings(submission.exam.secureSettings),
    },
    answers: submission.answers.map((a) => ({
      questionId: a.questionId,
      response: a.response,
      score: isOwner && submission.status !== "GRADED" ? undefined : a.score,
      feedback: isOwner && submission.status !== "GRADED" ? undefined : a.feedback,
      aiDraftScore: isExamOwner ? a.aiDraftScore : undefined,
      aiReasoning: isExamOwner ? a.aiReasoning : undefined,
    })),
  });
}

export const dynamic = "force-dynamic";
