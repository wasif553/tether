import { describe, it, expect } from "vitest";
import {
  buildTetherDeepLink,
  buildLegacySesDeepLink,
  shouldShowInstallerFallback,
  resolveTetherLaunchFailureMessage,
  DEFAULT_INSTALLER_FALLBACK_THRESHOLD_MS,
  isSecureClientSessionVerified,
  classifyDisplayBridgeAvailability,
  buildDisplayInvokeFailedDiagnostic,
  boundedDiagnosticString,
} from "./tetherLaunch";
import { isValidReportedDisplayCount } from "./secureClient/attestation";

describe("buildTetherDeepLink", () => {
  it("builds a tether:// link carrying only the examId", () => {
    expect(buildTetherDeepLink("exam-123")).toBe("tether://launch?examId=exam-123");
  });

  it("URL-encodes the examId defensively", () => {
    expect(buildTetherDeepLink("exam 123&x=1")).toBe("tether://launch?examId=exam%20123%26x%3D1");
  });

  it("never embeds a token, nonce, signature, or credential — only examId is ever present in the link", () => {
    const link = buildTetherDeepLink("exam-123");
    expect(link).not.toMatch(/nonce|signature|token|manifest|password|secret/i);
  });
});

describe("buildLegacySesDeepLink", () => {
  it("preserves ses:// compatibility for existing pilot installations", () => {
    expect(buildLegacySesDeepLink("exam-123")).toBe("ses://launch?examId=exam-123");
  });
});

describe("shouldShowInstallerFallback", () => {
  it("does not show the fallback before the threshold", () => {
    expect(shouldShowInstallerFallback(1000, 3000)).toBe(false);
  });

  it("shows the fallback once the threshold is reached", () => {
    expect(shouldShowInstallerFallback(3000, 3000)).toBe(true);
    expect(shouldShowInstallerFallback(5000, 3000)).toBe(true);
  });

  it("uses a sensible default threshold when none is supplied", () => {
    expect(shouldShowInstallerFallback(DEFAULT_INSTALLER_FALLBACK_THRESHOLD_MS)).toBe(true);
    expect(shouldShowInstallerFallback(DEFAULT_INSTALLER_FALLBACK_THRESHOLD_MS - 1)).toBe(false);
  });
});

describe("resolveTetherLaunchFailureMessage", () => {
  it("gives a distinct, neutral, non-accusatory message for every known failure code", () => {
    const codes = ["REPLAY", "EXPIRED", "REVOKED", "NOT_FOUND", "INVALID_SIGNATURE", "INVALID_NONCE", "TRANSIENT_FAILURE"];
    for (const code of codes) {
      const message = resolveTetherLaunchFailureMessage(code);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toMatch(/cheat|fraud|violation|misconduct/i);
    }
  });

  it("falls back to a generic retry message for an unrecognised code", () => {
    expect(resolveTetherLaunchFailureMessage("SOMETHING_UNKNOWN")).toMatch(/went wrong/i);
  });

  // URGENT fix — secure-client launch consume transaction latency.
  it("TRANSIENT_FAILURE (a server-side transaction failure) uses the exact controlled student-facing message, never mentioning reinstalling Tether", () => {
    const message = resolveTetherLaunchFailureMessage("TRANSIENT_FAILURE");
    expect(message).toBe("Your secure exam could not be opened. Please try again. If the problem continues, contact support.");
    expect(message).not.toMatch(/reinstall|install tether|check tether/i);
  });
});

