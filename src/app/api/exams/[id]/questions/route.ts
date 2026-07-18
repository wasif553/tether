import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { institutionWhere, institutionErrorResponse } from "@/lib/institutionScope";

const createQuestionSchema = z.object({
  type: z.enum(["MULTIPLE_CHOICE", "SHORT_ANSWER", "ESSAY"]),
  text: z.string().min(1),
  options: z.array(z.string()).optional(),
  correctAnswer: z.string().optional(),
  points: z.number().int().positive().default(1),
  // Question Pools v1 — see docs/question-pools-v1.md. Omitted/null means
  // "no pool" — always included for every student.
  questionPoolId: z.string().min(1).nullable().optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { id } = await params;
    const exam = await prisma.exam.findFirst({
      where: { id, createdById: session.user.id, ...institutionWhere(session) },
    });
    if (!exam) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const body = await req.json();
    const parsed = createQuestionSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const { type, text, options, correctAnswer, points, questionPoolId } = parsed.data;

    // A pool id must belong to this same exam — never let a question be
    // assigned to another exam's pool.
    if (questionPoolId) {
      const pool = await prisma.questionPool.findFirst({ where: { id: questionPoolId, examId: id } });
      if (!pool) return NextResponse.json({ error: "Invalid question pool" }, { status: 400 });
    }

    const lastQuestion = await prisma.question.findFirst({
      where: { examId: id },
      orderBy: { order: "desc" },
    });

    const question = await prisma.question.create({
      data: {
        examId: id,
        type,
        text,
        options: options ?? undefined,
        correctAnswer,
        points,
        order: (lastQuestion?.order ?? -1) + 1,
        questionPoolId: questionPoolId ?? undefined,
      },
    });

    return NextResponse.json(question, { status: 201 });
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export const dynamic = "force-dynamic";
