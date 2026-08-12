/**
 * Tether v1.7.4 pre-exam readiness — POST /api/submissions/[id]/activate.
 * See docs/tether-preflight-lifecycle-v1.7.4.md and
 * src/lib/secureClientActivation.ts.
 *
 * The ONE authoritative server-side operation that transitions a
 * TETHER_CLIENT_REQUIRED/SEB_REQUIRED submission out of PREPARING
 * (activatedAt null) into ACTIVE (activatedAt set) — the moment the
 * timed attempt truly begins and question content becomes retrievable.
 *
 * Deliberately does NOT accept, or trust, any client-supplied
 * "lockdownActive"/"ready" boolean — the caller (tether-launch/page.tsx)
 * is only ever allowed to call this AFTER it has already awaited a
 * successful result from window.sesLockdown.activateSecureExamLockdown()
 * (the native-side handshake — see apps/lockdown/src/main.ts's
 * lockdown:activate-secure-exam-lockdown handler), but this endpoint
 * itself re-derives its OWN eligibility entirely from server-side facts
 * it already trusts: the authenticated session, submission ownership,
 * submission status, and the SAME SecureClientSession verification
 * computation GET /api/submissions/[id] already uses (never a second,
 * looser check). A page that skipped the native handshake, or a forged
 * direct POST from anywhere else, gains nothing beyond what an already-
 * verified secure-client session legitimately allows — this endpoint
 * cannot be tricked into activating a submission whose secure-client
 * session was never actually verified server-side.
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseSecureClientPolicy } from "@/lib/secureClientPolicy";
import { submissionRequiresActivation } from "@/lib/secureClientActivation";
import { getCurrentSessionForSubmission, resolvePriorSessionTrust } from "@/lib/secureClientRunner";
import { parseAttestationRequirement } from "@/lib/tetherAttestationConfig";
import { resolveTrustedTetherVerification } from "@/lib/tetherRecovery";
import { resolveOfflineContinueMs } from "@/lib/tetherRecoveryConfig";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const submission = await prisma.submission.findUnique({ where: { id } });
  if (!submission || submission.studentId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (submission.status !== "IN_PROGRESS") {
    return NextResponse.json({ error: "This submission is no longer active", code: "SUBMISSION_NOT_IN_PROGRESS" }, { status: 409 });
  }

  const policy = parseSecureClientPolicy(submission.secureClientPolicySnapshotJson);

  // A submission whose frozen policy never required activation (every
  // mode except TETHER_CLIENT_REQUIRED/SEB_REQUIRED) already had
  // activatedAt stamped at creation — see POST /api/exams/[id]/start.
  // Nothing to do here; report the already-active state rather than
  // erroring, so a caller never needs to branch on delivery mode before
  // calling this endpoint.
  if (!submissionRequiresActivation(policy)) {
    return NextResponse.json({ ok: true, activatedAt: submission.activatedAt, startedAt: submission.startedAt, alreadyActivated: true });
  }

  // Idempotent repeat — activatedAt, once set, never moves. Reported
  // exactly like a first-time success (ok:true), with alreadyActivated
  // distinguishing the two for the caller's own logging only.
  if (submission.activatedAt != null) {
    return NextResponse.json({ ok: true, activatedAt: submission.activatedAt, startedAt: submission.startedAt, alreadyActivated: true });
  }

  // The SAME authoritative verification computation GET
  // /api/submissions/[id] and POST /api/exams/[id]/start already use —
  // never a second, independently-derived (and therefore possibly
  // divergent) trust decision. See those routes' own doc comments for
  // why resolvePriorSessionTrust is always safe to compute unconditionally.
  const currentSession = await getCurrentSessionForSubmission(submission.id);
  const priorSessionTrust = await resolvePriorSessionTrust(currentSession?.recoveryOfSessionId ?? null);
  const hasVerifiedTetherSession = resolveTrustedTetherVerification({
    sessionRequirement: parseAttestationRequirement(currentSession?.attestationRequirement ?? null),
    legacyVerified: currentSession?.verificationStatus === "VERIFIED",
    v2Verified: currentSession?.installationAttestationVerified === true,
    lastHeartbeatAtMs: currentSession?.lastHeartbeatAt?.getTime() ?? null,
    sessionStartedAtMs: currentSession?.startedAt?.getTime() ?? 0,
    nowMs: Date.now(),
    heartbeatPolicy: { heartbeatIntervalSeconds: policy.heartbeatIntervalSeconds, heartbeatGraceSeconds: policy.heartbeatGraceSeconds },
    offlineContinueMs: resolveOfflineContinueMs(),
    isRecoverySession: Boolean(currentSession?.recoveryOfSessionId),
    priorSessionTrustedInstallationId: priorSessionTrust.trustedInstallationId,
    priorSessionEverVerified: priorSessionTrust.everVerified,
    priorSessionAttestationRequirement: priorSessionTrust.attestationRequirement,
  });

  if (!hasVerifiedTetherSession) {
    return NextResponse.json(
      { error: "This examination's secure client session has not been verified.", code: "SECURE_SESSION_NOT_VERIFIED" },
      { status: 403 },
    );
  }

  // Atomic, race-safe first activation: the WHERE clause (id AND
  // activatedAt IS NULL) means at most one concurrent caller's UPDATE
  // can ever match this row — a second, near-simultaneous POST (e.g. a
  // duplicated retry) always sees count 0 below and falls through to the
  // idempotent re-fetch, never a second write. Resets startedAt to the
  // SAME instant so submissionDeadline(startedAt, durationMins) — used
  // unchanged everywhere else in this codebase — now correctly measures
  // from the true activation instant, not from POST /start's earlier
  // (pre-attestation/pre-native-lockdown) submission-creation time.
  const now = new Date();
  const result = await prisma.submission.updateMany({
    where: { id: submission.id, activatedAt: null },
    data: { activatedAt: now, startedAt: now },
  });

  if (result.count === 0) {
    // Lost the race to a concurrent activation call — re-fetch and
    // return that one's result, never our own now/now (which never
    // actually got written).
    const winner = await prisma.submission.findUnique({ where: { id: submission.id }, select: { activatedAt: true, startedAt: true } });
    return NextResponse.json({ ok: true, activatedAt: winner?.activatedAt ?? now, startedAt: winner?.startedAt ?? now, alreadyActivated: true });
  }

  return NextResponse.json({ ok: true, activatedAt: now, startedAt: now, alreadyActivated: false });
}

export const dynamic = "force-dynamic";
