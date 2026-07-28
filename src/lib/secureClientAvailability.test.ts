import { describe, it, expect, afterEach, vi } from "vitest";
import {
  deploymentEnvironment,
  secureClientAvailability,
  isMockSecureClientAllowed,
  isSebOptionalAvailable,
  isSebRequiredAllowed,
  isTetherSecureClientBypassAllowed,
} from "./secureClientAvailability";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("deploymentEnvironment", () => {
  it("is production when VERCEL_ENV=production, regardless of NODE_ENV", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("NODE_ENV", "production");
    expect(deploymentEnvironment()).toBe("production");
  });

  it("is preview when VERCEL_ENV=preview even though NODE_ENV is also production (Vercel Preview builds)", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("NODE_ENV", "production");
    expect(deploymentEnvironment()).toBe("preview");
  });

  it("is local-development when VERCEL_ENV is unset and NODE_ENV=development", () => {
    vi.stubEnv("VERCEL_ENV", undefined);
    vi.stubEnv("NODE_ENV", "development");
    expect(deploymentEnvironment()).toBe("local-development");
  });

  it("is unknown when VERCEL_ENV is unset and NODE_ENV is not development", () => {
    vi.stubEnv("VERCEL_ENV", undefined);
    vi.stubEnv("NODE_ENV", "production");
    expect(deploymentEnvironment()).toBe("unknown");
  });

  it("is unknown for a malformed/unexpected VERCEL_ENV value — never falls back to production", () => {
    vi.stubEnv("VERCEL_ENV", "staging");
    vi.stubEnv("NODE_ENV", "production");
    expect(deploymentEnvironment()).toBe("unknown");
  });

  it("is unknown for VERCEL_ENV=development (vercel dev) — distinct from genuine local development", () => {
    vi.stubEnv("VERCEL_ENV", "development");
    vi.stubEnv("NODE_ENV", "development");
    expect(deploymentEnvironment()).toBe("unknown");
  });
});

describe("secureClientAvailability", () => {
  it("TETHER_CLIENT_REQUIRED is available by default in local development", () => {
    vi.stubEnv("VERCEL_ENV", undefined);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("TETHER_CLIENT_REQUIRED_DISABLED", undefined);
    expect(secureClientAvailability().tetherClientRequiredAvailable).toBe(true);
  });

  it("TETHER_CLIENT_REQUIRED is available by default on Preview", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("TETHER_CLIENT_REQUIRED_DISABLED", undefined);
    expect(secureClientAvailability().tetherClientRequiredAvailable).toBe(true);
  });

  it("TETHER_CLIENT_REQUIRED is available by default in Production — Tether Secure Browser is now the normal final-exam delivery path", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("TETHER_CLIENT_REQUIRED_DISABLED", undefined);
    expect(secureClientAvailability().tetherClientRequiredAvailable).toBe(true);
  });

  it("TETHER_CLIENT_REQUIRED is disabled everywhere, including Production, only by the explicit kill-switch", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("TETHER_CLIENT_REQUIRED_DISABLED", "true");
    expect(secureClientAvailability().tetherClientRequiredAvailable).toBe(false);

    vi.stubEnv("VERCEL_ENV", "preview");
    expect(secureClientAvailability().tetherClientRequiredAvailable).toBe(false);

    vi.stubEnv("VERCEL_ENV", undefined);
    vi.stubEnv("NODE_ENV", "development");
    expect(secureClientAvailability().tetherClientRequiredAvailable).toBe(false);
  });

  it("a truthy-looking but non-'true' kill-switch value does not disable it (only the exact string 'true' does)", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("TETHER_CLIENT_REQUIRED_DISABLED", "1");
    expect(secureClientAvailability().tetherClientRequiredAvailable).toBe(true);
  });

  it("TETHER_CLIENT_OPTIONAL is unavailable without the explicit flag", () => {
    vi.stubEnv("VERCEL_ENV", undefined);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("TETHER_CLIENT_OPTIONAL_ENABLED", undefined);
    expect(secureClientAvailability().tetherClientOptionalAvailable).toBe(false);
  });

  it("TETHER_CLIENT_OPTIONAL is unavailable in production even with the flag set", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("TETHER_CLIENT_OPTIONAL_ENABLED", "true");
    expect(secureClientAvailability().tetherClientOptionalAvailable).toBe(false);
  });

  it("TETHER_CLIENT_OPTIONAL is available outside production with the flag set", () => {
    vi.stubEnv("VERCEL_ENV", undefined);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("TETHER_CLIENT_OPTIONAL_ENABLED", "true");
    expect(secureClientAvailability().tetherClientOptionalAvailable).toBe(true);
  });
});

