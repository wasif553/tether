import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { mapBankQuestionToQuestionData } from "@/lib/questionBank";
import { institutionWhere, institutionErrorResponse } from "@/lib/institutionScope";

const importSchema = z.object({
  bankQuestionIds: z.array(z.string()).min(1),
});

/**
 * Legacy simple import (no delivery choice, no duplicate detection) —
 * kept for the standalone /lecturer/exams/[id]/import-questions page.
 * Question Bank / Exam Pools redesign v1's richer flow (delivery choice,
 * duplicate detection) lives at
 * POST /api/lecturer/exams/[examId]/questions/from-bank instead — see
 * docs/question-bank-exam-pools-v1.md.
 */
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
    });
    if (!exam) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const body = await req.json();
    const parsed = importSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const bankQuestions = await prisma.bankQuestion.findMany({
      where: { id: { in: parsed.data.bankQuestionIds } },
      include: { bank: true },
    });

    if (bankQuestions.length !== parsed.data.bankQuestionIds.length) {
      return NextResponse.json({ error: "One or more bank questions were not found" }, { status: 404 });
    }

    const ownsAll = bankQuestions.every((q) => q.bank.lecturerId === session.user.id);
    if (!ownsAll) {
      return NextResponse.json(
        { error: "You can only import questions from your own question banks" },
        { status: 403 },
      );
    }

    const lastQuestion = await prisma.question.findFirst({
      where: { examId },
      orderBy: { order: "desc" },
    });
    let nextOrder = (lastQuestion?.order ?? -1) + 1;

    let imported = 0;
    for (const bankQuestion of bankQuestions) {
      await prisma.question.create({
        data: mapBankQuestionToQuestionData(bankQuestion, examId, nextOrder++),
      });
      imported++;
    }

    return NextResponse.json({ imported });
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export const dynamic = "force-dynamic";
