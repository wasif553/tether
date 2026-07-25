/**
 * Tether Secure Client Foundation v1 — Safe Exam Browser Browser Exam Key
 * / Config Key request-hash validation. See
 * docs/secure-client-foundation-seb-v1.md ("Browser Exam Key
 * validation") and Part 5/14 of the spec.
 *
 * Server-only (uses Node's `crypto`), but otherwise dependency-free — no
 * Prisma, no Next.js — mirrors src/lib/sessionBinding.ts's "the one place
 * raw secret material is ever touched before being reduced to a hash or
 * comparison result" pattern. Implements the official SEB request-hash
 * formula: expectedHash = SHA256(requestUrl + key), hex-encoded,
 * lowercase. Uses the externally-visible CANONICAL URL — never an
 * untrusted raw Host header — and a timing-safe comparison throughout.
 * Never logs a received or configured key, and never reveals to a caller
 * WHICH of several allowed keys matched.
 */
import { createHash, timingSafeEqual } from "crypto";

export const SEB_REQUEST_HASH_HEADER = "x-safeexambrowser-requesthash";
export const SEB_CONFIG_KEY_HASH_HEADER = "x-safeexambrowser-configkeyhash";

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i;

/** True only for a syntactically well-formed SHA-256 hex digest (64 hex characters) — never throws on malformed input. */
export function isWellFormedSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX_PATTERN.test(value.trim());
}

function normaliseHex(value: string): string {
  return value.trim().toLowerCase();
}

/** SHA256(canonicalUrl + key), hex-encoded lowercase — the official SEB per-request hash formula. */
export function computeExpectedRequestHash(canonicalUrl: string, key: string): string {
  return createHash("sha256").update(canonicalUrl + key, "utf8").digest("hex");
}

/** SHA-256 of the raw key alone — used only for storage-side fingerprinting/lookup, never for request-hash comparison. */
export function computeKeyLookupHash(rawKey: string): string {
  return createHash("sha256").update(rawKey.trim(), "utf8").digest("hex");
}

/** Timing-safe comparison of two SHA-256 hex digests. Returns false (never throws) for any malformed input. */
export function timingSafeHexEqual(a: unknown, b: unknown): boolean {
  if (!isWellFormedSha256Hex(a) || !isWellFormedSha256Hex(b)) return false;
  const bufA = Buffer.from(normaliseHex(a), "hex");
  const bufB = Buffer.from(normaliseHex(b), "hex");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Canonical URL — never trust a raw Host/X-Forwarded-Host header directly;
// only an explicitly allowlisted canonical origin. See
// src/lib/secureClient/canonicalOrigin.ts for the allowlist check itself;
// this module only assembles the final string once an origin has already
// been validated by the caller.
// ---------------------------------------------------------------------------

/** Builds the canonical absolute URL used for the hash formula — origin + pathname + search (query string), excluding any fragment (fragments are never sent to a server). */
export function buildCanonicalRequestUrl(canonicalOrigin: string, pathname: string, search: string): string {
  const trimmedOrigin = canonicalOrigin.replace(/\/+$/, "");
  const normalisedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${trimmedOrigin}${normalisedPath}${search ?? ""}`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type KeyValidationResult =
  | { status: "VALID" }
  | { status: "MALFORMED_HASH" }
  | { status: "NO_MATCH" }
  | { status: "NO_ALLOWED_KEYS" };

/**
 * Validates a supplied request hash against every currently-allowed raw
 * key value (already decrypted by the caller — see sebKeyEncryption.ts).
 * Never reveals which specific key matched — the caller only learns
 * VALID or a failure reason, matching "do not return which specific key
 * matched to the student" (Part 5).
 */
export function validateSebRequestHash(suppliedHash: unknown, canonicalUrl: string, allowedRawKeys: string[]): KeyValidationResult {
  if (!isWellFormedSha256Hex(suppliedHash)) return { status: "MALFORMED_HASH" };
  if (allowedRawKeys.length === 0) return { status: "NO_ALLOWED_KEYS" };
  let matched = false;
  for (const key of allowedRawKeys) {
    const expected = computeExpectedRequestHash(canonicalUrl, key);
    // Every key is checked (never short-circuited early on the FIRST
    // candidate's outcome) so overall timing does not vary with WHICH
    // position a matching key happens to be in the allowed list.
    if (timingSafeHexEqual(suppliedHash, expected)) matched = true;
  }
  return matched ? { status: "VALID" } : { status: "NO_MATCH" };
}
