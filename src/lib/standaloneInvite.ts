/**
 * Standalone Exam Link v1 — see docs/standalone-exam-link-v1.md.
 *
 * Pure token generation/hashing helpers, no Prisma. The plaintext token
 * is never stored — only its hash — and never returned to the lecturer
 * more than once, at generation/regeneration time.
 *
 * Deliberately NOT bcrypt, unlike accessCode/password hashing elsewhere
 * in this app: bcrypt's slow cost factor exists specifically to
 * compensate for LOW-entropy secrets a human might choose (a password,
 * a short access code) against brute-force guessing — it provides no
 * extra security for an already-unguessable 256-bit, server-generated
 * token, and would only add unnecessary latency and reintroduce
 * bcrypt's 72-byte input-truncation footgun (base64url of 32 random
 * bytes is ~43 chars today, but a future token-length change could
 * silently exceed it). A fast, constant-time-compared SHA-256 digest is
 * the standard, correctly-scoped approach for high-entropy API-
 * key/token storage.
 */
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

/** 32 random bytes = 256 bits of entropy. */
export const STANDALONE_INVITE_TOKEN_BYTES = 32;

/** URL-safe (base64url — no +, /, or = padding), high-entropy, server-generated only. Never derived from anything caller-controlled. */
export function generateStandaloneInviteToken(): string {
  return randomBytes(STANDALONE_INVITE_TOKEN_BYTES).toString("base64url");
}

/** Deterministic, one-way. Only the hex digest is ever persisted (Exam.standaloneInviteTokenHash). */
export function hashStandaloneInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time comparison — never a plain `===` on the digest, to avoid a timing side-channel on token verification. */
export function verifyStandaloneInviteToken(token: string, hash: string): boolean {
  const candidate = Buffer.from(hashStandaloneInviteToken(token), "hex");
  const stored = Buffer.from(hash, "hex");
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}

/**
 * The invitation URL shape — a dedicated path segment, not a query
 * string. This lets the callback-URL safety allowlist
 * (src/lib/safeCallbackUrl.ts) stay a pure path-based regex, consistent
 * with every other safe-redirect target in this app, rather than
 * teaching that security-critical validator to parse query strings.
 */
export function buildStandaloneInviteUrl(examId: string, token: string): string {
  return `/student/exams/join/${examId}/invite/${token}`;
}
