import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseSecureSettings, secureSettingsInputSchema } from "@/lib/secureExam";
import type { Prisma } from "@/generated/prisma/client";

const updateExamSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  durationMins: z.number().int().positive().optional(),
  published: z.boolean().optional(),
  startsAt: z.string().datetime().optional().nullable(),
  endsAt: z.string().datetime().optional().nullable(),
  secureSettings: secureSettingsInputSchema.optional(),
});

async function getOwnedExam(examId: string, lecturerId: string) {
  return prisma.exam.findFirst({ where: { id: examId, createdById: lecturerId } });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const exam = await prisma.exam.findUnique({
    where: { id },
    include: { questions: { orderBy: { order: "asc" } } },
  });

  if (!exam) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (session.user.role === "LECTURER" && exam.createdById !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Secure Exam Mode settings are not sensitive — students need them to
  // know whether fullscreen is required, copy/paste is blocked, etc.
  const secureSettings = parseSecureSettings(exam.secureSettings);

  if (session.user.role === "STUDENT") {
    if (!exam.published) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const sanitized = {
      ...exam,
      secureSettings,
      questions: exam.questions.map((q) => ({ ...q, correctAnswer: undefined })),
    };
    return NextResponse.json(sanitized);
  }

  return NextResponse.json({ ...exam, secureSettings });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const exam = await getOwnedExam(id, session.user.id);
  if (!exam) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json();
  const parsed = updateExamSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { startsAt, endsAt, secureSettings, ...rest } = parsed.data;

  const mergedSecureSettings = secureSettings
    ? parseSecureSettings({ ...parseSecureSettings(exam.secureSettings), ...secureSettings })
    : undefined;

  const updated = await prisma.exam.update({
    where: { id },
    data: {
      ...rest,
      ...(startsAt !== undefined ? { startsAt: startsAt ? new Date(startsAt) : null } : {}),
      ...(endsAt !== undefined ? { endsAt: endsAt ? new Date(endsAt) : null } : {}),
      ...(mergedSecureSettings
        ? { secureSettings: mergedSecureSettings as Prisma.InputJsonValue }
        : {}),
    },
  });

  return NextResponse.json({ ...updated, secureSettings: parseSecureSettings(updated.secureSettings) });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const exam = await getOwnedExam(id, session.user.id);
  if (!exam) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.exam.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

export const dynamic = "force-dynamic";
