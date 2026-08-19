/**
 * Password Reset v1 — see docs/password-reset-v1.md.
 *
 * Same cryptographic shape as src/lib/courseInvitationToken.ts and
 * src/lib/standaloneInvite.ts (256-bit random token, SHA-256 hash,
 * timing-safe comparison), and the same reasoning for using SHA-256
 * instead of bcrypt: bcrypt's slow cost factor defends against
 * brute-forcing a low-entropy, human-chosen secret, and adds nothing for
 * an already-unguessable 256-bit server-generated token. A deliberately
 * separate module rather than a shared/generalized one, matching this
 * codebase's established convention of keeping each feature's token
 * semantics independent even when the shape happens to coincide.
 */
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

export const PASSWORD_RESET_TOKEN_BYTES = 32;

/** Fixed expiry per the product spec — no configurable duration in v1. */
export const PASSWORD_RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

/** Minimum interval between newly-issued reset emails for the same account. */
export const PASSWORD_RESET_REQUEST_COOLDOWN_MS = 60 * 1000;

export function generatePasswordResetToken(): string {
  return randomBytes(PASSWORD_RESET_TOKEN_BYTES).toString("base64url");
}

export function hashPasswordResetToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function verifyPasswordResetToken(token: string, hash: string): boolean {
  const candidate = Buffer.from(hashPasswordResetToken(token), "hex");
  const stored = Buffer.from(hash, "hex");
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}

export function buildPasswordResetUrl(origin: string, token: string): string {
  return `${origin}/reset-password?token=${encodeURIComponent(token)}`;
}
