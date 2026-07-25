import { describe, it, expect } from "vitest";
import crypto from "crypto";
import {
  isWellFormedSha256Hex,
  computeExpectedRequestHash,
  computeKeyLookupHash,
  timingSafeHexEqual,
  buildCanonicalRequestUrl,
  validateSebRequestHash,
} from "./sebBrowserExamKey";

describe("isWellFormedSha256Hex", () => {
  it("accepts a 64-char lowercase hex string", () => {
    expect(isWellFormedSha256Hex("a".repeat(64))).toBe(true);
  });
  it("accepts uppercase hex too", () => {
    expect(isWellFormedSha256Hex("A".repeat(64))).toBe(true);
  });
  it("rejects wrong length, non-hex, and non-string values", () => {
    expect(isWellFormedSha256Hex("a".repeat(63))).toBe(false);
    expect(isWellFormedSha256Hex("z".repeat(64))).toBe(false);
    expect(isWellFormedSha256Hex(12345)).toBe(false);
    expect(isWellFormedSha256Hex(null)).toBe(false);
    expect(isWellFormedSha256Hex(undefined)).toBe(false);
  });
});

describe("computeExpectedRequestHash", () => {
  it("matches the official SEB formula SHA256(url + key)", () => {
    const url = "https://example.test/exam/123";
    const key = "raw-key-value";
    const expected = crypto.createHash("sha256").update(url + key, "utf8").digest("hex");
    expect(computeExpectedRequestHash(url, key)).toBe(expected);
  });

  it("is sensitive to both the url and the key", () => {
    const h1 = computeExpectedRequestHash("https://a.test/x", "key");
    const h2 = computeExpectedRequestHash("https://b.test/x", "key");
    const h3 = computeExpectedRequestHash("https://a.test/x", "other-key");
    expect(h1).not.toBe(h2);
    expect(h1).not.toBe(h3);
  });
});

describe("computeKeyLookupHash", () => {
  it("is deterministic and trims whitespace", () => {
    expect(computeKeyLookupHash("mykey")).toBe(computeKeyLookupHash("mykey"));
    expect(computeKeyLookupHash("mykey")).toBe(computeKeyLookupHash(" mykey \n"));
  });
});

describe("timingSafeHexEqual", () => {
  it("returns true for equal hex digests, case-insensitively", () => {
    const hex = "ab".repeat(32);
    expect(timingSafeHexEqual(hex, hex.toUpperCase())).toBe(true);
  });
  it("returns false for different digests", () => {
    expect(timingSafeHexEqual("a".repeat(64), "b".repeat(64))).toBe(false);
  });
  it("returns false (never throws) for malformed input", () => {
    expect(timingSafeHexEqual("not-hex", "a".repeat(64))).toBe(false);
    expect(timingSafeHexEqual(null, undefined)).toBe(false);
    expect(timingSafeHexEqual(123, "a".repeat(64))).toBe(false);
  });
});

describe("buildCanonicalRequestUrl", () => {
  it("joins origin + pathname + search, stripping a trailing slash on origin", () => {
    expect(buildCanonicalRequestUrl("https://example.test/", "/exam/1", "?a=1")).toBe("https://example.test/exam/1?a=1");
  });
  it("normalises a pathname missing its leading slash", () => {
    expect(buildCanonicalRequestUrl("https://example.test", "exam/1", "")).toBe("https://example.test/exam/1");
  });
});

describe("validateSebRequestHash", () => {
  const url = "https://example.test/exam/1";
  const key1 = "key-one";
  const key2 = "key-two";

  it("returns VALID when the supplied hash matches one of several allowed keys", () => {
    const suppliedHash = computeExpectedRequestHash(url, key2);
    const result = validateSebRequestHash(suppliedHash, url, [key1, key2]);
    expect(result.status).toBe("VALID");
  });

  it("returns NO_MATCH when the hash matches none of the allowed keys", () => {
    const suppliedHash = computeExpectedRequestHash(url, "wrong-key");
    const result = validateSebRequestHash(suppliedHash, url, [key1, key2]);
    expect(result.status).toBe("NO_MATCH");
  });

  it("returns MALFORMED_HASH for a non-SHA-256-shaped supplied value", () => {
    const result = validateSebRequestHash("not-a-hash", url, [key1]);
    expect(result.status).toBe("MALFORMED_HASH");
  });

  it("returns NO_ALLOWED_KEYS when there are no configured keys at all", () => {
    const suppliedHash = computeExpectedRequestHash(url, key1);
    const result = validateSebRequestHash(suppliedHash, url, []);
    expect(result.status).toBe("NO_ALLOWED_KEYS");
  });

  it("checks every key rather than short-circuiting on the first mismatch", () => {
    const suppliedHash = computeExpectedRequestHash(url, "third-key");
    const result = validateSebRequestHash(suppliedHash, url, [key1, key2, "third-key"]);
    expect(result.status).toBe("VALID");
  });
});
