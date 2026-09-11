/**
 * AI Marking Assistance v1 — exam-wide "generate missing AI suggestions".
 * See docs/ai-marking-assistance-v1.md.
 *
 * POST /api/lecturer/exams/[examId]/ai-mark-essays
 *
 * Generates an AI draft ONLY for an eligible essay answer that doesn't
 * already have one (Answer.aiDraftScore is null) — an answer that
 * already has a draft (from an earlier run of this same action, a
 * single-answer "Get AI marking suggestion" request, or a prior
 * cohort-wide regeneration) is intentionally left untouched. For
 * cohort-wide regeneration after a marking guide is added or changed,
 * see the separate POST /api/lecturer/exams/[examId]/ai-mark-essays/regenerate.
 *
 * Always reports a full, honest breakdown — never a silent no-op: how
 * many essay answers were eligible in total, how many got a NEW
 * suggestion this run, how many already had one (intentionally
 * skipped), and how many failed.
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { markEssay, buildDefaultRubric, buildLecturerGuideRubric, type AiMarkingRecord } from "@/lib/ai/essayMarker";
import { institutionWhere, institutionErrorResponse } from "@/lib/institutionScope";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ examId: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { examId } = await params;
  let exam;
  try {
    exam = await prisma.exam.findFirst({
      where: { id: examId, createdById: session.user.id, ...institutionWhere(session) },
    });
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
  if (!exam) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "Anthropic API key not configured" },
      { status: 502 },
    );
  }

  // Every eligible essay answer, regardless of whether it already has a
  // draft — needed so the response can honestly report "already had a
  // suggestion" rather than silently omitting those from every count
  // (the previous version's WHERE aiDraftScore: null meant an exam
  // where every answer already had a draft returned {marked: 0,
  // skipped: 0} with no way to tell "nothing eligible" apart from
  // "everything already done").
  const eligibleAnswers = await prisma.answer.findMany({
    where: {
      question: { type: "ESSAY", examId },
      submission: { status: "SUBMITTED" },
    },
    include: { question: true },
  });

  let generated = 0;
  let alreadySuggested = 0;
  let failed = 0;

  for (const answer of eligibleAnswers) {
    if (answer.aiDraftScore != null) {
      alreadySuggested++;
      continue;
    }
    if (!answer.response) {
      failed++;
      continue;
    }

    try {
      // Question-level guide (configured once on the "AI Marking Guides"
      // page — see docs/ai-marking-assistance-v1.md) is used automatically
      // for every eligible answer to this question, exam-wide. Falls back
      // to the existing default rubric when no guide is configured.
      const guideText = answer.question.aiMarkingGuide?.trim() || null;
      const rubric = guideText
        ? buildLecturerGuideRubric(guideText, answer.question.points)
        : buildDefaultRubric(answer.question.points);
      const rubricSource: AiMarkingRecord["rubricSource"] = guideText ? "LECTURER" : "DEFAULT";
      const result = await markEssay({
        subject: exam.title,
        question: answer.question.text,
        rubric,
        totalMarks: answer.question.points,
        studentResponse: answer.response,
      });

      // Stores the same enriched record shape the single-answer endpoint
      // uses, so the grading page's "Based on Tether default rubric" /
      // "Based on lecturer marking guide" line renders correctly
      // regardless of which path produced the draft.
      const stored: AiMarkingRecord = { ...result, rubricSource, rubric, lecturerGuideText: guideText };

      await prisma.answer.update({
        where: { id: answer.id },
        data: {
          aiDraftScore: result.totalScore,
          aiReasoning: JSON.stringify(stored),
          aiGradedAt: new Date(),
        },
      });

      generated++;
    } catch (err) {
      console.error(`AI essay marking failed for answer ${answer.id}:`, err);
      failed++;
    }
  }

  return NextResponse.json({ eligible: eligibleAnswers.length, generated, alreadySuggested, failed });
}

export const dynamic = "force-dynamic";
