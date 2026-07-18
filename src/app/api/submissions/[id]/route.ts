import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseSecureSettings, questionPoolsActive } from "@/lib/secureExam";
import { canStudentViewMarks, submissionDeadline } from "@/lib/assessmentLifecycle";
import { resolveEffectiveQuestionIds } from "@/lib/questionDelivery";

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
      student: { select: { id: true, name: true, email: true, institutionStudentId: true } },
    },
  });

  if (!submission) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const isOwner = submission.studentId === session.user.id;
  const isExamOwner =
    session.user.role === "LECTURER" && submission.exam.createdById === session.user.id;
  if (!isOwner && !isExamOwner) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const deadline = submissionDeadline(submission.startedAt, submission.exam.durationMins);
  const studentCanViewMarks = canStudentViewMarks({
    role: session.user.role,
    isOwner,
    marksReleasedAt: submission.exam.marksReleasedAt,
  });
  const canViewMarks = isExamOwner || studentCanViewMarks;
  const canViewQuestionPoints =
    isExamOwner || submission.status === "IN_PROGRESS" || studentCanViewMarks;

  const settings = parseSecureSettings(submission.exam.secureSettings);
  // One-Question-At-A-Time Exam Delivery v1 — see
  // docs/one-question-delivery-v1.md. Only ever applies to the STUDENT's
  // own in-progress view — the lecturer's grading view (isExamOwner)
  // always gets the full question list regardless of this setting, since
  // it's a student-delivery concern, not a grading concern. The student
  // page instead fetches one question at a time from
  // GET/POST /api/submissions/[id]/question(-progress).
  const deliverOneQuestionAtATime =
    isOwner && !isExamOwner && settings.oneQuestionAtATime && submission.status === "IN_PROGRESS";

  // Question Pools v1 — see docs/question-pools-v1.md. Resolves to this
  // submission's persisted selected/ordered subset when pools are active
  // for this exam, otherwise the full exam question set unchanged
  // (resolveEffectiveQuestionIds falls back to the full set on its own
  // when nothing valid is stored, or when pools aren't active at all).
  // Applied to BOTH the student's own view and the lecturer's grading
  // view of this submission — a lecturer reviewing one student's
  // attempt should see exactly the questions that student was actually
  // given, not the full pool/question bank (which remains visible
  // elsewhere, in the exam editor).
  const effectiveQuestionIds = resolveEffectiveQuestionIds({
    examQuestionIds: submission.exam.questions.map((q) => q.id),
    stored: submission.questionOrderJson,
    questionPoolsActive: questionPoolsActive(settings),
  });
  const effectiveQuestionIdSet = new Set(effectiveQuestionIds);
  const effectiveOrderIndex = new Map(effectiveQuestionIds.map((qid, i) => [qid, i]));
  const effectiveQuestions = submission.exam.questions
    .filter((q) => effectiveQuestionIdSet.has(q.id))
    .sort((a, b) => effectiveOrderIndex.get(a.id)! - effectiveOrderIndex.get(b.id)!);

  const questions = deliverOneQuestionAtATime
    ? []
    : effectiveQuestions.map((q) => ({
        id: q.id,
        type: q.type,
        text: q.text,
        options: q.options,
        points: canViewQuestionPoints ? q.points : undefined,
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
    attemptNumber: submission.attemptNumber,
    startedAt: submission.startedAt,
    submittedAt: submission.submittedAt,
    totalScore: canViewMarks ? submission.totalScore : null,
    deadline,
    marksReleasedAt: submission.exam.marksReleasedAt,
    marksReleased: submission.exam.marksReleasedAt != null,
    canvasPassback,
    // Optional Student Verification v1 — see
    // docs/on-device-ai-integrity-detection-v1.md. Never includes
    // passwordHash or any other sensitive field.
    student: {
      // id is included only for the Exam Watermark v1 fallback identifier
      // (see src/lib/examWatermark.ts) — used only when institutionStudentId
      // and email are both unavailable, and only ever shown truncated to 8
      // characters, never the raw id.
      id: submission.student.id,
      name: submission.student.name,
      email: submission.student.email,
      institutionStudentId: submission.student.institutionStudentId,
    },
    exam: {
      id: submission.exam.id,
      title: submission.exam.title,
      questions,
      // Present even when `questions` is empty (one-question mode) so the
      // student page can render "Question X of N" without needing the
      // full question list. Reflects the SELECTED question count when
      // question pools are active, never the full exam/pool question
      // count.
      totalQuestions: effectiveQuestionIds.length,
      secureSettings: settings,
    },
    answers: submission.answers.map((a) => ({
      questionId: a.questionId,
      response: a.response,
      score: canViewMarks ? a.score : undefined,
      feedback: canViewMarks ? a.feedback : undefined,
      aiDraftScore: isExamOwner ? a.aiDraftScore : undefined,
      aiReasoning: isExamOwner ? a.aiReasoning : undefined,
    })),
  });
}

export const dynamic = "force-dynamic";
