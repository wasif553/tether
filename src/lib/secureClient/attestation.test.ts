import { describe, it, expect } from "vitest";
import {
  overallStatusFromChecks,
  checksSupportedByClientType,
  normaliseChecksForClientType,
  isValidProhibitedProcessEvidence,
  isValidReportedDisplayCount,
  isValidDisplayTopology,
  MAX_REPORTED_DISPLAY_COUNT,
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
  it("SEB does not support displayCheck/remoteSession/virtualMachine/processCheck/captureProtection", () => {
    const supported = checksSupportedByClientType("SAFE_EXAM_BROWSER");
    for (const key of SEB_UNSUPPORTED_CHECKS) {
      expect(supported.has(key)).toBe(false);
    }
    // Single Display Requirement v1 — the official SEB JavaScript API
    // (window.SafeExamBrowser) exposes only version/security.updateKeys(),
    // nothing about connected displays, so displayCheck can never be a
    // trustworthy SEB-reported attestation value — see SEB_UNSUPPORTED_CHECKS'
    // own doc comment in attestation.ts for the full citation trail. The
    // display restriction itself is still enforced for SEB, just
    // out-of-band via the generated .seb configuration, not through this
    // attestation channel.
    expect(supported.has("displayCheck")).toBe(false);
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
    const claimed = { virtualMachine: "PASS" as const, displayCheck: "PASS" as const, clientSignature: "PASS" as const };
    const normalised = normaliseChecksForClientType(claimed, "SAFE_EXAM_BROWSER");
    expect(normalised.virtualMachine).toBe("NOT_SUPPORTED");
    // A SEB session claiming "PASS" for displayCheck is never trusted —
    // there is no real channel for SEB to report this (see
    // SEB_UNSUPPORTED_CHECKS) — force-corrected the same as virtualMachine.
    expect(normalised.displayCheck).toBe("NOT_SUPPORTED");
    expect(normalised.clientSignature).toBe("PASS");
  });

  it("a future Tether client's displayCheck claim is honoured, never force-corrected", () => {
    const claimed = { displayCheck: "PASS" as const };
    const normalised = normaliseChecksForClientType(claimed, "TETHER_SECURE_CLIENT");
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

// ---------------------------------------------------------------------------
// Single Display Requirement v1 (Part 6) — bounded, optional fields for a
// future trusted native client. See docs/secure-client-foundation-seb-v1.md.
// ---------------------------------------------------------------------------

describe("isValidReportedDisplayCount", () => {
  it("accepts integers within [1, MAX_REPORTED_DISPLAY_COUNT]", () => {
    expect(isValidReportedDisplayCount(1)).toBe(true);
    expect(isValidReportedDisplayCount(MAX_REPORTED_DISPLAY_COUNT)).toBe(true);
  });

  it("rejects zero, negative, non-integer, out-of-bounds, and non-number values", () => {
    expect(isValidReportedDisplayCount(0)).toBe(false);
    expect(isValidReportedDisplayCount(-1)).toBe(false);
    expect(isValidReportedDisplayCount(1.5)).toBe(false);
    expect(isValidReportedDisplayCount(MAX_REPORTED_DISPLAY_COUNT + 1)).toBe(false);
    expect(isValidReportedDisplayCount("2")).toBe(false);
    expect(isValidReportedDisplayCount(null)).toBe(false);
    expect(isValidReportedDisplayCount(undefined)).toBe(false);
  });
});

describe("isValidDisplayTopology", () => {
  it("accepts only the five documented topology values", () => {
    for (const value of ["SINGLE", "CLONE", "EXTEND", "EXTERNAL_ONLY", "UNKNOWN"]) {
      expect(isValidDisplayTopology(value)).toBe(true);
    }
  });

  it("rejects an arbitrary/unrecognised string", () => {
    expect(isValidDisplayTopology("MIRRORED")).toBe(false);
    expect(isValidDisplayTopology("")).toBe(false);
  });
});
