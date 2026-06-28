import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { institutionWhere, requireInstitutionId, institutionErrorResponse } from "@/lib/institutionScope";

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

  try {
    const exams = await prisma.exam.findMany({
      where: { createdById: session.user.id, ...institutionWhere(session) },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { questions: true, submissions: true } } },
    });

    return NextResponse.json(exams);
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
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

  try {
    const exam = await prisma.exam.create({
      data: {
        title,
        description,
        durationMins,
        startsAt: startsAt ? new Date(startsAt) : undefined,
        endsAt: endsAt ? new Date(endsAt) : undefined,
        createdById: session.user.id,
        institutionId: requireInstitutionId(session),
      },
    });

    return NextResponse.json(exam, { status: 201 });
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export const dynamic = "force-dynamic";
