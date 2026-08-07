import { describe, it, expect } from "vitest";
import {
  buildTetherDeepLink,
  buildLegacySesDeepLink,
  shouldShowInstallerFallback,
  resolveTetherLaunchFailureMessage,
  DEFAULT_INSTALLER_FALLBACK_THRESHOLD_MS,
} from "./tetherLaunch";

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
