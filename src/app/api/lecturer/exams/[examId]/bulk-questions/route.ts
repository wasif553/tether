import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { institutionWhere, institutionErrorResponse } from "@/lib/institutionScope";
import { parseBulkQuestionsText } from "@/lib/bulkQuestionParser";

const bulkQuestionsSchema = z.object({
  text: z.string().min(1),
  saveToBankId: z.string().optional(),
});

/**
 * Assessment Operations v1 bulk question entry — see
 * docs/assessment-operations-v1.md. Re-parses/re-validates the raw text
 * server-side (never trusts a client-computed preview) and saves
 * all-or-nothing: if any row is invalid, nothing is created.
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
      include: { course: { select: { code: true } } },
    });
    if (!exam) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const body = await req.json();
    const parsed = bulkQuestionsSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const { rows, invalidCount } = parseBulkQuestionsText(parsed.data.text);
    if (rows.length === 0) {
      return NextResponse.json({ error: "No questions found in the pasted text" }, { status: 400 });
    }
    if (invalidCount > 0) {
      return NextResponse.json(
        { error: "Some questions are invalid — fix the errors below and try again.", rows },
        { status: 400 },
      );
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

    const created = await prisma.$transaction(async (tx) => {
      let count = 0;
      let bankSaved = 0;
      for (const row of rows) {
        await tx.question.create({
          data: {
            examId,
            type: row.type!,
            text: row.text,
            options: row.options.length > 0 ? row.options : undefined,
            correctAnswer: row.correctAnswer ?? undefined,
            points: row.points!,
            order: nextOrder++,
          },
        });
        count++;

        if (bank) {
          await tx.bankQuestion.create({
            data: {
              bankId: bank.id,
              type: row.type!,
              text: row.text,
              optionsJson: row.options.length > 0 ? JSON.stringify(row.options) : undefined,
              correctAnswer: row.correctAnswer ?? undefined,
              points: row.points!,
              topic: exam.course?.code ?? undefined,
            },
          });
          bankSaved++;
        }
      }
      return { count, bankSaved };
    });

    return NextResponse.json({
      created: created.count,
      bankSaved: created.bankSaved,
      warning: exam.published
        ? "This exam is published — the imported questions are now visible/available to students."
        : undefined,
    });
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export const dynamic = "force-dynamic";
