import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

const createExamSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  durationMins: z.number().int().positive(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
});

export async function GET() {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const exams = await prisma.exam.findMany({
    where: { createdById: session.user.id },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { questions: true, submissions: true } } },
  });

  return NextResponse.json(exams);
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const parsed = createExamSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { title, description, durationMins, startsAt, endsAt } = parsed.data;

  const exam = await prisma.exam.create({
    data: {
      title,
      description,
      durationMins,
      startsAt: startsAt ? new Date(startsAt) : undefined,
      endsAt: endsAt ? new Date(endsAt) : undefined,
      createdById: session.user.id,
    },
  });

  return NextResponse.json(exam, { status: 201 });
}

export const dynamic = "force-dynamic";
