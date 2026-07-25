/**
 * Tether Secure Client Foundation v1 — see
 * docs/secure-client-foundation-seb-v1.md and Part 11 of the spec.
 *
 * GET /api/lecturer/secure-client/sessions/[sessionId]
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { assertSameInstitution, institutionErrorResponse, isPlatformAdmin } from "@/lib/institutionScope";

export async function GET(_req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const session = await auth();
  if (!session || (session.user.role !== "LECTURER" && session.user.role !== "PLATFORM_ADMIN")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { sessionId } = await params;

  const clientSession = await prisma.secureClientSession.findUnique({
    where: { id: sessionId },
    include: {
      attestations: { orderBy: { serverReceivedAt: "asc" } },
      events: { orderBy: { serverReceivedAt: "asc" } },
      recoveryGrants: { orderBy: { issuedAt: "asc" }, include: { issuedBy: { select: { name: true } } } },
    },
  });
  if (!clientSession) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const exam = await prisma.exam.findUnique({ where: { id: clientSession.examId }, select: { createdById: true, institutionId: true, title: true } });
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

  const student = await prisma.user.findUnique({ where: { id: clientSession.studentId }, select: { name: true } });

  return NextResponse.json({
    session: {
      id: clientSession.id,
      examTitle: exam.title,
      studentName: student?.name ?? "Unknown",
      submissionId: clientSession.submissionId,
      clientType: clientSession.clientType,
      status: clientSession.status,
      verificationStatus: clientSession.verificationStatus,
      platform: clientSession.platform,
      clientVersion: clientSession.clientVersion,
      startedAt: clientSession.startedAt,
      verifiedAt: clientSession.verifiedAt,
      lastHeartbeatAt: clientSession.lastHeartbeatAt,
      interruptedAt: clientSession.interruptedAt,
      recoveredAt: clientSession.recoveredAt,
      endedAt: clientSession.endedAt,
      endReason: clientSession.endReason,
    },
    attestations: clientSession.attestations.map((a) => ({
      id: a.id,
      overallStatus: a.overallStatus,
      displayCheckStatus: a.displayCheckStatus,
      remoteSessionStatus: a.remoteSessionStatus,
      virtualMachineStatus: a.virtualMachineStatus,
      processCheckStatus: a.processCheckStatus,
      captureProtectionStatus: a.captureProtectionStatus,
      clipboardPolicyStatus: a.clipboardPolicyStatus,
      printingPolicyStatus: a.printingPolicyStatus,
      externalNavigationPolicyStatus: a.externalNavigationPolicyStatus,
      serverReceivedAt: a.serverReceivedAt,
    })),
    events: clientSession.events.map((e) => ({
      id: e.id,
      eventType: e.eventType,
      eventLevel: e.eventLevel,
      serverReceivedAt: e.serverReceivedAt,
      metadata: e.metadataJson,
    })),
    recoveryGrants: clientSession.recoveryGrants.map((g) => ({
      id: g.id,
      issuedByName: g.issuedBy.name,
      issuedAt: g.issuedAt,
      expiresAt: g.expiresAt,
      consumedAt: g.consumedAt,
      revokedAt: g.revokedAt,
      reason: g.reason,
    })),
  });
}

export const dynamic = "force-dynamic";
