/**
 * Tether Secure Exam Recovery and Resilient Autosave v1 — server-only
 * Prisma orchestration around src/lib/tetherRecovery.ts's pure decision
 * logic. See docs/tether-secure-resume-recovery-v1.md.
 *
 * Touches Prisma, so it must never be imported from a "use client"
 * component — mirrors the split already used by
 * src/lib/secureClientRunner.ts (Prisma orchestration) versus
 * src/lib/secureClient/*.ts (pure decision logic).
 */
import { prisma } from "@/lib/prisma";
import { parseSecureSettings } from "@/lib/secureExam";
import { resolveSubmissionTimingPolicy, submissionDeadline } from "@/lib/assessmentLifecycle";
import { parseSecureClientPolicy } from "@/lib/secureClientPolicy";
import { getCurrentSessionForSubmission } from "@/lib/secureClientRunner";
import { parseAttestationRequirement } from "@/lib/tetherAttestationConfig";
import { resolveOfflineContinueMs } from "@/lib/tetherRecoveryConfig";
import { buildTetherLaunchPagePath } from "@/lib/secureClientStartGate";
import { resolveRecoveryState, RECOVERY_STATE_COPY, type RecoveryState, type RecoverySessionInput } from "@/lib/tetherRecovery";
import { createPlatformAuditLog } from "@/lib/platformAdmin";

export type SubmissionRecoveryStatus = {
  state: RecoveryState;
  redirectTo: string | null;
  resumeCount: number;
  lastResumedAt: Date | null;
  lastAutosaveAcknowledgedAt: Date | null;
  lastServerContactAt: Date | null;
  deadline: Date;
};

/**
 * The ONE read path every recovery-status surface (student page, lecturer
 * badge) must call — see resolveRecoveryState's own doc comment for why
 * this must never be reimplemented per-caller. Returns null when the
 * submission doesn't exist or doesn't belong to `requestingUserId` (the
 * caller should treat that as 404, exactly like every other
 * ownership-scoped submission route in this codebase).
 */
export async function resolveSubmissionRecoveryState(params: {
  submissionId: string;
  requestingUserId: string;
  /** A client claim only — see ResolveRecoveryStateInput.requestingInstallationId's own doc comment. */
  requestingInstallationId?: string | null;
}): Promise<SubmissionRecoveryStatus | null> {
  const submission = await prisma.submission.findUnique({
    where: { id: params.submissionId },
    include: { exam: true },
  });
  if (!submission || submission.studentId !== params.requestingUserId) return null;

  const settings = parseSecureSettings(submission.exam.secureSettings);
  const timingPolicy = resolveSubmissionTimingPolicy({
    examPolicySnapshotJson: submission.examPolicySnapshotJson,
    currentExamDurationMins: submission.exam.durationMins,
    currentSecureSettings: settings,
  });
  const deadline = submissionDeadline(submission.startedAt, timingPolicy.durationMins);
  const policy = parseSecureClientPolicy(submission.secureClientPolicySnapshotJson);

  const currentSession = await getCurrentSessionForSubmission(submission.id);
  const session: RecoverySessionInput | null = currentSession
    ? {
        status: currentSession.status as RecoverySessionInput["status"],
        verificationStatus: currentSession.verificationStatus,
        installationAttestationVerified: currentSession.installationAttestationVerified,
        attestationRequirement: parseAttestationRequirement(currentSession.attestationRequirement),
        lastHeartbeatAtMs: currentSession.lastHeartbeatAt?.getTime() ?? null,
        startedAtMs: currentSession.startedAt.getTime(),
        clientInstallationId: currentSession.clientInstallationId,
      }
    : null;

  const nowMs = Date.now();
  const result = resolveRecoveryState({
    authenticated: true,
    submissionStatus: submission.status,
    nowMs,
    deadlineMs: deadline.getTime(),
    deliveryMode: policy.deliveryMode,
    session,
    heartbeatPolicy: { heartbeatIntervalSeconds: policy.heartbeatIntervalSeconds, heartbeatGraceSeconds: policy.heartbeatGraceSeconds },
    offlineContinueMs: resolveOfflineContinueMs(),
    requestingInstallationId: params.requestingInstallationId ?? null,
  });

  if (result.state === "MANUAL_REVIEW_REQUIRED" && currentSession) {
    // Part 13 — a blocked device-change *attempt* is recorded, never an
    // IntegrityEvent (this is a technical/administrative fact, not a
    // misconduct signal — see Part 8/13 of the spec).
    await createPlatformAuditLog({
      actorId: params.requestingUserId,
      action: "TETHER_DEVICE_CHANGE_RECOVERY_BLOCKED",
      targetType: "Submission",
      targetId: submission.id,
      institutionId: submission.exam.institutionId,
      metadata: {
        secureClientSessionId: currentSession.id,
        boundInstallationId: currentSession.clientInstallationId,
        requestingInstallationId: params.requestingInstallationId ?? null,
      },
    }).catch(() => {});
  }

  return {
    state: result.state,
    redirectTo: result.state === "RESUME_REQUIRES_TETHER" || result.state === "RESUME_REQUIRES_FRESH_ATTESTATION" ? buildTetherLaunchPagePath(submission.examId) : null,
    resumeCount: submission.resumeCount,
    lastResumedAt: submission.lastResumedAt,
    lastAutosaveAcknowledgedAt: submission.lastAutosaveAcknowledgedAt,
    lastServerContactAt: currentSession?.lastHeartbeatAt ?? null,
    deadline,
  };
}

