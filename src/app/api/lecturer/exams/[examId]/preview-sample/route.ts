/**
 * Pool Selection Refinement v1 — see docs/pool-selection-refinement-v1.md.
 *
 * POST /api/lecturer/exams/[examId]/preview-sample
 *
 * Lecturer-only, read-only exam preview. Reuses the exact same pure
 * selection function real student delivery uses (buildSelectedQuestionIds,
 * src/lib/questionDelivery.ts) against the exam's live questions/pools,
 * but NEVER persists anything: no Submission, no IntegrityEvent, no
 * secure-client session, no questionOrderJson write. Every call is a
 * fresh, independent draw (a new Math.random() run) — nothing here is
 * seeded or reproducible, so "Generate another sample" is simply calling
 * this route again.
 *
 * When the exam has no active question pools, the result is the same
 * every call (every question is "required") — there is nothing random to
 * resample, so the caller can treat this as a plain static preview.
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { institutionWhere, institutionErrorResponse } from "@/lib/institutionScope";
import { buildSelectedQuestionIds } from "@/lib/questionDelivery";
import { parseSecureSettings, questionPoolsActive } from "@/lib/secureExam";

export async function POST(
  _req: Request,
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
      include: {
        questions: { orderBy: { order: "asc" } },
        questionPools: { orderBy: { order: "asc" } },
      },
    });
    if (!exam) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const settings = parseSecureSettings(exam.secureSettings);
    const poolsActive = questionPoolsActive(settings);

    const selectedIds = poolsActive
      ? new Set(
          buildSelectedQuestionIds({
            questions: exam.questions.map((q) => ({
              id: q.id,
              questionPoolId: q.questionPoolId,
              order: q.order,
              difficulty: q.difficulty,
            })),
            pools: exam.questionPools.map((p) => ({
              id: p.id,
              drawCount: p.drawCount,
              drawCountEasy: p.drawCountEasy,
              drawCountMedium: p.drawCountMedium,
              drawCountHard: p.drawCountHard,
            })),
            randomiseQuestionOrder: settings.randomiseQuestionOrder,
          }),
        )
      : new Set(exam.questions.map((q) => q.id));

    const deliveredQuestions = exam.questions
      .filter((q) => selectedIds.has(q.id))
      .sort((a, b) => a.order - b.order)
      .map((q, i) => ({
        number: i + 1,
        id: q.id,
        type: q.type,
        text: q.text,
        options: q.options as string[] | null,
        points: q.points,
        poolName: q.questionPoolId ? (exam.questionPools.find((p) => p.id === q.questionPoolId)?.name ?? null) : null,
      }));

    const poolSummary = exam.questionPools.map((p) => {
      const isQuotaConfigured = p.drawCountEasy != null || p.drawCountMedium != null || p.drawCountHard != null;
      const poolQuestions = exam.questions.filter((q) => q.questionPoolId === p.id);
      return {
        id: p.id,
        name: p.name,
        questionCount: poolQuestions.length,
        composition: {
          easy: poolQuestions.filter((q) => q.difficulty === "easy").length,
          medium: poolQuestions.filter((q) => q.difficulty === "medium").length,
          hard: poolQuestions.filter((q) => q.difficulty === "hard").length,
        },
        isQuotaConfigured,
        drawCount: p.drawCount,
        drawCountEasy: p.drawCountEasy,
        drawCountMedium: p.drawCountMedium,
        drawCountHard: p.drawCountHard,
        deliveredFromThisPool: poolQuestions.filter((q) => selectedIds.has(q.id)).length,
      };
    });

    return NextResponse.json({
      examTitle: exam.title,
      durationMins: exam.durationMins,
      totalDelivered: deliveredQuestions.length,
      isSample: poolsActive,
      questions: deliveredQuestions,
      poolSummary,
    });
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export const dynamic = "force-dynamic";
