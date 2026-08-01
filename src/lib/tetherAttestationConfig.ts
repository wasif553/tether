/**
 * Secure Client Attestation v2 — protocol version / compatibility
 * configuration. See docs/tether-system-check-v1.md, "Compatibility and
 * rollout" and "Immutable per-session attestation requirement".
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
 * anything.
 *
 * Pre-Preview safety pass: `resolveExamAttestationMode()` below is now
 * consumed ONLY at SecureClientSession creation time
 * (getOrCreateSessionCore in secureClientRunner.ts), to compute the
 * snapshot written to `SecureClientSession.attestationRequirement`.
 * `resolveEffectiveTetherVerification()` no longer reads the live
 * environment variable at all — it reads that per-session snapshot
 * instead. This closes a real client-controlled-downgrade path: the
 * previous design re-derived DUAL's "is this client new enough to
 * require v2 too" decision from `SecureClientSession.clientVersion`,
 * which is written completely unsigned by the LEGACY attestation route
 * (`recordAttestation()` in secureClientRunner.ts, straight from the
 * renderer-supplied request body) — a modified client could simply claim
 * an old version and downgrade itself to legacy-only treatment. There is
 * no version-based branching left anywhere in this file.
 */

/** The attestation protocol version THIS server issues challenges under. */
export const ATTESTATION_PROTOCOL_VERSION = 2;

export const EXAM_ATTESTATION_MODES = ["LEGACY", "DUAL", "V2_REQUIRED"] as const;
export type ExamAttestationMode = (typeof EXAM_ATTESTATION_MODES)[number];

/**
 * Truth table (see docs/tether-system-check-v1.md, "Compatibility and
 * rollout" for the full rationale) — this is now the requirement
 * SNAPSHOTTED onto a session at creation time, not something
 * re-evaluated per request:
 *
 *  - LEGACY (default/safe): only the existing recordAttestation() flow
 *    (secureClientRunner.ts) can mark a session verified. v2 EXAM_SESSION
 *    evidence may still be recorded (SecureClientSession.installationAttestationVerified
 *    etc.) but has zero effect on the access decision. No student can be
 *    locked out by this pass merely existing.
 *  - DUAL: BOTH the legacy VERIFIED status AND genuine v2 EXAM_SESSION
 *    evidence are required — unconditionally, for every session whose
 *    snapshot is DUAL. There is no grandfathering by reported client
 *    version: a client physically unable to produce v2 evidence (too old
 *    to have the capability at all) simply cannot complete a
 *    DUAL-snapshotted session — see "Compatibility and rollout" for how
 *    that is surfaced to the student (a deterministic, distinguishable
 *    `CLIENT_VERSION_UNSUPPORTED` from the v2 verify route once it does
 *    attempt v2, or the existing pre-attempt readiness check).
 *  - V2_REQUIRED: only genuine, installation-bound v2 EXAM_SESSION
 *    evidence verifies a session — legacy-only attestation is rejected
 *    outright. Never enabled in Production by this pass (see
 *    docs/tether-system-check-v1.md).
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

/** Safe default (2) — a student may need a replacement device if their original fails before an exam; never so large it defeats the point of a limit. Clamped to [1, 5] against a malformed env value. */
const DEFAULT_MAX_ACTIVE_INSTALLATIONS_PER_USER = 2;
const MIN_MAX_ACTIVE_INSTALLATIONS_PER_USER = 1;
const MAX_MAX_ACTIVE_INSTALLATIONS_PER_USER = 5;

export function resolveMaxActiveInstallationsPerUser(): number {
  const raw = process.env.TETHER_MAX_ACTIVE_INSTALLATIONS_PER_USER;
  // `Number("")` is 0, not NaN — an unset-but-present-as-empty-string env
  // value (common in some deployment configs) must fall back to the
  // documented default, never silently resolve to the clamped minimum.
  const trimmed = raw?.trim();
  const parsed = trimmed ? Number(trimmed) : NaN;
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return DEFAULT_MAX_ACTIVE_INSTALLATIONS_PER_USER;
  return Math.min(MAX_MAX_ACTIVE_INSTALLATIONS_PER_USER, Math.max(MIN_MAX_ACTIVE_INSTALLATIONS_PER_USER, parsed));
}

/** Parses a raw, possibly-null `SecureClientSession.attestationRequirement` column value into a mode — any unrecognised or missing value (including every session created before this column existed) is treated as LEGACY, never re-derived from the current environment. */
export function parseAttestationRequirement(raw: string | null): ExamAttestationMode {
  if (raw === "DUAL") return "DUAL";
  if (raw === "V2_REQUIRED") return "V2_REQUIRED";
  return "LEGACY";
}

export type EffectiveTetherVerificationInput = {
  /** The SESSION's own immutable snapshot (SecureClientSession.attestationRequirement, parsed via parseAttestationRequirement) — never the live environment variable. */
  sessionRequirement: ExamAttestationMode;
  /** SecureClientSession.verificationStatus === "VERIFIED", from the existing, unmodified legacy flow. */
  legacyVerified: boolean;
  /** SecureClientSession.installationAttestationVerified — set only after all v2 checks pass (tetherAttestationRunner.ts). */
  v2Verified: boolean;
};

/**
 * The SINGLE function every real enforcement point (POST
 * /api/exams/[id]/start, GET /api/submissions/[id]) must call instead of
 * reading SecureClientSession.verificationStatus directly — see
 * docs/tether-system-check-v1.md, "Compatibility and rollout" for the
 * full truth table this implements. Deliberately takes no client-version
 * input of any kind — see this module's own top-level doc comment for
 * why that was removed.
 */
export function resolveEffectiveTetherVerification(input: EffectiveTetherVerificationInput): boolean {
  switch (input.sessionRequirement) {
    case "LEGACY":
      return input.legacyVerified;
    case "DUAL":
      return input.legacyVerified && input.v2Verified;
    case "V2_REQUIRED":
      return input.v2Verified;
    default:
      return input.legacyVerified;
  }
}
