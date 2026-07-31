/**
 * Tether System Check and Exam Readiness v1 — security hardening pass.
 * See docs/tether-system-check-v1.md, "Genuine client attestation".
 *
 * Server-side counterpart to apps/lockdown/src/clientAttestationKey.ts.
 * A signed SYSTEM_CHECK challenge alone only proves the SERVER's own
 * signature round-tripped intact — never that the responder is a
 * genuine packaged Tether Secure Browser instance, since any browser
 * can echo a challenge back with self-reported facts. This module
 * verifies a SECOND, independent signature — produced by the embedded
 * client-attestation PRIVATE key that only exists inside the compiled
 * Electron main process (never sent to, or reachable from, any
 * renderer or ordinary browser) — over a canonical string binding the
 * challenge nonce together with the natively-gathered facts. Only the
 * corresponding PUBLIC key is ever configured here
 * (TETHER_CLIENT_ATTESTATION_PUBLIC_KEY), exactly mirroring how
 * TETHER_SECURE_CLIENT_SIGNING_PUBLIC_KEY already works for the
 * server's own signing key.
 *
 * Pure verification logic — no Prisma, no Next.js. The one place that
 * reads process.env for this key is `clientAttestationPublicKey()`
 * below.
 */
import crypto from "crypto";

/**
 * MUST exactly match buildSystemCheckAttestationCanonicalString in
 * apps/lockdown/src/main.ts — kept as two small, independently
 * reviewable copies (apps/lockdown is a separate compiled package) with
 * an explicit cross-reference comment in both places, rather than a
 * cross-package import.
 */
export function buildSystemCheckAttestationCanonicalString(params: {
  nonce: string;
  clientVersion: string;
  platform: string;
  displayTopologyClassification: string;
}): string {
  return ["SYSTEM_CHECK_ATTESTATION_V1", params.nonce, params.clientVersion, params.platform, params.displayTopologyClassification].join("|");
}

export class ClientAttestationKeyNotConfiguredError extends Error {
  constructor() {
    super("TETHER_CLIENT_ATTESTATION_PUBLIC_KEY is not configured.");
    this.name = "ClientAttestationKeyNotConfiguredError";
  }
}

/** Throws if unset — a missing key must never silently accept every client-attestation signature as valid (fail closed, not fail open). */
export function clientAttestationPublicKey(): string {
  const key = process.env.TETHER_CLIENT_ATTESTATION_PUBLIC_KEY;
  if (!key) throw new ClientAttestationKeyNotConfiguredError();
  return key;
}

export type ClientAttestationFacts = {
  nonce: string;
  clientVersion: string;
  platform: string;
  displayTopologyClassification: string;
  signature: string;
};

/**
 * Verifies that `signature` was produced by the embedded client-
 * attestation private key over the EXACT canonical string reconstructed
 * from `nonce`/`clientVersion`/`platform`/`displayTopologyClassification`.
 * If ANY of those facts were tampered with after main.ts signed them,
 * the reconstructed string differs and verification fails — this is
 * what makes the facts themselves trustworthy, not just the nonce.
 * Never throws on a malformed signature — returns false.
 */
export function verifyClientAttestation(facts: ClientAttestationFacts, publicKeyPem: string): boolean {
  try {
    const canonicalString = buildSystemCheckAttestationCanonicalString(facts);
    const signatureBuffer = Buffer.from(facts.signature, "base64");
    return crypto.verify(null, Buffer.from(canonicalString, "utf8"), publicKeyPem, signatureBuffer);
  } catch {
    return false;
  }
}
