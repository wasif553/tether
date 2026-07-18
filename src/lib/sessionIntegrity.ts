/**
 * Exam Session Binding v1 — pure session classification rules. See
 * docs/exam-session-binding-v1.md.
 *
 * Pure, dependency-free, deterministic: no Prisma, no Next.js, no
 * browser APIs, no crypto — operates entirely on opaque hash STRINGS and
 * plain epoch-millisecond timestamps supplied by the caller (mirrors the
 * separation between src/lib/answerSimilarity.ts (pure engine) and
 * src/lib/similarityAnalysisRunner.ts (server orchestration)).
 *
 * Every function here produces a REVIEW SIGNAL for a human lecturer:
 * "Session review recommended", never "device fraud confirmed". A single
 * weak signal (one IP-prefix change, one user-agent change) is
 * deliberately insufficient on its own — see the thresholds below.
 */

export const SIGNAL_LEVELS = ["LOW", "MEDIUM", "HIGH"] as const;
export type SignalLevel = (typeof SIGNAL_LEVELS)[number];

export const SESSION_SIGNAL_TYPES = [
  "CONCURRENT_ACTIVE_SESSIONS",
  "DEVICE_TOKEN_CHANGED",
  "COARSE_DEVICE_PROFILE_CHANGED",
  "USER_AGENT_CHANGED",
  "NETWORK_PREFIX_CHANGED",
  "REPEATED_NETWORK_CHANGES",
  "CAMERA_PERMISSION_CHANGED",
  "SESSION_TOKEN_MISMATCH",
  "SESSION_RESTARTED",
] as const;
export type SessionSignalType = (typeof SESSION_SIGNAL_TYPES)[number];

export const SESSION_REVIEW_STATUSES = [
  "NEEDS_REVIEW",
  "REVIEWED_NO_CONCERN",
  "REVIEWED_CONCERN_REMAINS",
  "ESCALATED",
  "RESOLVED",
] as const;
export type SessionReviewStatus = (typeof SESSION_REVIEW_STATUSES)[number];

export function isValidSessionReviewStatus(value: string): value is SessionReviewStatus {
  return (SESSION_REVIEW_STATUSES as readonly string[]).includes(value);
}

/** Required neutral wording — see docs/exam-session-binding-v1.md. Never "device fraud confirmed" / "impersonation confirmed". */
export const SESSION_REVIEW_STATUS_LABELS: Record<SessionReviewStatus, string> = {
  NEEDS_REVIEW: "Session review recommended",
  REVIEWED_NO_CONCERN: "Reviewed — no concern",
  REVIEWED_CONCERN_REMAINS: "Concern remains",
  ESCALATED: "Escalated",
  RESOLVED: "Resolved",
};

export const SESSION_SIGNAL_HEADLINES: Record<SessionSignalType, string> = {
  CONCURRENT_ACTIVE_SESSIONS: "Session review recommended",
  DEVICE_TOKEN_CHANGED: "Device or browser changed during attempt",
  COARSE_DEVICE_PROFILE_CHANGED: "Device or browser changed during attempt",
  USER_AGENT_CHANGED: "Device or browser changed during attempt",
  NETWORK_PREFIX_CHANGED: "Network changed during attempt",
  REPEATED_NETWORK_CHANGES: "Network changed during attempt",
  CAMERA_PERMISSION_CHANGED: "Session review recommended",
  SESSION_TOKEN_MISMATCH: "Session review recommended",
  SESSION_RESTARTED: "Session review recommended",
};

// ---------------------------------------------------------------------------
// Thresholds — every default is named and documented, never a magic
// number buried in a UI component. See docs/exam-session-binding-v1.md.
// ---------------------------------------------------------------------------

/** A session is only "active" if seen within this window (Part 5). */
export const ACTIVE_SESSION_TIMEOUT_MS = 90_000;
/** Overlap shorter than this is treated as request-duplication noise, not a genuine concurrent session. */
export const MIN_OVERLAP_MS_FOR_CONCURRENT_SIGNAL = 5_000;
/** Window within which distinct network prefixes are counted for the "repeated changes" signal. */
export const NETWORK_CHANGE_WINDOW_MS = 30 * 60 * 1000;
/** Distinct IP prefixes within the window required for REPEATED_NETWORK_CHANGES. */
export const MIN_DISTINCT_PREFIXES_FOR_REPEATED_CHANGE = 3;
/** Do not create a duplicate signal of the same type within this cooldown (Part 4 — "avoid duplicate signals on every request"). */
export const SIGNAL_DEDUPLICATION_COOLDOWN_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Signal record shape
// ---------------------------------------------------------------------------

