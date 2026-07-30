/**
 * Tether System Check and Exam Readiness v1 — corrective pass (first-time
 * verification). See docs/tether-system-check-v1.md, "System-check
 * secure-client verification".
 *
 * Server-only (Ed25519 sign/verify via Node's `crypto`), otherwise
 * dependency-free — no Prisma, no Next.js. Mirrors
 * src/lib/secureClient/secureLaunchManifest.ts exactly (same signing
 * key, same nonce/hash/canonicalisation primitives — reused directly,
 * not reimplemented) but scoped to a SYSTEM_CHECK challenge rather than
 * an exam launch: no examId/submissionId/policyHash/launchPath exist on
 * this type at all, which is itself part of why a SYSTEM_CHECK challenge
 * can never be mistaken for, or coerced into, an exam launch manifest —
 * the two types are structurally incompatible, not just conventionally
 * different.
 *
 * The raw nonce is returned to the caller exactly once (embedded in the
 * signed challenge response) and never itself persisted — only
 * `hashNonce(nonce)` is stored (see
 * SystemCheckSecureClientVerification.nonceHash in prisma/schema.prisma),
 * exactly like the exam-launch manifest. No user email, name, or other
 * direct PII appears anywhere in the challenge — only `userSubjectHash`.
 */
import crypto from "crypto";
import { canonicalJsonStringify, generateLaunchNonce, hashNonce } from "./secureLaunchManifest";

export { generateLaunchNonce as generateSystemCheckNonce, hashNonce };

export const SYSTEM_CHECK_CHALLENGE_SCHEMA_VERSION = 1;
export const SYSTEM_CHECK_CHALLENGE_ISSUER = "tether-secure-client";
export const SYSTEM_CHECK_CHALLENGE_PURPOSE = "SYSTEM_CHECK" as const;

export type SystemCheckChallenge = {
  schemaVersion: number;
  challengeId: string;
  keyId: string;
  issuer: string;
  purpose: "SYSTEM_CHECK";
  audience: string;
  userSubjectHash: string;
  issuedAt: string;
  notBefore: string;
  expiresAt: string;
  nonce: string;
};

export function canonicalChallengeString(challenge: SystemCheckChallenge): string {
  return canonicalJsonStringify(challenge);
}

/** SHA-256 hex digest of the canonical challenge — a compact fingerprint distinct from the signature itself. */
export function computeChallengeHash(challenge: SystemCheckChallenge): string {
  return crypto.createHash("sha256").update(canonicalChallengeString(challenge), "utf8").digest("hex");
}

/** SHA-256 hex digest of an already-opaque user id — never a directly-identifying value in a signed, client-visible challenge. */
export function computeUserSubjectHash(userId: string): string {
  return crypto.createHash("sha256").update(`system-check-subject:${userId}`, "utf8").digest("hex");
}

/** Signs the canonical challenge string with an Ed25519 private key (PEM) — the exact same key used for exam launch manifests (see getSigningPrivateKey in secureClientRunner.ts). */
export function signChallenge(challenge: SystemCheckChallenge, privateKeyPem: string): string {
  const data = Buffer.from(canonicalChallengeString(challenge), "utf8");
  return crypto.sign(null, data, privateKeyPem).toString("base64");
}

/** Verifies a challenge's signature against an Ed25519 public key (PEM). Never throws — a malformed signature/key simply verifies false. */
export function verifyChallengeSignature(challenge: SystemCheckChallenge, signatureBase64: string, publicKeyPem: string): boolean {
  try {
    const data = Buffer.from(canonicalChallengeString(challenge), "utf8");
    const signature = Buffer.from(signatureBase64, "base64");
    return crypto.verify(null, data, publicKeyPem, signature);
  } catch {
    return false;
  }
}

export const CHALLENGE_VALIDATION_REASON_CODES = [
  "VALID",
  "EXPIRED",
  "NOT_YET_VALID",
  "WRONG_AUDIENCE",
  "WRONG_PURPOSE",
  "WRONG_SUBJECT",
  "INVALID_SIGNATURE",
] as const;
export type ChallengeValidationReasonCode = (typeof CHALLENGE_VALIDATION_REASON_CODES)[number];

export type ChallengeValidationContext = {
  expectedAudience: string;
  expectedUserSubjectHash: string;
  nowMs: number;
};

/**
 * Validates everything about a challenge that can be checked WITHOUT a
 * database read: signature, purpose, subject binding, expiry, not-before,
 * and audience. Returns the first failing check — the caller combines
 * this with its own nonce-replay check (a DB unique-constraint insert —
 * see systemCheckSecureClientRunner.ts), exactly mirroring how
 * validateManifestContext/consumeLaunchManifest split responsibilities
 * for the real exam-launch flow.
 */
export function validateChallengeContext(
  challenge: SystemCheckChallenge,
  signatureBase64: string,
  publicKeyPem: string,
  context: ChallengeValidationContext,
): ChallengeValidationReasonCode {
  if (!verifyChallengeSignature(challenge, signatureBase64, publicKeyPem)) return "INVALID_SIGNATURE";
  if (challenge.purpose !== SYSTEM_CHECK_CHALLENGE_PURPOSE) return "WRONG_PURPOSE";
  if (challenge.userSubjectHash !== context.expectedUserSubjectHash) return "WRONG_SUBJECT";
  const notBefore = Date.parse(challenge.notBefore);
  const expiresAt = Date.parse(challenge.expiresAt);
  if (Number.isFinite(notBefore) && context.nowMs < notBefore) return "NOT_YET_VALID";
  if (Number.isFinite(expiresAt) && context.nowMs > expiresAt) return "EXPIRED";
  if (challenge.audience !== context.expectedAudience) return "WRONG_AUDIENCE";
  return "VALID";
}
