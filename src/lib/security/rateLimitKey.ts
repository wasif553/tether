/**
 * Auth and Token Abuse Protection v1 — see
 * docs/auth-token-abuse-protection-v1.md.
 *
 * Derives a dedicated HMAC-SHA256 key from AUTH_SECRET via HKDF, with a
 * context label independent of every other HKDF-derived key in this
 * codebase (e.g. src/lib/lti/identityLinkHandoff.ts's handoff-signing
 * key) — a leak of one derived key never exposes another, and neither
 * ever exposes AUTH_SECRET itself. Same HKDF convention as that module.
 *
 * HMAC (not plain SHA-256) is deliberate: a rate-limit identifier is
 * built from a PREDICTABLE input (an email address, an IP address, an
 * invitation id) — unlike a high-entropy server-generated token, a plain
 * hash of a predictable value is invertible via a rainbow table/dictionary
 * attack. Keying the hash with a secret the attacker doesn't have makes
 * every derived identifier opaque even though its input space is small.
 *
 * AUTH_SECRET rotation is acceptable and expected to reset every rate-
 * limit bucket's effective identity (a bucket's keyHash changes, so a
 * post-rotation request simply starts a fresh window under a new key) —
 * this is a deliberate, documented tradeoff: rate-limit state resetting
 * on a genuine secret rotation is far preferable to either persisting
 * plaintext identifiers or requiring a second, separately-rotated secret
 * just for this.
 */
import { createHmac, hkdfSync } from "node:crypto";

const RATE_LIMIT_HKDF_CONTEXT = "tether-security-rate-limit-v1";

function deriveRateLimitHmacKey(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error("Missing required environment variable: AUTH_SECRET");
  }
  return Buffer.from(hkdfSync("sha256", secret, "", RATE_LIMIT_HKDF_CONTEXT, 32));
}

/**
 * Opaque, deterministic digest of a scope-qualified rate-limit identifier.
 * Never logged, never the sole limiter key without the caller having
 * already folded `scope` into `rawIdentifier` (see rateLimiter.ts) —
 * this function itself performs no scope-handling; callers are
 * responsible for building an unambiguous input string.
 */
export function hashRateLimitIdentifier(rawIdentifier: string): string {
  return createHmac("sha256", deriveRateLimitHmacKey()).update(rawIdentifier, "utf8").digest("hex");
}