export type SessionIntegritySignalRecord = {
  examAttemptSessionId: string | null;
  signalType: SessionSignalType;
  signalLevel: SignalLevel;
  explanation: string;
  evidence: string[];
  limitation: string;
  reasonCode: string;
};

// ---------------------------------------------------------------------------
// Part 5 — Concurrent-session detection
// ---------------------------------------------------------------------------

export type SessionSnapshot = {
  id: string;
  browserSessionTokenHash: string;
  deviceTokenHash: string;
  browserFamily: string | null;
  status: "ACTIVE" | "STALE" | "ENDED" | "REPLACED";
  firstSeenAt: number;
  lastSeenAt: number;
};

/** A session counts as active only when flagged ACTIVE and seen within the timeout — never STALE/ENDED/REPLACED. */
export function isSessionActive(session: SessionSnapshot, nowMs: number, timeoutMs = ACTIVE_SESSION_TIMEOUT_MS): boolean {
  return session.status === "ACTIVE" && nowMs - session.lastSeenAt <= timeoutMs;
}

export type ConcurrentSessionResult = {
  flagged: boolean;
  overlappingSessionIds: string[];
  overlapCount: number;
  firstOverlapAtMs: number | null;
  lastOverlapAtMs: number | null;
  deviceTokenHashesInvolved: string[];
  browserFamiliesInvolved: string[];
};

/**
 * Flags CONCURRENT_ACTIVE_SESSIONS only when two DIFFERENT browser-session
 * tokens are both active (Part 5) and their active windows genuinely
 * overlap for at least MIN_OVERLAP_MS_FOR_CONCURRENT_SIGNAL — never a
 * page refresh resuming the same token, never a session that went stale
 * before another started, never a single duplicate request's momentary
 * overlap.
 */
export function detectConcurrentActiveSessions(
  sessions: SessionSnapshot[],
  nowMs: number,
  timeoutMs = ACTIVE_SESSION_TIMEOUT_MS,
): ConcurrentSessionResult {
  const active = sessions.filter((s) => isSessionActive(s, nowMs, timeoutMs));
  // Distinct browser-session tokens only — the same token seen via two
  // rows (should not normally happen) is not "concurrent" with itself.
  const distinctByToken = new Map<string, SessionSnapshot>();
  for (const s of active) {
    if (!distinctByToken.has(s.browserSessionTokenHash)) distinctByToken.set(s.browserSessionTokenHash, s);
  }
  const distinctActive = [...distinctByToken.values()];

  const overlappingIds = new Set<string>();
  let firstOverlapAtMs: number | null = null;
  let lastOverlapAtMs: number | null = null;

  for (let i = 0; i < distinctActive.length; i++) {
    for (let j = i + 1; j < distinctActive.length; j++) {
      const a = distinctActive[i];
      const b = distinctActive[j];
      // Active interval extended by the timeout grace window on the end,
      // since "last seen" doesn't mean "ended" for a still-active session.
      const aEnd = a.lastSeenAt + timeoutMs;
      const bEnd = b.lastSeenAt + timeoutMs;
      const overlapStart = Math.max(a.firstSeenAt, b.firstSeenAt);
      const overlapEnd = Math.min(aEnd, bEnd);
      const overlapDuration = overlapEnd - overlapStart;
      if (overlapDuration >= MIN_OVERLAP_MS_FOR_CONCURRENT_SIGNAL) {
        overlappingIds.add(a.id);
        overlappingIds.add(b.id);
        firstOverlapAtMs = firstOverlapAtMs === null ? overlapStart : Math.min(firstOverlapAtMs, overlapStart);
        lastOverlapAtMs = lastOverlapAtMs === null ? overlapEnd : Math.max(lastOverlapAtMs, overlapEnd);
      }
    }
  }

  const overlapping = distinctActive.filter((s) => overlappingIds.has(s.id));
  return {
    flagged: overlapping.length >= 2,
    overlappingSessionIds: [...overlappingIds],
    overlapCount: overlapping.length,
    firstOverlapAtMs,
    lastOverlapAtMs,
    deviceTokenHashesInvolved: [...new Set(overlapping.map((s) => s.deviceTokenHash))],
    browserFamiliesInvolved: [...new Set(overlapping.map((s) => s.browserFamily).filter((f): f is string => Boolean(f)))],
  };
}

