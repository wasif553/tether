/**
 * Tether Secure Client Foundation v1 — see
 * docs/secure-client-foundation-seb-v1.md.
 *
 * POST /api/lecturer/exams/[id]/secure-client/configuration/revoke
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { assertSameInstitution, institutionErrorResponse, isPlatformAdmin } from "@/lib/institutionScope";
import { createPlatformAuditLog } from "@/lib/platformAdmin";
import { revokeConfiguration } from "@/lib/secureClientRunner";

const bodySchema = z.object({ configurationId: z.string() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session || (session.user.role !== "LECTURER" && session.user.role !== "PLATFORM_ADMIN")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

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

  const config = await prisma.secureClientConfiguration.findUnique({ where: { id: parsed.data.configurationId } });
  if (!config || config.examId !== id) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const revoked = await revokeConfiguration(parsed.data.configurationId, session.user.id);
  createPlatformAuditLog({
    actorId: session.user.id,
    action: "SECURE_CLIENT_CONFIGURATION_REVOKED",
    targetType: "SecureClientConfiguration",
    targetId: revoked.id,
    institutionId: exam.institutionId,
    metadata: { examId: id },
  }).catch(() => {});

  return NextResponse.json({ ok: true });
}

export const dynamic = "force-dynamic";
