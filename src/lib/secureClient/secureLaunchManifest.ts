/**
 * Tether Secure Client Foundation v1 — signed secure-launch manifest. See
 * docs/secure-client-foundation-seb-v1.md and Part 6/14 of the spec.
 *
 * Server-only (uses Node's `crypto` for Ed25519 signing/verification and
 * SHA-256 hashing), otherwise dependency-free — no Prisma, no Next.js.
 * Short-lived, single-use, asymmetrically signed. The raw nonce is
 * returned to the caller exactly once (embedded in the signed manifest
 * response) and NEVER stored — only `hashNonce(nonce)` is persisted (see
 * SecureClientLaunchManifest.nonceHash in prisma/schema.prisma). No
 * student email, name, or other direct PII appears anywhere in the
 * manifest — only `studentSubjectHash`, a hash of the already-opaque
 * database id.
 */
import crypto from "crypto";

export const SECURE_LAUNCH_MANIFEST_SCHEMA_VERSION = 1;
export const SECURE_LAUNCH_MANIFEST_ISSUER = "tether-secure-client";

export type SecureLaunchManifest = {
  schemaVersion: number;
  manifestId: string;
  keyId: string;
  issuer: string;
  audience: string;
  institutionId: string;
  examId: string;
  submissionId: string;
  studentSubjectHash: string;
  configurationId: string | null;
  clientType: string;
  policyHash: string;
  canonicalExamOrigin: string;
  launchPath: string;
  issuedAt: string;
  notBefore: string;
  expiresAt: string;
  nonce: string;
  minimumClientVersion: string | null;
  allowedPlatform: string[];
  heartbeatIntervalSeconds: number;
  heartbeatGraceSeconds: number;
  requiredChecks: string[];
  permittedCapabilities: string[];
};

/** Deterministically stringifies a JSON-compatible value with object keys sorted recursively — array order is preserved (it can be meaningful). The exact canonical form that gets signed and later re-verified. */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function canonicalManifestString(manifest: SecureLaunchManifest): string {
  return canonicalJsonStringify(manifest);
}

/** SHA-256 hex digest of the canonical manifest — a compact fingerprint distinct from the signature itself, useful for logging/comparison without re-serialising. */
export function computeManifestHash(manifest: SecureLaunchManifest): string {
  return crypto.createHash("sha256").update(canonicalManifestString(manifest), "utf8").digest("hex");
}

/** SHA-256 hex digest of a canonicalised policy snapshot — binds a manifest to the EXACT immutable policy in effect when it was issued. */
export function computePolicyHash(policy: unknown): string {
  return crypto.createHash("sha256").update(canonicalJsonStringify(policy), "utf8").digest("hex");
}

/** SHA-256 hex digest of an already-opaque database id — belt-and-suspenders against embedding a directly-identifying value in a signed, client-visible manifest. */
export function computeStudentSubjectHash(studentId: string): string {
  return crypto.createHash("sha256").update(`secure-client-subject:${studentId}`, "utf8").digest("hex");
}

/** Cryptographically random, URL-safe nonce — generated once per launch, returned once, never itself persisted. */
export function generateLaunchNonce(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** SHA-256 hex digest of the raw nonce — the ONLY nonce representation ever stored (Part 6/14). */
export function hashNonce(rawNonce: string): string {
  return crypto.createHash("sha256").update(rawNonce, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Signing / verification — Ed25519. Private key lives only in
// TETHER_SECURE_CLIENT_SIGNING_PRIVATE_KEY (server env, never committed).
// ---------------------------------------------------------------------------

/** Signs the canonical manifest string with an Ed25519 private key (PEM). Returns a base64-encoded signature. */
export function signManifest(manifest: SecureLaunchManifest, privateKeyPem: string): string {
  const data = Buffer.from(canonicalManifestString(manifest), "utf8");
  const signature = crypto.sign(null, data, privateKeyPem);
  return signature.toString("base64");
}

/** Verifies a manifest's signature against an Ed25519 public key (PEM). Never throws — a malformed signature/key simply verifies false. */
export function verifyManifestSignature(manifest: SecureLaunchManifest, signatureBase64: string, publicKeyPem: string): boolean {
  try {
    const data = Buffer.from(canonicalManifestString(manifest), "utf8");
    const signature = Buffer.from(signatureBase64, "base64");
    return crypto.verify(null, data, publicKeyPem, signature);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Context validation (Part 6/14) — stateless checks only; consumed-nonce
// and revoked-manifest checks require a database read and live in
// src/lib/secureClient/secureClientRunner.ts.
// ---------------------------------------------------------------------------

export const MANIFEST_VALIDATION_REASON_CODES = [
  "VALID",
  "EXPIRED",
  "NOT_YET_VALID",
  "WRONG_AUDIENCE",
  "WRONG_ORIGIN",
  "POLICY_HASH_MISMATCH",
  "INVALID_SIGNATURE",
] as const;
export type ManifestValidationReasonCode = (typeof MANIFEST_VALIDATION_REASON_CODES)[number];

export type ManifestValidationContext = {
  expectedAudience: string;
  expectedOrigin: string;
  expectedPolicyHash: string;
  nowMs: number;
};

/**
 * Validates everything about a manifest that can be checked WITHOUT a
 * database read: signature, expiry, not-before, audience, origin, and
 * policy-hash binding. Returns the first failing check — callers combine
 * this with their own consumed/revoked lookups.
 */
export function validateManifestContext(
  manifest: SecureLaunchManifest,
  signatureBase64: string,
  publicKeyPem: string,
  context: ManifestValidationContext,
): ManifestValidationReasonCode {
  if (!verifyManifestSignature(manifest, signatureBase64, publicKeyPem)) return "INVALID_SIGNATURE";
  const issuedNotBefore = Date.parse(manifest.notBefore);
  const issuedExpiresAt = Date.parse(manifest.expiresAt);
  if (Number.isFinite(issuedNotBefore) && context.nowMs < issuedNotBefore) return "NOT_YET_VALID";
  if (Number.isFinite(issuedExpiresAt) && context.nowMs > issuedExpiresAt) return "EXPIRED";
  if (manifest.audience !== context.expectedAudience) return "WRONG_AUDIENCE";
  if (manifest.canonicalExamOrigin !== context.expectedOrigin) return "WRONG_ORIGIN";
  if (manifest.policyHash !== context.expectedPolicyHash) return "POLICY_HASH_MISMATCH";
  return "VALID";
}