// ---------------------------------------------------------------------------
// Lecturer visibility (Part 12) — compact, batched (never N+1), never
// exposes local answer contents/tokens/public keys/signatures/
// installation secrets/stack traces. See
// src/app/lecturer/exams/[id]/submissions/page.tsx.
// ---------------------------------------------------------------------------

export type LecturerRecoveryStatus = {
  state: RecoveryState;
  label: string;
  lastServerContactAt: Date | null;
  resumeCount: number;
  /** null when no recent report exists — the UI treats that as "unknown", never as zero. */
  pendingSaveCount: number | null;
};

/** How recent an AUTOSAVE_PENDING_COUNT_REPORTED event must be to be shown at all (Part 12: "pending-save count where reliable") — a report older than this is stale and treated as unknown, never shown as if it were current. */
const PENDING_SAVE_COUNT_FRESHNESS_MS = 2 * 60_000;

/**
 * Batched (never N+1) — one query for submissions, one for their current
 * non-terminal SecureClientSessions, one for their most recent
 * AUTOSAVE_PENDING_COUNT_REPORTED event. Never queries per-submission in
 * a loop.
 */
export async function resolveExamSubmissionsRecoveryStatuses(
  submissionIds: string[],
): Promise<Map<string, LecturerRecoveryStatus>> {
  const result = new Map<string, LecturerRecoveryStatus>();
  if (submissionIds.length === 0) return result;

  const submissions = await prisma.submission.findMany({
    where: { id: { in: submissionIds } },
    include: { exam: true },
  });
  const sessions = await prisma.secureClientSession.findMany({
    where: { submissionId: { in: submissionIds }, status: { in: ["CREATED", "PREFLIGHT", "ACTIVE", "INTERRUPTED", "RECOVERY_REQUIRED"] } },
    orderBy: { createdAt: "desc" },
  });
  const sessionBySubmission = new Map<string, (typeof sessions)[number]>();
  for (const s of sessions) {
    if (!sessionBySubmission.has(s.submissionId)) sessionBySubmission.set(s.submissionId, s);
  }
  const pendingCountEvents = await prisma.secureClientEvent.findMany({
    where: { submissionId: { in: submissionIds }, eventType: "AUTOSAVE_PENDING_COUNT_REPORTED" },
    orderBy: { serverReceivedAt: "desc" },
  });
  const pendingCountBySubmission = new Map<string, { count: number; at: Date }>();
  for (const e of pendingCountEvents) {
    if (pendingCountBySubmission.has(e.submissionId)) continue;
    const metadata = e.metadataJson as { pendingSaveCount?: number } | null;
    if (typeof metadata?.pendingSaveCount === "number") {
      pendingCountBySubmission.set(e.submissionId, { count: metadata.pendingSaveCount, at: e.serverReceivedAt });
    }
  }

  const offlineContinueMs = resolveOfflineContinueMs();
  const nowMs = Date.now();

  for (const submission of submissions) {
    const settings = parseSecureSettings(submission.exam.secureSettings);
    const timingPolicy = resolveSubmissionTimingPolicy({
      examPolicySnapshotJson: submission.examPolicySnapshotJson,
      currentExamDurationMins: submission.exam.durationMins,
      currentSecureSettings: settings,
    });
    const deadline = submissionDeadline(submission.startedAt, timingPolicy.durationMins);
    const policy = parseSecureClientPolicy(submission.secureClientPolicySnapshotJson);
    const currentSession = sessionBySubmission.get(submission.id) ?? null;

    const { state } = resolveRecoveryState({
      authenticated: true,
      submissionStatus: submission.status,
      nowMs,
      deadlineMs: deadline.getTime(),
      deliveryMode: policy.deliveryMode,
      session: currentSession
        ? {
            status: currentSession.status as RecoverySessionInput["status"],
            verificationStatus: currentSession.verificationStatus,
            installationAttestationVerified: currentSession.installationAttestationVerified,
            attestationRequirement: parseAttestationRequirement(currentSession.attestationRequirement),
            lastHeartbeatAtMs: currentSession.lastHeartbeatAt?.getTime() ?? null,
            startedAtMs: currentSession.startedAt.getTime(),
            clientInstallationId: currentSession.clientInstallationId,
          }
        : null,
      heartbeatPolicy: { heartbeatIntervalSeconds: policy.heartbeatIntervalSeconds, heartbeatGraceSeconds: policy.heartbeatGraceSeconds },
      offlineContinueMs,
      requestingInstallationId: null,
    });

    // Part 12's own compact vocabulary is narrower than the full
    // RecoveryState set — "Resumed" is shown once resumeCount > 0 and the
    // attempt is otherwise ACTIVE, distinctly from a plain never-
    // interrupted ACTIVE attempt.
    const label =
      state === "ACTIVE" && submission.resumeCount > 0
        ? "Resumed"
        : state === "TEMPORARILY_DISCONNECTED"
          ? "Connection interrupted"
          : state === "MANUAL_REVIEW_REQUIRED"
            ? "Manual review required"
            : state === "SUBMITTED"
              ? "Submitted"
              : state === "ACTIVE"
                ? "Active"
                : RECOVERY_STATE_COPY[state].label;

    const pendingReport = pendingCountBySubmission.get(submission.id);
    const pendingSaveCount = pendingReport && nowMs - pendingReport.at.getTime() <= PENDING_SAVE_COUNT_FRESHNESS_MS ? pendingReport.count : null;

    result.set(submission.id, {
      state,
      label,
      lastServerContactAt: latestOf(currentSession?.lastHeartbeatAt ?? null, submission.lastAutosaveAcknowledgedAt),
      resumeCount: submission.resumeCount,
      pendingSaveCount,
    });
  }

  return result;
}

