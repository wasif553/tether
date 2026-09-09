import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { generatedQuestionsSchema } from "@/lib/ai/questionGenerator";
import { institutionWhere, institutionErrorResponse } from "@/lib/institutionScope";
import type { Prisma } from "@/generated/prisma/client";

const bulkImportSchema = z.object({
  questions: generatedQuestionsSchema,
  // Question Bank / Exam Pools redesign v1 (Part 8) — "Add selected to
  // exam + Question Bank", mirroring the same optional field the manual/
  // bulk-paste route (bulk-questions) already had for the AI path.
  saveToBankId: z.string().optional(),
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

  try {
    const { examId } = await params;
    const exam = await prisma.exam.findFirst({
      where: { id: examId, createdById: session.user.id, ...institutionWhere(session) },
      include: { course: { select: { code: true } } },
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
      return NextResponse.json({ created: 0, bankSaved: 0 });
    }

    let bank: { id: string; lecturerId: string } | null = null;
    if (parsed.data.saveToBankId) {
      bank = await prisma.questionBank.findUnique({
        where: { id: parsed.data.saveToBankId },
        select: { id: true, lecturerId: true },
      });
      if (!bank || bank.lecturerId !== session.user.id) {
        return NextResponse.json(
          { error: "You can only save to your own question banks" },
          { status: 403 },
        );
      }
    }

    const lastQuestion = await prisma.question.findFirst({
      where: { examId },
      orderBy: { order: "desc" },
    });
    let nextOrder = (lastQuestion?.order ?? -1) + 1;

    const data: (Prisma.QuestionCreateManyInput & { options?: string[] })[] = parsed.data.questions.map((q) => {
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
        // Question Bank / Exam Pools redesign v1 — every question this
        // route creates came from the AI question-generation pipeline.
        source: "AI_GENERATED",
      };
    });

    const result = await prisma.$transaction(async (tx) => {
      let count = 0;
      let bankSaved = 0;
      for (const q of data) {
        await tx.question.create({ data: q });
        count++;

        if (bank) {
          await tx.bankQuestion.create({
            data: {
              bankId: bank.id,
              type: q.type,
              text: q.text,
              optionsJson: q.options && q.options.length > 0 ? JSON.stringify(q.options) : undefined,
              correctAnswer: q.correctAnswer ?? undefined,
              points: q.points,
              topic: exam.course?.code ?? undefined,
            },
          });
          bankSaved++;
        }
      }
      return { count, bankSaved };
    });

    return NextResponse.json({ created: result.count, bankSaved: result.bankSaved });
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export const dynamic = "force-dynamic";
