/**
 * Tether Secure Client Foundation v1 — session state machine. See
 * docs/secure-client-foundation-seb-v1.md and Part 10 of the spec.
 *
 * Pure, dependency-free: no Prisma, no Next.js. A missed heartbeat is NOT
 * immediately treated as misconduct — the configured grace period (from
 * the immutable policy snapshot) must fully expire before a session is
 * ever derived as interrupted. Interruption never automatically submits
 * the attempt. No high-frequency background job — interruption state is
 * derived on demand (client reconnect, lecturer opening the session,
 * start/resume) per Part 10.
 */

export const SESSION_STATUSES = ["CREATED", "PREFLIGHT", "ACTIVE", "INTERRUPTED", "RECOVERY_REQUIRED", "ENDED", "REJECTED"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];
export function isValidSessionStatus(value: string): value is SessionStatus {
  return (SESSION_STATUSES as readonly string[]).includes(value);
}

export const VERIFICATION_STATUSES = [
  "NOT_CHECKED",
  "VERIFIED",
  "INVALID_CONFIGURATION",
  "UNSUPPORTED_VERSION",
  "UNVERIFIED_CLIENT",
  "EXPIRED_LAUNCH",
  "REPLAY_REJECTED",
  "TECHNICAL_FAILURE",
  "LECTURER_OVERRIDE",
] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];
export function isValidVerificationStatus(value: string): value is VerificationStatus {
  return (VERIFICATION_STATUSES as readonly string[]).includes(value);
}

/** Non-terminal statuses — a submission may have at most one session in one of these at a time (Part 3: "one current active session per submission unless explicitly recovered"). */
export const NON_TERMINAL_SESSION_STATUSES: ReadonlySet<SessionStatus> = new Set([
  "CREATED",
  "PREFLIGHT",
  "ACTIVE",
  "INTERRUPTED",
  "RECOVERY_REQUIRED",
]);
export function isTerminalSessionStatus(status: SessionStatus): boolean {
  return !NON_TERMINAL_SESSION_STATUSES.has(status);
}

export type HeartbeatPolicy = {
  heartbeatIntervalSeconds: number;
  heartbeatGraceSeconds: number;
};

/** The absolute deadline (ms) by which a heartbeat must arrive before the session is considered overdue — interval + grace, from the immutable snapshot, never a live/current setting. */
export function heartbeatDeadlineMs(lastHeartbeatAtMs: number, policy: HeartbeatPolicy): number {
  return lastHeartbeatAtMs + (policy.heartbeatIntervalSeconds + policy.heartbeatGraceSeconds) * 1000;
}

export function isHeartbeatOverdue(lastHeartbeatAtMs: number, nowMs: number, policy: HeartbeatPolicy): boolean {
  return nowMs > heartbeatDeadlineMs(lastHeartbeatAtMs, policy);
}

/**
 * Tether Secure Exam Recovery and Resilient Autosave v1 — see
 * docs/tether-secure-resume-recovery-v1.md, "Server-authoritative
 * recovery state". A session's `verificationStatus`/
 * `installationAttestationVerified` are booleans that persist in the
 * database exactly as they were the moment they were last written — a
 * Tether crash, a killed process, or a Windows restart does not itself
 * change them. Left unchecked, that means a session verified minutes (or
 * hours) before a crash would still read as "verified" forever after,
 * which is exactly the "previously verified session trusted indefinitely"
 * gap this feature closes. This function answers a narrower question than
 * `isHeartbeatOverdue`: not just "is a heartbeat currently overdue" (which
 * an ordinary short reconnect already self-heals from, see
 * `deriveSessionStatus`/`recordHeartbeat`), but "has enough time passed
 * with no contact at all that the underlying client process may genuinely
 * be gone" — i.e. overdue AND still overdue after the bounded
 * "TEMPORARILY_DISCONNECTED / keep answering while reconnecting" window
 * (`offlineContinueMs`) has also fully elapsed. Only past that combined
 * threshold does a previously-verified session stop being trusted by the
 * real content-access gates (see resolveTrustedTetherVerification in
 * src/lib/tetherRecovery.ts) — an ordinary brief network blip, well
 * within `offlineContinueMs`, never forces a fresh attestation.
 */
export function isVerificationStillFresh(
  baselineMs: number,
  nowMs: number,
  policy: HeartbeatPolicy & { offlineContinueMs: number },
): boolean {
  return nowMs <= heartbeatDeadlineMs(baselineMs, policy) + policy.offlineContinueMs;
}

/**
 * Derives whether an ACTIVE session should now be considered interrupted
 * — called on demand (reconnect / lecturer view / start-resume), never
 * from a background job. A session that has never sent a heartbeat uses
 * `startedAt` as the baseline. Only ACTIVE sessions can become
 * INTERRUPTED this way; every other status is left unchanged (PREFLIGHT/
 * CREATED sessions that stall are a different, policy-driven timeout
 * concern, not a heartbeat interruption).
 */
export function deriveSessionStatus(
  session: { status: SessionStatus; startedAt: number; lastHeartbeatAt: number | null },
  policy: HeartbeatPolicy,
  nowMs: number,
): SessionStatus {
  if (session.status !== "ACTIVE") return session.status;
  const baseline = session.lastHeartbeatAt ?? session.startedAt;
  return isHeartbeatOverdue(baseline, nowMs, policy) ? "INTERRUPTED" : "ACTIVE";
}

// ---------------------------------------------------------------------------
// Recovery grants (Part 3/10) — one-time, short-lived, submission- and
// institution-scoped.
// ---------------------------------------------------------------------------

export type RecoveryGrantCheckInput = {
  grant: {
    submissionId: string;
    expiresAt: number;
    consumedAt: number | null;
    revokedAt: number | null;
  };
  requestSubmissionId: string;
  nowMs: number;
};

export type RecoveryGrantCheckResult = "VALID" | "WRONG_SUBMISSION" | "EXPIRED" | "ALREADY_CONSUMED" | "REVOKED";

/**
 * Validates a recovery grant WITHOUT touching the database — institution
 * scoping is enforced by the caller (the grant is only ever looked up
 * through an already-institution-scoped session query, so a cross-
 * institution grant can never even be fetched — see
 * src/lib/secureClient/secureClientRunner.ts).
 */
export function checkRecoveryGrant(input: RecoveryGrantCheckInput): RecoveryGrantCheckResult {
  if (input.grant.submissionId !== input.requestSubmissionId) return "WRONG_SUBMISSION";
  if (input.grant.revokedAt != null) return "REVOKED";
  if (input.grant.consumedAt != null) return "ALREADY_CONSUMED";
  if (input.nowMs > input.grant.expiresAt) return "EXPIRED";
  return "VALID";
}
