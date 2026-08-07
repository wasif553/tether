/**
 * Mid-exam remote-session monitoring v1 — tests for
 * reportRemoteSessionMonitorTransition (src/lib/lockdownClient.ts). This
 * project's default vitest environment is plain Node (see
 * vitest.config.ts — no jsdom), so `window` is stubbed explicitly via
 * vi.stubGlobal, exactly as needed for the CHECK_UNAVAILABLE/
 * CHECK_RECOVERED branches which call window.sesLockdown directly; the
 * BECAME_ACTIVE/BECAME_INACTIVE branches only need `fetch`, matching
 * every existing lockdownClient.ts call (never unit-tested before this —
 * see lockdownClient.ts's own doc comment on being feature-detected/
 * best-effort).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { reportRemoteSessionMonitorTransition, reportScreenShareRequestFailed } from "./lockdownClient";

const CLASSIFICATION_ACTIVE = { isRemoteSession: true, remoteSessionSignalSource: "BOTH_AGREE", isLikelyVirtualMachine: false, vmSignatureMatched: null };
const CLASSIFICATION_INACTIVE = { isRemoteSession: false, remoteSessionSignalSource: "BOTH_AGREE", isLikelyVirtualMachine: false, vmSignatureMatched: null };

function baseParams(overrides: Partial<Parameters<typeof reportRemoteSessionMonitorTransition>[0]> = {}) {
  return {
    submissionId: "sub-1",
    kind: "BECAME_ACTIVE" as const,
    effectiveAction: "BLOCK_DURING_EXAM",
    previousState: "INACTIVE",
    currentState: "ACTIVE",
    detectedAtMsForClear: null,
    classification: CLASSIFICATION_ACTIVE,
    tetherVersion: "1.8.0",
    secureClientSessionId: "session-abc",
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", { sesLockdown: { reportLockdownAuditFact: vi.fn() } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reportRemoteSessionMonitorTransition — BECAME_ACTIVE", () => {
  it("posts REMOTE_CONTROL_SOFTWARE_DETECTED with MEDIUM severity when the effective action is BLOCK_DURING_EXAM", async () => {
    await reportRemoteSessionMonitorTransition(baseParams());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/submissions/sub-1/integrity-events");
    const body = JSON.parse(init.body);
    expect(body.eventType).toBe("REMOTE_CONTROL_SOFTWARE_DETECTED");
    expect(body.severity).toBe("MEDIUM");
    expect(body.metadata).toMatchObject({
      capabilityId: "REMOTE_DESKTOP_SESSION",
      category: "REMOTE_CONTROL",
      detectionSource: "WINDOWS_SESSION_API",
      previousState: "INACTIVE",
      currentState: "ACTIVE",
      sessionType: "REMOTE_DESKTOP_SESSION",
      checkConfidence: "BOTH_AGREE",
      tetherVersion: "1.8.0",
      secureClientSessionId: "session-abc",
      policyAction: "BLOCK_DURING_EXAM",
    });
    expect(typeof body.metadata.detectedAtMs).toBe("number");
  });

  it("posts an INFO-severity event when the effective action is downgraded to DETECT_AND_RECORD (policy toggle off)", async () => {
    await reportRemoteSessionMonitorTransition(baseParams({ effectiveAction: "DETECT_AND_RECORD" }));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.severity).toBe("INFO");
  });

  it("never posts anything for an effective action that is neither BLOCK_DURING_EXAM nor DETECT_AND_RECORD", async () => {
    await reportRemoteSessionMonitorTransition(baseParams({ effectiveAction: "WARN_AND_REQUIRE_CLOSE" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sessionType is null when the classification says the session is not actually remote", async () => {
    await reportRemoteSessionMonitorTransition(baseParams({ classification: CLASSIFICATION_INACTIVE }));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.metadata.sessionType).toBeNull();
  });

  it("never throws when the POST itself fails (non-fatal, matches every other lockdownClient reporting call)", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await expect(reportRemoteSessionMonitorTransition(baseParams())).resolves.toBeUndefined();
  });
});

describe("reportRemoteSessionMonitorTransition — BECAME_INACTIVE", () => {
  it("posts the existing generic PROHIBITED_APPLICATION_CLOSED event, always INFO severity, with a computed durationMs", async () => {
    const detectedAtMsForClear = Date.now() - 5_000;
    await reportRemoteSessionMonitorTransition(
      baseParams({ kind: "BECAME_INACTIVE", previousState: "ACTIVE", currentState: "INACTIVE", detectedAtMsForClear, classification: CLASSIFICATION_INACTIVE }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.eventType).toBe("PROHIBITED_APPLICATION_CLOSED");
    expect(body.severity).toBe("INFO");
    expect(body.metadata.durationMs).toBeGreaterThanOrEqual(5_000);
  });

  it("omits durationMs when detectedAtMsForClear is null", async () => {
    await reportRemoteSessionMonitorTransition(baseParams({ kind: "BECAME_INACTIVE", detectedAtMsForClear: null, classification: CLASSIFICATION_INACTIVE }));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.metadata.durationMs).toBeUndefined();
  });
});

describe("reportRemoteSessionMonitorTransition — CHECK_UNAVAILABLE / CHECK_RECOVERED", () => {
  it("CHECK_UNAVAILABLE reports a PlatformAuditLog-only fact, never an IntegrityEvent", async () => {
    await reportRemoteSessionMonitorTransition(baseParams({ kind: "CHECK_UNAVAILABLE", previousState: null, currentState: null }));
    expect(fetchMock).not.toHaveBeenCalled();
    const auditFact = (window as unknown as { sesLockdown: { reportLockdownAuditFact: ReturnType<typeof vi.fn> } }).sesLockdown.reportLockdownAuditFact;
    expect(auditFact).toHaveBeenCalledWith("TETHER_LOCKDOWN_REMOTE_SESSION_MONITOR_CHECK_UNAVAILABLE", expect.any(Object));
  });

  it("CHECK_RECOVERED reports a distinct PlatformAuditLog-only fact, never an IntegrityEvent", async () => {
    await reportRemoteSessionMonitorTransition(baseParams({ kind: "CHECK_RECOVERED", previousState: null, currentState: null }));
    expect(fetchMock).not.toHaveBeenCalled();
    const auditFact = (window as unknown as { sesLockdown: { reportLockdownAuditFact: ReturnType<typeof vi.fn> } }).sesLockdown.reportLockdownAuditFact;
    expect(auditFact).toHaveBeenCalledWith("TETHER_LOCKDOWN_REMOTE_SESSION_MONITOR_CHECK_RECOVERED", expect.any(Object));
  });
});

describe("reportScreenShareRequestFailed — URGENT screen-sharing fix, Part A2 diagnostics", () => {
  it("[9] reports a PlatformAuditLog-only fact distinguishing the DOMException name and diagnostic reason, never an IntegrityEvent", () => {
    reportScreenShareRequestFailed({ errorName: "NotFoundError", screenShareMode: "REQUIRED" });
    expect(fetchMock).not.toHaveBeenCalled();
    const auditFact = (window as unknown as { sesLockdown: { reportLockdownAuditFact: ReturnType<typeof vi.fn> } }).sesLockdown.reportLockdownAuditFact;
    expect(auditFact).toHaveBeenCalledWith(
      "TETHER_SCREEN_SHARE_REQUEST_FAILED",
      expect.objectContaining({ errorName: "NotFoundError", diagnosticReason: "NO_SOURCE", screenShareMode: "REQUIRED" }),
    );
  });

  it("[9] distinguishes user cancellation (AbortError) from an internal failure", () => {
    reportScreenShareRequestFailed({ errorName: "AbortError", screenShareMode: "REQUIRED" });
    const auditFact = (window as unknown as { sesLockdown: { reportLockdownAuditFact: ReturnType<typeof vi.fn> } }).sesLockdown.reportLockdownAuditFact;
    expect(auditFact).toHaveBeenCalledWith("TETHER_SCREEN_SHARE_REQUEST_FAILED", expect.objectContaining({ diagnosticReason: "CANCELLED" }));
  });

  it("never includes captured pixels, tokens, cookies, or credentials — only bounded string/boolean fields", () => {
    reportScreenShareRequestFailed({ errorName: "NotAllowedError", screenShareMode: "REQUIRED" });
    const auditFact = (window as unknown as { sesLockdown: { reportLockdownAuditFact: ReturnType<typeof vi.fn> } }).sesLockdown.reportLockdownAuditFact;
    const metadata = auditFact.mock.calls[0][1] as Record<string, unknown>;
    for (const value of Object.values(metadata)) {
      expect(["string", "boolean"].includes(typeof value)).toBe(true);
    }
    expect(Object.keys(metadata).join(",")).not.toMatch(/token|cookie|credential|signature|manifest/i);
  });

  it("is a silent no-op outside Tether (no window.sesLockdown bridge) — never throws", () => {
    vi.stubGlobal("window", {});
    expect(() => reportScreenShareRequestFailed({ errorName: "NotAllowedError", screenShareMode: "REQUIRED" })).not.toThrow();
  });
});

describe("reportRemoteSessionMonitorTransition — no automatic misconduct decision", () => {
  it("the posted metadata never contains a decision/terminate/submit/misconduct field", async () => {
    await reportRemoteSessionMonitorTransition(baseParams());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const keys = Object.keys(body.metadata).map((k) => k.toLowerCase());
    for (const forbidden of ["decision", "terminate", "submit", "misconduct"]) {
      expect(keys.some((k) => k.includes(forbidden))).toBe(false);
    }
  });
});
