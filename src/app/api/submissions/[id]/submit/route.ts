import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { pushGradeToCanvas } from "@/lib/lti/gradePassback";
import { parseSecureSettings, severityFor } from "@/lib/secureExam";
import type { Prisma } from "@/generated/prisma/client";

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

  const settings = parseSecureSettings(submission.exam.secureSettings);
  const deadline = new Date(
    submission.startedAt.getTime() + submission.exam.durationMins * 60_000,
  );
  if (new Date() > deadline && !settings.allowLateSubmit) {
    await prisma.integrityEvent.create({
      data: {
        submissionId: id,
        examId: submission.examId,
        studentId: submission.studentId,
        eventType: "SUBMIT_AFTER_DEADLINE",
        severity: severityFor("SUBMIT_AFTER_DEADLINE", settings),
        message: "A submission attempt was made after the exam deadline.",
        occurredAt: new Date(),
      },
    });
    return NextResponse.json(
      { error: "The deadline for this exam has passed and late submission is not allowed" },
      { status: 409 },
    );
  }

  // Compute grading from data already fetched above, outside any
  // transaction. Then run all writes as a single batch ($transaction with
  // an array of operations) rather than an interactive callback — the
  // array form executes as one multi-statement transaction with no
  // per-call interactive-transaction timeout, which an awaited loop of
  // individual updates inside a callback transaction could hit under
  // concurrent submits (see docs/concurrent-exam-pilot-capacity.md).
  const answersByQuestion = new Map(submission.answers.map((a) => [a.questionId, a]));

  let autoScore = 0;
  let hasEssay = false;
  const answerOps: Prisma.PrismaPromise<unknown>[] = [];

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
      answerOps.push(
        prisma.answer.update({ where: { id: answer.id }, data: { score, isCorrect: correct } }),
      );
    } else {
      answerOps.push(
        prisma.answer.create({
          data: { submissionId: id, questionId: question.id, score, isCorrect: correct },
        }),
      );
    }
  }

  const now = new Date();
  const submissionUpdate = prisma.submission.update({
    where: { id },
    data: {
      status: hasEssay ? "SUBMITTED" : "GRADED",
      submittedAt: now,
      gradedAt: hasEssay ? null : now,
      totalScore: hasEssay ? null : autoScore,
    },
  });

  const results = await prisma.$transaction([...answerOps, submissionUpdate]);
  const result = results[results.length - 1] as Awaited<typeof submissionUpdate>;

  if (!hasEssay) {
    pushGradeToCanvas(id).catch(console.error);
  }

  return NextResponse.json(result);
}

export const dynamic = "force-dynamic";
