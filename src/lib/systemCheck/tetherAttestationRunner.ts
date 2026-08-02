/**
 * Secure Client Attestation v2 — server-only orchestration. See
 * docs/tether-system-check-v1.md, "Secure Client Attestation v2".
 *
 * Touches Prisma, so this must never be imported from a "use client"
 * component — pure crypto/canonicalisation logic lives in
 * src/lib/secureClient/tetherAttestation.ts. Reuses the EXISTING server
 * signing key (getSigningPrivateKey/getSigningPublicKey/getSigningKeyId
 * in secureClientRunner.ts) for CHALLENGE signatures only — installation
 * signatures are verified against each installation's OWN registered
 * public key, never a shared key.
 *
 * Replaces the removed v1 module (systemCheckSecureClientRunner.ts,
 * deleted — relied on ONE globally embedded private key). Every function
 * here that writes SystemCheckSecureClientVerification requires a
 * genuine, currently-ACTIVE TetherClientInstallation; there is no path
 * that accepts a client-self-reported "verified" boolean or a globally
 * shared secret.
 *
 * Structural non-authorization guarantee (unchanged from v1): nothing in
 * this file creates, writes, or updates Submission, Answer,
 * IntegrityEvent, or ExamAttemptSession. `verifyExamSessionAttestation`
 * DOES read/update an EXISTING SecureClientSession row (additive only —
 * see its own doc comment) but never creates one, and
 * `verifySystemCheckAttestation` never touches SecureClientSession at
 * all — see the "purpose isolation" tests in
 * tetherAttestation.routes.test.ts for the automated proof.
 *
 * One READ-only exception (device-management revocation guard, see
 * resolveActiveExamRevocationBlock below): it reads
 * Submission.startedAt/Submission.examPolicySnapshotJson/
 * Exam.durationMins/Exam.secureSettings — the same inputs
 * resolveSubmissionTimingPolicy (assessmentLifecycle.ts) resolves from
 * for POST /api/submissions/[id]/submit — to decide whether a candidate
 * session is still within its authoritative, FROZEN submission window
 * (submissionDeadline/canAcceptSubmit in assessmentLifecycle.ts; see
 * "Freeze timing policy for active exam attempts"). Still never writes to
 * Submission/Answer/IntegrityEvent/ExamAttemptSession.
 */
