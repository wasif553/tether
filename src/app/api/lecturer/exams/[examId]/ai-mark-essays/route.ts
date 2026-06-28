import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { markEssay, type RubricCriterion } from "@/lib/ai/essayMarker";
import { institutionWhere, institutionErrorResponse } from "@/lib/institutionScope";

function buildDefaultRubric(points: number): RubricCriterion[] {
  return [
    {
      criterion: "Content & accuracy",
      description: "Response demonstrates understanding and accuracy",
      maxMarks: Math.ceil(points * 0.6),
    },
    {
      criterion: "Clarity & structure",
      description: "Response is well-organised and clearly expressed",
      maxMarks: Math.floor(points * 0.4),
    },
  ];
}

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

      await prisma.answer.update({
        where: { id: answer.id },
        data: {
          aiDraftScore: result.totalScore,
          aiReasoning: JSON.stringify(result),
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
