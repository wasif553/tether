/**
 * Question Bank / Exam Pools redesign v1 — see
 * docs/question-bank-exam-pools-v1.md.
 *
 * POST /api/lecturer/exams/[examId]/questions/from-bank
 *
 * The one Bank -> Exam copy endpoint, used by both the exam page's "Add
 * from Question Bank" flow and the bank page's "Add to exam" flow.
 * Every copy is a fully independent Question row (see
 * mapBankQuestionToQuestionData in src/lib/questionBank.ts) — editing or
 * deleting the source BankQuestion afterward never touches it.
 *
 * `delivery` decides where the copies land:
 *  - REQUIRED: questionPoolId stays null — always included for every
 *    student attempt (Question Pools v1 semantics, unchanged).
 *  - EXISTING_POOL: assigned to an existing pool already on this exam.
 *  - NEW_POOL: a new pool is created first (same append-order convention
 *    as POST /api/exams/[id]/question-pools), then every copy is
 *    assigned to it.
 *
 * Duplicate protection: any bankQuestionId already copied into this exam
 * (Question.sourceBankQuestionId) is skipped, never re-copied — reported
 * back distinctly from newly-created ones so the caller can warn the
 * lecturer rather than silently doing nothing or erroring the whole
 * batch.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { institutionWhere, institutionErrorResponse } from "@/lib/institutionScope";
import { mapBankQuestionToQuestionData } from "@/lib/questionBank";

const deliverySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("REQUIRED") }),
  z.object({ kind: z.literal("EXISTING_POOL"), poolId: z.string().min(1) }),
  z.object({ kind: z.literal("NEW_POOL"), name: z.string().min(1), drawCount: z.number().int().positive().nullable().optional() }),
]);

const fromBankSchema = z.object({
  bankId: z.string().min(1),
  bankQuestionIds: z.array(z.string().min(1)).min(1),
  delivery: deliverySchema,
});

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
    const parsed = fromBankSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const { bankId, bankQuestionIds, delivery } = parsed.data;

    // Bank ownership — a lecturer may only copy from their own bank. See
    // src/lib/questionBank.ts's own doc comment for why this is a plain
    // lecturerId-equality check rather than institutionWhere: a bank has
    // no shared/institution-wide visibility at all today, so ownership
    // by exact user id is already the full boundary.
    const bank = await prisma.questionBank.findFirst({ where: { id: bankId, lecturerId: session.user.id } });
    if (!bank) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const bankQuestions = await prisma.bankQuestion.findMany({
      where: { id: { in: bankQuestionIds }, bankId },
    });
    if (bankQuestions.length !== bankQuestionIds.length) {
      return NextResponse.json({ error: "One or more bank questions were not found" }, { status: 404 });
    }

    // Duplicate detection (Part 16) — now that Question.sourceBankQuestionId
    // exists, this is a real, indexed lookup, never text-equality
    // guessing. Already-copied ids are skipped, never re-copied.
    const alreadyCopied = await prisma.question.findMany({
      where: { examId, sourceBankQuestionId: { in: bankQuestionIds } },
      select: { sourceBankQuestionId: true },
    });
    const alreadyCopiedIds = new Set(alreadyCopied.map((q) => q.sourceBankQuestionId));
    const toCopy = bankQuestions.filter((q) => !alreadyCopiedIds.has(q.id));
    const skippedAsDuplicate = bankQuestions.filter((q) => alreadyCopiedIds.has(q.id)).map((q) => q.id);

    if (toCopy.length === 0) {
      return NextResponse.json({ created: 0, skippedAsDuplicate, poolId: null });
    }

    // Resolve the target pool (if any) BEFORE the transaction — a new
    // pool's own creation does not need to be atomic with the question
    // copies (an empty pool with 0 questions is a perfectly valid,
    // harmless state if the transaction below were to fail).
    let poolId: string | null = null;
    if (delivery.kind === "EXISTING_POOL") {
      const pool = await prisma.questionPool.findFirst({ where: { id: delivery.poolId, examId } });
      if (!pool) return NextResponse.json({ error: "Invalid question pool" }, { status: 400 });
      poolId = pool.id;
    } else if (delivery.kind === "NEW_POOL") {
      const lastPool = await prisma.questionPool.findFirst({ where: { examId }, orderBy: { order: "desc" } });
      const pool = await prisma.questionPool.create({
        data: {
          examId,
          name: delivery.name,
          drawCount: delivery.drawCount ?? null,
          order: (lastPool?.order ?? -1) + 1,
        },
      });
      poolId = pool.id;
    }

    const lastQuestion = await prisma.question.findFirst({ where: { examId }, orderBy: { order: "desc" } });
    let nextOrder = (lastQuestion?.order ?? -1) + 1;

    const created = await prisma.$transaction(
      toCopy.map((bankQuestion) =>
        prisma.question.create({
          data: {
            ...mapBankQuestionToQuestionData(bankQuestion, examId, nextOrder++),
            questionPoolId: poolId ?? undefined,
          },
        }),
      ),
    );

    return NextResponse.json({ created: created.length, skippedAsDuplicate, poolId });
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export const dynamic = "force-dynamic";
