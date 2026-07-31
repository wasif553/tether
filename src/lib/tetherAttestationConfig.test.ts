import { describe, it, expect, afterEach, vi } from "vitest";
import { ATTESTATION_PROTOCOL_VERSION, isLegacyAttestationAllowed, isV2ExamSessionRequiredForNewFinalExams } from "./tetherAttestationConfig";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ATTESTATION_PROTOCOL_VERSION", () => {
  it("is 2", () => {
    expect(ATTESTATION_PROTOCOL_VERSION).toBe(2);
  });
});

describe("24. legacy compatibility setting behaves exactly as documented", () => {
  it("defaults to true (legacy accepted) when unset — never accidentally locks out every existing student", () => {
    vi.stubEnv("TETHER_LEGACY_ATTESTATION_ALLOWED", "");
    expect(isLegacyAttestationAllowed()).toBe(true);
  });

  it("only 'false' (exact string) disables legacy acceptance", () => {
    vi.stubEnv("TETHER_LEGACY_ATTESTATION_ALLOWED", "false");
    expect(isLegacyAttestationAllowed()).toBe(false);
  });

  it("any other value (typo-safe) still defaults to allowed", () => {
    vi.stubEnv("TETHER_LEGACY_ATTESTATION_ALLOWED", "nope");
    expect(isLegacyAttestationAllowed()).toBe(true);
  });
});

describe("isV2ExamSessionRequiredForNewFinalExams", () => {
  it("defaults to false — v2-only Production enforcement is never enabled by a missing config value", () => {
    vi.stubEnv("TETHER_REQUIRE_EXAM_SESSION_V2", "");
    expect(isV2ExamSessionRequiredForNewFinalExams()).toBe(false);
  });

  it("only the exact string 'true' enables it", () => {
    vi.stubEnv("TETHER_REQUIRE_EXAM_SESSION_V2", "true");
    expect(isV2ExamSessionRequiredForNewFinalExams()).toBe(true);
  });
});
