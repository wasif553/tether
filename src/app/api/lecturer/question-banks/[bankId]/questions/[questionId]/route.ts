import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { bankQuestionInputSchema } from "@/lib/questionBank";

async function getOwnedBankQuestion(bankId: string, questionId: string, lecturerId: string) {
  const bank = await prisma.questionBank.findFirst({ where: { id: bankId, lecturerId } });
  if (!bank) return { bank: null, question: null };

  const question = await prisma.bankQuestion.findFirst({ where: { id: questionId, bankId } });
  return { bank, question };
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ bankId: string; questionId: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { bankId, questionId } = await params;
  const { bank, question } = await getOwnedBankQuestion(bankId, questionId, session.user.id);
  if (!bank || !question) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json();
  const merged = {
    type: body.type ?? question.type,
    text: body.text ?? question.text,
    optionsJson: body.optionsJson ?? question.optionsJson ?? undefined,
    correctAnswer: body.correctAnswer ?? question.correctAnswer ?? undefined,
    sampleAnswer: body.sampleAnswer ?? question.sampleAnswer ?? undefined,
    points: body.points ?? question.points,
    difficulty: body.difficulty ?? question.difficulty ?? undefined,
    topic: body.topic ?? question.topic ?? undefined,
  };

  const parsed = bankQuestionInputSchema.safeParse(merged);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const updated = await prisma.bankQuestion.update({
    where: { id: questionId },
    data: parsed.data,
  });

  return NextResponse.json(updated);
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ bankId: string; questionId: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { bankId, questionId } = await params;
  const { bank, question } = await getOwnedBankQuestion(bankId, questionId, session.user.id);
  if (!bank || !question) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.bankQuestion.delete({ where: { id: questionId } });

  return new NextResponse(null, { status: 204 });
}

export const dynamic = "force-dynamic";
