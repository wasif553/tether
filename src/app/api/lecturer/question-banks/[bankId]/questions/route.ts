import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { bankQuestionInputSchema } from "@/lib/questionBank";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ bankId: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { bankId } = await params;
  const bank = await prisma.questionBank.findFirst({
    where: { id: bankId, lecturerId: session.user.id },
  });
  if (!bank) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json();
  const parsed = bankQuestionInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const question = await prisma.bankQuestion.create({
    data: { ...parsed.data, bankId },
  });

  return NextResponse.json(question, { status: 201 });
}

export const dynamic = "force-dynamic";
