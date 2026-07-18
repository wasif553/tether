/**
 * Exam Session Binding v1 — server-only attempt-binding lifecycle. See
 * docs/exam-session-binding-v1.md.
 *
 * Touches Prisma and reads request headers, so it must never be imported
 * from a "use client" component. Pure classification logic lives in
 * src/lib/sessionIntegrity.ts; pure crypto/classification helpers live in
 * src/lib/sessionBinding.ts — this module only wires data in and out of
 * them, mirroring src/lib/similarityAnalysisRunner.ts.
 *
 * The FIRST heartbeat call after an exam page loads is what creates the
 * ExamAttemptSession (see docs/exam-session-binding-v1.md, "Why binding
 * happens on first heartbeat, not at POST /api/exams/[id]/start") — this
 * keeps the already-complex attempt-start route untouched and gives one
 * single, well-tested place where binding is created or resumed.
 */
import { prisma } from "@/lib/prisma";
import { getClientIpFromRequest } from "@/lib/networkEvidence";
import {
  generateRandomToken,
  hmacHash,
  deriveIpPrefix,
  classifyUserAgent,
  bucketScreenSize,
  normalizeAcceptLanguage,
  computeCoarseFingerprintHash,
  normalizeCameraPermissionState,
  BROWSER_SESSION_COOKIE_NAME,
  DEVICE_TOKEN_COOKIE_NAME,
} from "@/lib/sessionBinding";
import {
  detectConcurrentActiveSessions,
  buildConcurrentSessionSignal,
  detectDeviceTokenChange,
  detectCoarseDeviceProfileChange,
  detectUserAgentChange,
  detectNetworkPrefixChange,
  detectCameraPermissionChange,
  buildSessionRestartedSignal,
  shouldEmitSignal,
  SIGNAL_DEDUPLICATION_COOLDOWN_MS,
  type SessionSnapshot,
  type DeviceProfileSnapshot,
  type SessionIntegritySignalRecord,
  type RecentSignalRecord,
  type SessionSignalType,
} from "@/lib/sessionIntegrity";
import { createPlatformAuditLog } from "@/lib/platformAdmin";

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

export type HeartbeatClientHints = {
  timezone?: string | null;
  screenWidth?: number | null;
  cameraPermissionState?: string | null;
};

export type HeartbeatResult = {
  sessionId: string;
  cameraPermissionState: string;
  concurrentSessionDetected: boolean;
  browserSessionToken: string;
  deviceToken: string;
  browserSessionIsNew: boolean;
  deviceTokenIsNew: boolean;
};

/**
 * Creates or resumes the ExamAttemptSession for this (submission, user)
 * pair, binds it to the current request's device/network/UA signals, and
 * persists any explainable session-integrity signals — deduplicated
 * within SIGNAL_DEDUPLICATION_COOLDOWN_MS so a signal is never recreated
 * on every heartbeat. Never throws for a classification/signal-write
 * failure path beyond what Prisma itself would throw for the core
 * upsert; callers should still treat this as best-effort where called
 * from a non-heartbeat route (see wiring in answers/submit routes).
 */
