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
import { parseSecureSettings } from "@/lib/secureExam";
import { parseSecureClientPolicy } from "@/lib/secureClientPolicy";

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

  const exam = await prisma.exam.findUnique({
    where: { id: clientSession.examId },
    select: { createdById: true, institutionId: true, title: true, secureSettings: true },
  });
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

  // Production administration hardening v1, Part G — Recovery Admin UX.
  // See docs/tether-broad-rollout-readiness.md. A lecturer facing a
  // RECOVERY_REQUIRED / device-change-flagged session previously had no
  // way to see WHY on this page — recoveryOfSessionId,
  // installationAttestationFailureReason, and the PRIOR session's own
  // verification status all already existed on the schema but were never
  // queried here. Read-only, additive: nothing about the actual recovery
  // POLICY changes — see resolveRecoveryState (tetherRecovery.ts) and
  // verifyExamSessionAttestation (tetherAttestationRunner.ts) for the
  // real, authoritative decision logic this page only ever DISPLAYS
  // evidence for.
  const priorSession = clientSession.recoveryOfSessionId
    ? await prisma.secureClientSession.findUnique({
        where: { id: clientSession.recoveryOfSessionId },
        select: { id: true, status: true, installationAttestationVerified: true, clientInstallationId: true, endedAt: true, endReason: true, closeReason: true },
      })
    : null;

  // Mandatory Tether Delivery for Final Examinations — Part 9: "Expose in
  // lecturer/admin views: assessment type; required delivery mode;
  // display policy; ... policy snapshot version/hash where already
  // supported." The FROZEN per-attempt snapshot (never the exam's
  // current/live settings) is the authoritative record of what was
  // actually enforced for THIS attempt — see docs/exam-design-policy-v1.md
  // and buildSecureClientPolicySnapshot in secureClientPolicy.ts. Neutral
  // reporting only: a failed/incomplete client check is never labelled
  // misconduct here, only its factual status (verificationStatus above).
  const submission = await prisma.submission.findUnique({
    where: { id: clientSession.submissionId },
    select: { secureClientPolicySnapshotJson: true },
  });
  const policySnapshot = parseSecureClientPolicy(submission?.secureClientPolicySnapshotJson);
  const currentSettings = parseSecureSettings(exam.secureSettings);

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
      // Assessment type reflects the exam's CURRENT classification (a
      // lecturer-facing setting, not something frozen per attempt);
      // everything else below is the FROZEN attempt policy.
      assessmentType: currentSettings.assessmentType,
      deliveryMode: policySnapshot.deliveryMode,
      displayPolicy: policySnapshot.displayPolicy,
      policyVersion: policySnapshot.policyVersion,
      policySchemaVersion: policySnapshot.schemaVersion,
      // Part G — recovery admin UX. installationAttestationFailureReason
      // is a single, bounded reason-code string (e.g.
      // "DEVICE_CHANGE_DETECTED") — never a stack trace or raw request
      // body (see recordExamSessionFailure in tetherAttestationRunner.ts).
      installationAttestationVerified: clientSession.installationAttestationVerified,
      installationAttestationFailureReason: clientSession.installationAttestationFailureReason,
      recoveryOfSessionId: clientSession.recoveryOfSessionId,
    },
    priorSession: priorSession
      ? {
          id: priorSession.id,
          status: priorSession.status,
          installationAttestationVerified: priorSession.installationAttestationVerified,
          hadBoundInstallation: priorSession.clientInstallationId != null,
          endedAt: priorSession.endedAt,
          endReason: priorSession.endReason ?? priorSession.closeReason,
        }
      : null,
    attestations: clientSession.attestations.map((a) => ({
      id: a.id,
      overallStatus: a.overallStatus,
      displayCheckStatus: a.displayCheckStatus,
      // Single Display Requirement v1 (Part 6) — displayCount is a
      // dedicated bounded column; displayTopology has no column of its
      // own and is read back from the existing detailsJson blob (never a
      // raw monitor name/serial/EDID — see attestation.ts). Both are
      // null for every SAFE_EXAM_BROWSER attestation (see
      // recordAttestation in secureClientRunner.ts).
      displayCount: a.displayCount,
      displayTopology: (a.detailsJson as { displayTopology?: string } | null)?.displayTopology ?? null,
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
