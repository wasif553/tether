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
 * this file creates, reads, or updates Submission, Answer,
 * IntegrityEvent, or ExamAttemptSession. `verifyExamSessionAttestation`
 * DOES read/update an EXISTING SecureClientSession row (additive only —
 * see its own doc comment) but never creates one, and
 * `verifySystemCheckAttestation` never touches SecureClientSession at
 * all — see the "purpose isolation" tests in
 * tetherAttestation.routes.test.ts for the automated proof.
 */
import { randomBytes, createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { getSigningPrivateKey, getSigningPublicKey, getSigningKeyId } from "@/lib/secureClientRunner";
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
import { resolveMaxActiveInstallationsPerUser } from "@/lib/tetherAttestationConfig";

export const REGISTRATION_CHALLENGE_TTL_SECONDS = 120;
export const ATTESTATION_CHALLENGE_TTL_SECONDS = 120;
export const REGISTRATION_AUDIENCE = "tether-installation-registration";
export const ATTESTATION_AUDIENCE = "tether-attestation";

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

/** No database write — stateless, like the attestation challenge. */
export function issueRegistrationChallenge(params: { userId: string }): { challenge: RegistrationChallenge; signature: string } {
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

  const validation = validateRegistrationChallengeContext(params.challenge, params.challengeSignature, getSigningPublicKey(), {
    expectedAudience: REGISTRATION_AUDIENCE,
    expectedUserSubjectHash: computeUserSubjectHash(params.userId),
    nowMs: Date.now(),
  });
  if (validation !== "VALID") {
    return { outcome: "INVALID_CHALLENGE", reason: validation };
  }

  if (!verifyRegistrationProofOfPossession(params.challenge.nonce, params.proofOfPossessionSignature, params.publicKey)) {
    return { outcome: "PROOF_OF_POSSESSION_INVALID" };
  }

  const publicKeyFingerprint = computePublicKeyFingerprint(params.publicKey);
  const maxActiveInstallations = resolveMaxActiveInstallationsPerUser();

  try {
    const installationId = await prisma.$transaction(async (tx) => {
      const activeCount = await tx.tetherClientInstallation.count({ where: { userId: params.userId, status: "ACTIVE" } });
      if (activeCount >= maxActiveInstallations) {
        return null;
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
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
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

/**
 * The student's own self-service "log out this device" action — used
 * both to free up a slot under the multi-device limit and to revoke a
 * lost/shared/lab device. An administrative (lecturer/platform-admin)
 * revocation UI is out of scope for this pass (see "Known limitations").
 */
export async function revokeInstallation(installationId: string, userId: string, reason: string) {
  const owned = await loadOwnedInstallation(installationId, userId);
  if (!owned) return null;
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
  return revoked;
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
  | { outcome: "VERIFIED"; sessionId: string; installationPublicKeyFingerprint: string }
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
  | { outcome: "POLICY_HASH_MISMATCH" };

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

  // 6, 20: nonce not previously consumed — enforced by the unique index
  // on nonceHash; a second attempt with the same nonce fails the
  // transaction outright (P2002) and NOTHING below it is applied,
  // satisfying "do not partially update verification state".
  const nonceHash = hashNonce(challenge.nonce);
  const challengeHash = createHash("sha256").update(JSON.stringify(challenge), "utf8").digest("hex");

  try {
    const sessionId = await prisma.$transaction(async (tx) => {
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
      await tx.secureClientSession.update({
        where: { id: session.id },
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
      return session.id;
    });
    return { outcome: "VERIFIED", sessionId, installationPublicKeyFingerprint: loaded.installation.publicKeyFingerprint };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { outcome: "REPLAY" };
    }
    throw err;
  }
}
