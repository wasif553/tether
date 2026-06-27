import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { pushGradeToCanvas } from "@/lib/lti/gradePassback";
import { parseSecureSettings, severityFor } from "@/lib/secureExam";

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

  // The grading loop below issues one query per question. Run the whole
  // check-grade-update sequence as a single interactive transaction so it
  // holds (and releases) exactly one pooled connection for the entire
  // submit, instead of one connection per query — under concurrent submits
  // with a small connection pool, the previous sequential-queries version
  // exhausted the pool and caused 500s (see docs/concurrent-exam-pilot-capacity.md).
  const { submission: result, didGrade } = await prisma.$transaction(async (tx) => {
    // Re-check idempotency inside the transaction in case another request
    // finalized this submission between the initial fetch above and now.
    const current = await tx.submission.findUnique({ where: { id } });
    if (!current || current.status !== "IN_PROGRESS") {
      return { submission: current, didGrade: false };
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
        await tx.answer.update({
          where: { id: answer.id },
          data: { score, isCorrect: correct },
        });
      } else {
        await tx.answer.create({
          data: { submissionId: id, questionId: question.id, score, isCorrect: correct },
        });
      }
    }

    const now = new Date();
    const updated = await tx.submission.update({
      where: { id },
      data: {
        status: hasEssay ? "SUBMITTED" : "GRADED",
        submittedAt: now,
        gradedAt: hasEssay ? null : now,
        totalScore: hasEssay ? null : autoScore,
      },
    });
    return { submission: updated, didGrade: !hasEssay };
  });

  if (didGrade) {
    pushGradeToCanvas(id).catch(console.error);
  }

  return NextResponse.json(result);
}

export const dynamic = "force-dynamic";