import { randomBytes, createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { getSigningPrivateKey, getSigningPublicKey, getSigningKeyId, resolvePriorSessionTrust } from "@/lib/secureClientRunner";
import {
  ATTESTATION_PROTOCOL_VERSION,
  ATTESTATION_ISSUER,
  REGISTRATION_PURPOSE,
  computeUserSubjectHash,
  computePublicKeyFingerprint,
  generateAttestationNonce,
  hashNonce,
  signRegistrationChallenge,
  validateRegistrationChallengeContext,
  verifyRegistrationProofOfPossession,
  signAttestationChallenge,
  validateAttestationChallengeContext,
  buildSystemCheckAttestationCanonicalString,
  buildExamSessionAttestationCanonicalString,
  verifyInstallationSignature,
  type AttestationPurpose,
  type RegistrationChallenge,
  type AttestationChallenge,
  type ValidationReasonCode,
} from "@/lib/secureClient/tetherAttestation";
import { isValidDisplayTopologyClassification, evaluateDisplayTopology, evaluateOperatingSystem, compareVersions, type DisplayTopologyClassification } from "@/lib/systemCheck/readiness";
import { parseSecureClientPolicy } from "@/lib/secureClientPolicy";
import { computePolicyHash } from "@/lib/secureClient/secureLaunchManifest";
import { createPlatformAuditLog } from "@/lib/platformAdmin";
import { resolveMaxActiveInstallationsPerUser, parseAttestationRequirement } from "@/lib/tetherAttestationConfig";
import { parseSecureSettings } from "@/lib/secureExam";
import { submissionDeadline, canAcceptSubmit, resolveSubmissionTimingPolicy, type ExamTimingPolicy } from "@/lib/assessmentLifecycle";

export const REGISTRATION_CHALLENGE_TTL_SECONDS = 120;
export const ATTESTATION_CHALLENGE_TTL_SECONDS = 120;
export const REGISTRATION_AUDIENCE = "tether-installation-registration";
export const ATTESTATION_AUDIENCE = "tether-attestation";

/** Internal sentinel — thrown ONLY when the TetherInstallationRegistrationChallenge nonceHash insert itself hits its unique constraint, so registerInstallation's outer catch can distinguish "this exact challenge was already consumed" from a genuinely duplicate public key without depending on Prisma's provider-specific P2002 error-metadata shape. Never exposed outside this module. */
class ChallengeAlreadyConsumedError extends Error {}

/**
 * Registration rate limit — bounds how many installations a single
 * authenticated user may successfully CREATE in a rolling window
 * (proof-of-possession already makes blind/brute-force registration
 * attempts computationally infeasible — Ed25519 signature forgery, not a
 * guessable secret — so this specifically targets a scripted loop that
 * legitimately proves possession of many freshly generated keys in quick
 * succession, e.g. to spam device rows). Generous enough to never
 * interfere with a genuine multi-device replacement flow (well above
 * resolveMaxActiveInstallationsPerUser()'s default of 2).
 */
export const REGISTRATION_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const REGISTRATION_RATE_LIMIT_MAX_ATTEMPTS = 10;

/** Only self-reportable levels — never "TPM_ATTESTED": no attestation-evidence-verification code exists yet to substantiate that claim, so a client asserting it is rejected outright, not silently downgraded. */
export const SELF_REPORTABLE_KEY_PROTECTION_LEVELS = ["SOFTWARE_PROTECTED", "TPM_UNATTESTED"] as const;
export type SelfReportableKeyProtectionLevel = (typeof SELF_REPORTABLE_KEY_PROTECTION_LEVELS)[number];
export function isSelfReportableKeyProtectionLevel(value: string): value is SelfReportableKeyProtectionLevel {
  return (SELF_REPORTABLE_KEY_PROTECTION_LEVELS as readonly string[]).includes(value);
}

export const INSTALLATION_KEY_ALGORITHMS = ["Ed25519", "ECDSA_P256"] as const;
export type InstallationKeyAlgorithm = (typeof INSTALLATION_KEY_ALGORITHMS)[number];
export function isValidInstallationKeyAlgorithm(value: string): value is InstallationKeyAlgorithm {
  return (INSTALLATION_KEY_ALGORITHMS as readonly string[]).includes(value);
}

export const SYSTEM_CHECK_CLIENT_TYPES = ["TETHER_SECURE_CLIENT", "MOCK_TETHER_CLIENT"] as const;
export type SystemCheckClientType = (typeof SYSTEM_CHECK_CLIENT_TYPES)[number];
export function isValidSystemCheckClientType(value: string): value is SystemCheckClientType {
  return (SYSTEM_CHECK_CLIENT_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Installation registration (Part: "bootstrap and enrolment")
// ---------------------------------------------------------------------------

/**
 * No database write at issuance — stateless, like the attestation
 * challenge (single-use is enforced later, atomically, at CONSUMPTION
 * time — see registerInstallation). Requires the caller's public key up
 * front so the resulting challenge can bind
 * `publicKeyFingerprint` — the renderer already has it by this point
 * (it always calls ensureInstallationKey() before requesting a
 * registration challenge — see src/lib/secureClient/installationClient.ts).
 */
export function issueRegistrationChallenge(params: { userId: string; publicKey: string }): { challenge: RegistrationChallenge; signature: string } {
  const now = new Date();
  const challenge: RegistrationChallenge = {
    schemaVersion: ATTESTATION_PROTOCOL_VERSION,
    challengeId: randomBytes(16).toString("hex"),
    keyId: getSigningKeyId(),
    issuer: ATTESTATION_ISSUER,
    purpose: REGISTRATION_PURPOSE,
    audience: REGISTRATION_AUDIENCE,
    userSubjectHash: computeUserSubjectHash(params.userId),
    issuedAt: now.toISOString(),
    notBefore: now.toISOString(),
    expiresAt: new Date(now.getTime() + REGISTRATION_CHALLENGE_TTL_SECONDS * 1000).toISOString(),
    nonce: generateAttestationNonce(),
    publicKeyFingerprint: computePublicKeyFingerprint(params.publicKey),
  };
  const signature = signRegistrationChallenge(challenge, getSigningPrivateKey());
  return { challenge, signature };
}

export type RegisterInstallationParams = {
  userId: string;
  institutionId: string;
  challenge: RegistrationChallenge;
  challengeSignature: string;
  publicKey: string;
  keyAlgorithm: InstallationKeyAlgorithm;
  keyProtectionLevel: SelfReportableKeyProtectionLevel;
  proofOfPossessionSignature: string;
  clientVersion: string | null;
  platform: string | null;
};

export type RegisterInstallationResult =
  | { outcome: "REGISTERED"; installationId: string; publicKeyFingerprint: string }
  | { outcome: "INVALID_CHALLENGE"; reason: ValidationReasonCode }
  | { outcome: "PROOF_OF_POSSESSION_INVALID" }
  | { outcome: "DUPLICATE_KEY" }
  | { outcome: "CHALLENGE_ALREADY_CONSUMED" }
  | { outcome: "LIMIT_REACHED"; maxActiveInstallations: number }
  | { outcome: "RATE_LIMITED" };

/** Counts this user's registration attempts (of any outcome) in the rolling rate-limit window — see REGISTRATION_RATE_LIMIT_* above. */
async function countRecentRegistrationAttempts(userId: string): Promise<number> {
  return prisma.tetherClientInstallation.count({
    where: { userId, installedAt: { gte: new Date(Date.now() - REGISTRATION_RATE_LIMIT_WINDOW_MS) } },
  });
}

/**
 * Registers a NEW per-installation keypair for the authenticated user.
 * Requires proof of possession (a signature over the registration
 * challenge's nonce, verified against the SUBMITTED public key) — a
 * party registering a public key it does not hold the matching private
 * key for cannot complete this. This does NOT, and cannot, prove the
 * registering process is genuinely Electron — see "Known limitations"
 * in docs/tether-system-check-v1.md: the first registration for a given
 * user is inherently trust-on-first-use, exactly like every other
 * bootstrap step in this codebase's secure-client architecture. What IS
 * structurally different from v1: a compromised key here only ever
 * affects the ONE installation it belongs to (revocable independently),
 * never every installation industry-wide.
 *
 * Multi-device support: up to resolveMaxActiveInstallationsPerUser() (see
 * tetherAttestationConfig.ts, default 2) installations may be ACTIVE at
 * once for the same user — a student replacing a failed device is never
 * silently locked out of registering a second one. Registering NEVER
 * auto-revokes or auto-replaces an existing ACTIVE installation to make
 * room ("do not silently revoke an existing device") — once at the
 * limit, registration is rejected with LIMIT_REACHED and the student
 * must explicitly revoke an old installation first (self-service — see
 * revokeInstallation below) before registering a new one.
 */
export async function registerInstallation(params: RegisterInstallationParams): Promise<RegisterInstallationResult> {
  if ((await countRecentRegistrationAttempts(params.userId)) >= REGISTRATION_RATE_LIMIT_MAX_ATTEMPTS) {
    return { outcome: "RATE_LIMITED" };
  }

  const publicKeyFingerprint = computePublicKeyFingerprint(params.publicKey);

  const validation = validateRegistrationChallengeContext(params.challenge, params.challengeSignature, getSigningPublicKey(), {
    expectedAudience: REGISTRATION_AUDIENCE,
    expectedUserSubjectHash: computeUserSubjectHash(params.userId),
    expectedPublicKeyFingerprint: publicKeyFingerprint,
    nowMs: Date.now(),
  });
  if (validation !== "VALID") {
    return { outcome: "INVALID_CHALLENGE", reason: validation };
  }

  // Failed proof verification must never register an installation — this
  // check, and everything above it, runs BEFORE the transaction that
  // both consumes the challenge and creates the installation, so a
  // failure here leaves the challenge unconsumed (and thus, unlike a
  // successful registration, still theoretically retryable with a fresh
  // proof attempt against the SAME challenge until it expires — which is
  // fine: no installation is ever created without a genuinely valid
  // proof, regardless of how many attempts against one challenge are
  // made).
  if (!verifyRegistrationProofOfPossession(params.challenge.nonce, params.proofOfPossessionSignature, params.publicKey)) {
    return { outcome: "PROOF_OF_POSSESSION_INVALID" };
  }

  const maxActiveInstallations = resolveMaxActiveInstallationsPerUser();
  const nonceHash = hashNonce(params.challenge.nonce);

  try {
    const installationId = await prisma.$transaction(async (tx) => {
      const activeCount = await tx.tetherClientInstallation.count({ where: { userId: params.userId, status: "ACTIVE" } });
      if (activeCount >= maxActiveInstallations) {
        return null;
      }
      // Single-use enforcement: this INSERT is the atomic consumption
      // gate. A concurrent or replayed second request for the SAME
      // challenge hits the unique constraint on nonceHash here and the
      // whole transaction (including the TetherClientInstallation
      // create below) rolls back — "concurrent submissions accept at
      // most one" holds by the same Postgres unique-index guarantee
      // already relied on for attestation nonce replay protection.
      //
      // Caught and re-thrown as a distinct sentinel HERE (rather than
      // disambiguated later from the generic P2002's error metadata,
      // whose exact shape/target format is provider- and
      // Prisma-version-dependent and not worth depending on) — the
      // LOCATION of this catch is what unambiguously identifies which
      // constraint fired, never string-matching.
      try {
        await tx.tetherInstallationRegistrationChallenge.create({
          data: { userId: params.userId, publicKeyFingerprint, nonceHash },
        });
      } catch (challengeErr) {
        if (challengeErr instanceof Prisma.PrismaClientKnownRequestError && challengeErr.code === "P2002") {
          throw new ChallengeAlreadyConsumedError();
        }
        throw challengeErr;
      }
      const created = await tx.tetherClientInstallation.create({
        data: {
          userId: params.userId,
          institutionId: params.institutionId,
          publicKey: params.publicKey,
          publicKeyFingerprint,
          keyAlgorithm: params.keyAlgorithm,
          keyProtectionLevel: params.keyProtectionLevel,
          clientVersion: params.clientVersion,
          platform: params.platform,
          status: "ACTIVE",
        },
      });
      return created.id;
    });
    if (installationId === null) {
      return { outcome: "LIMIT_REACHED", maxActiveInstallations };
    }
    await createPlatformAuditLog({
      actorId: params.userId,
      action: "TETHER_INSTALLATION_REGISTERED",
      targetType: "TetherClientInstallation",
      targetId: installationId,
      institutionId: params.institutionId,
      metadata: { keyAlgorithm: params.keyAlgorithm, keyProtectionLevel: params.keyProtectionLevel, clientVersion: params.clientVersion, platform: params.platform },
    }).catch(() => {});
    return { outcome: "REGISTERED", installationId, publicKeyFingerprint };
  } catch (err) {
    if (err instanceof ChallengeAlreadyConsumedError) {
      return { outcome: "CHALLENGE_ALREADY_CONSUMED" };
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Only the TetherClientInstallation insert's own unique
      // constraints (publicKeyFingerprint / (userId, publicKeyFingerprint))
      // can reach this point — the challenge-consumption insert's P2002
      // is already handled above.
      return { outcome: "DUPLICATE_KEY" };
    }
    throw err;
  }
}

/** Ownership-scoped lookup — 404-equivalent semantics for both "not found" and "belongs to someone else". */
export async function loadOwnedInstallation(installationId: string, userId: string) {
  const record = await prisma.tetherClientInstallation.findUnique({ where: { id: installationId } });
  if (!record || record.userId !== userId) return null;
  return record;
}

/** Non-terminal SecureClientSession states — mirrors the set used throughout secureClientRunner.ts (getOrCreateSessionCore's own "still open" check). */
const NON_TERMINAL_SESSION_STATUSES = ["CREATED", "PREFLIGHT", "ACTIVE", "INTERRUPTED", "RECOVERY_REQUIRED"] as const;

/**
 * Device management UI v1 — "Active exam safety", authoritative-expiry
 * gate. `Submission.status` only ever leaves IN_PROGRESS through POST
 * /api/submissions/[id]/submit (explicit student action, or a client-side
 * auto-submit timer post — see shouldAutoSubmit in assessmentLifecycle.ts,
 * driven from the STUDENT's own browser). There is no server-side sweep
 * job that expires a stale row: a closed laptop, dead battery, crashed
 * browser, or an abandoned attempt leaves Submission.status IN_PROGRESS
 * and the SecureClientSession non-terminal FOREVER, even long after the
 * exam's own deadline has genuinely passed. A revocation guard keyed only
 * on those two stored statuses would therefore block a student's devices
 * indefinitely for an exam that, in every real sense, is already over.
 *
 * This reuses — never reimplements — the EXACT same calculation the real
 * enforcement point (POST /api/submissions/[id]/submit) already uses to
 * decide whether a submit attempt would even be accepted right now:
 * submissionDeadline(startedAt, durationMins) + canAcceptSubmit(...), both
 * from assessmentLifecycle.ts. Freeze timing policy for active exam
 * attempts: the duration/allowLateSubmit/autoSubmitOnTimerEnd inputs are
 * resolved via resolveSubmissionTimingPolicy — THIS attempt's own frozen
 * `examPolicySnapshotJson.timingPolicy` snapshot when present, falling
 * back to the exam's current settings only for a legacy submission that
 * predates it. A lecturer editing Exam.durationMins/secureSettings after
 * this attempt started never changes what this returns for it — see
 * PATCH /api/exams/[id], which has no in-progress-attempt restriction and
 * so only ever affects attempts started afterwards. `systemAutoSubmit` is
 * always passed as `false`: that flag exists only to let the submit
 * route's OWN forced-auto-submit call through past the deadline for
 * `autoSubmitOnTimerEnd`, and is irrelevant to "is this exam still
 * genuinely ongoing" — an `allowLateSubmit` exam is correctly still
 * "ongoing" past its nominal timer (canAcceptSubmit already returns true
 * for that case); one that neither allows late submission nor has had
 * its forced auto-submit actually run yet is not.
 *
 * `now` is always this server's own `new Date()` — nothing here ever
 * reads a client-supplied clock, timestamp, or remaining-time value (the
 * revoke API's own request body only ever accepts `reason`; nothing else
 * it might contain can reach this calculation).
 */
function isWithinAuthoritativeSubmissionWindow(startedAt: Date, timingPolicy: ExamTimingPolicy): boolean {
  const deadline = submissionDeadline(startedAt, timingPolicy.durationMins);
  return canAcceptSubmit({ now: new Date(), deadline, settings: timingPolicy, systemAutoSubmit: false });
}

/** Fields needed to resolve a candidate submission's frozen (or legacy-fallback) timing policy — shared shape between findActiveBoundExamSessionId's and findLegacyTetherRequiredActiveSessionId's Prisma selects. */
type TimingCandidateSubmission = {
  startedAt: Date;
  examPolicySnapshotJson: unknown;
  exam: { durationMins: number; secureSettings: unknown };
};

function isCandidateWithinAuthoritativeWindow(submission: TimingCandidateSubmission): boolean {
  const timingPolicy = resolveSubmissionTimingPolicy({
    examPolicySnapshotJson: submission.examPolicySnapshotJson,
    currentExamDurationMins: submission.exam.durationMins,
    currentSecureSettings: parseSecureSettings(submission.exam.secureSettings),
  });
  return isWithinAuthoritativeSubmissionWindow(submission.startedAt, timingPolicy);
}

/**
 * Device management UI v1 — "Active exam safety", installation-specific
 * branch. Returns the id of a non-terminal secure-client session (whose
 * submission is still IN_PROGRESS AND still within its authoritative
 * submission window — see isWithinAuthoritativeSubmissionWindow above)
 * that is CURRENTLY bound to this exact installation via
 * SecureClientSession.clientInstallationId — populated only by a genuine
 * v2 EXAM_SESSION attestation, see verifyExamSessionAttestation above —
 * or null if none exists. Precise: never blocks a DIFFERENT installation
 * than the one actually carrying the active session (see
 * resolveActiveExamRevocationBlock below for how this composes with the
 * LEGACY-mode conservative check).
 */
async function findActiveBoundExamSessionId(installationId: string): Promise<string | null> {
  const candidates = await prisma.secureClientSession.findMany({
    where: {
      clientInstallationId: installationId,
      status: { in: [...NON_TERMINAL_SESSION_STATUSES] },
      submission: { status: "IN_PROGRESS" },
    },
    select: {
      id: true,
      submission: { select: { startedAt: true, examPolicySnapshotJson: true, exam: { select: { durationMins: true, secureSettings: true } } } },
    },
  });
  for (const candidate of candidates) {
    if (isCandidateWithinAuthoritativeWindow(candidate.submission)) {
      return candidate.id;
    }
  }
  return null;
}

/**
 * Device management UI v1 — "Active exam safety", conservative LEGACY-mode
 * branch. Closes the gap findActiveBoundExamSessionId cannot see: under
 * the safe-default LEGACY attestation mode, a real in-progress exam's
 * SecureClientSession never populates clientInstallationId at all (only a
 * genuine v2 EXAM_SESSION attestation does that), so the installation-
 * specific check above is structurally blind to it. Rather than leaving
 * that student able to revoke any installation mid-exam, this scans for
 * ANY non-terminal, still-unbound, LEGACY-snapshotted session belonging to
 * this student whose submission requires Tether
 * (secureClientPolicySnapshotJson.deliveryMode === "TETHER_CLIENT_REQUIRED")
 * and is still IN_PROGRESS — deliberately account-wide, not installation-
 * specific, because the data model has no way to know which installation
 * a LEGACY-only session is actually running on. Returns the blocking
 * session's id, or null if no such session exists.
 *
 * Deliberately narrow in four ways so this can never over-block:
 *  - `verificationStatus` must be exactly "VERIFIED" — the same
 *    authoritative signal resolveEffectiveTetherVerification's own
 *    `legacyVerified` input reads (SecureClientSession.verificationStatus
 *    === "VERIFIED"). A session row that merely exists because the
 *    student started the exam, but has never actually completed the
 *    legacy attestation flow, is not yet "an active examination in
 *    progress" in any sense that matters here — it grants no content
 *    access either, so there is nothing real to protect yet.
 *  - `attestationRequirement` must resolve (via parseAttestationRequirement,
 *    the same reader used everywhere else — NULL/garbage values are
 *    treated as LEGACY, matching the safe default) to exactly "LEGACY".
 *    A DUAL- or V2_REQUIRED-snapshotted session that hasn't produced v2
 *    evidence yet is not "verified" for content access either way
 *    (resolveEffectiveTetherVerification), so it is intentionally left to
 *    the ordinary installation-specific path once it does.
 *  - Only sessions with `clientInstallationId: null` are considered — the
 *    moment a session gains a real v2 binding, it is exclusively governed
 *    by findActiveBoundExamSessionId above, never double-counted here.
 *  - The submission's own immutable policy snapshot must show
 *    TETHER_CLIENT_REQUIRED — an ordinary STANDARD_WEB/MONITORED_WEB
 *    assessment, or one merely offering Tether as optional, never blocks
 *    revocation of anything.
 *  - The submission must still be within its authoritative submission
 *    window — see isWithinAuthoritativeSubmissionWindow above. A
 *    genuinely expired attempt (deadline passed, late submission not
 *    permitted) never blocks, no matter how stale the stored
 *    IN_PROGRESS/non-terminal statuses are.
 */
async function findLegacyTetherRequiredActiveSessionId(userId: string): Promise<string | null> {
  const candidates = await prisma.secureClientSession.findMany({
    where: {
      studentId: userId,
      clientInstallationId: null,
      status: { in: [...NON_TERMINAL_SESSION_STATUSES] },
      clientType: { in: [...SYSTEM_CHECK_CLIENT_TYPES] },
      verificationStatus: "VERIFIED",
      submission: { status: "IN_PROGRESS" },
    },
    select: {
      id: true,
      attestationRequirement: true,
      submission: {
        select: {
          startedAt: true,
          secureClientPolicySnapshotJson: true,
          examPolicySnapshotJson: true,
          exam: { select: { durationMins: true, secureSettings: true } },
        },
      },
    },
  });
  for (const candidate of candidates) {
    if (parseAttestationRequirement(candidate.attestationRequirement) !== "LEGACY") continue;
    const policy = parseSecureClientPolicy(candidate.submission.secureClientPolicySnapshotJson);
    if (policy.deliveryMode !== "TETHER_CLIENT_REQUIRED") continue;
    if (!isCandidateWithinAuthoritativeWindow(candidate.submission)) continue;
    return candidate.id;
  }
  return null;
}

export type ActiveExamRevocationBlock =
  | { blocked: false }
  | { blocked: true; kind: "INSTALLATION_BOUND"; sessionId: string }
  | { blocked: true; kind: "LEGACY_ACCOUNT_WIDE"; sessionId: string };

/**
 * Single deterministic decision point for "may this installation be
 * revoked right now" — composes the two checks above. Installation-bound
 * (v2) is checked first and is always precise, regardless of the
 * installation's own status (an installation can only ever be v2-bound to
 * an active session while it is ACTIVE — attestation requires an ACTIVE
 * installation, and revoking one that WAS bound already goes through this
 * same gate — so this can never fire against a REVOKED installation in
 * practice, but is left unconditional to match the historical guarantee
 * exactly). The conservative LEGACY-mode check only ever applies to
 * installations that are still ACTIVE — a REVOKED/REPLACED installation
 * has nothing left to protect, and gating it here would only make a
 * harmless idempotent re-revoke behave inconsistently.
 */
async function resolveActiveExamRevocationBlock(installationId: string, userId: string, installationStatus: string): Promise<ActiveExamRevocationBlock> {
  const boundSessionId = await findActiveBoundExamSessionId(installationId);
  if (boundSessionId) return { blocked: true, kind: "INSTALLATION_BOUND", sessionId: boundSessionId };

  if (installationStatus !== "ACTIVE") return { blocked: false };

  const legacySessionId = await findLegacyTetherRequiredActiveSessionId(userId);
  if (legacySessionId) return { blocked: true, kind: "LEGACY_ACCOUNT_WIDE", sessionId: legacySessionId };

  return { blocked: false };
}

export type RevokeInstallationResult =
  | { outcome: "REVOKED"; installation: NonNullable<Awaited<ReturnType<typeof loadOwnedInstallation>>> }
  | { outcome: "NOT_FOUND" }
  | { outcome: "ACTIVE_EXAM_IN_PROGRESS" }
  | { outcome: "ACTIVE_EXAM_IN_PROGRESS_ACCOUNT_WIDE" };

/**
 * The student's own self-service "log out this device" action — used
 * both to free up a slot under the multi-device limit and to revoke a
 * lost/shared/lab device. An administrative (lecturer/platform-admin)
 * revocation UI is out of scope for this pass (see "Known limitations").
 *
 * Device management UI v1 — refuses to revoke an installation currently
 * carrying an active examination session, precisely (v2-bound) or, under
 * LEGACY mode, conservatively account-wide (see
 * resolveActiveExamRevocationBlock above for the exact policy). A blocked
 * attempt is itself audited, distinctly from a successful revocation and
 * distinctly per block kind, so an unusual pattern of blocked attempts is
 * reviewable later.
 */
export async function revokeInstallation(installationId: string, userId: string, reason: string): Promise<RevokeInstallationResult> {
  const owned = await loadOwnedInstallation(installationId, userId);
  if (!owned) return { outcome: "NOT_FOUND" };

  const block = await resolveActiveExamRevocationBlock(installationId, userId, owned.status);
  if (block.blocked) {
    await createPlatformAuditLog({
      actorId: userId,
      action:
        block.kind === "INSTALLATION_BOUND"
          ? "TETHER_INSTALLATION_REVOCATION_BLOCKED_ACTIVE_EXAM"
          : "TETHER_INSTALLATION_REVOCATION_BLOCKED_LEGACY_ACTIVE_EXAM",
      targetType: "TetherClientInstallation",
      targetId: installationId,
      institutionId: owned.institutionId,
      metadata: { reason, activeSecureClientSessionId: block.sessionId },
    }).catch(() => {});
    return { outcome: block.kind === "INSTALLATION_BOUND" ? "ACTIVE_EXAM_IN_PROGRESS" : "ACTIVE_EXAM_IN_PROGRESS_ACCOUNT_WIDE" };
  }

  const revoked = await prisma.tetherClientInstallation.update({
    where: { id: installationId },
    data: { status: "REVOKED", revokedAt: new Date(), revocationReason: reason },
  });
  await createPlatformAuditLog({
    actorId: userId,
    action: "TETHER_INSTALLATION_REVOKED",
    targetType: "TetherClientInstallation",
    targetId: installationId,
    institutionId: owned.institutionId,
    metadata: { reason },
  }).catch(() => {});
  return { outcome: "REVOKED", installation: revoked };
}

/**
 * The student's own devices — for the self-service "manage my devices"
 * surface (privacy-preserving: id/dates/status only, NEVER the public
 * key or fingerprint). Ordered newest-first.
 */
export async function listOwnedInstallations(userId: string) {
  return prisma.tetherClientInstallation.findMany({
    where: { userId },
    orderBy: { installedAt: "desc" },
    select: { id: true, status: true, keyProtectionLevel: true, clientVersion: true, platform: true, installedAt: true, lastAttestedAt: true, revokedAt: true },
  });
}

// ---------------------------------------------------------------------------
// Purpose-bound attestation challenge (SYSTEM_CHECK | EXAM_SESSION)
// ---------------------------------------------------------------------------

export type IssueAttestationChallengeParams = {
  userId: string;
  purpose: AttestationPurpose;
  installationId: string;
  examId?: string | null;
  submissionId?: string | null;
  policyHash?: string | null;
  // EXAM_SESSION only — see "Wiring installation attestation into real
  // exam sessions" in docs/tether-system-check-v1.md. All server-computed
  // from the existing SecureClientSession + its immutable policy
  // snapshot, never trusted from the caller's own claim of what they
  // should be (the API route resolves these itself before calling here).
  secureClientSessionId?: string | null;
  institutionId?: string | null;
  allowedClientType?: string | null;
  displayPolicy?: string | null;
  requiredMinimumClientVersion?: string | null;
};

export type IssueAttestationChallengeResult =
  | { outcome: "ISSUED"; challenge: AttestationChallenge; signature: string }
  | { outcome: "INSTALLATION_NOT_FOUND" }
  | { outcome: "INSTALLATION_NOT_ACTIVE" };

export async function issueAttestationChallenge(params: IssueAttestationChallengeParams): Promise<IssueAttestationChallengeResult> {
  const installation = await loadOwnedInstallation(params.installationId, params.userId);
  if (!installation) return { outcome: "INSTALLATION_NOT_FOUND" };
  if (installation.status !== "ACTIVE") return { outcome: "INSTALLATION_NOT_ACTIVE" };

  const now = new Date();
  const challenge: AttestationChallenge = {
    schemaVersion: ATTESTATION_PROTOCOL_VERSION,
    challengeId: randomBytes(16).toString("hex"),
    keyId: getSigningKeyId(),
    issuer: ATTESTATION_ISSUER,
    purpose: params.purpose,
    audience: ATTESTATION_AUDIENCE,
    userSubjectHash: computeUserSubjectHash(params.userId),
    installationId: installation.id,
    installationPublicKeyFingerprint: installation.publicKeyFingerprint,
    issuedAt: now.toISOString(),
    notBefore: now.toISOString(),
    expiresAt: new Date(now.getTime() + ATTESTATION_CHALLENGE_TTL_SECONDS * 1000).toISOString(),
    nonce: generateAttestationNonce(),
    examId: params.purpose === "EXAM_SESSION" ? (params.examId ?? null) : null,
    submissionId: params.purpose === "EXAM_SESSION" ? (params.submissionId ?? null) : null,
    policyHash: params.purpose === "EXAM_SESSION" ? (params.policyHash ?? null) : null,
    secureClientSessionId: params.purpose === "EXAM_SESSION" ? (params.secureClientSessionId ?? null) : null,
    institutionId: params.purpose === "EXAM_SESSION" ? (params.institutionId ?? null) : null,
    allowedClientType: params.purpose === "EXAM_SESSION" ? (params.allowedClientType ?? null) : null,
    displayPolicy: params.purpose === "EXAM_SESSION" ? (params.displayPolicy ?? null) : null,
    requiredMinimumClientVersion: params.purpose === "EXAM_SESSION" ? (params.requiredMinimumClientVersion ?? null) : null,
  };
  const signature = signAttestationChallenge(challenge, getSigningPrivateKey());
  return { outcome: "ISSUED", challenge, signature };
}

/**
 * Common preamble shared by both verify functions below: re-validates the
 * server's own challenge signature/purpose/subject/installation-binding/
 * expiry/protocol-version, then re-confirms the installation is STILL
 * ACTIVE and its self-reported key-protection level is still one this
 * server accepts (defensive — registration already restricts this at
 * write time, but re-checking here means a hypothetical future data
 * change can never silently grandfather a rejected level into producing
 * verified attestations).
 */
async function loadAndValidateChallengeInstallation(
  userId: string,
  purpose: AttestationPurpose,
  challenge: AttestationChallenge,
  challengeSignature: string,
): Promise<
  | { outcome: "VALID"; installation: NonNullable<Awaited<ReturnType<typeof loadOwnedInstallation>>> }
  | { outcome: "INVALID"; reason: ValidationReasonCode }
  | { outcome: "INSTALLATION_NOT_ACTIVE" }
  | { outcome: "INSTALLATION_KEY_PROTECTION_REJECTED" }
> {
  const installation = await loadOwnedInstallation(challenge.installationId, userId);
  if (!installation) return { outcome: "INVALID", reason: "INVALID_SIGNATURE" };

  const validation = validateAttestationChallengeContext(challenge, challengeSignature, getSigningPublicKey(), {
    expectedPurpose: purpose,
    expectedAudience: ATTESTATION_AUDIENCE,
    expectedUserSubjectHash: computeUserSubjectHash(userId),
    expectedInstallationId: installation.id,
    expectedInstallationPublicKeyFingerprint: installation.publicKeyFingerprint,
    nowMs: Date.now(),
  });
  if (validation !== "VALID") return { outcome: "INVALID", reason: validation };

  // 8. Revoked installation cannot attest. 9. Replaced installation
  // cannot attest — even if it had a valid outstanding challenge issued
  // before the revocation/replacement.
  if (installation.status !== "ACTIVE") return { outcome: "INSTALLATION_NOT_ACTIVE" };

  // 10. Key-protection level must still be one this server accepts.
  if (!isSelfReportableKeyProtectionLevel(installation.keyProtectionLevel)) {
    return { outcome: "INSTALLATION_KEY_PROTECTION_REJECTED" };
  }

  return { outcome: "VALID", installation };
}

export type VerifySystemCheckAttestationParams = {
  userId: string;
  institutionId: string;
  challenge: AttestationChallenge;
  challengeSignature: string;
  clientType: SystemCheckClientType;
  installationSignature: string;
  clientVersion: string;
  platform: string;
  displayTopologyClassification: string;
};

export type VerifyAttestationResult =
  | { outcome: "VERIFIED"; verificationId: string; expiresAt: Date }
  | { outcome: "REPLAY" }
  | { outcome: "INVALID"; reason: ValidationReasonCode }
  | { outcome: "INSTALLATION_NOT_ACTIVE" }
  | { outcome: "INSTALLATION_KEY_PROTECTION_REJECTED" }
  | { outcome: "INSTALLATION_SIGNATURE_INVALID" };

/**
 * Verifies a SYSTEM_CHECK attestation. TWO independent signatures are
 * checked: (1) the server's own challenge signature (proves the
 * challenge is genuine/current/bound to this user+installation — NOT by
 * itself proof of client genuineness) and (2) the installation's own
 * signature over the canonical SYSTEM_CHECK payload, verified against
 * THAT installation's registered public key (proves possession of the
 * per-installation private key — the actual proof an ordinary browser
 * cannot fabricate, since it never held that key or any key the server
 * has pinned to this installation). Structurally writes ONLY to
 * SystemCheckSecureClientVerification — see this file's own top-level
 * doc comment for the non-authorization guarantee.
 */
export async function verifySystemCheckAttestation(params: VerifySystemCheckAttestationParams): Promise<VerifyAttestationResult> {
  const loaded = await loadAndValidateChallengeInstallation(params.userId, "SYSTEM_CHECK", params.challenge, params.challengeSignature);
  if (loaded.outcome === "INVALID") return { outcome: "INVALID", reason: loaded.reason };
  if (loaded.outcome === "INSTALLATION_NOT_ACTIVE") return { outcome: "INSTALLATION_NOT_ACTIVE" };
  if (loaded.outcome === "INSTALLATION_KEY_PROTECTION_REJECTED") return { outcome: "INSTALLATION_KEY_PROTECTION_REJECTED" };

  if (!isValidDisplayTopologyClassification(params.displayTopologyClassification)) {
    return { outcome: "INSTALLATION_SIGNATURE_INVALID" };
  }
  const canonicalString = buildSystemCheckAttestationCanonicalString({
    nonce: params.challenge.nonce,
    installationPublicKeyFingerprint: loaded.installation.publicKeyFingerprint,
    clientVersion: params.clientVersion,
    platform: params.platform,
    displayTopologyClassification: params.displayTopologyClassification,
  });
  if (!verifyInstallationSignature(canonicalString, params.installationSignature, loaded.installation.publicKey)) {
    return { outcome: "INSTALLATION_SIGNATURE_INVALID" };
  }

  const nonceHash = hashNonce(params.challenge.nonce);
  const challengeHash = createHash("sha256").update(JSON.stringify(params.challenge), "utf8").digest("hex");

  try {
    const [record] = await prisma.$transaction([
      prisma.systemCheckSecureClientVerification.create({
        data: {
          userId: params.userId,
          institutionId: params.institutionId,
          purpose: "SYSTEM_CHECK",
          installationId: loaded.installation.id,
          clientType: params.clientType,
          verificationStatus: "VERIFIED",
          clientVersion: params.clientVersion,
          platform: params.platform,
          displayTopologyClassification: params.displayTopologyClassification,
          nonceHash,
          challengeHash,
          issuedAt: new Date(params.challenge.issuedAt),
          expiresAt: new Date(params.challenge.expiresAt),
          verifiedAt: new Date(),
        },
      }),
      prisma.tetherClientInstallation.update({ where: { id: loaded.installation.id }, data: { lastAttestedAt: new Date() } }),
    ]);
    return { outcome: "VERIFIED", verificationId: record.id, expiresAt: record.expiresAt };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { outcome: "REPLAY" };
    }
    throw err;
  }
}

/** Ownership + freshness lookup for POST /api/tether/system-check/runs. */
export async function loadOwnedSystemCheckVerification(verificationId: string, userId: string) {
  const record = await prisma.systemCheckSecureClientVerification.findUnique({ where: { id: verificationId } });
  if (!record || record.userId !== userId) return null;
  return record;
}

// ---------------------------------------------------------------------------
// EXAM_SESSION attestation — ADDITIVE only in this pass. See
// docs/tether-system-check-v1.md, "Real exam attestation — additive
// groundwork" for exactly what this does and does not change about the
// live exam-taking path.
// ---------------------------------------------------------------------------

export type VerifyExamSessionAttestationParams = {
  userId: string;
  challenge: AttestationChallenge;
  challengeSignature: string;
  installationSignature: string;
  clientVersion: string;
  platform: string;
  displayTopologyClassification: string;
  displayCount: number;
  // Added when wiring v2 into the real exam-session gate — see
  // ExamSessionAttestationFacts in tetherAttestation.ts.
  capabilities: string;
  timestamp: string;
};

export type VerifyExamSessionAttestationResult =
  | {
      outcome: "VERIFIED";
      sessionId: string;
      installationPublicKeyFingerprint: string;
      // Tether Secure Exam Recovery and Resilient Autosave v1 — true only
      // when this session (a) supersedes an earlier one for the same
      // submission (recoveryOfSessionId set) AND (b) is verifying for the
      // first time. The caller (the verify route, never this file — see
      // the structural non-authorization guarantee in this file's
      // top-level doc comment) uses this to decide whether to call
      // recordSecureResumeCompleted (tetherRecoveryRunner.ts), which is
      // the only thing in this whole flow that writes to Submission.
      isRecoveryCompletion: boolean;
    }
  | { outcome: "REPLAY" }
  | { outcome: "INVALID"; reason: ValidationReasonCode }
  | { outcome: "INSTALLATION_NOT_ACTIVE" }
  | { outcome: "INSTALLATION_KEY_PROTECTION_REJECTED" }
  | { outcome: "INSTALLATION_SIGNATURE_INVALID" }
  | { outcome: "SESSION_NOT_FOUND" }
  | { outcome: "BINDING_MISMATCH" }
  | { outcome: "CLIENT_VERSION_UNSUPPORTED" }
  | { outcome: "PLATFORM_UNSUPPORTED" }
  | { outcome: "DISPLAY_POLICY_VIOLATION" }
  | { outcome: "POLICY_HASH_MISMATCH" }
  // Tether Secure Exam Recovery and Resilient Autosave v1 — Part 8 (same
  // device / device change). See the check just before the verification
  // transaction below.
  | { outcome: "DEVICE_CHANGE_DETECTED" };

/**
 * Best-effort, single-field failure-reason breadcrumb — never sets
 * installationAttestationVerified, never touches the legacy
 * status/verificationStatus columns. Only called for failures discovered
 * AFTER the target session has been definitively located (so the
 * breadcrumb lands on the right row); earlier failures (bad signature,
 * unknown/foreign installation, expired challenge) return an error to the
 * caller directly without writing anything, which is fine — the session
 * simply stays as it was. Swallows its own errors: a failed audit
 * breadcrumb must never turn a correctly-rejected attestation into a
 * 500.
 */
async function recordExamSessionFailure(sessionId: string, reason: string): Promise<void> {
  await prisma.secureClientSession.update({ where: { id: sessionId }, data: { installationAttestationFailureReason: reason } }).catch(() => {});
}

/**
 * Verifies a genuine, installation-signed EXAM_SESSION attestation
 * against the FULL 20-point checklist documented in
 * docs/tether-system-check-v1.md ("Wiring installation attestation into
 * real exam sessions") and, ONLY IF EVERY check passes, records it
 * against the matching SecureClientSession: sets
 * installationAttestationVerified = true, populates the real
 * clientInstallationId relation (and clientInstallationIdHash, kept for
 * continuity with the pre-v2 dormant field), and points
 * installationVerificationId at the full evidence row. All 20 checks run
 * BEFORE any database write — a failed check returns early and leaves
 * every one of these fields untouched (or, once the session is known,
 * updates ONLY installationAttestationFailureReason — never
 * installationAttestationVerified — see recordExamSessionFailure above).
 *
 * Deliberately does NOT change SecureClientSession.status or
 * .verificationStatus — those remain governed entirely by the existing,
 * live recordAttestation() flow in secureClientRunner.ts, completely
 * unmodified by this pass. Whether this function's outcome actually
 * gates real exam content access is decided separately, at request time,
 * by resolveEffectiveTetherVerification()
 * (src/lib/tetherAttestationConfig.ts) according to
 * TETHER_EXAM_ATTESTATION_MODE — see that module's doc comment for the
 * full LEGACY/DUAL/V2_REQUIRED truth table.
 */
export async function verifyExamSessionAttestation(params: VerifyExamSessionAttestationParams): Promise<VerifyExamSessionAttestationResult> {
  // 1-5, 7-11: server challenge signature, protocol version, purpose,
  // installation exists/owned/ACTIVE, key-protection level accepted,
  // fingerprint match, expiry.
  const loaded = await loadAndValidateChallengeInstallation(params.userId, "EXAM_SESSION", params.challenge, params.challengeSignature);
  if (loaded.outcome === "INVALID") return { outcome: "INVALID", reason: loaded.reason };
  if (loaded.outcome === "INSTALLATION_NOT_ACTIVE") return { outcome: "INSTALLATION_NOT_ACTIVE" };
  if (loaded.outcome === "INSTALLATION_KEY_PROTECTION_REJECTED") return { outcome: "INSTALLATION_KEY_PROTECTION_REJECTED" };

  const challenge = params.challenge;
  if (
    !challenge.examId ||
    !challenge.submissionId ||
    !challenge.policyHash ||
    !challenge.secureClientSessionId ||
    !challenge.institutionId ||
    !challenge.allowedClientType ||
    !challenge.displayPolicy ||
    !challenge.requiredMinimumClientVersion
  ) {
    return { outcome: "BINDING_MISMATCH" };
  }
  if (!isValidDisplayTopologyClassification(params.displayTopologyClassification)) {
    return { outcome: "INSTALLATION_SIGNATURE_INVALID" };
  }

  // 12. Installation signature over the canonical EXAM_SESSION payload —
  // 6 (nonce, as part of the signed payload) is implicitly re-asserted
  // here too, independent of the server challenge's own binding.
  const canonicalString = buildExamSessionAttestationCanonicalString({
    nonce: challenge.nonce,
    installationPublicKeyFingerprint: loaded.installation.publicKeyFingerprint,
    clientVersion: params.clientVersion,
    platform: params.platform,
    displayTopologyClassification: params.displayTopologyClassification,
    displayCount: params.displayCount,
    examId: challenge.examId,
    submissionId: challenge.submissionId,
    policyHash: challenge.policyHash,
    secureClientSessionId: challenge.secureClientSessionId,
    capabilities: params.capabilities,
    timestamp: params.timestamp,
  });
  if (!verifyInstallationSignature(canonicalString, params.installationSignature, loaded.installation.publicKey)) {
    return { outcome: "INSTALLATION_SIGNATURE_INVALID" };
  }

  // 16, 17, 18: exam/submission/secure-client-session id all match a
  // REAL, existing session belonging to this exact student — looked up
  // by primary key (the challenge's own claimed session id), never
  // trusted without cross-checking every bound field against it.
  const session = await prisma.secureClientSession.findUnique({ where: { id: challenge.secureClientSessionId } });
  if (!session || session.studentId !== params.userId) return { outcome: "SESSION_NOT_FOUND" };
  if (session.examId !== challenge.examId || session.submissionId !== challenge.submissionId) {
    return { outcome: "BINDING_MISMATCH" };
  }
  if (session.institutionId !== challenge.institutionId) {
    return { outcome: "BINDING_MISMATCH" };
  }

  // 13. Signed client version satisfies the challenge's own required
  // minimum (server-computed at challenge-issuance time — see
  // issueAttestationChallenge's caller).
  if (compareVersions(params.clientVersion, challenge.requiredMinimumClientVersion) < 0) {
    await recordExamSessionFailure(session.id, "CLIENT_VERSION_UNSUPPORTED");
    return { outcome: "CLIENT_VERSION_UNSUPPORTED" };
  }

  // 14. Signed platform supported.
  if (evaluateOperatingSystem(params.platform).status !== "PASS") {
    await recordExamSessionFailure(session.id, "PLATFORM_UNSUPPORTED");
    return { outcome: "PLATFORM_UNSUPPORTED" };
  }

  // 19. Policy hash matches the submission's OWN current, immutable
  // policy snapshot — recomputed here from the authoritative source
  // (Submission.secureClientPolicySnapshotJson), never merely compared
  // against the challenge's own unverified copy of itself.
  const submission = await prisma.submission.findUnique({ where: { id: session.submissionId } });
  if (!submission) return { outcome: "SESSION_NOT_FOUND" };
  const policy = parseSecureClientPolicy(submission.secureClientPolicySnapshotJson);
  const recomputedPolicyHash = computePolicyHash(policy);
  if (recomputedPolicyHash !== challenge.policyHash) {
    await recordExamSessionFailure(session.id, "POLICY_HASH_MISMATCH");
    return { outcome: "POLICY_HASH_MISMATCH" };
  }

  // 15. Signed display facts satisfy the immutable attempt policy — a
  // SINGLE_DISPLAY_REQUIRED attempt must see exactly one PASS-worthy
  // display, using the same evaluateDisplayTopology used everywhere else
  // in this codebase for this decision (never a bespoke re-implementation
  // here).
  if (policy.displayPolicy === "SINGLE_DISPLAY_REQUIRED") {
    const topologyResult = evaluateDisplayTopology(params.displayTopologyClassification as DisplayTopologyClassification);
    if (topologyResult.status !== "PASS" || params.displayCount > 1) {
      await recordExamSessionFailure(session.id, "DISPLAY_POLICY_VIOLATION");
      return { outcome: "DISPLAY_POLICY_VIOLATION" };
    }
  }

  // Allowed-client-type binding: the challenge's claimed allowedClientType
  // must match this session's actual clientType — belt-and-suspenders
  // against a challenge issued for one session being reused to attest a
  // differently-typed one. (The policy's own allowedClientTypes set is
  // already covered by the policy-hash check above — policyHash is a hash
  // of the whole policy object, including allowedClientTypes.)
  if (challenge.allowedClientType !== session.clientType) {
    await recordExamSessionFailure(session.id, "BINDING_MISMATCH");
    return { outcome: "BINDING_MISMATCH" };
  }

  // Tether Secure Exam Recovery and Resilient Autosave v1 — Part 8 (same
  // device / device change), hardened further by the secure-recovery
  // hardening v1 pass (Part A/B/C). This IS the real, authoritative
  // enforcement gate (the recovery-state resolver's own device-change
  // check — see resolveRecoveryState in src/lib/tetherRecovery.ts — is a
  // proactive, non-authoritative UI hint only). If this session
  // supersedes an earlier one for the same submission (recoveryOfSessionId
  // set — see getOrCreateSessionCore in secureClientRunner.ts), resolves
  // whether that PRIOR session ever established a trusted installation
  // reference (resolvePriorSessionTrust — walks back through the chain
  // via the prior session's own clientInstallationId, never inferred,
  // never a renderer claim). Reused below both to refuse a genuine
  // device mismatch AND (Part C) to decide whether a successful
  // verification is even ELIGIBLE to count as a completed recovery at
  // all — an unbound-original recovery is never eligible, regardless of
  // what this attestation shows (see resolveTrustedTetherVerification's
  // own doc comment for why). trustedInstallationId non-null already
  // implies the prior session was genuinely v2-verified, so no separate
  // everVerified check is needed for either use below.
  const { trustedInstallationId: priorSessionTrustedInstallationId } = await resolvePriorSessionTrust(session.recoveryOfSessionId);
  if (session.recoveryOfSessionId && priorSessionTrustedInstallationId && priorSessionTrustedInstallationId !== loaded.installation.id) {
    // Part B — audited AT MOST ONCE per session: a mismatched device
    // retrying verification against this SAME session (a different
    // challenge/nonce each time) would otherwise re-log on every
    // attempt. installationAttestationFailureReason already reflects the
    // outcome of the LAST attempt against this session, read once above
    // (`session`) before this request's own write — a genuinely
    // concurrent double-attempt could still log twice in the worst case,
    // but a normal retry sequence (the actual "double-click/rerender"
    // scenario this hardening pass targets) will not.
    if (session.installationAttestationFailureReason !== "DEVICE_CHANGE_DETECTED") {
      await createPlatformAuditLog({
        actorId: params.userId,
        action: "TETHER_SECURE_RESUME_DENIED_DEVICE_CHANGE",
        targetType: "Submission",
        targetId: session.submissionId,
        institutionId: session.institutionId,
        metadata: {
          secureClientSessionId: session.id,
          boundInstallationId: priorSessionTrustedInstallationId,
          attemptingInstallationId: loaded.installation.id,
        },
      }).catch(() => {});
    }
    await recordExamSessionFailure(session.id, "DEVICE_CHANGE_DETECTED");
    return { outcome: "DEVICE_CHANGE_DETECTED" };
  }

  // 6, 20: nonce not previously consumed — enforced by the unique index
  // on nonceHash; a second attempt with the same nonce fails the
  // transaction outright (P2002) and NOTHING below it is applied,
  // satisfying "do not partially update verification state".
  const nonceHash = hashNonce(challenge.nonce);
  const challengeHash = createHash("sha256").update(JSON.stringify(challenge), "utf8").digest("hex");

  try {
    const { sessionId, transitioned } = await prisma.$transaction(async (tx) => {
      const verification = await tx.systemCheckSecureClientVerification.create({
        data: {
          userId: params.userId,
          institutionId: session.institutionId,
          purpose: "EXAM_SESSION",
          attestationProtocolVersion: challenge.schemaVersion,
          installationId: loaded.installation.id,
          clientType: "TETHER_SECURE_CLIENT",
          verificationStatus: "VERIFIED",
          clientVersion: params.clientVersion,
          platform: params.platform,
          displayTopologyClassification: params.displayTopologyClassification,
          nonceHash,
          challengeHash,
          issuedAt: new Date(challenge.issuedAt),
          expiresAt: new Date(challenge.expiresAt),
          verifiedAt: new Date(),
        },
      });
      // Secure-recovery hardening v1, Part C — resumeCount idempotency.
      // Conditional on installationAttestationVerified STILL being false
      // at the moment this UPDATE actually runs (not on the `session` row
      // read at the top of this function, which can be stale under
      // genuine concurrency — two duplicate verify requests, e.g. from a
      // double-click or a React rerender, each with their own valid
      // challenge/nonce, could otherwise both read
      // installationAttestationVerified as false before either commits).
      // Postgres serializes concurrent
      // UPDATEs to the same row: the second transaction blocks until the
      // first commits, then re-evaluates this WHERE clause against the
      // NOW-committed row and matches zero rows — updateMany reports
      // count 0 rather than throwing, so exactly one of any number of
      // concurrent duplicate requests ever sees transitioned:true. This
      // is the authoritative server-transaction boundary Part C asks
      // for — never client debounce.
      const updateResult = await tx.secureClientSession.updateMany({
        where: { id: session.id, installationAttestationVerified: false },
        data: {
          clientInstallationId: loaded.installation.id,
          clientInstallationIdHash: loaded.installation.publicKeyFingerprint,
          installationAttestationVerified: true,
          installationAttestationVerifiedAt: new Date(),
          installationAttestationFailureReason: null,
          installationVerificationId: verification.id,
        },
      });
      await tx.tetherClientInstallation.update({ where: { id: loaded.installation.id }, data: { lastAttestedAt: new Date() } });
      return { sessionId: session.id, transitioned: updateResult.count === 1 };
    });
    return {
      outcome: "VERIFIED",
      sessionId,
      installationPublicKeyFingerprint: loaded.installation.publicKeyFingerprint,
      // Part A/C — only a genuine, bound-original recovery whose
      // verification transition THIS request actually performed counts
      // as a completed recovery. Never true for: an ordinary first
      // launch (recoveryOfSessionId null), an unbound-original recovery
      // (priorSessionTrustedInstallationId null — that's
      // MANUAL_REVIEW_REQUIRED, never an automatic completion), or a
      // duplicate/concurrent request that lost the race to actually
      // transition the row (transitioned false).
      isRecoveryCompletion: Boolean(session.recoveryOfSessionId) && Boolean(priorSessionTrustedInstallationId) && transitioned,
    };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { outcome: "REPLAY" };
    }
    throw err;
  }
}
