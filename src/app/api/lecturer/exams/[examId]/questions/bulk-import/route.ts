import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { generatedQuestionsSchema } from "@/lib/ai/questionGenerator";
import type { Prisma } from "@/generated/prisma/client";

const bulkImportSchema = z.object({
  questions: generatedQuestionsSchema,
});

const QUESTION_TYPE_MAP = {
  MCQ: "MULTIPLE_CHOICE",
  SHORT_ANSWER: "SHORT_ANSWER",
  ESSAY: "ESSAY",
} as const;

const POINTS_BY_DIFFICULTY = {
  easy: 1,
  medium: 2,
  hard: 3,
} as const;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ examId: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { examId } = await params;
  const exam = await prisma.exam.findFirst({
    where: { id: examId, createdById: session.user.id },
  });
  if (!exam) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await req.json();
  const parsed = bulkImportSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  if (parsed.data.questions.length === 0) {
    return NextResponse.json({ created: 0 });
  }

  const lastQuestion = await prisma.question.findFirst({
    where: { examId },
    orderBy: { order: "desc" },
  });
  let nextOrder = (lastQuestion?.order ?? -1) + 1;

  const data: Prisma.QuestionCreateManyInput[] = parsed.data.questions.map((q) => {
    // The model returns MCQ correctAnswer as a letter (A-D), but grading and the
    // exam-take UI compare the student's response against the literal option text.
    const correctAnswer =
      q.type === "MCQ" && q.options && q.correctAnswer
        ? q.options[q.correctAnswer.charCodeAt(0) - "A".charCodeAt(0)] ?? q.correctAnswer
        : q.type === "ESSAY"
          ? undefined
          : q.correctAnswer;

    return {
      examId,
      type: QUESTION_TYPE_MAP[q.type],
      text: q.body,
      options: q.type === "MCQ" ? q.options : undefined,
      correctAnswer,
      points: POINTS_BY_DIFFICULTY[q.difficulty],
      order: nextOrder++,
    };
  });

  const result = await prisma.question.createMany({ data });

  return NextResponse.json({ created: result.count });
}

export const dynamic = "force-dynamic";
