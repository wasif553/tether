/**
 * Tether Secure Exam Recovery and Resilient Autosave v1 — server-
 * authoritative recovery state. See
 * docs/tether-secure-resume-recovery-v1.md, "Server-authoritative
 * recovery state" (Part 1) and "Security and data-integrity principles".
 *
 * Pure, dependency-free: no Prisma, no Next.js — safe to import from
 * anywhere, including plain vitest, mirroring
 * src/lib/secureClient/secureClientSession.ts and
 * src/lib/tetherAttestationConfig.ts. This is the ONE place recovery
 * state is computed — every route and UI surface that needs to answer
 * "can this student continue/resume this attempt right now" reads from
 * here (via src/lib/tetherRecoveryRunner.ts, the Prisma-backed wrapper),
 * never re-derives its own version of this logic. Never trusts anything
 * renderer-supplied for the DECISION itself (remaining time, deadline,
 * recovery state, or "current" installation id) — every input here is
 * documented as to whether it is server-authoritative or a client claim
 * that is only ever used for a proactive, non-authoritative UI hint.
 */
import {
  deriveSessionStatus,
  isHeartbeatOverdue,
  isVerificationStillFresh,
  type HeartbeatPolicy,
  type SessionStatus,
} from "@/lib/secureClient/secureClientSession";
import { resolveEffectiveTetherVerification, type ExamAttestationMode } from "@/lib/tetherAttestationConfig";
import type { DeliveryMode } from "@/lib/secureClientPolicy";

export const RECOVERY_STATES = [
  "NOT_STARTED",
  "ACTIVE",
  "TEMPORARILY_DISCONNECTED",
  "RESUME_REQUIRES_TETHER",
  "RESUME_REQUIRES_REAUTHENTICATION",
  "RESUME_REQUIRES_FRESH_ATTESTATION",
  "MANUAL_REVIEW_REQUIRED",
  "SUBMITTED",
  "EXPIRED",
] as const;
export type RecoveryState = (typeof RECOVERY_STATES)[number];

// ---------------------------------------------------------------------------
// Trusted verification — composes the existing LEGACY/DUAL/V2_REQUIRED
// truth table (resolveEffectiveTetherVerification) with heartbeat
// freshness, so a session that WAS genuinely verified before a crash
// eventually stops being trusted once contact has been lost long enough
// that the underlying client process may be gone (see
// isVerificationStillFresh's own doc comment for exactly where that
// boundary sits and why an ordinary short reconnect never crosses it).
// This is the function every REAL content-access enforcement point
// (POST /api/exams/[id]/start's resolveSecureClientLaunchField, GET
// /api/submissions/[id]'s content-exposure gate) must call instead of
// resolveEffectiveTetherVerification directly.
// ---------------------------------------------------------------------------

export type TrustedTetherVerificationInput = {
  sessionRequirement: ExamAttestationMode;
  legacyVerified: boolean;
  v2Verified: boolean;
  /** SecureClientSession.lastHeartbeatAt, or null if none has ever arrived. */
  lastHeartbeatAtMs: number | null;
  /** SecureClientSession.startedAt — the baseline used when no heartbeat has ever arrived yet, exactly like deriveSessionStatus. */
  sessionStartedAtMs: number;
  nowMs: number;
  heartbeatPolicy: HeartbeatPolicy;
  offlineContinueMs: number;
};

export function resolveTrustedTetherVerification(input: TrustedTetherVerificationInput): boolean {
  const baseVerified = resolveEffectiveTetherVerification(input);
  if (!baseVerified) return false;
  const baseline = input.lastHeartbeatAtMs ?? input.sessionStartedAtMs;
  return isVerificationStillFresh(baseline, input.nowMs, { ...input.heartbeatPolicy, offlineContinueMs: input.offlineContinueMs });
}

// ---------------------------------------------------------------------------
// Central recovery-state resolver (Part 1).
// ---------------------------------------------------------------------------

export type RecoverySessionInput = {
  status: SessionStatus;
  verificationStatus: string;
  installationAttestationVerified: boolean;
  attestationRequirement: ExamAttestationMode;
  lastHeartbeatAtMs: number | null;
  startedAtMs: number;
  /** The registered installation this session is v2-bound to, if any — see Part 8, "same device / device change". */
  clientInstallationId: string | null;
};

export type ResolveRecoveryStateInput = {
  /** false only when the caller could not establish who is asking (e.g. an expired/absent auth session) — see Part 1, RESUME_REQUIRES_REAUTHENTICATION. Every real route already 401s before this is ever called with false in practice; kept here so the state is independently testable and documented. */
  authenticated: boolean;
  submissionStatus: "IN_PROGRESS" | "SUBMITTED" | "GRADED";
  nowMs: number;
  /** submissionDeadline(startedAt, frozen timingPolicy.durationMins) — server-computed, never renderer-supplied. */
  deadlineMs: number;
  /** From the FROZEN secureClientPolicySnapshotJson — never the exam's live settings. */
  deliveryMode: DeliveryMode;
  session: RecoverySessionInput | null;
  heartbeatPolicy: HeartbeatPolicy;
  offlineContinueMs: number;
  /**
   * The installation id the CURRENT request claims to be resuming from,
   * if any (e.g. the student's Tether app has already registered/
   * identified itself) — a client claim, used ONLY for the proactive,
   * non-authoritative "this looks like a different computer" UI hint
   * (Part 8). The actual, authoritative device-change enforcement happens
   * server-side inside verifyExamSessionAttestation
   * (tetherAttestationRunner.ts), which is the real gate content access
   * depends on — this never substitutes for that.
   */
  requestingInstallationId: string | null;
};

