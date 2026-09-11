/**
 * AI Marking Assistance v1 — exam-wide "regenerate AI suggestions". See
 * docs/ai-marking-assistance-v1.md.
 *
 * POST /api/lecturer/exams/[examId]/ai-mark-essays/regenerate
 *
 * Unlike the "missing only" POST /api/lecturer/exams/[examId]/ai-mark-essays,
 * this DELIBERATELY overwrites every eligible essay answer's existing AI
 * draft (Answer.aiDraftScore/aiReasoning/aiGradedAt) with a fresh one,
 * generated against each question's CURRENT Question.aiMarkingGuide (or
 * the default rubric if none is set) — never the guide a stale draft
 * happened to be generated with. This is a deliberate, lecturer-
 * confirmed action (the UI requires a confirmation dialog before
 * calling this), so overwriting an existing AI DRAFT here is intended,
 * not a regression of the "missing only" action's own skip behaviour.
 *
 * Never touches anything else: Submission.status, Submission.totalScore,
 * Answer.score, Answer.feedback, Answer.response, or any non-ESSAY
 * answer. Only the three AI-draft fields on an eligible ESSAY answer are
 * ever written — the lecturer's own manual scores/feedback and any
 * already-finalized grade are completely unaffected, because this route
 * never reads or writes Answer.score/feedback or Submission.status/
 * totalScore at all.
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { markEssay, buildDefaultRubric, buildLecturerGuideRubric, EssayMarkingError, type AiMarkingRecord } from "@/lib/ai/essayMarker";
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

  // Same eligibility as the "missing only" action — every essay answer
  // on a SUBMITTED submission — but here EVERY one is a regeneration
  // candidate regardless of whether it already has a draft.
  const eligibleAnswers = await prisma.answer.findMany({
    where: {
      question: { type: "ESSAY", examId },
      submission: { status: "SUBMITTED" },
    },
    include: { question: true },
  });

  let regenerated = 0;
  let failed = 0;
  let skipped = 0;
  const defaultRubricQuestionIds = new Set<string>();

  for (const answer of eligibleAnswers) {
    if (!answer.response) {
      skipped++;
      continue;
    }

    try {
      // Always the question's CURRENT saved guide, read fresh on every
      // call — never whatever guide (if any) an existing draft was
      // generated with.
      const guideText = answer.question.aiMarkingGuide?.trim() || null;
      const rubric = guideText
        ? buildLecturerGuideRubric(guideText, answer.question.points)
        : buildDefaultRubric(answer.question.points);
      const rubricSource: AiMarkingRecord["rubricSource"] = guideText ? "LECTURER" : "DEFAULT";
      if (!guideText) defaultRubricQuestionIds.add(answer.questionId);

      const result = await markEssay({
        subject: exam.title,
        question: answer.question.text,
        rubric,
        totalMarks: answer.question.points,
        studentResponse: answer.response,
      });

      const stored: AiMarkingRecord = { ...result, rubricSource, rubric, lecturerGuideText: guideText };

      // Deliberately overwrites any existing draft (that is the entire
      // point of this route) — only ever the three AI-draft fields.
      await prisma.answer.update({
        where: { id: answer.id },
        data: {
          aiDraftScore: result.totalScore,
          aiReasoning: JSON.stringify(stored),
          aiGradedAt: new Date(),
        },
      });

      regenerated++;
    } catch (err) {
      if (err instanceof EssayMarkingError) {
        console.error(`AI essay regeneration failed for answer ${answer.id}:`, err.message);
      } else {
        console.error(`AI essay regeneration failed for answer ${answer.id}:`, err);
      }
      failed++;
    }
  }

  return NextResponse.json({
    eligible: eligibleAnswers.length,
    regenerated,
    failed,
    skipped,
    // How many DISTINCT questions (among those actually processed this
    // run) had no lecturer guide and used the default rubric — lets the
    // UI surface "N question(s) used Tether default rubric."
    defaultRubricQuestionCount: defaultRubricQuestionIds.size,
  });
}

export const dynamic = "force-dynamic";
