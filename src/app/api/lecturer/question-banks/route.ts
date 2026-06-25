import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

const createBankSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  subject: z.string().optional(),
  courseCode: z.string().optional(),
});

export async function GET() {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const banks = await prisma.questionBank.findMany({
    where: { lecturerId: session.user.id },
    include: { _count: { select: { questions: true } } },
    orderBy: { updatedAt: "desc" },
  });

  return NextResponse.json(banks);
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const parsed = createBankSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const bank = await prisma.questionBank.create({
    data: { ...parsed.data, lecturerId: session.user.id },
  });

  return NextResponse.json(bank, { status: 201 });
}

export const dynamic = "force-dynamic";
