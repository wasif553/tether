import { describe, it, expect, afterEach, vi } from "vitest";
import { secureClientAvailability, isMockSecureClientAllowed } from "./secureClientAvailability";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("secureClientAvailability", () => {
  it("TETHER_CLIENT_REQUIRED is unconditionally unavailable regardless of any flag", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("TETHER_CLIENT_OPTIONAL_ENABLED", "true");
    expect(secureClientAvailability().tetherClientRequiredAvailable).toBe(false);
  });

  it("TETHER_CLIENT_OPTIONAL is unavailable without the explicit flag", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("TETHER_CLIENT_OPTIONAL_ENABLED", undefined);
    expect(secureClientAvailability().tetherClientOptionalAvailable).toBe(false);
  });

  it("TETHER_CLIENT_OPTIONAL is unavailable in production even with the flag set", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TETHER_CLIENT_OPTIONAL_ENABLED", "true");
    expect(secureClientAvailability().tetherClientOptionalAvailable).toBe(false);
  });

  it("TETHER_CLIENT_OPTIONAL is available outside production with the flag set", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("TETHER_CLIENT_OPTIONAL_ENABLED", "true");
    expect(secureClientAvailability().tetherClientOptionalAvailable).toBe(true);
  });
});

describe("isMockSecureClientAllowed", () => {
  it("is NEVER allowed in production, regardless of every other flag", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TETHER_MOCK_SECURE_CLIENT_ENABLED", "true");
    vi.stubEnv("TETHER_MOCK_CLIENT_ALLOWED_INSTITUTION_SLUGS", "test-institution");
    expect(isMockSecureClientAllowed("test-institution")).toBe(false);
  });

  it("is disallowed outside production without the explicit enable flag", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("TETHER_MOCK_SECURE_CLIENT_ENABLED", undefined);
    vi.stubEnv("TETHER_MOCK_CLIENT_ALLOWED_INSTITUTION_SLUGS", "test-institution");
    expect(isMockSecureClientAllowed("test-institution")).toBe(false);
  });

  it("is disallowed when the flag is set but the allowlist is empty", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("TETHER_MOCK_SECURE_CLIENT_ENABLED", "true");
    vi.stubEnv("TETHER_MOCK_CLIENT_ALLOWED_INSTITUTION_SLUGS", undefined);
    expect(isMockSecureClientAllowed("test-institution")).toBe(false);
  });

  it("is disallowed for an institution not on the allowlist", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("TETHER_MOCK_SECURE_CLIENT_ENABLED", "true");
    vi.stubEnv("TETHER_MOCK_CLIENT_ALLOWED_INSTITUTION_SLUGS", "some-other-institution");
    expect(isMockSecureClientAllowed("test-institution")).toBe(false);
  });

  it("is disallowed for a null institution slug even when the flag is on", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("TETHER_MOCK_SECURE_CLIENT_ENABLED", "true");
    vi.stubEnv("TETHER_MOCK_CLIENT_ALLOWED_INSTITUTION_SLUGS", "test-institution");
    expect(isMockSecureClientAllowed(null)).toBe(false);
  });

  it("is allowed only when all three conditions hold: non-production, flag enabled, institution allowlisted", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("TETHER_MOCK_SECURE_CLIENT_ENABLED", "true");
    vi.stubEnv("TETHER_MOCK_CLIENT_ALLOWED_INSTITUTION_SLUGS", "test-institution, another-institution");
    expect(isMockSecureClientAllowed("test-institution")).toBe(true);
    expect(isMockSecureClientAllowed("another-institution")).toBe(true);
  });
});
