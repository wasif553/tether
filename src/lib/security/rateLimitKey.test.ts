/**
 * Auth and Token Abuse Protection v1 — key-derivation unit tests (pure,
 * no DB). See docs/auth-token-abuse-protection-v1.md.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { hashRateLimitIdentifier } from "./rateLimitKey";

describe("hashRateLimitIdentifier", () => {
  it("is deterministic for the same input", () => {
    expect(hashRateLimitIdentifier("scope:some-identifier")).toBe(
      hashRateLimitIdentifier("scope:some-identifier"),
    );
  });

  it("produces different digests for different scope-qualified inputs", () => {
    const a = hashRateLimitIdentifier("auth.login.source_account:203.0.113.5|student@test.invalid");
    const b = hashRateLimitIdentifier("auth.login.source_failures:203.0.113.5|student@test.invalid");
    expect(a).not.toBe(b);
  });

  it("is a 64-char hex digest (SHA-256 output size)", () => {
    expect(hashRateLimitIdentifier("anything")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is NOT a plain, unkeyed SHA-256 of the raw identifier (opacity requirement)", () => {
    const raw = "auth.login.source_account:203.0.113.5|student@test.invalid";
    const plainSha256 = createHash("sha256").update(raw, "utf8").digest("hex");
    expect(hashRateLimitIdentifier(raw)).not.toBe(plainSha256);
  });

  it("throws a clear error when AUTH_SECRET is missing", () => {
    const original = process.env.AUTH_SECRET;
    delete process.env.AUTH_SECRET;
    try {
      expect(() => hashRateLimitIdentifier("anything")).toThrow(/AUTH_SECRET/);
    } finally {
      if (original !== undefined) process.env.AUTH_SECRET = original;
    }
  });
});
