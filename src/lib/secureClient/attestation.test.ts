import { describe, it, expect } from "vitest";
import {
  overallStatusFromChecks,
  checksSupportedByClientType,
  normaliseChecksForClientType,
  isValidProhibitedProcessEvidence,
  SEB_UNSUPPORTED_CHECKS,
  ATTESTATION_CHECK_KEYS,
  type OverallStatusInput,
} from "./attestation";

function baseInput(overrides: Partial<OverallStatusInput> = {}): OverallStatusInput {
  return {
    checks: {},
    required: {},
    clientVerificationFailed: false,
    configurationInvalid: false,
    versionUnsupported: false,
    technicalFailure: false,
    ...overrides,
  };
}

describe("overallStatusFromChecks", () => {
  it("READY when every required, supported check passes", () => {
    const result = overallStatusFromChecks(baseInput({ required: { displayCheck: true }, checks: { displayCheck: "PASS" } }));
    expect(result).toBe("READY");
  });

  it("READY when nothing is required at all", () => {
    expect(overallStatusFromChecks(baseInput())).toBe("READY");
  });

  it("ACTION_REQUIRED when a required check fails", () => {
    const result = overallStatusFromChecks(baseInput({ required: { displayCheck: true }, checks: { displayCheck: "FAIL" } }));
    expect(result).toBe("ACTION_REQUIRED");
  });

  it("ACTION_REQUIRED when a required check warns", () => {
    const result = overallStatusFromChecks(baseInput({ required: { remoteSession: true }, checks: { remoteSession: "WARNING" } }));
    expect(result).toBe("ACTION_REQUIRED");
  });

  it("an unrequired check's failure never affects the overall status", () => {
    const result = overallStatusFromChecks(baseInput({ required: { displayCheck: true }, checks: { displayCheck: "PASS", processCheck: "FAIL" } }));
    expect(result).toBe("READY");
  });

  it("CANNOT_START when a required check is NOT_SUPPORTED by this client", () => {
    const result = overallStatusFromChecks(baseInput({ required: { virtualMachine: true }, checks: { virtualMachine: "NOT_SUPPORTED" } }));
    expect(result).toBe("CANNOT_START");
  });

  it("CANNOT_START when client verification failed, regardless of checks", () => {
    const result = overallStatusFromChecks(baseInput({ clientVerificationFailed: true, required: { displayCheck: true }, checks: { displayCheck: "PASS" } }));
    expect(result).toBe("CANNOT_START");
  });

  it("CANNOT_START when configuration is invalid", () => {
    expect(overallStatusFromChecks(baseInput({ configurationInvalid: true }))).toBe("CANNOT_START");
  });

  it("CANNOT_START when the client version is unsupported", () => {
    expect(overallStatusFromChecks(baseInput({ versionUnsupported: true }))).toBe("CANNOT_START");
  });

  it("TECHNICAL_FAILURE takes priority over everything else — never represented as misconduct", () => {
    const result = overallStatusFromChecks(baseInput({ technicalFailure: true, clientVerificationFailed: true, configurationInvalid: true }));
    expect(result).toBe("TECHNICAL_FAILURE");
  });
});

describe("checksSupportedByClientType / normaliseChecksForClientType", () => {
  it("SEB does not support remoteSession/virtualMachine/processCheck/captureProtection", () => {
    const supported = checksSupportedByClientType("SAFE_EXAM_BROWSER");
    for (const key of SEB_UNSUPPORTED_CHECKS) {
      expect(supported.has(key)).toBe(false);
    }
    expect(supported.has("displayCheck")).toBe(true);
  });

  it("a future Tether client supports every defined check", () => {
    const supported = checksSupportedByClientType("TETHER_SECURE_CLIENT");
    expect(supported.size).toBe(ATTESTATION_CHECK_KEYS.length);
  });

  it("the mock client also supports every check (contract parity with the future real client)", () => {
    const supported = checksSupportedByClientType("MOCK_TETHER_CLIENT");
    expect(supported.size).toBe(ATTESTATION_CHECK_KEYS.length);
  });

  it("normaliseChecksForClientType forces unsupported checks to NOT_SUPPORTED even if the client claimed otherwise", () => {
    const claimed = { virtualMachine: "PASS" as const, displayCheck: "PASS" as const };
    const normalised = normaliseChecksForClientType(claimed, "SAFE_EXAM_BROWSER");
    expect(normalised.virtualMachine).toBe("NOT_SUPPORTED");
    expect(normalised.displayCheck).toBe("PASS");
  });
});

describe("isValidProhibitedProcessEvidence", () => {
  it("accepts a well-formed, minimal evidence object", () => {
    expect(
      isValidProhibitedProcessEvidence({
        ruleId: "rule-1",
        category: "remote-access",
        normalisedApplicationId: "some-app",
        detectedAt: new Date().toISOString(),
      }),
    ).toBe(true);
  });

  it("rejects a payload with an extra, unlisted key — strict allowlist only", () => {
    expect(
      isValidProhibitedProcessEvidence({
        ruleId: "rule-1",
        category: "remote-access",
        normalisedApplicationId: "some-app",
        detectedAt: new Date().toISOString(),
        commandLine: "should never be here",
      }),
    ).toBe(false);
  });

  it("rejects an invalid detectedAt timestamp", () => {
    expect(
      isValidProhibitedProcessEvidence({ ruleId: "r", category: "c", normalisedApplicationId: "a", detectedAt: "not-a-date" }),
    ).toBe(false);
  });

  it("rejects non-object input without throwing", () => {
    expect(isValidProhibitedProcessEvidence(null)).toBe(false);
    expect(isValidProhibitedProcessEvidence("a string")).toBe(false);
    expect(isValidProhibitedProcessEvidence(42)).toBe(false);
  });
});