// P0 secure-launch redirect loop hotfix — see
// docs/tether-secure-launch-loop-hotfix.md. This is THE authoritative
// gate the fix added: tether-launch/page.tsx must never navigate into
// exam content unless this returns true. Covers the exact conditions
// that produced the physically-observed infinite loop (attestation
// submitted but not VERIFIED) and proves the gate fails closed on every
// malformed/absent-data shape.
describe("isSecureClientSessionVerified — the authoritative post-attestation navigation gate", () => {
  it("[3, 4] returns false when the session's verificationStatus is anything other than VERIFIED — the exact case that caused the P0 redirect loop (attestation submitted, overall status not READY)", () => {
    expect(isSecureClientSessionVerified({ session: { verificationStatus: "NOT_CHECKED" } })).toBe(false);
    expect(isSecureClientSessionVerified({ session: { verificationStatus: "UNVERIFIED_CLIENT" } })).toBe(false);
    expect(isSecureClientSessionVerified({ session: { verificationStatus: "INVALID_CONFIGURATION" } })).toBe(false);
    expect(isSecureClientSessionVerified({ session: { verificationStatus: "TECHNICAL_FAILURE" } })).toBe(false);
  });

  it("[9] returns true only for the exact string VERIFIED", () => {
    expect(isSecureClientSessionVerified({ session: { verificationStatus: "VERIFIED" } })).toBe(true);
  });

  it("[2] fails closed when there is no current session at all (e.g. the manifest-consume/attestation request itself failed outright)", () => {
    expect(isSecureClientSessionVerified({ session: null })).toBe(false);
  });

  it("fails closed for malformed/absent response shapes — never throws", () => {
    expect(isSecureClientSessionVerified(null)).toBe(false);
    expect(isSecureClientSessionVerified(undefined)).toBe(false);
    expect(isSecureClientSessionVerified({})).toBe(false);
    expect(isSecureClientSessionVerified({ session: {} })).toBe(false);
  });

  it("never treats a case-different or substring match as verified (e.g. 'verified' lowercase, or a status merely containing the word)", () => {
    expect(isSecureClientSessionVerified({ session: { verificationStatus: "verified" } })).toBe(false);
    expect(isSecureClientSessionVerified({ session: { verificationStatus: "NOT_VERIFIED" } })).toBe(false);
  });
});

// P0 runtime display-bridge failure capture — see
// docs/tether-secure-launch-verification-investigation.md. Distinguishes
// the 5 conclusive outcomes: [1] SES_LOCKDOWN_UNAVAILABLE, [2]
// DISPLAY_COUNT_METHOD_UNAVAILABLE, [3] DISPLAY_COUNT_INVOKE_FAILED, [4]
// DISPLAY_COUNT_INVALID_RESULT (via the shared isValidReportedDisplayCount
// validator), [5]/[6] DISPLAY_COUNT_OK.
describe("classifyDisplayBridgeAvailability", () => {
  it("[1] returns SES_LOCKDOWN_UNAVAILABLE when window.sesLockdown itself is missing", () => {
    expect(classifyDisplayBridgeAvailability(undefined)).toBe("SES_LOCKDOWN_UNAVAILABLE");
    expect(classifyDisplayBridgeAvailability(null)).toBe("SES_LOCKDOWN_UNAVAILABLE");
  });

  it("[1] never confuses a non-object sesLockdown (e.g. a stray primitive) with a real bridge", () => {
    expect(classifyDisplayBridgeAvailability("not-an-object")).toBe("SES_LOCKDOWN_UNAVAILABLE");
    expect(classifyDisplayBridgeAvailability(42)).toBe("SES_LOCKDOWN_UNAVAILABLE");
  });

  it("[2] returns DISPLAY_COUNT_METHOD_UNAVAILABLE when sesLockdown exists but getDisplayCount is not a function", () => {
    expect(classifyDisplayBridgeAvailability({ version: "1.7.2" })).toBe("DISPLAY_COUNT_METHOD_UNAVAILABLE");
    expect(classifyDisplayBridgeAvailability({ getDisplayCount: "not-a-function" })).toBe("DISPLAY_COUNT_METHOD_UNAVAILABLE");
    expect(classifyDisplayBridgeAvailability({ getDisplayCount: null })).toBe("DISPLAY_COUNT_METHOD_UNAVAILABLE");
  });

  it("returns AVAILABLE when both sesLockdown and getDisplayCount (as a function) exist", () => {
    expect(classifyDisplayBridgeAvailability({ getDisplayCount: () => Promise.resolve(1) })).toBe("AVAILABLE");
  });
});

