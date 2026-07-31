/**
 * Tether Secure Client Attestation v2 — see
 * docs/tether-system-check-v1.md, "Secure Client Attestation v2".
 *
 * Replaces the v1 globally-embedded-key design (removed — see git
 * history for `clientAttestationKey.ts` and
 * `systemCheckClientAttestation.ts`, which relied on ONE Ed25519 private
 * key compiled into every packaged build; extracting it from any single
 * installation would have compromised every installation). v2 uses a
 * PER-INSTALLATION keypair instead — see "Per-installation key" in the
 * doc above. This module is server-only crypto/canonicalisation logic
 * (Ed25519 sign/verify via Node's `crypto`), otherwise dependency-free —
 * no Prisma, no Next.js.
 *
 * Two distinct signature roles, never confused:
 *  1. The SERVER's own challenge signature (TETHER_SECURE_CLIENT_SIGNING_*)
 *     — proves a challenge was genuinely issued by this server, bound to
 *     a specific user/purpose/installation/expiry. Reused unchanged from
 *     v1 — see getSigningPrivateKey/getSigningPublicKey in
 *     secureClientRunner.ts.
 *  2. The INSTALLATION's own signature — proves possession of the
 *     specific per-installation private key registered as
 *     TetherClientInstallation.publicKey, computed entirely in the
 *     Electron main process, never exposed to the renderer. BOTH must
 *     verify before any attestation is accepted — the server signature
 *     alone (proving the challenge is genuine) is explicitly NOT
 *     sufficient proof of client genuineness (this was the actual
 *     vulnerability in the v1 corrective pass).
 */
import crypto from "crypto";
import { canonicalJsonStringify, generateLaunchNonce, hashNonce } from "./secureLaunchManifest";

export { generateLaunchNonce as generateAttestationNonce, hashNonce };

export const ATTESTATION_PROTOCOL_VERSION = 2;
export const ATTESTATION_ISSUER = "tether-secure-client";

export const ATTESTATION_PURPOSES = ["SYSTEM_CHECK", "EXAM_SESSION"] as const;
export type AttestationPurpose = (typeof ATTESTATION_PURPOSES)[number];
export function isValidAttestationPurpose(value: string): value is AttestationPurpose {
  return (ATTESTATION_PURPOSES as readonly string[]).includes(value);
}

export const REGISTRATION_PURPOSE = "INSTALLATION_REGISTRATION" as const;

/** SHA-256 hex digest of an already-opaque user id — never a directly-identifying value in a signed, client-visible challenge. */
export function computeUserSubjectHash(userId: string): string {
  return crypto.createHash("sha256").update(`tether-attestation-subject:${userId}`, "utf8").digest("hex");
}

