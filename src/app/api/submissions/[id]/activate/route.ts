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
 *
 * Release-blocking server content-boundary audit — see
 * tetherContentAccessLease.ts. hasVerifiedTetherSession above is a plain
 * submission-keyed database read: it proves a verified session exists
 * SOMEWHERE, not that THIS request comes from the Tether/SEB instance
 * that established it. Without the additional lease check below, an
 * ordinary Chrome/Edge tab — separately authenticated as the same
 * student via their own normal login, which requires no Tether-specific
 * proof at all — could call this endpoint directly and activate the
 * submission (starting the timer, unlocking content) the moment
 * verification completes, without ever going through native lockdown.
 * The lease closes this: it is issued only by an attestation success
 * that already proved genuine native/installation-backed proof for THIS
 * request, and is physically absent from any browser whose cookie jar
 * isn't the same Electron/SEB instance.
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
import {
  issueContentAccessLeaseCookie,
  checkTetherContentAccessLease,
  readContentAccessLeaseCookieFromRequest,
  TETHER_CONTENT_ACCESS_REQUIRED_CODE,
  TETHER_CONTENT_ACCESS_REQUIRED_MESSAGE,
} from "@/lib/secureClient/requireTetherContentAccess";

export async function POST(
  req: Request,
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

  // Release-blocking server content-boundary audit — see this route's
  // own updated doc comment above and tetherContentAccessLease.ts. The
  // REQUEST-bound half of activation eligibility: a verified session
  // existing for this submission is necessary but not sufficient — THIS
  // request must also carry the lease that only a genuine native-backed
  // attestation success (for this student, this submission) could have
  // produced. An ordinary separately-authenticated Chrome/Edge request
  // never has this cookie.
  //
  // Scoped to TETHER_CLIENT_REQUIRED only — a lease is only ever mintable
  // via native Tether installation-key proof (see
  // tetherContentAccessLease.ts's own doc comment), which SAFE_EXAM_BROWSER
  // has no equivalent of. Requiring it for SEB_REQUIRED would permanently
  // lock every SEB attempt out of activation; that gap is unchanged by
  // this fix and out of scope here.
  if (policy.deliveryMode === "TETHER_CLIENT_REQUIRED") {
    const leaseDecision = await checkTetherContentAccessLease(readContentAccessLeaseCookieFromRequest(req), {
      submissionId: submission.id,
      studentId: session.user.id,
    });
    if (!leaseDecision.ok) {
      return NextResponse.json(
        { error: TETHER_CONTENT_ACCESS_REQUIRED_MESSAGE, code: TETHER_CONTENT_ACCESS_REQUIRED_CODE },
        { status: 403 },
      );
    }
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
    const raceResponse = NextResponse.json({ ok: true, activatedAt: winner?.activatedAt ?? now, startedAt: winner?.startedAt ?? now, alreadyActivated: true });
    if (currentSession && policy.deliveryMode === "TETHER_CLIENT_REQUIRED") {
      issueContentAccessLeaseCookie(raceResponse, {
        submissionId: submission.id,
        secureClientSessionId: currentSession.id,
        installationKeyFingerprint: currentSession.clientInstallationIdHash ?? null,
        studentId: session.user.id,
      });
    }
    return raceResponse;
  }

  const response = NextResponse.json({ ok: true, activatedAt: now, startedAt: now, alreadyActivated: false });
  // Refresh the lease here too — activation is itself further genuine,
  // server-verified proof this request is legitimate, and this keeps the
  // lease's TTL from expiring partway through a long exam attempt. Never
  // for SEB_REQUIRED — see the requirement check above.
  if (currentSession && policy.deliveryMode === "TETHER_CLIENT_REQUIRED") {
    issueContentAccessLeaseCookie(response, {
      submissionId: submission.id,
      secureClientSessionId: currentSession.id,
      installationKeyFingerprint: currentSession.clientInstallationIdHash ?? null,
      studentId: session.user.id,
    });
  }
  return response;
}

export const dynamic = "force-dynamic";