describe("boundedDiagnosticString", () => {
  it("[9] truncates to the exact max length, never longer", () => {
    expect(boundedDiagnosticString("a".repeat(500), 300)).toHaveLength(300);
    expect(boundedDiagnosticString("short", 300)).toBe("short");
  });

  it("[9] never includes a stack trace — only ever formats the given value directly, no property traversal beyond String()", () => {
    const fakeErrorWithStack = { toString: () => "Error: boom" } as unknown;
    const result = boundedDiagnosticString(fakeErrorWithStack, 300);
    expect(result).not.toMatch(/at \w+.*:\d+:\d+/); // no "at functionName (file:line:col)" stack-frame pattern
  });

  it("stringifies a non-string value minimally rather than JSON-serializing it (never emits nested object/array structure)", () => {
    expect(boundedDiagnosticString(42, 300)).toBe("42");
    expect(boundedDiagnosticString(undefined, 300)).toBe("undefined");
  });
});

describe("buildDisplayInvokeFailedDiagnostic — [3, 9]", () => {
  it("[3] captures a real Error's name/message, bounded, with outcome DISPLAY_COUNT_INVOKE_FAILED", () => {
    const diagnostic = buildDisplayInvokeFailedDiagnostic(new TypeError("getDisplayCount is not a function"));
    expect(diagnostic.outcome).toBe("DISPLAY_COUNT_INVOKE_FAILED");
    expect(diagnostic.errorName).toBe("TypeError");
    expect(diagnostic.errorMessage).toBe("getDisplayCount is not a function");
  });

  it("[9] never includes a stack trace, even though a real Error object always carries one", () => {
    const err = new Error("boom");
    const diagnostic = buildDisplayInvokeFailedDiagnostic(err);
    expect(diagnostic).not.toHaveProperty("stack");
    expect(JSON.stringify(diagnostic)).not.toContain(err.stack?.split("\n")[1] ?? "__no_stack_line__");
  });

  it("[9] errorName is capped at ~100 chars and errorMessage at ~300 chars, even for a pathological long message", () => {
    const err = new Error("x".repeat(1000));
    err.name = "y".repeat(1000);
    const diagnostic = buildDisplayInvokeFailedDiagnostic(err);
    expect(diagnostic.errorName!.length).toBeLessThanOrEqual(100);
    expect(diagnostic.errorMessage!.length).toBeLessThanOrEqual(300);
  });

  it("handles a non-Error thrown value safely (e.g. a rejected string/number) without crashing", () => {
    const diagnostic = buildDisplayInvokeFailedDiagnostic("plain string rejection");
    expect(diagnostic.outcome).toBe("DISPLAY_COUNT_INVOKE_FAILED");
    expect(diagnostic.errorName).toBe("string");
    expect(diagnostic.errorMessage).toBe("plain string rejection");
  });
});

describe("isValidReportedDisplayCount — [4, 5, 6] reused directly by the client, never a second drifting validator", () => {
  it("[4] rejects non-integer, zero, negative, and out-of-range values — these must never become PASS", () => {
    expect(isValidReportedDisplayCount(0)).toBe(false);
    expect(isValidReportedDisplayCount(-1)).toBe(false);
    expect(isValidReportedDisplayCount(1.5)).toBe(false);
    expect(isValidReportedDisplayCount(9)).toBe(false);
    expect(isValidReportedDisplayCount(NaN)).toBe(false);
    expect(isValidReportedDisplayCount("1")).toBe(false);
    expect(isValidReportedDisplayCount(null)).toBe(false);
    expect(isValidReportedDisplayCount(undefined)).toBe(false);
  });

  it("[5, 6] accepts 1 and 2 — the exact values distinguishing PASS from FAIL", () => {
    expect(isValidReportedDisplayCount(1)).toBe(true);
    expect(isValidReportedDisplayCount(2)).toBe(true);
  });
});
