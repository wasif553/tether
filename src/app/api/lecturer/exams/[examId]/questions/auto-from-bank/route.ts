/**
 * Pool Selection Refinement v1 — see docs/pool-selection-refinement-v1.md.
 *
 * POST /api/lecturer/exams/[examId]/questions/auto-from-bank
 *
 * "Select automatically" mode of the Add-from-Question-Bank flow — the
 * BANK -> EXAM POOL CONSTRUCTION stage. Given exact per-difficulty
 * quotas (e.g. 10 Easy / 5 Medium / 5 Hard = 20 total), randomly selects
 * that many eligible BankQuestions and copies them into the target pool,
 * using the exact same copy semantics as the manual `from-bank` route
 * (mapBankQuestionToQuestionData — a fully independent Question row per
 * copy, never a live link) and the exact same duplicate-detection rule
 * (Question.sourceBankQuestionId already copied into this exam is never
 * re-copied).
 *
 * If any requested band has fewer eligible questions than requested, OR
 * the optional student-draw quota would exceed what the resulting pool
 * can actually deliver, nothing is created — this route never silently
 * reduces a quota or partially copies. The caller gets back exactly
 * which band(s) fell short so the lecturer can adjust the numbers.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { institutionWhere, institutionErrorResponse } from "@/lib/institutionScope";
import { mapBankQuestionToQuestionData } from "@/lib/questionBank";
import { shuffleWithRng } from "@/lib/questionDelivery";
import { QUESTION_DIFFICULTIES, type QuestionDifficulty } from "@/lib/questionDifficulty";

const difficultyQuotaSchema = z.object({
  easy: z.number().int().min(0),
  medium: z.number().int().min(0),
  hard: z.number().int().min(0),
});

const autoDeliverySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("EXISTING_POOL"), poolId: z.string().min(1) }),
  z.object({ kind: z.literal("NEW_POOL"), name: z.string().min(1) }),
]);

const autoFromBankSchema = z.object({
  bankId: z.string().min(1),
  filters: z
    .object({
      type: z.enum(["MULTIPLE_CHOICE", "SHORT_ANSWER", "ESSAY"]).optional(),
      topic: z.string().min(1).optional(),
    })
    .optional(),
  quotas: difficultyQuotaSchema,
  delivery: autoDeliverySchema,
  // Optional STUDENT ATTEMPT DELIVERY stage — a separate distribution
  // from `quotas` above (pool composition). Omitted = leave the pool's
  // existing draw configuration untouched.
  studentDraw: difficultyQuotaSchema.optional(),
});

function difficultyCounts(items: { difficulty: string | null }[]): Record<QuestionDifficulty, number> {
  return {
    easy: items.filter((i) => i.difficulty === "easy").length,
    medium: items.filter((i) => i.difficulty === "medium").length,
    hard: items.filter((i) => i.difficulty === "hard").length,
  };
}

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
    const parsed = autoFromBankSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const { bankId, filters, quotas, delivery, studentDraw } = parsed.data;

    const totalRequested = quotas.easy + quotas.medium + quotas.hard;
    if (totalRequested === 0) {
      return NextResponse.json({ error: "Request at least one question (Easy/Medium/Hard quotas are all 0)." }, { status: 400 });
    }

    // Bank ownership — see the manual from-bank route's own doc comment
    // for why this is a plain lecturerId-equality check.
    const bank = await prisma.questionBank.findFirst({ where: { id: bankId, lecturerId: session.user.id } });
    if (!bank) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Resolve the target pool up front — needed both to know its
    // CURRENT composition (for the student-draw feasibility check below,
    // EXISTING_POOL only) and as the assignment target for the copies.
    let existingPool: { id: string; name: string } | null = null;
    if (delivery.kind === "EXISTING_POOL") {
      const pool = await prisma.questionPool.findFirst({ where: { id: delivery.poolId, examId } });
      if (!pool) return NextResponse.json({ error: "Invalid question pool" }, { status: 400 });
      existingPool = { id: pool.id, name: pool.name };
    }

    // Eligible BankQuestions: only ones with a RECORDED difficulty (a
    // question with no difficulty cannot honestly satisfy a difficulty
    // quota), matching the optional type/topic filters, not already
    // copied into this exam.
    const eligible = await prisma.bankQuestion.findMany({
      where: {
        bankId,
        difficulty: { in: [...QUESTION_DIFFICULTIES] },
        ...(filters?.type ? { type: filters.type } : {}),
        ...(filters?.topic ? { topic: { contains: filters.topic, mode: "insensitive" } } : {}),
      },
    });

    const alreadyCopied = await prisma.question.findMany({
      where: { examId, sourceBankQuestionId: { in: eligible.map((q) => q.id) } },
      select: { sourceBankQuestionId: true },
    });
    const alreadyCopiedIds = new Set(alreadyCopied.map((q) => q.sourceBankQuestionId));
    const eligibleFresh = eligible.filter((q) => !alreadyCopiedIds.has(q.id));

    const byDifficulty: Record<QuestionDifficulty, typeof eligibleFresh> = {
      easy: eligibleFresh.filter((q) => q.difficulty === "easy"),
      medium: eligibleFresh.filter((q) => q.difficulty === "medium"),
      hard: eligibleFresh.filter((q) => q.difficulty === "hard"),
    };

    // Section 8 — never silently reduce a quota. Collect EVERY band
    // that falls short and block the whole request if any do.
    const shortfalls = QUESTION_DIFFICULTIES.filter((d) => quotas[d] > byDifficulty[d].length).map((d) => ({
      difficulty: d,
      requested: quotas[d],
      available: byDifficulty[d].length,
    }));
    if (shortfalls.length > 0) {
      return NextResponse.json(
        {
          error: "Not enough eligible questions for the requested quotas.",
          shortfalls,
          message: shortfalls
            .map((s) => `Only ${s.available} ${s.difficulty} question${s.available === 1 ? "" : "s"} available; ${s.requested} requested.`)
            .join(" "),
        },
        { status: 400 },
      );
    }

    // Section 9/10 — a student-draw quota must never exceed what the
    // resulting pool will actually contain. Computed against CURRENT
    // pool composition (EXISTING_POOL) plus what this call is about to
    // add, so this is honest even for a pool that already has questions.
    if (studentDraw) {
      let currentComposition: Record<QuestionDifficulty, number> = { easy: 0, medium: 0, hard: 0 };
      if (existingPool) {
        const currentQuestions = await prisma.question.findMany({
          where: { questionPoolId: existingPool.id },
          select: { difficulty: true },
        });
        currentComposition = difficultyCounts(currentQuestions);
      }
      const resultingComposition = {
        easy: currentComposition.easy + quotas.easy,
        medium: currentComposition.medium + quotas.medium,
        hard: currentComposition.hard + quotas.hard,
      };
      const drawShortfalls = QUESTION_DIFFICULTIES.filter((d) => studentDraw[d] > resultingComposition[d]).map((d) => ({
        difficulty: d,
        requested: studentDraw[d],
        available: resultingComposition[d],
      }));
      if (drawShortfalls.length > 0) {
        return NextResponse.json(
          {
            error: "Student draw quota exceeds the resulting pool's composition.",
            shortfalls: drawShortfalls,
            message: drawShortfalls
              .map((s) => `Draw ${s.requested} ${s.difficulty}, but the pool will only contain ${s.available} ${s.difficulty} question${s.available === 1 ? "" : "s"}.`)
              .join(" "),
          },
          { status: 400 },
        );
      }
    }

    // Random selection — exact quota per band, never approximate.
    const selected = QUESTION_DIFFICULTIES.flatMap((d) =>
      shuffleWithRng(byDifficulty[d]).slice(0, quotas[d]),
    );

    const lastPool = await prisma.questionPool.findFirst({ where: { examId }, orderBy: { order: "desc" } });
    const lastQuestion = await prisma.question.findFirst({ where: { examId }, orderBy: { order: "desc" } });
    let nextOrder = (lastQuestion?.order ?? -1) + 1;

    const result = await prisma.$transaction(async (tx) => {
      const pool =
        delivery.kind === "NEW_POOL"
          ? await tx.questionPool.create({
              data: {
                examId,
                name: delivery.name,
                order: (lastPool?.order ?? -1) + 1,
                drawCountEasy: studentDraw?.easy ?? null,
                drawCountMedium: studentDraw?.medium ?? null,
                drawCountHard: studentDraw?.hard ?? null,
              },
            })
          : await tx.questionPool.update({
              where: { id: existingPool!.id },
              data: studentDraw
                ? {
                    drawCountEasy: studentDraw.easy,
                    drawCountMedium: studentDraw.medium,
                    drawCountHard: studentDraw.hard,
                  }
                : {},
            });

      const created = await Promise.all(
        selected.map((bankQuestion) =>
          tx.question.create({
            data: {
              ...mapBankQuestionToQuestionData(bankQuestion, examId, nextOrder++),
              questionPoolId: pool.id,
            },
          }),
        ),
      );

      return { pool, created };
    });

    return NextResponse.json({
      created: result.created.length,
      poolId: result.pool.id,
      poolName: result.pool.name,
      composition: { easy: quotas.easy, medium: quotas.medium, hard: quotas.hard },
      bankEligibleTotal: eligibleFresh.length,
      studentDraw: studentDraw ?? null,
    });
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export const dynamic = "force-dynamic";