function latestOf(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/**
 * Called by the POST /api/tether/exam-session/attestation/verify route
 * (never by tetherAttestationRunner.ts itself, which documents a
 * structural guarantee that it never writes to Submission — see that
 * file's own top-level doc comment) immediately after
 * verifyExamSessionAttestation returns `{ outcome: "VERIFIED",
 * isRecoveryCompletion: true, ... }` — that flag already encodes both
 * "this session has recoveryOfSessionId set" (created to supersede an
 * earlier session for this submission — see getOrCreateSessionCore in
 * secureClientRunner.ts) AND "this is the first time THIS session has
 * verified" (so a hypothetical re-attestation of an already-verified
 * session can never double-count). A submission's very first launch never
 * has recoveryOfSessionId set, so resumeCount is never incremented for
 * it. Best-effort: the caller must catch — never allowed to turn a
 * successful attestation into a failure response.
 */
export async function recordSecureResumeCompleted(sessionId: string): Promise<void> {
  const session = await prisma.secureClientSession.findUnique({ where: { id: sessionId } });
  if (!session || !session.recoveryOfSessionId) return;

  await prisma.submission.update({
    where: { id: session.submissionId },
    data: { resumeCount: { increment: 1 }, lastResumedAt: new Date() },
  });
  await createPlatformAuditLog({
    actorId: session.studentId,
    action: "TETHER_SECURE_RESUME_COMPLETED",
    targetType: "Submission",
    targetId: session.submissionId,
    institutionId: session.institutionId,
    metadata: { secureClientSessionId: session.id, recoveryOfSessionId: session.recoveryOfSessionId },
  }).catch(() => {});
}

/**
 * Called from verifyExamSessionAttestation when a recovery session's
 * fresh attestation is refused because the installation attempting it
 * differs from the one the superseded session was bound to (Part 8).
 * Audited distinctly from an ordinary attestation failure so an unusual
 * pattern of device-change attempts is reviewable later — never an
 * IntegrityEvent (Part 13: a device change is not itself misconduct).
 */
export async function recordSecureResumeDeviceChangeBlocked(params: {
  sessionId: string;
  submissionId: string;
  studentId: string;
  institutionId: string;
  boundInstallationId: string;
  attemptingInstallationId: string;
}): Promise<void> {
  await createPlatformAuditLog({
    actorId: params.studentId,
    action: "TETHER_SECURE_RESUME_DENIED_DEVICE_CHANGE",
    targetType: "Submission",
    targetId: params.submissionId,
    institutionId: params.institutionId,
    metadata: {
      secureClientSessionId: params.sessionId,
      boundInstallationId: params.boundInstallationId,
      attemptingInstallationId: params.attemptingInstallationId,
    },
  }).catch(() => {});
}
