import { describe, it, expect, afterEach, vi } from "vitest";
import {
  ATTESTATION_PROTOCOL_VERSION,
  resolveExamAttestationMode,
  isClientV2Capable,
  resolveEffectiveTetherVerification,
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

describe("isClientV2Capable", () => {
  it("null/missing version is never capable", () => {
    expect(isClientV2Capable(null)).toBe(false);
  });
  it("a pre-1.5.0 client is not capable", () => {
    expect(isClientV2Capable("1.4.0")).toBe(false);
    expect(isClientV2Capable("1.3.0")).toBe(false);
  });
  it("1.5.0 and newer are capable", () => {
    expect(isClientV2Capable("1.5.0")).toBe(true);
    expect(isClientV2Capable("1.6.0")).toBe(true);
    expect(isClientV2Capable("2.0.0")).toBe(true);
  });
});

describe("resolveEffectiveTetherVerification — mode truth table", () => {
  it("LEGACY mode: only legacyVerified matters, v2Verified is ignored entirely", () => {
    expect(resolveEffectiveTetherVerification({ mode: "LEGACY", legacyVerified: true, v2Verified: false, legacyClientVersion: "1.6.0" })).toBe(true);
    expect(resolveEffectiveTetherVerification({ mode: "LEGACY", legacyVerified: false, v2Verified: true, legacyClientVersion: "1.6.0" })).toBe(false);
  });

  it("DUAL mode + v2-capable client: BOTH legacy and v2 must be verified", () => {
    expect(resolveEffectiveTetherVerification({ mode: "DUAL", legacyVerified: true, v2Verified: true, legacyClientVersion: "1.5.0" })).toBe(true);
    expect(resolveEffectiveTetherVerification({ mode: "DUAL", legacyVerified: true, v2Verified: false, legacyClientVersion: "1.5.0" })).toBe(false);
    expect(resolveEffectiveTetherVerification({ mode: "DUAL", legacyVerified: false, v2Verified: true, legacyClientVersion: "1.5.0" })).toBe(false);
  });

  it("DUAL mode + pre-1.5.0 (v2-incapable) client: grandfathered on legacy alone", () => {
    expect(resolveEffectiveTetherVerification({ mode: "DUAL", legacyVerified: true, v2Verified: false, legacyClientVersion: "1.3.0" })).toBe(true);
    expect(resolveEffectiveTetherVerification({ mode: "DUAL", legacyVerified: true, v2Verified: false, legacyClientVersion: null })).toBe(true);
  });

  it("V2_REQUIRED mode: only v2Verified matters, legacyVerified is ignored entirely", () => {
    expect(resolveEffectiveTetherVerification({ mode: "V2_REQUIRED", legacyVerified: false, v2Verified: true, legacyClientVersion: null })).toBe(true);
    expect(resolveEffectiveTetherVerification({ mode: "V2_REQUIRED", legacyVerified: true, v2Verified: false, legacyClientVersion: "1.6.0" })).toBe(false);
  });
});
