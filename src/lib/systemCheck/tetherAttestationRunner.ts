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
import { isValidDisplayTopologyClassification } from "@/lib/systemCheck/readiness";

export const REGISTRATION_CHALLENGE_TTL_SECONDS = 120;
export const ATTESTATION_CHALLENGE_TTL_SECONDS = 120;
export const REGISTRATION_AUDIENCE = "tether-installation-registration";
export const ATTESTATION_AUDIENCE = "tether-attestation";

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
  | { outcome: "DUPLICATE_KEY" };

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
 * Automatically marks any existing ACTIVE installation for this user as
 * REPLACED — at most one ACTIVE installation per user at a time (see
 * the model's own doc comment in prisma/schema.prisma for the UX
 * tradeoff this implies).
 */
export async function registerInstallation(params: RegisterInstallationParams): Promise<RegisterInstallationResult> {
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

  try {
    const installationId = await prisma.$transaction(async (tx) => {
      await tx.tetherClientInstallation.updateMany({
        where: { userId: params.userId, status: "ACTIVE" },
        data: { status: "REPLACED" },
      });
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

/** The student's own self-service "log out this device" action — an administrative revocation UI is out of scope for this pass (see "Known limitations"). */
export async function revokeInstallation(installationId: string, userId: string, reason: string) {
  const owned = await loadOwnedInstallation(installationId, userId);
  if (!owned) return null;
  return prisma.tetherClientInstallation.update({
    where: { id: installationId },
    data: { status: "REVOKED", revokedAt: new Date(), revocationReason: reason },
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
  };
  const signature = signAttestationChallenge(challenge, getSigningPrivateKey());
  return { outcome: "ISSUED", challenge, signature };
}

/** Common preamble shared by both verify functions below: re-validates the server's own challenge signature/purpose/subject/installation-binding/expiry, then re-confirms the installation is STILL ACTIVE right now (not revoked/replaced since the challenge was issued). */
async function loadAndValidateChallengeInstallation(
  userId: string,
  purpose: AttestationPurpose,
  challenge: AttestationChallenge,
  challengeSignature: string,
): Promise<{ outcome: "VALID"; installation: NonNullable<Awaited<ReturnType<typeof loadOwnedInstallation>>> } | { outcome: "INVALID"; reason: ValidationReasonCode } | { outcome: "INSTALLATION_NOT_ACTIVE" }> {
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
};

export type VerifyExamSessionAttestationResult =
  | { outcome: "VERIFIED"; sessionId: string; installationPublicKeyFingerprint: string }
  | { outcome: "REPLAY" }
  | { outcome: "INVALID"; reason: ValidationReasonCode }
  | { outcome: "INSTALLATION_NOT_ACTIVE" }
  | { outcome: "INSTALLATION_SIGNATURE_INVALID" }
  | { outcome: "SESSION_NOT_FOUND" }
  | { outcome: "BINDING_MISMATCH" };

/**
 * Verifies a genuine, installation-signed EXAM_SESSION attestation and,
 * ONLY IF valid, records it against the matching SecureClientSession —
 * additively, by populating the existing (previously dormant, never
 * written by any code path)
 * SecureClientSession.clientInstallationIdHash field with this
 * installation's publicKeyFingerprint, and by tracking the nonce/replay
 * state in the SAME SystemCheckSecureClientVerification table (purpose
 * "EXAM_SESSION" this time — the two purposes share the replay-
 * protection table but are never confusable: the canonical signed
 * payload format itself differs, see buildExamSessionAttestationCanonicalString,
 * so a SYSTEM_CHECK signature could never be replayed here even if the
 * nonce were somehow reused).
 *
 * Deliberately does NOT change SecureClientSession.status or
 * .verificationStatus — those remain governed entirely by the existing,
 * live recordAttestation() flow in secureClientRunner.ts, unchanged.
 * Wiring this as the actual enforcement gate for a session's
 * READY/CANNOT_START outcome is flagged as a follow-up (see "Known
 * limitations") rather than attempted in this pass, given the risk of
 * destabilising the live exam-taking path without a dedicated,
 * separately-reviewed change.
 */
export async function verifyExamSessionAttestation(params: VerifyExamSessionAttestationParams): Promise<VerifyExamSessionAttestationResult> {
  const loaded = await loadAndValidateChallengeInstallation(params.userId, "EXAM_SESSION", params.challenge, params.challengeSignature);
  if (loaded.outcome === "INVALID") return { outcome: "INVALID", reason: loaded.reason };
  if (loaded.outcome === "INSTALLATION_NOT_ACTIVE") return { outcome: "INSTALLATION_NOT_ACTIVE" };

  if (!params.challenge.examId || !params.challenge.submissionId || !params.challenge.policyHash) {
    return { outcome: "BINDING_MISMATCH" };
  }
  if (!isValidDisplayTopologyClassification(params.displayTopologyClassification)) {
    return { outcome: "INSTALLATION_SIGNATURE_INVALID" };
  }

  const session = await prisma.secureClientSession.findFirst({
    where: { submissionId: params.challenge.submissionId, examId: params.challenge.examId, studentId: params.userId },
    orderBy: { createdAt: "desc" },
  });
  if (!session) return { outcome: "SESSION_NOT_FOUND" };

  const canonicalString = buildExamSessionAttestationCanonicalString({
    nonce: params.challenge.nonce,
    installationPublicKeyFingerprint: loaded.installation.publicKeyFingerprint,
    clientVersion: params.clientVersion,
    platform: params.platform,
    displayTopologyClassification: params.displayTopologyClassification,
    displayCount: params.displayCount,
    examId: params.challenge.examId,
    submissionId: params.challenge.submissionId,
    policyHash: params.challenge.policyHash,
  });
  if (!verifyInstallationSignature(canonicalString, params.installationSignature, loaded.installation.publicKey)) {
    return { outcome: "INSTALLATION_SIGNATURE_INVALID" };
  }

  const nonceHash = hashNonce(params.challenge.nonce);
  const challengeHash = createHash("sha256").update(JSON.stringify(params.challenge), "utf8").digest("hex");

  try {
    await prisma.$transaction([
      prisma.systemCheckSecureClientVerification.create({
        data: {
          userId: params.userId,
          institutionId: session.institutionId,
          purpose: "EXAM_SESSION",
          installationId: loaded.installation.id,
          clientType: "TETHER_SECURE_CLIENT",
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
      prisma.secureClientSession.update({
        where: { id: session.id },
        data: { clientInstallationIdHash: loaded.installation.publicKeyFingerprint },
      }),
      prisma.tetherClientInstallation.update({ where: { id: loaded.installation.id }, data: { lastAttestedAt: new Date() } }),
    ]);
    return { outcome: "VERIFIED", sessionId: session.id, installationPublicKeyFingerprint: loaded.installation.publicKeyFingerprint };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { outcome: "REPLAY" };
    }
    throw err;
  }
}
