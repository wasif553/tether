/**
 * Question Pools v1 — see docs/question-pools-v1.md.
 *
 * GET  /api/exams/[id]/question-pools — list pools for lecturer editing.
 * POST /api/exams/[id]/question-pools — create a pool.
 *
 * Lecturer (owner of the exam) only — never reachable by a student.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { institutionWhere, institutionErrorResponse } from "@/lib/institutionScope";

// Pool Selection Refinement v1 — see docs/pool-selection-refinement-v1.md.
// A per-difficulty quota is >= 0 (unlike drawCount, 0 is a meaningful
// value here — "none from this band," not "unlimited").
const drawQuotaField = z.number().int().min(0).nullable().optional();

const createPoolSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  drawCount: z.number().int().positive().nullable().optional(),
  drawCountEasy: drawQuotaField,
  drawCountMedium: drawQuotaField,
  drawCountHard: drawQuotaField,
});

async function getOwnedExam(examId: string, lecturerId: string, session: Parameters<typeof institutionWhere>[0]) {
  return prisma.exam.findFirst({
    where: { id: examId, createdById: lecturerId, ...institutionWhere(session) },
  });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { id } = await params;
    const exam = await getOwnedExam(id, session.user.id, session);
    if (!exam) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const pools = await prisma.questionPool.findMany({
      where: { examId: id },
      orderBy: { order: "asc" },
      include: { questions: { select: { difficulty: true } } },
    });
    return NextResponse.json(
      pools.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        drawCount: p.drawCount,
        drawCountEasy: p.drawCountEasy,
        drawCountMedium: p.drawCountMedium,
        drawCountHard: p.drawCountHard,
        order: p.order,
        questionCount: p.questions.length,
        // Pool Selection Refinement v1 — the pool's LIVE composition,
        // counted from the exam's own Question rows (never from
        // BankQuestion) — always accurate even after questions are
        // added/removed/edited, unlike a stored snapshot.
        composition: {
          easy: p.questions.filter((q) => q.difficulty === "easy").length,
          medium: p.questions.filter((q) => q.difficulty === "medium").length,
          hard: p.questions.filter((q) => q.difficulty === "hard").length,
        },
      })),
    );
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

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
    const exam = await getOwnedExam(id, session.user.id, session);
    if (!exam) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const body = await req.json();
    const parsed = createPoolSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const { name, description, drawCount, drawCountEasy, drawCountMedium, drawCountHard } = parsed.data;

    const lastPool = await prisma.questionPool.findFirst({
      where: { examId: id },
      orderBy: { order: "desc" },
    });

    const pool = await prisma.questionPool.create({
      data: {
        examId: id,
        name,
        description,
        drawCount: drawCount ?? null,
        drawCountEasy: drawCountEasy ?? null,
        drawCountMedium: drawCountMedium ?? null,
        drawCountHard: drawCountHard ?? null,
        order: (lastPool?.order ?? -1) + 1,
      },
    });

    return NextResponse.json(
      {
        id: pool.id,
        name: pool.name,
        description: pool.description,
        drawCount: pool.drawCount,
        drawCountEasy: pool.drawCountEasy,
        drawCountMedium: pool.drawCountMedium,
        drawCountHard: pool.drawCountHard,
        order: pool.order,
        questionCount: 0,
      },
      { status: 201 },
    );
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export const dynamic = "force-dynamic";
