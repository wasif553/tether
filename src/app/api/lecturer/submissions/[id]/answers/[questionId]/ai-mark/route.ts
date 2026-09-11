/**
 * AI Marking Assistance v1 — single-answer, lecturer-triggered. See
 * docs/ai-marking-assistance-v1.md.
 *
 * POST /api/lecturer/submissions/[id]/answers/[questionId]/ai-mark
 *
 * The per-question counterpart to the existing exam-wide
 * POST /api/lecturer/exams/[examId]/ai-mark-essays (unchanged, still the
 * only bulk trigger): marks exactly ONE essay answer, optionally against a
 * lecturer-supplied marking guide, and never touches any other answer in
 * the exam. Reuses the same markEssay() engine and the same
 * Answer.aiDraftScore/aiReasoning/aiGradedAt fields the bulk action
 * already writes — never a new/parallel storage mechanism, never a
 * schema change. The lecturer remains the decision-maker: this only ever
 * writes a DRAFT suggestion, never Submission.status or Submission.totalScore.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
  markEssay,
  buildDefaultRubric,
  buildLecturerGuideRubric,
  EssayMarkingError,
  type AiMarkingRecord,
} from "@/lib/ai/essayMarker";
import { isPlatformAdmin, assertSameInstitution, institutionErrorResponse } from "@/lib/institutionScope";

const bodySchema = z.object({
  // Optional — an empty/omitted guide falls back to the existing default
  // rubric, exactly like the bulk action. Capped defensively (this is a
  // free-text field sent straight into the marking prompt); well above
  // any real marking guide's expected length.
  lecturerGuide: z.string().trim().max(4000).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; questionId: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, questionId } = await params;

  const submission = await prisma.submission.findUnique({
    where: { id },
    include: { exam: true },
  });
  if (!submission) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!isPlatformAdmin(session) && submission.exam.createdById !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  try {
    assertSameInstitution(session, submission.exam.institutionId);
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }

  // A moving target: the student may still be actively editing this
  // answer. AI marking (like manual grading — see PATCH
  // /api/submissions/[id]/grade) only ever runs against a finished
  // (SUBMITTED or GRADED) attempt's stored response.
  if (submission.status === "IN_PROGRESS") {
    return NextResponse.json({ error: "Student has not submitted yet" }, { status: 409 });
  }

  const question = await prisma.question.findUnique({ where: { id: questionId } });
  if (!question || question.examId !== submission.examId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // AI Marking Assistance is ESSAY-only in this pass — see
  // docs/ai-marking-assistance-v1.md, "Why ESSAY only". MULTIPLE_CHOICE
  // is already auto-graded exactly; SHORT_ANSWER is deliberately excluded
  // for now.
  if (question.type !== "ESSAY") {
    return NextResponse.json({ error: "AI marking assistance is only available for essay questions" }, { status: 400 });
  }

  const answer = await prisma.answer.findUnique({
    where: { submissionId_questionId: { submissionId: id, questionId } },
  });
  if (!answer?.response) {
    return NextResponse.json({ error: "This question has no student answer to mark" }, { status: 400 });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "Anthropic API key not configured" }, { status: 502 });
  }

  const body = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const guideText = parsed.data.lecturerGuide?.trim() || null;
  // A lecturer-supplied guide is passed through as ONE criterion, its
  // description the lecturer's own text verbatim — never split,
  // reinterpreted, or supplemented with invented criteria (see
  // buildLecturerGuideRubric's own doc comment). maxMarks is always the
  // question's real points, so the guide can never push scoring outside
  // the question's actual mark range.
  const rubric = guideText ? buildLecturerGuideRubric(guideText, question.points) : buildDefaultRubric(question.points);
  const rubricSource: AiMarkingRecord["rubricSource"] = guideText ? "LECTURER" : "DEFAULT";

  let result;
  try {
    result = await markEssay({
      subject: submission.exam.title,
      question: question.text,
      rubric,
      totalMarks: question.points,
      studentResponse: answer.response,
    });
  } catch (err) {
    if (err instanceof EssayMarkingError) {
      return NextResponse.json({ error: `AI marking failed: ${err.message}` }, { status: 502 });
    }
    throw err;
  }

  const stored: AiMarkingRecord = { ...result, rubricSource, rubric, lecturerGuideText: guideText };
  const aiReasoning = JSON.stringify(stored);
  const aiGradedAt = new Date();

  await prisma.answer.update({
    where: { submissionId_questionId: { submissionId: id, questionId } },
    data: { aiDraftScore: result.totalScore, aiReasoning, aiGradedAt },
  });

  return NextResponse.json({
    questionId,
    aiDraftScore: result.totalScore,
    aiReasoning,
    aiGradedAt: aiGradedAt.toISOString(),
  });
}

export const dynamic = "force-dynamic";
