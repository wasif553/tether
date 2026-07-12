import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { assertSameInstitution, institutionErrorResponse, isPlatformAdmin } from "@/lib/institutionScope";
import type { Exam } from "@/generated/prisma/client";

type AuthSession = {
  user: {
    id: string;
    role: string;
    institutionId?: string | null;
  };
};
type ReleasePermission =
  | { response: NextResponse }
  | { session: AuthSession; exam: Exam };

async function requireReleasePermission(examId: string): Promise<ReleasePermission> {
  const session = await auth();
  if (!session || (session.user.role !== "LECTURER" && session.user.role !== "PLATFORM_ADMIN")) {
    return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const exam = await prisma.exam.findUnique({ where: { id: examId } });
  if (!exam) return { response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  if (!isPlatformAdmin(session) && exam.createdById !== session.user.id) {
    return { response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }

  try {
    assertSameInstitution(session, exam.institutionId);
  } catch (err) {
    const response = institutionErrorResponse(err);
    if (response) return { response };
    throw err;
  }

  return { session, exam };
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ examId: string }> },
) {
  const { examId } = await params;
  const permission = await requireReleasePermission(examId);
  if ("response" in permission) return permission.response;

  const updated = await prisma.exam.update({
    where: { id: examId },
    data: {
      marksReleasedAt: new Date(),
      marksReleasedById: permission.session.user.id,
    },
    select: { id: true, marksReleasedAt: true, marksReleasedById: true },
  });

  return NextResponse.json(updated);
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ examId: string }> },
) {
  const { examId } = await params;
  const permission = await requireReleasePermission(examId);
  if ("response" in permission) return permission.response;

  const updated = await prisma.exam.update({
    where: { id: examId },
    data: { marksReleasedAt: null, marksReleasedById: null },
    select: { id: true, marksReleasedAt: true, marksReleasedById: true },
  });

  return NextResponse.json(updated);
}

export const dynamic = "force-dynamic";
