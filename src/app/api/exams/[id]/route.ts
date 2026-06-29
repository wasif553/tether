import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseSecureSettings, secureSettingsInputSchema } from "@/lib/secureExam";
import type { Prisma } from "@/generated/prisma/client";
import { assertSameInstitution, institutionWhere, institutionErrorResponse } from "@/lib/institutionScope";

const updateExamSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  durationMins: z.number().int().positive().optional(),
  published: z.boolean().optional(),
  startsAt: z.string().datetime().optional().nullable(),
  endsAt: z.string().datetime().optional().nullable(),
  secureSettings: secureSettingsInputSchema.optional(),
  // Student Onboarding and Exam Access v1 — see
  // docs/student-onboarding-and-exam-access.md. undefined = leave
  // unchanged, null = clear the code, a string = set a new code.
  accessCode: z.string().min(4).nullable().optional(),
});

/** Strips accessCodeHash from any exam object before it's ever sent in a response. */
function omitAccessCodeHash<T extends { accessCodeHash?: string | null }>(
  exam: T,
): Omit<T, "accessCodeHash"> {
  const rest: Partial<T> = { ...exam };
  delete rest.accessCodeHash;
  return rest as Omit<T, "accessCodeHash">;
}

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
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  try {
    const exam = await prisma.exam.findUnique({
      where: { id },
      include: { questions: { orderBy: { order: "asc" } } },
    });

    if (!exam) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Both the lecturer-owner path and the student-view path are direct-ID
    // access — assert institution membership before any role-specific
    // branching below, so a student/lecturer in another institution gets a
    // generic 403/404 rather than reaching the data at all.
    assertSameInstitution(session, exam.institutionId);

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
        ...omitAccessCodeHash(exam),
        secureSettings,
        questions: exam.questions.map((q) => ({ ...q, correctAnswer: undefined })),
      };
      return NextResponse.json(sanitized);
    }

    return NextResponse.json({ ...omitAccessCodeHash(exam), secureSettings });
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export async function PATCH(
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
    const parsed = updateExamSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const { startsAt, endsAt, secureSettings, accessCode, ...rest } = parsed.data;

    const mergedSecureSettings = secureSettings
      ? parseSecureSettings({ ...parseSecureSettings(exam.secureSettings), ...secureSettings })
      : undefined;

    // accessCode: undefined leaves it untouched, null clears it, a string
    // sets a new one. The plaintext code is never stored — only its hash.
    let accessCodeFields: { accessCodeHash: string | null; accessCodeRequired: boolean } | undefined;
    if (accessCode === null) {
      accessCodeFields = { accessCodeHash: null, accessCodeRequired: false };
    } else if (typeof accessCode === "string") {
      accessCodeFields = { accessCodeHash: await bcrypt.hash(accessCode, 12), accessCodeRequired: true };
    }

    const updated = await prisma.exam.update({
      where: { id },
      data: {
        ...rest,
        ...(accessCodeFields ?? {}),
        ...(startsAt !== undefined ? { startsAt: startsAt ? new Date(startsAt) : null } : {}),
        ...(endsAt !== undefined ? { endsAt: endsAt ? new Date(endsAt) : null } : {}),
        ...(mergedSecureSettings
          ? { secureSettings: mergedSecureSettings as Prisma.InputJsonValue }
          : {}),
      },
    });

    return NextResponse.json({
      ...omitAccessCodeHash(updated),
      secureSettings: parseSecureSettings(updated.secureSettings),
    });
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export async function DELETE(
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

    await prisma.exam.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export const dynamic = "force-dynamic";
