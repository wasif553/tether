import { describe, it, expect, afterEach, vi } from "vitest";
import {
  ATTESTATION_PROTOCOL_VERSION,
  resolveExamAttestationMode,
  parseAttestationRequirement,
  resolveEffectiveTetherVerification,
  resolveMaxActiveInstallationsPerUser,
} from "./tetherAttestationConfig";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ATTESTATION_PROTOCOL_VERSION", () => {
  it("is 2", () => {
    expect(ATTESTATION_PROTOCOL_VERSION).toBe(2);
  });
});

describe("resolveExamAttestationMode", () => {
  it("defaults to LEGACY when unset — never accidentally locks out every existing student", () => {
    vi.stubEnv("TETHER_EXAM_ATTESTATION_MODE", "");
    expect(resolveExamAttestationMode()).toBe("LEGACY");
  });

  it("defaults to LEGACY on any unrecognised value (typo-safe)", () => {
    vi.stubEnv("TETHER_EXAM_ATTESTATION_MODE", "STRICT");
    expect(resolveExamAttestationMode()).toBe("LEGACY");
  });

  it("only the exact string DUAL selects DUAL", () => {
    vi.stubEnv("TETHER_EXAM_ATTESTATION_MODE", "DUAL");
    expect(resolveExamAttestationMode()).toBe("DUAL");
  });

  it("only the exact string V2_REQUIRED selects V2_REQUIRED", () => {
    vi.stubEnv("TETHER_EXAM_ATTESTATION_MODE", "V2_REQUIRED");
    expect(resolveExamAttestationMode()).toBe("V2_REQUIRED");
  });

  it("is case-sensitive — lowercase 'dual' is not accepted, falls back to LEGACY", () => {
    vi.stubEnv("TETHER_EXAM_ATTESTATION_MODE", "dual");
    expect(resolveExamAttestationMode()).toBe("LEGACY");
  });
});

describe("parseAttestationRequirement — session snapshot parsing", () => {
  it("null (session created before this column existed) is LEGACY", () => {
    expect(parseAttestationRequirement(null)).toBe("LEGACY");
  });
  it("unrecognised/malformed stored value is LEGACY, never re-derived from environment", () => {
    expect(parseAttestationRequirement("garbage")).toBe("LEGACY");
    expect(parseAttestationRequirement("")).toBe("LEGACY");
  });
  it("DUAL and V2_REQUIRED round-trip exactly", () => {
    expect(parseAttestationRequirement("DUAL")).toBe("DUAL");
    expect(parseAttestationRequirement("V2_REQUIRED")).toBe("V2_REQUIRED");
  });
});

describe("resolveMaxActiveInstallationsPerUser", () => {
  it("defaults to 2", () => {
    vi.stubEnv("TETHER_MAX_ACTIVE_INSTALLATIONS_PER_USER", "");
    expect(resolveMaxActiveInstallationsPerUser()).toBe(2);
  });
  it("clamps to [1, 5]", () => {
    vi.stubEnv("TETHER_MAX_ACTIVE_INSTALLATIONS_PER_USER", "0");
    expect(resolveMaxActiveInstallationsPerUser()).toBe(1);
    vi.stubEnv("TETHER_MAX_ACTIVE_INSTALLATIONS_PER_USER", "99");
    expect(resolveMaxActiveInstallationsPerUser()).toBe(5);
  });
});

describe("resolveEffectiveTetherVerification — session-snapshot truth table (no client-version input of any kind)", () => {
  it("LEGACY requirement: only legacyVerified matters, v2Verified is ignored entirely", () => {
    expect(resolveEffectiveTetherVerification({ sessionRequirement: "LEGACY", legacyVerified: true, v2Verified: false })).toBe(true);
    expect(resolveEffectiveTetherVerification({ sessionRequirement: "LEGACY", legacyVerified: false, v2Verified: true })).toBe(false);
  });

  it("DUAL requirement: BOTH legacy and v2 must be verified — unconditionally, no grandfathering by any version", () => {
    expect(resolveEffectiveTetherVerification({ sessionRequirement: "DUAL", legacyVerified: true, v2Verified: true })).toBe(true);
    expect(resolveEffectiveTetherVerification({ sessionRequirement: "DUAL", legacyVerified: true, v2Verified: false })).toBe(false);
    expect(resolveEffectiveTetherVerification({ sessionRequirement: "DUAL", legacyVerified: false, v2Verified: true })).toBe(false);
  });

  it("V2_REQUIRED requirement: only v2Verified matters, legacyVerified is ignored entirely", () => {
    expect(resolveEffectiveTetherVerification({ sessionRequirement: "V2_REQUIRED", legacyVerified: false, v2Verified: true })).toBe(true);
    expect(resolveEffectiveTetherVerification({ sessionRequirement: "V2_REQUIRED", legacyVerified: true, v2Verified: false })).toBe(false);
  });

  it("the function's own input type has no client-version field at all — a TypeScript-level guarantee, not just a runtime one", () => {
    // @ts-expect-error — legacyClientVersion no longer exists on EffectiveTetherVerificationInput.
    resolveEffectiveTetherVerification({ sessionRequirement: "DUAL", legacyVerified: true, v2Verified: true, legacyClientVersion: "1.0.0" });
  });
});