describe("isMockSecureClientAllowed", () => {
  it("is NEVER allowed in Vercel Production, regardless of every other flag", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("TETHER_MOCK_SECURE_CLIENT_ENABLED", "true");
    vi.stubEnv("TETHER_MOCK_CLIENT_ALLOWED_INSTITUTION_SLUGS", "test-institution");
    expect(isMockSecureClientAllowed("test-institution")).toBe(false);
  });

  it("is allowed on Vercel Preview with the flag enabled and the institution allowlisted", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("TETHER_MOCK_SECURE_CLIENT_ENABLED", "true");
    vi.stubEnv("TETHER_MOCK_CLIENT_ALLOWED_INSTITUTION_SLUGS", "test-institution");
    expect(isMockSecureClientAllowed("test-institution")).toBe(true);
  });

  it("is denied on Vercel Preview without the institution allowlist", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("TETHER_MOCK_SECURE_CLIENT_ENABLED", "true");
    vi.stubEnv("TETHER_MOCK_CLIENT_ALLOWED_INSTITUTION_SLUGS", undefined);
    expect(isMockSecureClientAllowed("test-institution")).toBe(false);
  });

  it("is denied on Vercel Preview without the feature flag", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("TETHER_MOCK_SECURE_CLIENT_ENABLED", undefined);
    vi.stubEnv("TETHER_MOCK_CLIENT_ALLOWED_INSTITUTION_SLUGS", "test-institution");
    expect(isMockSecureClientAllowed("test-institution")).toBe(false);
  });

  it("is allowed in local development with the flag enabled and the institution allowlisted", () => {
    vi.stubEnv("VERCEL_ENV", undefined);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("TETHER_MOCK_SECURE_CLIENT_ENABLED", "true");
    vi.stubEnv("TETHER_MOCK_CLIENT_ALLOWED_INSTITUTION_SLUGS", "test-institution");
    expect(isMockSecureClientAllowed("test-institution")).toBe(true);
  });

  it("is denied when the deployment environment is unknown", () => {
    vi.stubEnv("VERCEL_ENV", "staging");
    vi.stubEnv("TETHER_MOCK_SECURE_CLIENT_ENABLED", "true");
    vi.stubEnv("TETHER_MOCK_CLIENT_ALLOWED_INSTITUTION_SLUGS", "test-institution");
    expect(isMockSecureClientAllowed("test-institution")).toBe(false);
  });

  it("is disallowed for an institution not on the allowlist", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("TETHER_MOCK_SECURE_CLIENT_ENABLED", "true");
    vi.stubEnv("TETHER_MOCK_CLIENT_ALLOWED_INSTITUTION_SLUGS", "some-other-institution");
    expect(isMockSecureClientAllowed("test-institution")).toBe(false);
  });

  it("is disallowed for a null institution slug even when the flag is on", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("TETHER_MOCK_SECURE_CLIENT_ENABLED", "true");
    vi.stubEnv("TETHER_MOCK_CLIENT_ALLOWED_INSTITUTION_SLUGS", "test-institution");
    expect(isMockSecureClientAllowed(null)).toBe(false);
  });

  it("is allowed only when all conditions hold: non-production/non-unknown environment, flag enabled, institution allowlisted", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("TETHER_MOCK_SECURE_CLIENT_ENABLED", "true");
    vi.stubEnv("TETHER_MOCK_CLIENT_ALLOWED_INSTITUTION_SLUGS", "test-institution, another-institution");
    expect(isMockSecureClientAllowed("test-institution")).toBe(true);
    expect(isMockSecureClientAllowed("another-institution")).toBe(true);
  });

  it("cannot be enabled by an attacker-supplied slug that mimics a frontend parameter — an arbitrary string not on the server-configured allowlist is still denied", () => {
    // This function never reads a request/query parameter itself — the
    // caller (see mock-launch/route.ts) always resolves institutionSlug
    // from the authenticated session's institution in the database, never
    // from client input. This test demonstrates that even if a caller
    // were to (incorrectly) forward an arbitrary client-supplied string
    // here, the allowlist check alone is still sufficient to deny it.
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("TETHER_MOCK_SECURE_CLIENT_ENABLED", "true");
    vi.stubEnv("TETHER_MOCK_CLIENT_ALLOWED_INSTITUTION_SLUGS", "test-institution");
    expect(isMockSecureClientAllowed("?mockClient=true")).toBe(false);
    expect(isMockSecureClientAllowed("attacker-controlled-value")).toBe(false);
  });
});

