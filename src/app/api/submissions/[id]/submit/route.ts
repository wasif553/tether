import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { pushGradeToCanvas } from "@/lib/lti/gradePassback";
import { parseSecureSettings, severityFor } from "@/lib/secureExam";
import { Prisma } from "@/generated/prisma/client";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    // --- Reads: submission + answers + exam + questions, all in one
    // query, all before any transaction. Grading is computed entirely
    // from this data in memory — the transaction below contains writes
    // only, no reads, so it never holds a lock waiting on a read.
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
    // The `status: "IN_PROGRESS"` guard makes this update a no-op match
    // (Prisma throws P2025, caught below) if another request already
    // finalized the submission between the read above and this write —
    // belt-and-suspenders alongside the early idempotency check above,
    // without adding a read inside the transaction.
    const submissionUpdate = prisma.submission.update({
      where: { id, status: "IN_PROGRESS" },
      data: {
        status: hasEssay ? "SUBMITTED" : "GRADED",
        submittedAt: now,
        gradedAt: hasEssay ? null : now,
        totalScore: hasEssay ? null : autoScore,
      },
    });

    // --- Writes only: every operation in this array is a write. ---
    console.log("[submit] starting transaction for submission:", id);
    const results = await prisma.$transaction([...answerOps, submissionUpdate]);
    console.log("[submit] transaction complete for submission:", id);
    const result = results[results.length - 1] as Awaited<typeof submissionUpdate>;

    if (!hasEssay) {
      pushGradeToCanvas(id).catch(console.error);
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("[submit] error:", error);
    // A P2025 here means another concurrent request already finalized
    // this submission — that's a benign race, not a failure; return the
    // current (already finalized) submission instead of a 500.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      const current = await prisma.submission.findUnique({ where: { id } });
      if (current) return NextResponse.json(current);
    }
    return NextResponse.json({ error: "Failed to submit exam" }, { status: 500 });
  }
}

export const dynamic = "force-dynamic";