export function buildConcurrentSessionSignal(result: ConcurrentSessionResult): SessionIntegritySignalRecord | null {
  if (!result.flagged) return null;
  const overlapSeconds =
    result.firstOverlapAtMs != null && result.lastOverlapAtMs != null
      ? Math.round((result.lastOverlapAtMs - result.firstOverlapAtMs) / 1000)
      : null;
  return {
    examAttemptSessionId: null,
    signalType: "CONCURRENT_ACTIVE_SESSIONS",
    signalLevel: "MEDIUM",
    explanation: `Two active browser sessions were observed for this attempt${overlapSeconds != null ? ` during an overlapping ${overlapSeconds}-second period` : ""}.`,
    evidence: [
      `Overlapping sessions: ${result.overlapCount}`,
      ...(result.browserFamiliesInvolved.length > 0 ? [`Browsers involved: ${result.browserFamiliesInvolved.join(", ")}`] : []),
    ],
    limitation: "A browser recovery or duplicated tab may sometimes create temporary overlap.",
    reasonCode: "CONCURRENT_ACTIVE_SESSIONS",
  };
}

// ---------------------------------------------------------------------------
// Part 6 — Device, user-agent, network, camera-permission changes
// ---------------------------------------------------------------------------

export type DeviceProfileSnapshot = {
  deviceTokenHash: string;
  userAgentHash: string | null;
  browserFamily: string | null;
  operatingSystemFamily: string | null;
  deviceCategory: string | null;
};

export function detectDeviceTokenChange(
  previous: DeviceProfileSnapshot,
  current: DeviceProfileSnapshot,
  previousSessionRecentlyActive: boolean,
): SessionIntegritySignalRecord | null {
  if (previous.deviceTokenHash === current.deviceTokenHash) return null;
  return {
    examAttemptSessionId: null,
    signalType: "DEVICE_TOKEN_CHANGED",
    signalLevel: previousSessionRecentlyActive ? "HIGH" : "MEDIUM",
    explanation: "The persistent server-issued device identifier changed during this attempt.",
    evidence: [previousSessionRecentlyActive ? "Previous session was still active or recently active" : "Previous session had already ended"],
    limitation: "A student may legitimately switch devices (e.g. laptop to a lab workstation) between sanctioned breaks.",
    reasonCode: "DEVICE_TOKEN_CHANGED",
  };
}

/** Never flags a minor browser VERSION change — browserFamily is already coarse (Chrome/Firefox/Safari/...), not versioned. */
export function detectCoarseDeviceProfileChange(
  previous: DeviceProfileSnapshot,
  current: DeviceProfileSnapshot,
): SessionIntegritySignalRecord | null {
  const desktopMobileSwitch =
    previous.deviceCategory != null &&
    current.deviceCategory != null &&
    previous.deviceCategory !== current.deviceCategory &&
    (previous.deviceCategory === "desktop" || current.deviceCategory === "desktop");
  const osChanged =
    previous.operatingSystemFamily != null &&
    current.operatingSystemFamily != null &&
    previous.operatingSystemFamily !== current.operatingSystemFamily;
  const browserAndDeviceBothChanged =
    previous.browserFamily != null &&
    current.browserFamily != null &&
    previous.browserFamily !== current.browserFamily &&
    previous.deviceCategory != null &&
    current.deviceCategory != null &&
    previous.deviceCategory !== current.deviceCategory;

  if (!desktopMobileSwitch && !osChanged && !browserAndDeviceBothChanged) return null;

  const evidence: string[] = [];
  if (desktopMobileSwitch) evidence.push(`Device category changed: ${previous.deviceCategory} → ${current.deviceCategory}`);
  if (osChanged) evidence.push(`Operating system family changed: ${previous.operatingSystemFamily} → ${current.operatingSystemFamily}`);
  if (browserAndDeviceBothChanged) evidence.push(`Browser and device category both changed`);

  return {
    examAttemptSessionId: null,
    signalType: "COARSE_DEVICE_PROFILE_CHANGED",
    signalLevel: "MEDIUM",
    explanation: "The device profile changed during the exam.",
    evidence,
    limitation: "A student may switch devices legitimately, or a browser may report a different profile after an update.",
    reasonCode: "COARSE_DEVICE_PROFILE_CHANGED",
  };
}

/** A user-agent hash change alone is LOW; only escalates to MEDIUM when combined with another concurrent change. */
export function detectUserAgentChange(
  previous: DeviceProfileSnapshot,
  current: DeviceProfileSnapshot,
  combinedWithOtherChange: boolean,
): SessionIntegritySignalRecord | null {
  if (!previous.userAgentHash || !current.userAgentHash || previous.userAgentHash === current.userAgentHash) return null;
  return {
    examAttemptSessionId: null,
    signalType: "USER_AGENT_CHANGED",
    signalLevel: combinedWithOtherChange ? "MEDIUM" : "LOW",
    explanation: "The browser's user-agent identifier changed during this attempt.",
    evidence: [combinedWithOtherChange ? "Combined with a concurrent device or session change" : "No other device/session change observed"],
    limitation: "A browser or OS update mid-session can change the user-agent string without any device change.",
    reasonCode: "USER_AGENT_CHANGED",
  };
}

