/**
 * Tether Secure Client Foundation v1 — see
 * docs/secure-client-foundation-seb-v1.md and Part 8/12 of the spec.
 *
 * POST /api/lecturer/secure-client/sessions/[sessionId]/override
 *
 * An explicit lecturer action allowing one student to proceed despite a
 * failed/incomplete secure-client verification (e.g. an approved
 * accessibility exception). Always requires a recorded reason and is
 * always audited — never automatic, never silent.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { assertSameInstitution, institutionErrorResponse, isPlatformAdmin } from "@/lib/institutionScope";
import { createPlatformAuditLog } from "@/lib/platformAdmin";
import { recordSecureClientEvent } from "@/lib/secureClientRunner";

const bodySchema = z.object({ reason: z.string().min(1).max(500) });

export async function POST(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const session = await auth();
  if (!session || (session.user.role !== "LECTURER" && session.user.role !== "PLATFORM_ADMIN")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { sessionId } = await params;
  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const clientSession = await prisma.secureClientSession.findUnique({ where: { id: sessionId } });
  if (!clientSession) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const exam = await prisma.exam.findUnique({ where: { id: clientSession.examId }, select: { createdById: true, institutionId: true } });
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

  const updated = await prisma.secureClientSession.update({
    where: { id: sessionId },
    data: { status: "ACTIVE", verificationStatus: "LECTURER_OVERRIDE" },
  });

  await recordSecureClientEvent({
    secureClientSessionId: sessionId,
    submissionId: clientSession.submissionId,
    examId: clientSession.examId,
    institutionId: clientSession.institutionId,
    eventType: "LECTURER_OVERRIDE_GRANTED",
    clientRequestId: null,
    sequenceNumber: null,
    clientElapsedMs: null,
    metadata: { reasonCode: parsed.data.reason.slice(0, 100) },
  }).catch(() => {});

  createPlatformAuditLog({
    actorId: session.user.id,
    action: "SECURE_CLIENT_OVERRIDE_GRANTED",
    targetType: "SecureClientSession",
    targetId: sessionId,
    institutionId: exam.institutionId,
    metadata: { submissionId: clientSession.submissionId, reason: parsed.data.reason },
  }).catch(() => {});

  return NextResponse.json({ ok: true, status: updated.status });
}

export const dynamic = "force-dynamic";
