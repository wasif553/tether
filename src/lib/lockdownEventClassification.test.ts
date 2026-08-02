import { describe, it, expect } from "vitest";
import {
  integrityEventTypeForCapabilityCategory,
  severityForLockdownDetection,
  isLockdownAuditAction,
  LOCKDOWN_AUDIT_ACTIONS,
  PROHIBITED_APPLICATION_CLOSED_EVENT_TYPE,
} from "./lockdownEventClassification";

describe("integrityEventTypeForCapabilityCategory", () => {
  it("maps each category to the documented event type", () => {
    expect(integrityEventTypeForCapabilityCategory("REMOTE_CONTROL")).toBe("REMOTE_CONTROL_SOFTWARE_DETECTED");
    expect(integrityEventTypeForCapabilityCategory("CAPTURE_OVERLAY")).toBe("SCREEN_CAPTURE_SOFTWARE_DETECTED");
    expect(integrityEventTypeForCapabilityCategory("DEBUGGING")).toBe("DEBUGGING_TOOL_DETECTED");
    expect(integrityEventTypeForCapabilityCategory("VIRTUALIZATION")).toBe("PROHIBITED_APPLICATION_DETECTED");
    expect(integrityEventTypeForCapabilityCategory("NAVIGATION_ESCAPE")).toBe("PROHIBITED_APPLICATION_DETECTED");
  });
});

describe("severityForLockdownDetection", () => {
  it("31. a BLOCK_DURING_EXAM-effective detection is MEDIUM (reviewable)", () => {
    expect(severityForLockdownDetection("BLOCK_DURING_EXAM")).toBe("MEDIUM");
  });
  it("a DETECT_AND_RECORD-effective detection (e.g. downgraded by a policy toggle) is INFO, never contributing risk", () => {
    expect(severityForLockdownDetection("DETECT_AND_RECORD")).toBe("INFO");
  });
  it("WARN_AND_REQUIRE_CLOSE and NOT_SUPPORTED are also INFO if ever passed here (defensive default)", () => {
    expect(severityForLockdownDetection("WARN_AND_REQUIRE_CLOSE")).toBe("INFO");
    expect(severityForLockdownDetection("NOT_SUPPORTED")).toBe("INFO");
  });
});

describe("PROHIBITED_APPLICATION_CLOSED_EVENT_TYPE", () => {
  it("is the fixed generic 'cleared' event, shared by every category", () => {
    expect(PROHIBITED_APPLICATION_CLOSED_EVENT_TYPE).toBe("PROHIBITED_APPLICATION_CLOSED");
  });
});

describe("isLockdownAuditAction — PlatformAuditLog-only allow-list (Part 11)", () => {
  it("accepts every documented action", () => {
    for (const action of LOCKDOWN_AUDIT_ACTIONS) {
      expect(isLockdownAuditAction(action)).toBe(true);
    }
  });

  it("rejects an arbitrary free-text action string — the client can never write an unlisted action", () => {
    expect(isLockdownAuditAction("SOMETHING_MADE_UP")).toBe(false);
    expect(isLockdownAuditAction("")).toBe(false);
    expect(isLockdownAuditAction(42)).toBe(false);
    expect(isLockdownAuditAction(null)).toBe(false);
  });

  it("none of the audit-only actions overlap with a real IntegrityEventType — these must never be creatable as an IntegrityEvent", () => {
    const integrityEventTypes = [
      "REMOTE_CONTROL_SOFTWARE_DETECTED",
      "SCREEN_CAPTURE_SOFTWARE_DETECTED",
      "DEBUGGING_TOOL_DETECTED",
      "PROHIBITED_APPLICATION_DETECTED",
      "PROHIBITED_APPLICATION_CLOSED",
    ];
    for (const action of LOCKDOWN_AUDIT_ACTIONS) {
      expect(integrityEventTypes).not.toContain(action);
    }
  });

  it("30. TETHER_LOCKDOWN_DETECTION_SERVICE_FAILURE (technical scan failure) is an audit action, never an integrity event type", () => {
    expect(isLockdownAuditAction("TETHER_LOCKDOWN_DETECTION_SERVICE_FAILURE")).toBe(true);
  });

  it("11. restoration lifecycle actions are audit-only, never misconduct-implying integrity events", () => {
    expect(isLockdownAuditAction("TETHER_LOCKDOWN_RESTORATION_STARTED")).toBe(true);
    expect(isLockdownAuditAction("TETHER_LOCKDOWN_RESTORATION_COMPLETED")).toBe(true);
    expect(isLockdownAuditAction("TETHER_LOCKDOWN_RESTORATION_FAILED")).toBe(true);
  });
});
