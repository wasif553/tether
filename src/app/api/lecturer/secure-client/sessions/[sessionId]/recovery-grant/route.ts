/**
 * Tether Secure Client Foundation v1 — see
 * docs/secure-client-foundation-seb-v1.md and Part 10 of the spec.
 *
 * POST /api/lecturer/secure-client/sessions/[sessionId]/recovery-grant
 *
 * Issues a one-time, short-lived recovery grant for an interrupted
 * secure-client session. The raw token is returned once — only its hash
 * is stored.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { assertSameInstitution, institutionErrorResponse, isPlatformAdmin } from "@/lib/institutionScope";
import { createPlatformAuditLog } from "@/lib/platformAdmin";
import { issueRecoveryGrant } from "@/lib/secureClientRunner";

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

  const { grant, rawToken } = await issueRecoveryGrant(sessionId, clientSession.submissionId, session.user.id, parsed.data.reason);

  createPlatformAuditLog({
    actorId: session.user.id,
    action: "SECURE_CLIENT_RECOVERY_GRANT_ISSUED",
    targetType: "SecureClientRecoveryGrant",
    targetId: grant.id,
    institutionId: exam.institutionId,
    metadata: { sessionId, submissionId: clientSession.submissionId, reason: parsed.data.reason },
  }).catch(() => {});

  return NextResponse.json({ ok: true, grantId: grant.id, recoveryToken: rawToken, expiresAt: grant.expiresAt }, { status: 201 });
}

export const dynamic = "force-dynamic";
