import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

const updateBankSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  subject: z.string().optional(),
  courseCode: z.string().optional(),
});

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ bankId: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { bankId } = await params;
  const bank = await prisma.questionBank.findFirst({
    where: { id: bankId, lecturerId: session.user.id },
    include: { questions: { orderBy: { createdAt: "asc" } } },
  });

  if (!bank) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json(bank);
}

export async function PATCH(
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
  const parsed = updateBankSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const updated = await prisma.questionBank.update({
    where: { id: bankId },
    data: parsed.data,
  });

  return NextResponse.json(updated);
}

export async function DELETE(
  _req: Request,
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

  await prisma.questionBank.delete({ where: { id: bankId } });

  return new NextResponse(null, { status: 204 });
}

export const dynamic = "force-dynamic";
