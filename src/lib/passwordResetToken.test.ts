/**
 * Password Reset v1 — pure token-shape unit tests (no DB). See
 * docs/password-reset-v1.md.
 */
import { describe, it, expect } from "vitest";
import {
  generatePasswordResetToken,
  hashPasswordResetToken,
  verifyPasswordResetToken,
  buildPasswordResetUrl,
  PASSWORD_RESET_TOKEN_BYTES,
  PASSWORD_RESET_TOKEN_TTL_MS,
} from "./passwordResetToken";

describe("password reset token — shape and entropy", () => {
  it("generates a base64url token with at least 256 bits of entropy", () => {
    expect(PASSWORD_RESET_TOKEN_BYTES * 8).toBeGreaterThanOrEqual(256);
    const token = generatePasswordResetToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    // base64url-decoding back should yield exactly PASSWORD_RESET_TOKEN_BYTES bytes.
    expect(Buffer.from(token, "base64url").length).toBe(PASSWORD_RESET_TOKEN_BYTES);
  });

  it("generates a different token on every call", () => {
    const a = generatePasswordResetToken();
    const b = generatePasswordResetToken();
    expect(a).not.toBe(b);
  });

  it("hashes with SHA-256 (32-byte / 64 hex-char digest)", () => {
    const hash = hashPasswordResetToken("some-token-value");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hash is deterministic for the same input", () => {
    const token = generatePasswordResetToken();
    expect(hashPasswordResetToken(token)).toBe(hashPasswordResetToken(token));
  });

  it("verifyPasswordResetToken accepts the correct token against its own hash", () => {
    const token = generatePasswordResetToken();
    expect(verifyPasswordResetToken(token, hashPasswordResetToken(token))).toBe(true);
  });

  it("verifyPasswordResetToken rejects a wrong token", () => {
    const token = generatePasswordResetToken();
    const other = generatePasswordResetToken();
    expect(verifyPasswordResetToken(other, hashPasswordResetToken(token))).toBe(false);
  });

  it("TTL is exactly 30 minutes", () => {
    expect(PASSWORD_RESET_TOKEN_TTL_MS).toBe(30 * 60 * 1000);
  });

  it("buildPasswordResetUrl embeds the plaintext token as a query param on /reset-password", () => {
    const url = buildPasswordResetUrl("https://app.example.com", "abc123_-XYZ");
    expect(url).toBe("https://app.example.com/reset-password?token=abc123_-XYZ");
  });
});
