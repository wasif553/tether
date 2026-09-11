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

  const answers = await prisma.answer.findMany({
    where: {
      aiDraftScore: null,
      question: { type: "ESSAY", examId },
      submission: { status: "SUBMITTED" },
    },
    include: { question: true },
  });

  let marked = 0;
  let skipped = 0;

  for (const answer of answers) {
    if (!answer.response) {
      skipped++;
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

      marked++;
    } catch (err) {
      console.error(`AI essay marking failed for answer ${answer.id}:`, err);
      skipped++;
    }
  }

  return NextResponse.json({ marked, skipped });
}

export const dynamic = "force-dynamic";
