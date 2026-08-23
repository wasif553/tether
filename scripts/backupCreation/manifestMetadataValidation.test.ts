/**
 * Production Database Backup Creation v1 — see
 * docs/database-backup-operations-v1.md.
 *
 * Unit tests over the pure manifest-metadata validators only — no
 * database, no Docker, no subprocess.
 */
import { describe, expect, it } from "vitest";
import { validateEnvironmentLabel, isProductionLabel, validateSourceProjectRef } from "./manifestMetadataValidation";

describe("validateEnvironmentLabel", () => {
  it("accepts a plain label", () => {
    expect(validateEnvironmentLabel("local-test")).toEqual({ ok: true, value: "local-test" });
  });

  it("trims whitespace", () => {
    expect(validateEnvironmentLabel("  staging  ")).toEqual({ ok: true, value: "staging" });
  });

  it("lowercases the value", () => {
    expect(validateEnvironmentLabel("Staging")).toEqual({ ok: true, value: "staging" });
  });

  it("normalises every casing/whitespace variant of 'production' to the canonical 'production'", () => {
    for (const variant of ["production", "Production", "PRODUCTION", " production ", "production "]) {
      expect(validateEnvironmentLabel(variant)).toEqual({ ok: true, value: "production" });
    }
  });

  it("rejects null (missing)", () => {
    expect(validateEnvironmentLabel(null).ok).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(validateEnvironmentLabel("").ok).toBe(false);
  });

  it("rejects a whitespace-only string", () => {
    expect(validateEnvironmentLabel("   ").ok).toBe(false);
  });

  it("rejects a value containing a URL scheme", () => {
    expect(validateEnvironmentLabel("postgres://user:pass@host/db").ok).toBe(false);
    expect(validateEnvironmentLabel("https://example.com").ok).toBe(false);
  });

  it("rejects a value containing '@'", () => {
    expect(validateEnvironmentLabel("user@host").ok).toBe(false);
  });

  it("rejects a value containing whitespace in the middle", () => {
    expect(validateEnvironmentLabel("prod uction").ok).toBe(false);
  });

  it("rejects a value containing a control character", () => {
    expect(validateEnvironmentLabel("prod\x00uction").ok).toBe(false);
  });

  it("rejects an oversized value", () => {
    expect(validateEnvironmentLabel("a".repeat(65)).ok).toBe(false);
  });

  it("accepts a value at the length boundary", () => {
    expect(validateEnvironmentLabel("a".repeat(64)).ok).toBe(true);
  });
});

describe("isProductionLabel", () => {
  it("is true only for the exact canonical form", () => {
    expect(isProductionLabel("production")).toBe(true);
  });

  it("is false for anything else, including un-normalised variants (this function assumes normalisation already happened)", () => {
    expect(isProductionLabel("Production")).toBe(false);
    expect(isProductionLabel("local-test")).toBe(false);
  });
});

describe("validateSourceProjectRef", () => {
  it("treats null (not supplied) as valid, with value null", () => {
    expect(validateSourceProjectRef(null)).toEqual({ ok: true, value: null });
  });

  it("accepts a plain alphanumeric token", () => {
    expect(validateSourceProjectRef("abcdefghijklmnop")).toEqual({ ok: true, value: "abcdefghijklmnop" });
  });

  it("trims and lowercases the value", () => {
    expect(validateSourceProjectRef("  ABCDEF123  ")).toEqual({ ok: true, value: "abcdef123" });
  });

  it("rejects an empty/whitespace-only supplied value", () => {
    expect(validateSourceProjectRef("").ok).toBe(false);
    expect(validateSourceProjectRef("   ").ok).toBe(false);
  });

  it("rejects a full postgres:// connection string", () => {
    expect(validateSourceProjectRef("postgres://user:password@host:5432/db").ok).toBe(false);
  });

  it("rejects a full postgresql:// connection string", () => {
    expect(validateSourceProjectRef("postgresql://user:password@host:5432/db").ok).toBe(false);
  });

  it("rejects a https:// URL", () => {
    expect(validateSourceProjectRef("https://example.com/abc").ok).toBe(false);
  });

  it("rejects a value containing '@'", () => {
    expect(validateSourceProjectRef("user@host").ok).toBe(false);
  });

  it("rejects a value containing whitespace", () => {
    expect(validateSourceProjectRef("abc 123").ok).toBe(false);
  });

  it("rejects a value containing a forward slash", () => {
    expect(validateSourceProjectRef("abc/123").ok).toBe(false);
  });

  it("rejects a value containing a backslash", () => {
    expect(validateSourceProjectRef("abc\\123").ok).toBe(false);
  });

  it("rejects a value containing a query string marker", () => {
    expect(validateSourceProjectRef("abc?foo=bar").ok).toBe(false);
  });

  it("rejects a value containing a control character", () => {
    expect(validateSourceProjectRef("abc\x00123").ok).toBe(false);
  });

  it("rejects an oversized value", () => {
    expect(validateSourceProjectRef("a".repeat(65)).ok).toBe(false);
  });

  it("accepts a value at the length boundary", () => {
    expect(validateSourceProjectRef("a".repeat(64)).ok).toBe(true);
  });
});
