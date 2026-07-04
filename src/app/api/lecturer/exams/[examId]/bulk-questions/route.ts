import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { institutionWhere, institutionErrorResponse } from "@/lib/institutionScope";
import { parseBulkQuestionsText } from "@/lib/bulkQuestionParser";
import {
  validateManualDraft,
  normalizeManualDraft,
  type ManualQuestionDraft,
  type NormalizedQuestion,
} from "@/lib/manualQuestionDraft";

const manualDraftSchema = z.object({
  type: z.enum(["MULTIPLE_CHOICE", "SHORT_ANSWER", "ESSAY"]),
  text: z.string(),
  options: z.array(z.string()).default([]),
  correctAnswer: z.string().default(""),
  points: z.number(),
});

const bulkQuestionsSchema = z
  .object({
    text: z.string().optional(),
    questions: z.array(manualDraftSchema).optional(),
    saveToBankId: z.string().optional(),
  })
  .refine((data) => Boolean(data.text) || Boolean(data.questions?.length), {
    message: "Provide either text or a non-empty questions array",
  });

/**
 * Assessment Operations v1 bulk/manual question entry — see
 * docs/assessment-operations-v1.md. Accepts either the structured-text
 * paste format (`text`) or an array of manually-filled draft cards
 * (`questions`, from the repeatable "Add questions" cards on the exam
 * edit page). Either way, the server re-validates every question itself
 * (never trusts a client-computed preview) and saves all-or-nothing —
 * if any question is invalid, nothing is created.
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

    let questions: NormalizedQuestion[];

    if (parsed.data.text) {
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
      questions = rows.map((row) => ({
        type: row.type!,
        text: row.text,
        options: row.options,
        correctAnswer: row.correctAnswer,
        points: row.points!,
      }));
    } else {
      const drafts = parsed.data.questions as ManualQuestionDraft[];
      const rows = drafts.map((draft, i) => ({ index: i, errors: validateManualDraft(draft) }));
      const invalidCount = rows.filter((r) => r.errors.length > 0).length;
      if (invalidCount > 0) {
        return NextResponse.json(
          { error: "Some questions are invalid — fix the errors below and try again.", rows },
          { status: 400 },
        );
      }
      questions = drafts.map(normalizeManualDraft);
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
      for (const q of questions) {
        await tx.question.create({
          data: {
            examId,
            type: q.type,
            text: q.text,
            options: q.options.length > 0 ? q.options : undefined,
            correctAnswer: q.correctAnswer ?? undefined,
            points: q.points,
            order: nextOrder++,
          },
        });
        count++;

        if (bank) {
          await tx.bankQuestion.create({
            data: {
              bankId: bank.id,
              type: q.type,
              text: q.text,
              optionsJson: q.options.length > 0 ? JSON.stringify(q.options) : undefined,
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