export type NetworkPrefixObservation = { prefixHash: string; atMs: number };

/**
 * A single prefix change is LOW/informational — mobile networks,
 * institutional Wi-Fi, and VPNs legitimately rotate addresses. Only
 * REPEATED distinct prefixes within a short window escalate to MEDIUM.
 * Never described as geographic travel — v1 does no IP geolocation.
 */
export function detectNetworkPrefixChange(
  observations: NetworkPrefixObservation[],
  nowMs: number,
  windowMs = NETWORK_CHANGE_WINDOW_MS,
  minDistinctForRepeated = MIN_DISTINCT_PREFIXES_FOR_REPEATED_CHANGE,
): SessionIntegritySignalRecord | null {
  const withinWindow = observations.filter((o) => nowMs - o.atMs <= windowMs);
  const distinctPrefixes = new Set(withinWindow.map((o) => o.prefixHash));
  if (distinctPrefixes.size >= minDistinctForRepeated) {
    return {
      examAttemptSessionId: null,
      signalType: "REPEATED_NETWORK_CHANGES",
      signalLevel: "MEDIUM",
      explanation: `${distinctPrefixes.size} distinct network address ranges were observed for this attempt within a short period.`,
      evidence: [`Distinct network prefixes: ${distinctPrefixes.size}`],
      limitation: "Mobile networks, institutional Wi-Fi roaming, and VPNs can legitimately rotate network addresses. This is not geographic location evidence.",
      reasonCode: "REPEATED_NETWORK_CHANGES",
    };
  }
  if (distinctPrefixes.size === 2) {
    return {
      examAttemptSessionId: null,
      signalType: "NETWORK_PREFIX_CHANGED",
      signalLevel: "LOW",
      explanation: "The network address range changed once during this attempt.",
      evidence: ["Network prefix changed once"],
      limitation: "A single network change is common and expected — mobile networks, Wi-Fi roaming, and VPNs legitimately change addresses. This is not geographic location evidence.",
      reasonCode: "NETWORK_PREFIX_CHANGED",
    };
  }
  return null;
}

export function detectCameraPermissionChange(
  previousState: string,
  currentState: string,
): SessionIntegritySignalRecord | null {
  // Only the "access was revoked" direction is meaningful — never flag
  // discovery transitions into/out of "unknown"/"prompt" (an unsupported
  // Permissions API result is "unknown", never a violation).
  const concerning = previousState === "granted" && (currentState === "denied" || currentState === "unavailable");
  if (!concerning) return null;
  return {
    examAttemptSessionId: null,
    signalType: "CAMERA_PERMISSION_CHANGED",
    signalLevel: "LOW",
    explanation: `Camera permission changed from "${previousState}" to "${currentState}" during this attempt.`,
    evidence: [`${previousState} → ${currentState}`],
    limitation: "The student may have revoked permission accidentally, or the browser/OS may have reset it. This does not duplicate camera integrity events, which are tracked separately.",
    reasonCode: "CAMERA_PERMISSION_CHANGED",
  };
}

export function buildSessionTokenMismatchSignal(): SessionIntegritySignalRecord {
  return {
    examAttemptSessionId: null,
    signalType: "SESSION_TOKEN_MISMATCH",
    signalLevel: "LOW",
    explanation: "A request for this attempt arrived with a session identifier that did not match any known session for this attempt.",
    evidence: ["Session token did not match a known active/stale session"],
    limitation: "This can happen after a browser restart, a cleared cookie, or a long period away from the tab. The attempt continues normally.",
    reasonCode: "SESSION_TOKEN_MISMATCH",
  };
}

export function buildSessionRestartedSignal(): SessionIntegritySignalRecord {
  return {
    examAttemptSessionId: null,
    signalType: "SESSION_RESTARTED",
    signalLevel: "LOW",
    explanation: "A previously ended session for this device resumed activity on this attempt.",
    evidence: ["Device token matched a previously ended session"],
    limitation: "This commonly happens after a browser or tab restart and is expected behaviour.",
    reasonCode: "SESSION_RESTARTED",
  };
}

// ---------------------------------------------------------------------------
// Deduplication / cooldown (Part 4)
// ---------------------------------------------------------------------------

export type RecentSignalRecord = { signalType: SessionSignalType; createdAtMs: number };

/** True only if no signal of this exact type was created within the cooldown window — prevents a signal being recreated on every heartbeat. */
export function shouldEmitSignal(
  recentSignals: RecentSignalRecord[],
  signalType: SessionSignalType,
  nowMs: number,
  cooldownMs = SIGNAL_DEDUPLICATION_COOLDOWN_MS,
): boolean {
  return !recentSignals.some((s) => s.signalType === signalType && nowMs - s.createdAtMs < cooldownMs);
}
