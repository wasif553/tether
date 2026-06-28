import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isPlatformAdmin, requireInstitutionId, institutionErrorResponse } from "@/lib/institutionScope";
import type { Session } from "next-auth";

const updateQuestionSchema = z.object({
  type: z.enum(["MULTIPLE_CHOICE", "SHORT_ANSWER", "ESSAY"]).optional(),
  text: z.string().min(1).optional(),
  options: z.array(z.string()).optional(),
  correctAnswer: z.string().optional(),
  points: z.number().int().positive().optional(),
  order: z.number().int().optional(),
});

async function getOwnedQuestion(examId: string, questionId: string, lecturerId: string, session: Session) {
  return prisma.question.findFirst({
    where: {
      id: questionId,
      examId,
      exam: {
        createdById: lecturerId,
        ...(isPlatformAdmin(session) ? {} : { institutionId: requireInstitutionId(session) }),
      },
    },
  });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; questionId: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { id, questionId } = await params;
    const question = await getOwnedQuestion(id, questionId, session.user.id, session);
    if (!question) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const body = await req.json();
    const parsed = updateQuestionSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const updated = await prisma.question.update({
      where: { id: questionId },
      data: parsed.data,
    });

    return NextResponse.json(updated);
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; questionId: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { id, questionId } = await params;
    const question = await getOwnedQuestion(id, questionId, session.user.id, session);
    if (!question) return NextResponse.json({ error: "Not found" }, { status: 404 });

    await prisma.question.delete({ where: { id: questionId } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export const dynamic = "force-dynamic";