export async function recordExamAttemptHeartbeat(
  req: Request,
  submissionId: string,
  userId: string,
  hints: HeartbeatClientHints,
): Promise<HeartbeatResult> {
  const now = new Date();
  const nowMs = now.getTime();

  const cookies = parseCookies(req.headers.get("cookie"));
  const existingBrowserSessionToken = cookies[BROWSER_SESSION_COOKIE_NAME];
  const existingDeviceToken = cookies[DEVICE_TOKEN_COOKIE_NAME];
  const browserSessionIsNew = !existingBrowserSessionToken;
  const deviceTokenIsNew = !existingDeviceToken;
  const browserSessionToken = existingBrowserSessionToken || generateRandomToken();
  const deviceToken = existingDeviceToken || generateRandomToken();

  const browserSessionTokenHash = hmacHash(browserSessionToken);
  const deviceTokenHash = hmacHash(deviceToken);

  const ua = req.headers.get("user-agent");
  const { browserFamily, operatingSystemFamily, deviceCategory, userAgentHash } = classifyUserAgent(ua);
  const ip = getClientIpFromRequest(req);
  const ipPrefix = deriveIpPrefix(ip);
  const acceptLanguagePrimary = normalizeAcceptLanguage(req.headers.get("accept-language"));
  const screenBucket = bucketScreenSize(hints.screenWidth ?? null);
  const coarseFingerprintHash = computeCoarseFingerprintHash({
    browserFamily,
    operatingSystemFamily,
    deviceCategory,
    acceptLanguagePrimary,
    timezone: hints.timezone ?? null,
    screenBucket,
  });
  const cameraPermissionState = normalizeCameraPermissionState(hints.cameraPermissionState);

  // Bounded to this one submission's own sessions — never institution-wide.
  const existingSessions = await prisma.examAttemptSession.findMany({ where: { submissionId } });
  const existingByToken = existingSessions.find((s) => s.browserSessionTokenHash === browserSessionTokenHash);

  const signalsToCreate: SessionIntegritySignalRecord[] = [];
  let sessionId: string;

  if (existingByToken) {
    const previousProfile: DeviceProfileSnapshot = {
      deviceTokenHash: existingByToken.deviceTokenHash,
      userAgentHash: existingByToken.userAgentHash,
      browserFamily: existingByToken.browserFamily,
      operatingSystemFamily: existingByToken.operatingSystemFamily,
      deviceCategory: existingByToken.deviceCategory,
    };
    const currentProfile: DeviceProfileSnapshot = { deviceTokenHash, userAgentHash, browserFamily, operatingSystemFamily, deviceCategory };

    const deviceChange = detectDeviceTokenChange(previousProfile, currentProfile, true);
    const coarseChange = detectCoarseDeviceProfileChange(previousProfile, currentProfile);
    const uaChange = detectUserAgentChange(previousProfile, currentProfile, Boolean(deviceChange || coarseChange));
    const cameraChange = detectCameraPermissionChange(existingByToken.cameraPermissionState, cameraPermissionState);
    for (const s of [deviceChange, coarseChange, uaChange, cameraChange]) if (s) signalsToCreate.push(s);

    const updated = await prisma.examAttemptSession.update({
      where: { id: existingByToken.id },
      data: {
        deviceTokenHash,
        coarseFingerprintHash,
        userAgentHash,
        browserFamily,
        operatingSystemFamily,
        deviceCategory,
        ipPrefixHash: ipPrefix?.prefixHash ?? existingByToken.ipPrefixHash,
        ipVersion: ipPrefix?.version ?? existingByToken.ipVersion,
        cameraPermissionState,
        lastSeenAt: now,
        status: "ACTIVE",
      },
    });
    sessionId = updated.id;
  } else {
    // A new browser-session token on a device that already has a
    // non-active session for this submission is a benign restart, not a
    // device change.
    const sameDeviceRecentSession = existingSessions.find((s) => s.deviceTokenHash === deviceTokenHash && s.status !== "ACTIVE");
    if (sameDeviceRecentSession) signalsToCreate.push(buildSessionRestartedSignal());

    const created = await prisma.examAttemptSession.create({
      data: {
        submissionId,
        userId,
        browserSessionTokenHash,
        deviceTokenHash,
        coarseFingerprintHash,
        userAgentHash,
        browserFamily,
        operatingSystemFamily,
        deviceCategory,
        ipPrefixHash: ipPrefix?.prefixHash ?? null,
        ipVersion: ipPrefix?.version ?? null,
        cameraPermissionState,
        startedAt: now,
        firstSeenAt: now,
        lastSeenAt: now,
        status: "ACTIVE",
      },
    });
    sessionId = created.id;
  }

  // Concurrent-session detection across ALL of this submission's sessions.
  const allSessions = await prisma.examAttemptSession.findMany({ where: { submissionId } });
  const snapshots: SessionSnapshot[] = allSessions.map((s) => ({
    id: s.id,
    browserSessionTokenHash: s.browserSessionTokenHash,
    deviceTokenHash: s.deviceTokenHash,
    browserFamily: s.browserFamily,
    status: s.status as SessionSnapshot["status"],
    firstSeenAt: s.firstSeenAt.getTime(),
    lastSeenAt: s.lastSeenAt.getTime(),
  }));
  const concurrentResult = detectConcurrentActiveSessions(snapshots, nowMs);
  const concurrentSignal = buildConcurrentSessionSignal(concurrentResult);
  if (concurrentSignal) signalsToCreate.push(concurrentSignal);

  if (ipPrefix) {
    const observations = allSessions
      .filter((s) => s.ipPrefixHash)
      .map((s) => ({ prefixHash: s.ipPrefixHash!, atMs: s.lastSeenAt.getTime() }));
    observations.push({ prefixHash: ipPrefix.prefixHash, atMs: nowMs });
    const networkSignal = detectNetworkPrefixChange(observations, nowMs);
    if (networkSignal) signalsToCreate.push(networkSignal);
  }

  if (signalsToCreate.length > 0) {
    const recentSignalRows = await prisma.sessionIntegritySignal.findMany({
      where: { submissionId, createdAt: { gte: new Date(nowMs - SIGNAL_DEDUPLICATION_COOLDOWN_MS) } },
      select: { signalType: true, createdAt: true },
    });
    const recentRecords: RecentSignalRecord[] = recentSignalRows.map((s) => ({
      signalType: s.signalType as SessionSignalType,
      createdAtMs: s.createdAt.getTime(),
    }));

    for (const sig of signalsToCreate) {
      if (!shouldEmitSignal(recentRecords, sig.signalType, nowMs)) continue;
      const created = await prisma.sessionIntegritySignal.create({
        data: {
          submissionId,
          examAttemptSessionId: sessionId,
          signalType: sig.signalType,
          signalLevel: sig.signalLevel,
          explanation: sig.explanation,
          evidenceJson: sig.evidence,
        },
      });
      recentRecords.push({ signalType: sig.signalType, createdAtMs: nowMs });
      createPlatformAuditLog({
        actorId: null,
        action: "SESSION_INTEGRITY_SIGNAL_DETECTED",
        targetType: "SessionIntegritySignal",
        targetId: created.id,
        metadata: { submissionId, signalType: sig.signalType, signalLevel: sig.signalLevel },
      }).catch(() => {});
    }
  }

  return {
    sessionId,
    cameraPermissionState,
    concurrentSessionDetected: concurrentResult.flagged,
    browserSessionToken,
    deviceToken,
    browserSessionIsNew,
    deviceTokenIsNew,
  };
}

/** Marks every non-ENDED session for this submission ENDED — called at final submit. Best-effort; never blocks submission. */
export async function endExamAttemptSessionsForSubmission(submissionId: string): Promise<void> {
  try {
    await prisma.examAttemptSession.updateMany({
      where: { submissionId, status: { not: "ENDED" } },
      data: { status: "ENDED", endedAt: new Date() },
    });
  } catch {
    // Never blocks submission.
  }
}

/**
 * Best-effort lookup of the most recently active session for a
 * submission, used by non-heartbeat routes (answer save, submit) to
 * attach telemetry to a session without performing full binding logic.
 * Returns null if none exists yet — telemetry is simply unattached.
 */
export async function findMostRecentSessionId(submissionId: string): Promise<string | null> {
  try {
    const session = await prisma.examAttemptSession.findFirst({
      where: { submissionId },
      orderBy: { lastSeenAt: "desc" },
      select: { id: true },
    });
    return session?.id ?? null;
  } catch {
    return null;
  }
}