describe("isSebOptionalAvailable", () => {
  it("is never available in production regardless of the flag", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("TETHER_SEB_EXPERIMENTAL_ENABLED", "true");
    expect(isSebOptionalAvailable()).toBe(false);
  });

  it("is denied when the deployment environment is unknown", () => {
    vi.stubEnv("VERCEL_ENV", "staging");
    vi.stubEnv("TETHER_SEB_EXPERIMENTAL_ENABLED", "true");
    expect(isSebOptionalAvailable()).toBe(false);
  });

  it("is unavailable on preview without the experimental flag", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("TETHER_SEB_EXPERIMENTAL_ENABLED", undefined);
    expect(isSebOptionalAvailable()).toBe(false);
  });

  it("is available on preview with the experimental flag", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("TETHER_SEB_EXPERIMENTAL_ENABLED", "true");
    expect(isSebOptionalAvailable()).toBe(true);
  });

  it("is available in local development with the experimental flag", () => {
    vi.stubEnv("VERCEL_ENV", undefined);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("TETHER_SEB_EXPERIMENTAL_ENABLED", "true");
    expect(isSebOptionalAvailable()).toBe(true);
  });
});

describe("isSebRequiredAllowed", () => {
  it("an ordinary Production institution can never enable SEB_REQUIRED, even with every flag and allowlist set", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("TETHER_SEB_EXPERIMENTAL_ENABLED", "true");
    vi.stubEnv("TETHER_SEB_REQUIRED_ALLOWED_INSTITUTION_SLUGS", "some-institution");
    expect(isSebRequiredAllowed("some-institution")).toBe(false);
  });

  it("is denied when the deployment environment is unknown", () => {
    vi.stubEnv("VERCEL_ENV", "staging");
    vi.stubEnv("TETHER_SEB_EXPERIMENTAL_ENABLED", "true");
    vi.stubEnv("TETHER_SEB_REQUIRED_ALLOWED_INSTITUTION_SLUGS", "some-institution");
    expect(isSebRequiredAllowed("some-institution")).toBe(false);
  });

  it("is denied on preview without the experimental flag", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("TETHER_SEB_EXPERIMENTAL_ENABLED", undefined);
    vi.stubEnv("TETHER_SEB_REQUIRED_ALLOWED_INSTITUTION_SLUGS", "some-institution");
    expect(isSebRequiredAllowed("some-institution")).toBe(false);
  });

  it("is denied on preview with the flag but without the institution being allowlisted", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("TETHER_SEB_EXPERIMENTAL_ENABLED", "true");
    vi.stubEnv("TETHER_SEB_REQUIRED_ALLOWED_INSTITUTION_SLUGS", undefined);
    expect(isSebRequiredAllowed("some-institution")).toBe(false);
  });

  it("is denied for an institution not on the allowlist", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("TETHER_SEB_EXPERIMENTAL_ENABLED", "true");
    vi.stubEnv("TETHER_SEB_REQUIRED_ALLOWED_INSTITUTION_SLUGS", "authorised-institution");
    expect(isSebRequiredAllowed("some-other-institution")).toBe(false);
  });

  it("is allowed on preview with the flag enabled and the institution allowlisted", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("TETHER_SEB_EXPERIMENTAL_ENABLED", "true");
    vi.stubEnv("TETHER_SEB_REQUIRED_ALLOWED_INSTITUTION_SLUGS", "authorised-institution, another-one");
    expect(isSebRequiredAllowed("authorised-institution")).toBe(true);
  });

  it("is denied for a null institution slug even when the flag is on", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("TETHER_SEB_EXPERIMENTAL_ENABLED", "true");
    vi.stubEnv("TETHER_SEB_REQUIRED_ALLOWED_INSTITUTION_SLUGS", "authorised-institution");
    expect(isSebRequiredAllowed(null)).toBe(false);
  });
});

