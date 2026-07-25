import { describe, it, expect } from "vitest";
import {
  SECURE_CLIENT_EVENT_TYPES,
  SECURE_CLIENT_EVENT_METADATA_SCHEMAS,
  DEFAULT_SECURE_CLIENT_EVENT_LEVEL,
  isValidSecureClientEventType,
  validateSecureClientEventMetadata,
  checkSequenceNumber,
} from "./secureClientEvents";

describe("event type / level tables", () => {
  it("every event type has a metadata schema and a default level", () => {
    for (const type of SECURE_CLIENT_EVENT_TYPES) {
      expect(SECURE_CLIENT_EVENT_METADATA_SCHEMAS[type]).toBeDefined();
      expect(DEFAULT_SECURE_CLIENT_EVENT_LEVEL[type]).toBeDefined();
    }
  });

  it("no event type's default level is a misconduct verdict — only the four documented levels exist", () => {
    const allowed = new Set(["INFORMATIONAL", "CONTEXT", "ACTION_REQUIRED", "REVIEW_CONTEXT"]);
    for (const type of SECURE_CLIENT_EVENT_TYPES) {
      expect(allowed.has(DEFAULT_SECURE_CLIENT_EVENT_LEVEL[type])).toBe(true);
    }
  });

  it("isValidSecureClientEventType rejects an unknown type", () => {
    expect(isValidSecureClientEventType("NOT_A_REAL_EVENT")).toBe(false);
    expect(isValidSecureClientEventType("HEARTBEAT_MISSED")).toBe(true);
  });
});

describe("validateSecureClientEventMetadata", () => {
  it("accepts empty metadata for an empty-schema event type", () => {
    const result = validateSecureClientEventMetadata("SECURE_CLIENT_LAUNCH_REQUESTED", {});
    expect(result.success).toBe(true);
  });

  it("accepts undefined metadata, defaulting to {}", () => {
    const result = validateSecureClientEventMetadata("SECURE_CLIENT_LAUNCH_REQUESTED", undefined);
    expect(result.success).toBe(true);
  });

  it("rejects an unrecognised key — .strict() schemas reject extras", () => {
    const result = validateSecureClientEventMetadata("SECURE_CLIENT_LAUNCH_REQUESTED", { extraField: "not allowed" });
    expect(result.success).toBe(false);
  });

  it("rejects a raw process list smuggled into PROHIBITED_PROCESS_SIGNAL metadata", () => {
    const result = validateSecureClientEventMetadata("PROHIBITED_PROCESS_SIGNAL", {
      ruleId: "rule-1",
      category: "remote-access",
      normalisedApplicationId: "app",
      detectedAt: new Date().toISOString(),
      fullProcessList: ["chrome.exe", "notepad.exe"],
    });
    expect(result.success).toBe(false);
  });

  it("accepts well-formed PROHIBITED_PROCESS_SIGNAL metadata", () => {
    const result = validateSecureClientEventMetadata("PROHIBITED_PROCESS_SIGNAL", {
      ruleId: "rule-1",
      category: "remote-access",
      normalisedApplicationId: "app",
      detectedAt: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it("rejects a client-supplied numeric misconduct score on an event type that doesn't define one", () => {
    const result = validateSecureClientEventMetadata("SECURE_CLIENT_INTERRUPTED", { misconductScore: 0.9 });
    expect(result.success).toBe(false);
  });

  it("accepts the optional reasonCode on a reason-metadata event type", () => {
    const result = validateSecureClientEventMetadata("SECURE_CLIENT_INTERRUPTED", { reasonCode: "NETWORK_LOSS" });
    expect(result.success).toBe(true);
  });
});

describe("checkSequenceNumber", () => {
  it("accepts when no prior sequence exists yet", () => {
    expect(checkSequenceNumber(1, null)).toBe("ACCEPT");
  });
  it("accepts when candidate is null (unsequenced client)", () => {
    expect(checkSequenceNumber(null, 5)).toBe("ACCEPT");
  });
  it("accepts a strictly-increasing candidate", () => {
    expect(checkSequenceNumber(6, 5)).toBe("ACCEPT");
  });
  it("flags an equal candidate as a duplicate", () => {
    expect(checkSequenceNumber(5, 5)).toBe("DUPLICATE");
  });
  it("flags a lower candidate as out-of-order rather than silently dropping it", () => {
    expect(checkSequenceNumber(3, 5)).toBe("OUT_OF_ORDER");
  });
});