export type RecoveryStateResult = {
  state: RecoveryState;
  /** Only set for RESUME_REQUIRES_TETHER — where the client should be sent to begin (or resume) the launch/attestation sequence. */
  redirectTo?: string;
};

/**
 * Pure decision function — see this module's own top-level doc comment.
 * Deliberately narrow: decides WHICH recovery state applies, never HOW to
 * get there (that's the job of the launch/attestation routes, which are
 * unchanged by this function's existence) and never grants or revokes
 * access by itself (it is read-only with respect to the database; see
 * src/lib/tetherRecoveryRunner.ts for the Prisma-backed wrapper that
 * calls this and nothing here ever runs a write).
 */
export function resolveRecoveryState(input: ResolveRecoveryStateInput): RecoveryStateResult {
  if (!input.authenticated) return { state: "RESUME_REQUIRES_REAUTHENTICATION" };

  if (input.submissionStatus === "SUBMITTED" || input.submissionStatus === "GRADED") {
    return { state: "SUBMITTED" };
  }

  // A submission's own frozen deadline is authoritative regardless of
  // delivery mode — an expired attempt can never "resume" into more
  // editing, whether or not it also required Tether. (Whether a late
  // submit is still ACCEPTED is a separate policy question the submit
  // route's own allowLateSubmit/autoSubmitOnTimerEnd check owns — this
  // state is purely "is this still within the ordinary editing window".)
  if (input.nowMs > input.deadlineMs) {
    return { state: "EXPIRED" };
  }

  // Non-Tether-required assessments have no session/attestation lifecycle
  // to resume through at all — recovery here is purely "keep autosaving
  // and reconnect", which the resilient-autosave queue already handles
  // without needing a distinct recovery state.
  if (input.deliveryMode !== "TETHER_CLIENT_REQUIRED") {
    return { state: "ACTIVE" };
  }

  const session = input.session;
  if (!session || session.status === "ENDED" || session.status === "REJECTED") {
    return { state: "RESUME_REQUIRES_TETHER" };
  }

  // Part 8 — proactive, non-authoritative device-change hint only. See
  // this field's own doc comment: the real enforcement happens inside
  // verifyExamSessionAttestation.
  if (
    input.requestingInstallationId != null &&
    session.clientInstallationId != null &&
    input.requestingInstallationId !== session.clientInstallationId
  ) {
    return { state: "MANUAL_REVIEW_REQUIRED" };
  }

  const trusted = resolveTrustedTetherVerification({
    sessionRequirement: session.attestationRequirement,
    legacyVerified: session.verificationStatus === "VERIFIED",
    v2Verified: session.installationAttestationVerified,
    lastHeartbeatAtMs: session.lastHeartbeatAtMs,
    sessionStartedAtMs: session.startedAtMs,
    nowMs: input.nowMs,
    heartbeatPolicy: input.heartbeatPolicy,
    offlineContinueMs: input.offlineContinueMs,
  });

  if (!trusted) return { state: "RESUME_REQUIRES_FRESH_ATTESTATION" };

  // Trusted, but is the session's own heartbeat currently overdue within
  // the bounded "still trusted, still keep going" window? That's exactly
  // TEMPORARILY_DISCONNECTED — content stays accessible, Tether
  // restrictions stay active, but the UI should show "Connection
  // interrupted / Reconnecting" (Part 4) rather than a plain steady-state
  // ACTIVE.
  const derivedStatus = deriveSessionStatus(
    { status: session.status, startedAt: session.startedAtMs, lastHeartbeatAt: session.lastHeartbeatAtMs },
    input.heartbeatPolicy,
    input.nowMs,
  );
  if (derivedStatus === "INTERRUPTED" || session.status === "RECOVERY_REQUIRED") {
    return { state: "TEMPORARILY_DISCONNECTED" };
  }
  const baseline = session.lastHeartbeatAtMs ?? session.startedAtMs;
  if (isHeartbeatOverdue(baseline, input.nowMs, input.heartbeatPolicy)) {
    return { state: "TEMPORARILY_DISCONNECTED" };
  }

  return { state: "ACTIVE" };
}

// ---------------------------------------------------------------------------
// Product language (Part "Product language") — the ONE place these exact
// strings live, so the student page, the lecturer badge, and any future
// surface can never drift into a different phrase for the same state.
// ---------------------------------------------------------------------------

export type RecoveryStateCopy = { label: string; detail: string };

export const RECOVERY_STATE_COPY: Record<RecoveryState, RecoveryStateCopy> = {
  NOT_STARTED: { label: "Not started", detail: "This examination has not been started yet." },
  ACTIVE: { label: "Active", detail: "Your examination is active." },
  TEMPORARILY_DISCONNECTED: {
    label: "Reconnecting",
    detail: "Connection interrupted. Reconnecting — your examination timer continued.",
  },
  RESUME_REQUIRES_TETHER: {
    label: "Resume secure examination",
    detail: "Resume secure examination in Tether Secure Browser to continue.",
  },
  RESUME_REQUIRES_REAUTHENTICATION: {
    label: "Sign in required",
    detail: "Please sign in again to resume your secure examination.",
  },
  RESUME_REQUIRES_FRESH_ATTESTATION: {
    label: "Recovery check",
    detail: "Recovery check required — resume secure examination in Tether Secure Browser to continue.",
  },
  MANUAL_REVIEW_REQUIRED: {
    label: "Manual review required",
    detail: "This examination was started on another registered computer. Contact your lecturer or exam support.",
  },
  SUBMITTED: { label: "Submitted", detail: "Submission received." },
  EXPIRED: { label: "Expired", detail: "The time for this examination has ended." },
};
