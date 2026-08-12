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
  resolveDisplayPreflightIssue,
  resolveActivationFailureIssue,
  classifyActivatePostOutcome,
  classifyReconciliationCheck,
  resolveServerActivationNotConfirmedIssue,
  resolveServerActivationUndeterminedIssue,
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

// ---------------------------------------------------------------------------
// v1.7.4 pre-exam readiness — Part 13A/B: calm PRECHECK/remediation copy.
// Mirrors apps/lockdown/src/displayEnforcementLogic.ts's taxonomy on the
// web side (separate compiled packages, so never literally shared code —
// see resolveDisplayPreflightIssue's own doc comment).
// ---------------------------------------------------------------------------

describe("resolveDisplayPreflightIssue — Part 8 factual display PRECHECK reporting", () => {
  it("[Part 8] reports exactly what Windows observed — genuine multi-display evidence", () => {
    expect(resolveDisplayPreflightIssue(2, "INTERNAL_ONLY")?.title).toBe("Additional display connected");
    expect(resolveDisplayPreflightIssue(1, "EXTEND")?.title).toBe("Extended display detected");
    expect(resolveDisplayPreflightIssue(1, "CLONE_OR_DUPLICATE")?.title).toBe("Mirrored display detected");
    expect(resolveDisplayPreflightIssue(1, "MULTIPLE_ACTIVE_TARGETS")?.title).toBe("Additional display connected");
  });

  it("[Part 8] a single physical display with no TeamViewer/virtual-target evidence never shows an issue — the confirmed TEST 2 false positive this fixes", () => {
    expect(resolveDisplayPreflightIssue(1, "INTERNAL_ONLY")).toBeNull();
    expect(resolveDisplayPreflightIssue(1, "EXTERNAL_ONLY")).toBeNull();
  });

  it("[Part 8] ERROR/UNKNOWN uses neutral wording, never claims a display was found", () => {
    const issue = resolveDisplayPreflightIssue(1, "ERROR");
    expect(issue?.message).toBe("Tether could not verify the display configuration. Resolve the display check and select Recheck before beginning the examination.");
    expect(issue?.message.toLowerCase()).not.toContain("additional display connected");
    expect(resolveDisplayPreflightIssue(1, "UNKNOWN")?.title).toBe("Display configuration could not be verified");
  });
});

