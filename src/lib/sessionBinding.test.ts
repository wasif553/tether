/**
 * Exam Session Binding v1 — crypto/classification helper tests. See
 * docs/exam-session-binding-v1.md and src/lib/sessionBinding.ts.
 */
import { describe, expect, it } from "vitest";
import {
  hmacHash,
  generateRandomToken,
  deriveIpPrefix,
  classifyUserAgent,
  bucketScreenSize,
  normalizeAcceptLanguage,
  computeCoarseFingerprintHash,
  normalizeCameraPermissionState,
  isValidExamAttemptSessionStatus,
} from "./sessionBinding";

describe("hmacHash / generateRandomToken", () => {
  it("produces a deterministic hash for the same input", () => {
    expect(hmacHash("abc")).toBe(hmacHash("abc"));
  });

  it("produces a different hash for different inputs", () => {
    expect(hmacHash("abc")).not.toBe(hmacHash("abd"));
  });

  it("never returns the raw input as the hash", () => {
    expect(hmacHash("192.168.1.1")).not.toContain("192.168.1.1");
  });

  it("generates unpredictable, non-empty tokens", () => {
    const a = generateRandomToken();
    const b = generateRandomToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(20);
  });
});

describe("deriveIpPrefix", () => {
  it("derives a /24 prefix hash for IPv4 and never returns the raw IP", () => {
    const result = deriveIpPrefix("203.0.113.42");
    expect(result?.version).toBe("v4");
    expect(result?.prefixHash).toBeDefined();
    expect(JSON.stringify(result)).not.toContain("203.0.113.42");
  });

  it("two IPs in the same /24 produce the same prefix hash", () => {
    const a = deriveIpPrefix("203.0.113.5");
    const b = deriveIpPrefix("203.0.113.250");
    expect(a?.prefixHash).toBe(b?.prefixHash);
  });

  it("two IPs in different /24s produce different prefix hashes", () => {
    const a = deriveIpPrefix("203.0.113.5");
    const b = deriveIpPrefix("203.0.114.5");
    expect(a?.prefixHash).not.toBe(b?.prefixHash);
  });

  it("derives a /48 prefix hash for IPv6", () => {
    const result = deriveIpPrefix("2001:db8:1234:5678::1");
    expect(result?.version).toBe("v6");
    expect(JSON.stringify(result)).not.toContain("2001:db8:1234:5678::1");
  });

  it("returns null for unparseable input", () => {
    expect(deriveIpPrefix("not-an-ip")).toBeNull();
    expect(deriveIpPrefix(null)).toBeNull();
  });
});

describe("classifyUserAgent", () => {
  it("classifies a common desktop Chrome UA and hashes it without exposing the raw string", () => {
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36";
    const result = classifyUserAgent(ua);
    expect(result.browserFamily).toBe("Chrome");
    expect(result.operatingSystemFamily).toBe("Windows");
    expect(result.deviceCategory).toBe("desktop");
    expect(result.userAgentHash).toBeDefined();
    expect(JSON.stringify(result)).not.toContain(ua);
  });

  it("returns nulls for an absent user agent", () => {
    const result = classifyUserAgent(null);
    expect(result.browserFamily).toBeNull();
    expect(result.userAgentHash).toBeNull();
  });
});

describe("bucketScreenSize", () => {
  it("buckets widths into small/medium/large, never exact pixels", () => {
    expect(bucketScreenSize(800)).toBe("small");
    expect(bucketScreenSize(1366)).toBe("medium");
    expect(bucketScreenSize(2560)).toBe("large");
    expect(bucketScreenSize(null)).toBe("unknown");
  });
});

describe("normalizeAcceptLanguage", () => {
  it("extracts only the primary language subtag", () => {
    expect(normalizeAcceptLanguage("en-US,en;q=0.9,fr;q=0.8")).toBe("en");
    expect(normalizeAcceptLanguage(null)).toBeNull();
  });
});

describe("computeCoarseFingerprintHash", () => {
  it("is stable for identical low-entropy input and changes when an input differs", () => {
    const base = {
      browserFamily: "Chrome",
      operatingSystemFamily: "Windows",
      deviceCategory: "desktop",
      acceptLanguagePrimary: "en",
      timezone: "Australia/Brisbane",
      screenBucket: "medium" as const,
    };
    expect(computeCoarseFingerprintHash(base)).toBe(computeCoarseFingerprintHash({ ...base }));
    expect(computeCoarseFingerprintHash(base)).not.toBe(computeCoarseFingerprintHash({ ...base, timezone: "UTC" }));
  });
});

describe("normalizeCameraPermissionState", () => {
  it("passes through known states", () => {
    expect(normalizeCameraPermissionState("granted")).toBe("granted");
  });
  it("treats an unsupported/unknown value as unknown, not a violation", () => {
    expect(normalizeCameraPermissionState(undefined)).toBe("unknown");
    expect(normalizeCameraPermissionState("something-unexpected")).toBe("unknown");
  });
});

describe("isValidExamAttemptSessionStatus", () => {
  it("accepts the four documented statuses", () => {
    expect(isValidExamAttemptSessionStatus("ACTIVE")).toBe(true);
    expect(isValidExamAttemptSessionStatus("STALE")).toBe(true);
    expect(isValidExamAttemptSessionStatus("ENDED")).toBe(true);
    expect(isValidExamAttemptSessionStatus("REPLACED")).toBe(true);
    expect(isValidExamAttemptSessionStatus("BOGUS")).toBe(false);
  });
});