/** SHA-256 hex digest of a PEM public key — the installation's fingerprint, pinned into every challenge issued for it so a mid-flow key swap invalidates the signature. */
export function computePublicKeyFingerprint(publicKeyPem: string): string {
  return crypto.createHash("sha256").update(publicKeyPem.trim(), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Installation registration challenge — issued BEFORE any
// TetherClientInstallation row exists, so it cannot bind an
// installationId/fingerprint yet. Proves only: this server issued this
// challenge, to this authenticated user, right now. The registration
// COMPLETE step separately proves the registering party possesses the
// private key matching the public key it submits (signs this challenge's
// nonce) — see systemCheckSecureClientRunner.ts's registerInstallation.
// ---------------------------------------------------------------------------

export type RegistrationChallenge = {
  schemaVersion: number;
  challengeId: string;
  keyId: string;
  issuer: string;
  purpose: typeof REGISTRATION_PURPOSE;
  audience: string;
  userSubjectHash: string;
  issuedAt: string;
  notBefore: string;
  expiresAt: string;
  nonce: string;
};

export function canonicalRegistrationChallengeString(challenge: RegistrationChallenge): string {
  return canonicalJsonStringify(challenge);
}

export function signRegistrationChallenge(challenge: RegistrationChallenge, privateKeyPem: string): string {
  return crypto.sign(null, Buffer.from(canonicalRegistrationChallengeString(challenge), "utf8"), privateKeyPem).toString("base64");
}

export function verifyRegistrationChallengeSignature(challenge: RegistrationChallenge, signatureBase64: string, publicKeyPem: string): boolean {
  try {
    return crypto.verify(null, Buffer.from(canonicalRegistrationChallengeString(challenge), "utf8"), publicKeyPem, Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}

export const VALIDATION_REASON_CODES = [
  "VALID",
  "EXPIRED",
  "NOT_YET_VALID",
  "WRONG_AUDIENCE",
  "WRONG_PURPOSE",
  "WRONG_SUBJECT",
  "INVALID_SIGNATURE",
] as const;
export type ValidationReasonCode = (typeof VALIDATION_REASON_CODES)[number];

export function validateRegistrationChallengeContext(
  challenge: RegistrationChallenge,
  signatureBase64: string,
  publicKeyPem: string,
  context: { expectedAudience: string; expectedUserSubjectHash: string; nowMs: number },
): ValidationReasonCode {
  if (!verifyRegistrationChallengeSignature(challenge, signatureBase64, publicKeyPem)) return "INVALID_SIGNATURE";
  if (challenge.purpose !== REGISTRATION_PURPOSE) return "WRONG_PURPOSE";
  if (challenge.userSubjectHash !== context.expectedUserSubjectHash) return "WRONG_SUBJECT";
  const notBefore = Date.parse(challenge.notBefore);
  const expiresAt = Date.parse(challenge.expiresAt);
  if (Number.isFinite(notBefore) && context.nowMs < notBefore) return "NOT_YET_VALID";
  if (Number.isFinite(expiresAt) && context.nowMs > expiresAt) return "EXPIRED";
  if (challenge.audience !== context.expectedAudience) return "WRONG_AUDIENCE";
  return "VALID";
}

/** Proof of possession at registration time: sign the registration challenge's nonce with the newly generated installation private key. */
export function signRegistrationProofOfPossession(nonce: string, installationPrivateKeyPem: string): string {
  return crypto.sign(null, Buffer.from(nonce, "utf8"), installationPrivateKeyPem).toString("base64");
}

export function verifyRegistrationProofOfPossession(nonce: string, signatureBase64: string, installationPublicKeyPem: string): boolean {
  try {
    return crypto.verify(null, Buffer.from(nonce, "utf8"), installationPublicKeyPem, Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Purpose-bound attestation challenge — issued AFTER an installation is
// registered. Binds installationId + its pinned publicKeyFingerprint, so
// the resulting signature can only ever be checked against that exact
// installation's registered key, and EXAM_SESSION additionally binds
// examId/submissionId/policyHash so a signature can never be replayed
// against a different exam or relabelled as a different purpose.
// ---------------------------------------------------------------------------

export type AttestationChallenge = {
  schemaVersion: number;
  challengeId: string;
  keyId: string;
  issuer: string;
  purpose: AttestationPurpose;
  audience: string;
  userSubjectHash: string;
  installationId: string;
  installationPublicKeyFingerprint: string;
  issuedAt: string;
  notBefore: string;
  expiresAt: string;
  nonce: string;
  // EXAM_SESSION only — always null for SYSTEM_CHECK.
  examId: string | null;
  submissionId: string | null;
  policyHash: string | null;
};

export function canonicalAttestationChallengeString(challenge: AttestationChallenge): string {
  return canonicalJsonStringify(challenge);
}

export function signAttestationChallenge(challenge: AttestationChallenge, privateKeyPem: string): string {
  return crypto.sign(null, Buffer.from(canonicalAttestationChallengeString(challenge), "utf8"), privateKeyPem).toString("base64");
}

export function verifyAttestationChallengeSignature(challenge: AttestationChallenge, signatureBase64: string, publicKeyPem: string): boolean {
  try {
    return crypto.verify(null, Buffer.from(canonicalAttestationChallengeString(challenge), "utf8"), publicKeyPem, Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}

export type AttestationChallengeValidationContext = {
  expectedPurpose: AttestationPurpose;
  expectedAudience: string;
  expectedUserSubjectHash: string;
  expectedInstallationId: string;
  expectedInstallationPublicKeyFingerprint: string;
  nowMs: number;
};

/** Validates everything checkable WITHOUT a database read beyond the caller's own installation lookup — the caller separately re-confirms installation status (ACTIVE) and nonce replay. */
export function validateAttestationChallengeContext(
  challenge: AttestationChallenge,
  signatureBase64: string,
  publicKeyPem: string,
  context: AttestationChallengeValidationContext,
): ValidationReasonCode {
  if (!verifyAttestationChallengeSignature(challenge, signatureBase64, publicKeyPem)) return "INVALID_SIGNATURE";
  if (challenge.purpose !== context.expectedPurpose) return "WRONG_PURPOSE";
  if (challenge.userSubjectHash !== context.expectedUserSubjectHash) return "WRONG_SUBJECT";
  if (challenge.installationId !== context.expectedInstallationId) return "INVALID_SIGNATURE";
  if (challenge.installationPublicKeyFingerprint !== context.expectedInstallationPublicKeyFingerprint) return "INVALID_SIGNATURE";
  const notBefore = Date.parse(challenge.notBefore);
  const expiresAt = Date.parse(challenge.expiresAt);
  if (Number.isFinite(notBefore) && context.nowMs < notBefore) return "NOT_YET_VALID";
  if (Number.isFinite(expiresAt) && context.nowMs > expiresAt) return "EXPIRED";
  if (challenge.audience !== context.expectedAudience) return "WRONG_AUDIENCE";
  return "VALID";
}

// ---------------------------------------------------------------------------
// Installation-signed attestation payloads — built entirely in the
// Electron main process (apps/lockdown/src/main.ts) from facts it
// gathers itself, never a value the renderer supplies. Explicit,
// purpose-tagged, pipe-delimited fields (no JSON key-ordering ambiguity)
// — the "TETHER_ATTESTATION_V2" + purpose prefix means a SYSTEM_CHECK
// signature can never be reinterpreted as an EXAM_SESSION one, or vice
// versa, even if every other field happened to collide.
// ---------------------------------------------------------------------------

export type SystemCheckAttestationFacts = {
  nonce: string;
  installationPublicKeyFingerprint: string;
  clientVersion: string;
  platform: string;
  displayTopologyClassification: string;
};

export function buildSystemCheckAttestationCanonicalString(f: SystemCheckAttestationFacts): string {
  return ["TETHER_ATTESTATION_V2", "SYSTEM_CHECK", f.nonce, f.installationPublicKeyFingerprint, f.clientVersion, f.platform, f.displayTopologyClassification].join("|");
}

export type ExamSessionAttestationFacts = {
  nonce: string;
  installationPublicKeyFingerprint: string;
  clientVersion: string;
  platform: string;
  displayTopologyClassification: string;
  displayCount: number;
  examId: string;
  submissionId: string;
  policyHash: string;
};

export function buildExamSessionAttestationCanonicalString(f: ExamSessionAttestationFacts): string {
  return [
    "TETHER_ATTESTATION_V2",
    "EXAM_SESSION",
    f.nonce,
    f.installationPublicKeyFingerprint,
    f.clientVersion,
    f.platform,
    f.displayTopologyClassification,
    String(f.displayCount),
    f.examId,
    f.submissionId,
    f.policyHash,
  ].join("|");
}

/** Verifies an installation-signed attestation payload against that installation's registered public key. Never throws — a malformed signature simply verifies false. */
export function verifyInstallationSignature(canonicalString: string, signatureBase64: string, installationPublicKeyPem: string): boolean {
  try {
    return crypto.verify(null, Buffer.from(canonicalString, "utf8"), installationPublicKeyPem, Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}
