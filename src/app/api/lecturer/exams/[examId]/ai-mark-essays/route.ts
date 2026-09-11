import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { markEssay, buildDefaultRubric, type AiMarkingRecord } from "@/lib/ai/essayMarker";
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
      const rubric = buildDefaultRubric(answer.question.points);
      const result = await markEssay({
        subject: exam.title,
        question: answer.question.text,
        rubric,
        totalMarks: answer.question.points,
        studentResponse: answer.response,
      });

      // AI Marking Assistance — stores the same enriched record shape the
      // single-answer endpoint uses, so the grading page's "Based on
      // Tether default rubric" / "Based on lecturer marking guide" line
      // renders correctly regardless of which path produced the draft.
      // Never a lecturer guide here — this bulk action has no per-answer
      // input surface.
      const stored: AiMarkingRecord = { ...result, rubricSource: "DEFAULT", rubric, lecturerGuideText: null };

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
