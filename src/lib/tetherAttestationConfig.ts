/**
 * Secure Client Attestation v2 — protocol version / compatibility
 * configuration. See docs/tether-system-check-v1.md, "Compatibility and
 * rollout".
 *
 * Server-only, pure otherwise (no Prisma, no Next.js — safe to import
 * from anywhere, including plain vitest). Reads process.env exactly once
 * per call, with a safe default (LEGACY) that can never accidentally
 * lock out an existing student.
 *
 * Single central resolver, per the "if retaining an environment-variable
 * design, centralise it in one deterministic resolver" instruction —
 * replaces the two independent booleans this file used to export
 * (isLegacyAttestationAllowed / isV2ExamSessionRequiredForNewFinalExams),
 * which were built ahead of any real wiring and never consumed by
 * anything. Now that EXAM_SESSION v2 is actually wired into the real
 * exam-session verification decision (resolveEffectiveTetherVerification
 * below, consumed by exams/[id]/start and submissions/[id] routes), a
 * single three-state mode is the one true source of truth instead.
 */
import { compareVersions } from "@/lib/systemCheck/readiness";

/** The attestation protocol version THIS server issues challenges under. */
export const ATTESTATION_PROTOCOL_VERSION = 2;

export const EXAM_ATTESTATION_MODES = ["LEGACY", "DUAL", "V2_REQUIRED"] as const;
export type ExamAttestationMode = (typeof EXAM_ATTESTATION_MODES)[number];

/**
 * Truth table (see docs/tether-system-check-v1.md, "Compatibility and
 * rollout" for the full rationale):
 *
 *  - LEGACY (default/safe): only the existing recordAttestation() flow
 *    (secureClientRunner.ts) can mark a session verified. v2 EXAM_SESSION
 *    evidence may still be recorded (SecureClientSession.installationAttestationVerified
 *    etc.) but has zero effect on the access decision. No student can be
 *    locked out by this pass merely existing.
 *  - DUAL: for a client whose LEGACY-reported clientVersion is
 *    v1.5.0-capable (>= V2_CAPABLE_MINIMUM_CLIENT_VERSION — i.e. new
 *    enough to have EVER been able to attempt v2), genuine v2 evidence is
 *    ADDITIONALLY required on top of the legacy VERIFIED status. An
 *    older, pre-1.5.0 client (which physically cannot produce v2
 *    evidence — that capability didn't exist yet) is grandfathered on
 *    legacy alone, so DUAL can be turned on mid-rollout without stranding
 *    students who haven't updated yet.
 *  - V2_REQUIRED: only genuine, installation-bound v2 EXAM_SESSION
 *    evidence verifies a session — legacy-only attestation is rejected
 *    outright, regardless of reported client version. Never enabled in
 *    Production by this pass (see docs/tether-system-check-v1.md).
 *
 * Only the EXACT strings "DUAL"/"V2_REQUIRED" opt in; any other value
 * (missing, empty, typo) resolves to LEGACY.
 */
export function resolveExamAttestationMode(): ExamAttestationMode {
  const raw = process.env.TETHER_EXAM_ATTESTATION_MODE;
  if (raw === "DUAL") return "DUAL";
  if (raw === "V2_REQUIRED") return "V2_REQUIRED";
  return "LEGACY";
}

/** The minimum LEGACY-reported client version capable of ever attempting v2 EXAM_SESSION attestation (the version installation-key registration first shipped in — see apps/lockdown/src/shared.ts). */
export const V2_CAPABLE_MINIMUM_CLIENT_VERSION = "1.5.0";

export function isClientV2Capable(legacyClientVersion: string | null): boolean {
  if (!legacyClientVersion) return false;
  return compareVersions(legacyClientVersion, V2_CAPABLE_MINIMUM_CLIENT_VERSION) >= 0;
}

export type EffectiveTetherVerificationInput = {
  mode: ExamAttestationMode;
  /** SecureClientSession.verificationStatus === "VERIFIED", from the existing, unmodified legacy flow. */
  legacyVerified: boolean;
  /** SecureClientSession.installationAttestationVerified — set only after all v2 checks pass (tetherAttestationRunner.ts). */
  v2Verified: boolean;
  /** SecureClientSession.clientVersion, as reported by the LEGACY attestation — used only to decide DUAL-mode grandfathering. */
  legacyClientVersion: string | null;
};

/**
 * The SINGLE function every real enforcement point (POST
 * /api/exams/[id]/start, GET /api/submissions/[id]) must call instead of
 * reading SecureClientSession.verificationStatus directly — see
 * docs/tether-system-check-v1.md, "Compatibility and rollout" for the
 * full truth table this implements.
 */
/** Safe default (2) — a student may need a replacement device if their original fails before an exam; never so large it defeats the point of a limit. Clamped to [1, 5] against a malformed env value. */
const DEFAULT_MAX_ACTIVE_INSTALLATIONS_PER_USER = 2;
const MIN_MAX_ACTIVE_INSTALLATIONS_PER_USER = 1;
const MAX_MAX_ACTIVE_INSTALLATIONS_PER_USER = 5;

export function resolveMaxActiveInstallationsPerUser(): number {
  const raw = process.env.TETHER_MAX_ACTIVE_INSTALLATIONS_PER_USER;
  const parsed = raw != null ? Number(raw) : NaN;
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return DEFAULT_MAX_ACTIVE_INSTALLATIONS_PER_USER;
  return Math.min(MAX_MAX_ACTIVE_INSTALLATIONS_PER_USER, Math.max(MIN_MAX_ACTIVE_INSTALLATIONS_PER_USER, parsed));
}

export function resolveEffectiveTetherVerification(input: EffectiveTetherVerificationInput): boolean {
  switch (input.mode) {
    case "LEGACY":
      return input.legacyVerified;
    case "DUAL":
      return isClientV2Capable(input.legacyClientVersion) ? input.legacyVerified && input.v2Verified : input.legacyVerified;
    case "V2_REQUIRED":
      return input.v2Verified;
    default:
      return input.legacyVerified;
  }
}
