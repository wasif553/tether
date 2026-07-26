/**
 * Tether Secure Client Foundation v1 â€” see
 * docs/secure-client-foundation-seb-v1.md.
 *
 * DELETE /api/lecturer/exams/[id]/secure-client/seb-keys/[keyId]
 *
 * Revokes an allowed key â€” never deletes the historical record.
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { assertSameInstitution, institutionErrorResponse, isPlatformAdmin } from "@/lib/institutionScope";
import { createPlatformAuditLog } from "@/lib/platformAdmin";
import { revokeSebAllowedExamKey } from "@/lib/secureClientRunner";

export async function DELETE(_req: Request, { params }: { params: Promise<{ examId: string; keyId: string }> }) {
  const session = await auth();
  if (!session || (session.user.role !== "LECTURER" && session.user.role !== "PLATFORM_ADMIN")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { examId: id, keyId } = await params;

  const exam = await prisma.exam.findUnique({ where: { id }, select: { createdById: true, institutionId: true } });
  if (!exam || (!isPlatformAdmin(session) && exam.createdById !== session.user.id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  try {
    assertSameInstitution(session, exam.institutionId);
  } catch (err) {
    const response = institutionErrorResponse(err);
    if (response) return response;
    throw err;
  }

  const key = await prisma.sebAllowedExamKey.findUnique({ where: { id: keyId }, include: { configuration: { select: { examId: true } } } });
  if (!key || key.configuration.examId !== id) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await revokeSebAllowedExamKey(keyId);
  createPlatformAuditLog({
    actorId: session.user.id,
    action: "SEB_ALLOWED_EXAM_KEY_REVOKED",
    targetType: "SebAllowedExamKey",
    targetId: keyId,
    institutionId: exam.institutionId,
    metadata: { examId: id },
  }).catch(() => {});

  return NextResponse.json({ ok: true });
}

export const dynamic = "force-dynamic";