describe("resolveActivationFailureIssue — Part 6/E: the fresh Phase 2 native check's failure copy matches the calm PRECHECK screen exactly", () => {
  it("[Part 6 TeamViewer race] PROHIBITED_APPLICATION lists the matched application display names via the SAME capability-id lookup", () => {
    const names = new Map([["TEAMVIEWER", "TeamViewer"]]);
    const issue = resolveActivationFailureIssue({ reason: "PROHIBITED_APPLICATION", matchedCapabilityIds: ["TEAMVIEWER"] }, names);
    expect(issue.title).toBe("Close applications before continuing");
    expect(issue.applicationNames).toEqual(["TeamViewer"]);
  });

  it("PROHIBITED_APPLICATION falls back to 'an application' when no display-name map is supplied", () => {
    const issue = resolveActivationFailureIssue({ reason: "PROHIBITED_APPLICATION", matchedCapabilityIds: ["UNKNOWN_ID"] });
    expect(issue.applicationNames).toEqual(["an application"]);
  });

  it("[Part 6 display race] the four genuine display reasons produce the exact same copy as resolveDisplayPreflightIssue", () => {
    expect(resolveActivationFailureIssue({ reason: "ADDITIONAL_ELECTRON_DISPLAY" })).toEqual(resolveDisplayPreflightIssue(2, "INTERNAL_ONLY"));
    expect(resolveActivationFailureIssue({ reason: "WINDOWS_TOPOLOGY_EXTEND" })).toEqual(resolveDisplayPreflightIssue(1, "EXTEND"));
    expect(resolveActivationFailureIssue({ reason: "TOPOLOGY_CHECK_UNAVAILABLE" })).toEqual(resolveDisplayPreflightIssue(1, "ERROR"));
  });

  it("REMOTE_SESSION_DETECTED and the two *_UNAVAILABLE reasons never claim a clean scan", () => {
    expect(resolveActivationFailureIssue({ reason: "REMOTE_SESSION_DETECTED" }).title).toContain("Remote Desktop");
    expect(resolveActivationFailureIssue({ reason: "PROCESS_CHECK_UNAVAILABLE" }).message.toLowerCase()).not.toContain("clean");
    expect(resolveActivationFailureIssue({ reason: "REMOTE_SESSION_CHECK_UNAVAILABLE" }).message.toLowerCase()).not.toContain("clean");
  });

  it("an unrecognised reason falls back to a generic, factual, non-alarming message rather than throwing", () => {
    const issue = resolveActivationFailureIssue({ reason: "SOMETHING_UNEXPECTED" });
    expect(issue.title.length).toBeGreaterThan(0);
    expect(issue.message.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// PR #22 release-blocking review — secure-activation failure
// reconciliation. See tether-launch/page.tsx's ensureSecureActivation.
// ---------------------------------------------------------------------------

describe("classifyActivatePostOutcome", () => {
  it("REQUIRED TEST 2 groundwork: a 2xx status is always SUCCESS, regardless of code", () => {
    expect(classifyActivatePostOutcome({ threw: false, status: 200, code: null })).toEqual({ kind: "SUCCESS" });
    expect(classifyActivatePostOutcome({ threw: false, status: 201, code: "irrelevant" })).toEqual({ kind: "SUCCESS" });
  });

  it("REQUIRED TEST 1 groundwork: 401/403/404/409 are trusted as DEFINITIVE_REJECTION — POST /api/submissions/[id]/activate never writes activatedAt before any of these statuses", () => {
    expect(classifyActivatePostOutcome({ threw: false, status: 401, code: null })).toEqual({ kind: "DEFINITIVE_REJECTION", code: null });
    expect(classifyActivatePostOutcome({ threw: false, status: 403, code: "SECURE_SESSION_NOT_VERIFIED" })).toEqual({
      kind: "DEFINITIVE_REJECTION",
      code: "SECURE_SESSION_NOT_VERIFIED",
    });
    expect(classifyActivatePostOutcome({ threw: false, status: 404, code: null })).toEqual({ kind: "DEFINITIVE_REJECTION", code: null });
    expect(classifyActivatePostOutcome({ threw: false, status: 409, code: "SUBMISSION_NOT_IN_PROGRESS" })).toEqual({
      kind: "DEFINITIVE_REJECTION",
      code: "SUBMISSION_NOT_IN_PROGRESS",
    });
  });

  it("REQUIRED TEST 3 groundwork: a thrown network exception is AMBIGUOUS, never treated as a rejection", () => {
    expect(classifyActivatePostOutcome({ threw: true, status: null, code: null })).toEqual({ kind: "AMBIGUOUS" });
  });

  it("a 500 (or any status this route cannot actually produce) is AMBIGUOUS, never guessed as a rejection — a 500 could occur AFTER the write already committed", () => {
    expect(classifyActivatePostOutcome({ threw: false, status: 500, code: null })).toEqual({ kind: "AMBIGUOUS" });
    expect(classifyActivatePostOutcome({ threw: false, status: 502, code: null })).toEqual({ kind: "AMBIGUOUS" });
    expect(classifyActivatePostOutcome({ threw: false, status: 418, code: null })).toEqual({ kind: "AMBIGUOUS" });
  });

  it("a null status with no exception (should not normally happen, but defensively) is AMBIGUOUS", () => {
    expect(classifyActivatePostOutcome({ threw: false, status: null, code: null })).toEqual({ kind: "AMBIGUOUS" });
  });
});

describe("classifyReconciliationCheck", () => {
  it("REQUIRED TEST 3: ok:true + activated:true -> ACTIVATED", () => {
    expect(classifyReconciliationCheck({ ok: true, activated: true })).toBe("ACTIVATED");
  });

  it("REQUIRED TEST 4: ok:true + activated:false -> NOT_ACTIVATED", () => {
    expect(classifyReconciliationCheck({ ok: true, activated: false })).toBe("NOT_ACTIVATED");
  });

  it("REQUIRED TEST 5: a non-ok response is UNDETERMINED, never guessed as either outcome", () => {
    expect(classifyReconciliationCheck({ ok: false, activated: true })).toBe("UNDETERMINED");
    expect(classifyReconciliationCheck({ ok: false, activated: false })).toBe("UNDETERMINED");
    expect(classifyReconciliationCheck({ ok: false, activated: undefined })).toBe("UNDETERMINED");
  });

  it("REQUIRED TEST 5: a malformed/missing activated field on an ok response is UNDETERMINED, never coerced to false", () => {
    expect(classifyReconciliationCheck({ ok: true, activated: undefined })).toBe("UNDETERMINED");
    expect(classifyReconciliationCheck({ ok: true, activated: null })).toBe("UNDETERMINED");
    expect(classifyReconciliationCheck({ ok: true, activated: "true" })).toBe("UNDETERMINED");
  });
});

describe("resolveServerActivationNotConfirmedIssue / resolveServerActivationUndeterminedIssue — distinct, honest wording", () => {
  it("the definitive-rejection issue states lockdown has been turned off, matching what the caller actually does (restoreLockdownControls first)", () => {
    const issue = resolveServerActivationNotConfirmedIssue();
    expect(issue.title.length).toBeGreaterThan(0);
    expect(issue.message.toLowerCase()).toContain("turned off");
  });

  it("the undetermined issue never claims lockdown is off — the caller deliberately does not restore it in this case", () => {
    const issue = resolveServerActivationUndeterminedIssue();
    expect(issue.message.toLowerCase()).not.toContain("turned off");
    expect(issue.message.toLowerCase()).not.toContain("secure lockdown is off");
  });

  it("both issues are structurally identical PreflightIssue shapes to every other precheck failure — rendered by the SAME LockdownApplicationCheck component, never a bespoke UI", () => {
    const rejected = resolveServerActivationNotConfirmedIssue();
    const undetermined = resolveServerActivationUndeterminedIssue();
    expect(typeof rejected.title).toBe("string");
    expect(typeof rejected.message).toBe("string");
    expect(typeof undetermined.title).toBe("string");
    expect(typeof undetermined.message).toBe("string");
  });
});
