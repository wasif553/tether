import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseSecureSettings } from "@/lib/secureExam";
import { submissionDeadline } from "@/lib/assessmentLifecycle";
import { recordAnswerSavedActivity } from "@/lib/answerActivityTelemetry";
import { findMostRecentSessionId } from "@/lib/examAttemptSessionRunner";

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

  const deadline = submissionDeadline(submission.startedAt, submission.exam.durationMins);
  const settings = parseSecureSettings(submission.exam.secureSettings);
  if (new Date() > deadline && !settings.allowLateSubmit) {
    return NextResponse.json({ error: "Time is up" }, { status: 409 });
  }

  const body = await req.json();
  const parsed = answerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { questionId, response } = parsed.data;

  // One transaction instead of two sequential queries — holds a single
  // pooled connection for the whole autosave instead of two checkouts,
  // which matters under concurrent autosave traffic with a small pool.
  const answer = await prisma.$transaction(async (tx) => {
    const question = await tx.question.findFirst({
      where: { id: questionId, examId: submission.examId },
    });
    if (!question) return null;

    return tx.answer.upsert({
      where: { submissionId_questionId: { submissionId: id, questionId } },
      update: { response },
      create: { submissionId: id, questionId, response },
    });
  });

  if (!answer) return NextResponse.json({ error: "Invalid question" }, { status: 400 });

  // Exam Session Binding + Time Anomaly Review v1 — coarse telemetry only
  // (length/hash/delta, never the full response text duplicated). Never
  // blocks the answer save: both calls are fire-and-forget and swallow
  // their own errors internally.
  findMostRecentSessionId(id)
    .then((examAttemptSessionId) =>
      recordAnswerSavedActivity({ submissionId: id, questionId, examAttemptSessionId, response }),
    )
    .catch(() => {});

  return NextResponse.json({ questionId: answer.questionId, response: answer.response });
}

export const dynamic = "force-dynamic";