describe("isTetherSecureClientBypassAllowed", () => {
  it("is NEVER allowed in Vercel Production, regardless of every other flag — Production bypass is always denied", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("TETHER_SECURE_CLIENT_BYPASS_ENABLED", "true");
    vi.stubEnv("TETHER_SECURE_CLIENT_BYPASS_ALLOWED_INSTITUTION_SLUGS", "test-institution");
    expect(isTetherSecureClientBypassAllowed("test-institution")).toBe(false);
  });

  it("is denied when the deployment environment is unknown", () => {
    vi.stubEnv("VERCEL_ENV", "staging");
    vi.stubEnv("TETHER_SECURE_CLIENT_BYPASS_ENABLED", "true");
    vi.stubEnv("TETHER_SECURE_CLIENT_BYPASS_ALLOWED_INSTITUTION_SLUGS", "test-institution");
    expect(isTetherSecureClientBypassAllowed("test-institution")).toBe(false);
  });

  it("is denied on preview without the explicit flag, even with the institution allowlisted", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("TETHER_SECURE_CLIENT_BYPASS_ENABLED", undefined);
    vi.stubEnv("TETHER_SECURE_CLIENT_BYPASS_ALLOWED_INSTITUTION_SLUGS", "test-institution");
    expect(isTetherSecureClientBypassAllowed("test-institution")).toBe(false);
  });

  it("is denied on preview with the flag but without the institution being allowlisted", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("TETHER_SECURE_CLIENT_BYPASS_ENABLED", "true");
    vi.stubEnv("TETHER_SECURE_CLIENT_BYPASS_ALLOWED_INSTITUTION_SLUGS", undefined);
    expect(isTetherSecureClientBypassAllowed("test-institution")).toBe(false);
  });

  it("is denied for an institution not on the allowlist", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("TETHER_SECURE_CLIENT_BYPASS_ENABLED", "true");
    vi.stubEnv("TETHER_SECURE_CLIENT_BYPASS_ALLOWED_INSTITUTION_SLUGS", "authorised-institution");
    expect(isTetherSecureClientBypassAllowed("some-other-institution")).toBe(false);
  });

  it("is allowed on Preview with the flag enabled and the institution allowlisted — the authorised local/Preview development bypass works", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("TETHER_SECURE_CLIENT_BYPASS_ENABLED", "true");
    vi.stubEnv("TETHER_SECURE_CLIENT_BYPASS_ALLOWED_INSTITUTION_SLUGS", "authorised-institution, another-one");
    expect(isTetherSecureClientBypassAllowed("authorised-institution")).toBe(true);
  });

  it("is allowed in genuine local development with the flag enabled and the institution allowlisted", () => {
    vi.stubEnv("VERCEL_ENV", undefined);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("TETHER_SECURE_CLIENT_BYPASS_ENABLED", "true");
    vi.stubEnv("TETHER_SECURE_CLIENT_BYPASS_ALLOWED_INSTITUTION_SLUGS", "test-institution");
    expect(isTetherSecureClientBypassAllowed("test-institution")).toBe(true);
  });

  it("is denied for a null institution slug even when the flag is on", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("TETHER_SECURE_CLIENT_BYPASS_ENABLED", "true");
    vi.stubEnv("TETHER_SECURE_CLIENT_BYPASS_ALLOWED_INSTITUTION_SLUGS", "test-institution");
    expect(isTetherSecureClientBypassAllowed(null)).toBe(false);
  });

  it("cannot be enabled by an attacker-supplied slug — never reads a header/query parameter, only the server-resolved institution slug against the server-configured allowlist", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("TETHER_SECURE_CLIENT_BYPASS_ENABLED", "true");
    vi.stubEnv("TETHER_SECURE_CLIENT_BYPASS_ALLOWED_INSTITUTION_SLUGS", "test-institution");
    expect(isTetherSecureClientBypassAllowed("?bypass=true")).toBe(false);
    expect(isTetherSecureClientBypassAllowed("attacker-controlled-value")).toBe(false);
  });
});
