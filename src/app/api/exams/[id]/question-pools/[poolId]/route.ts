/**
 * Question Pools v1 — see docs/question-pools-v1.md.
 *
 * PATCH  /api/exams/[id]/question-pools/[poolId] — rename/edit drawCount.
 * DELETE /api/exams/[id]/question-pools/[poolId] — delete a pool. Any
 *   questions assigned to it become unpooled (Question.questionPoolId
 *   set to null via the schema's `onDelete: SetNull`), never deleted.
 *
 * Lecturer (owner of the exam) only — never reachable by a student.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { institutionWhere, institutionErrorResponse } from "@/lib/institutionScope";

const updatePoolSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  drawCount: z.number().int().positive().nullable().optional(),
  order: z.number().int().optional(),
});

async function getOwnedPool(
  examId: string,
  poolId: string,
  lecturerId: string,
  session: Parameters<typeof institutionWhere>[0],
) {
  return prisma.questionPool.findFirst({
    where: { id: poolId, examId, exam: { createdById: lecturerId, ...institutionWhere(session) } },
  });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; poolId: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { id, poolId } = await params;
    const pool = await getOwnedPool(id, poolId, session.user.id, session);
    if (!pool) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const body = await req.json();
    const parsed = updatePoolSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const updated = await prisma.questionPool.update({
      where: { id: poolId },
      data: parsed.data,
    });
    return NextResponse.json({
      id: updated.id,
      name: updated.name,
      description: updated.description,
      drawCount: updated.drawCount,
      order: updated.order,
    });
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; poolId: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { id, poolId } = await params;
    const pool = await getOwnedPool(id, poolId, session.user.id, session);
    if (!pool) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Questions in this pool become unpooled (always included), never
    // deleted — see Question.questionPool's onDelete: SetNull.
    await prisma.questionPool.delete({ where: { id: poolId } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export const dynamic = "force-dynamic";
