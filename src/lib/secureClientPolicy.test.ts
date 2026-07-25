import { describe, it, expect } from "vitest";
import {
  buildSecureClientPolicySnapshot,
  parseSecureClientPolicy,
  resolveEffectiveDeliveryMode,
  deliveryModeRequiresSecureClient,
  deliveryModeOffersSecureClient,
  isValidDeliveryMode,
  isSecureClientDeliveryEnabled,
  isSecureClientRequired,
  isSecureClientOffered,
  DISABLED_SECURE_CLIENT_POLICY,
  DEFAULT_SECURE_CLIENT_AVAILABILITY,
  clampHeartbeatIntervalSeconds,
  clampMaximumDisplays,
  type RelevantSecureClientSettings,
} from "./secureClientPolicy";

const baseSettings: RelevantSecureClientSettings = {
  deliveryMode: "STANDARD_WEB",
  allowedSebPlatforms: [],
  allowedSebVersions: [],
  requireSebBrowserExamKey: false,
  requireSebConfigKey: false,
  allowSebHeaderValidation: true,
  allowSebJavascriptApiValidation: true,
  secureLaunchTokenTtlSeconds: 300,
  secureClientHeartbeatIntervalSeconds: 30,
  secureClientHeartbeatGraceSeconds: 90,
  requireDisplayCheck: false,
  secureClientMaximumDisplays: 1,
  requireRemoteSessionCheck: false,
  requireVirtualMachineCheck: false,
  requireProcessCheck: false,
  requireCaptureProtectionCheck: false,
  blockCopyPaste: false,
  secureClientAllowPrinting: true,
  secureClientAllowExternalNavigation: true,
  secureClientAllowApplicationSwitching: true,
  secureClientAllowRecovery: true,
  secureClientEventRetentionDays: 180,
  secureClientLecturerOverrideAllowed: true,
};

describe("delivery mode helpers", () => {
  it("validates known delivery modes only", () => {
    expect(isValidDeliveryMode("STANDARD_WEB")).toBe(true);
    expect(isValidDeliveryMode("SEB_REQUIRED")).toBe(true);
    expect(isValidDeliveryMode("NOT_A_MODE")).toBe(false);
  });

  it("only SEB_REQUIRED/TETHER_CLIENT_REQUIRED require a secure client", () => {
    expect(deliveryModeRequiresSecureClient("SEB_REQUIRED")).toBe(true);
    expect(deliveryModeRequiresSecureClient("TETHER_CLIENT_REQUIRED")).toBe(true);
    expect(deliveryModeRequiresSecureClient("SEB_OPTIONAL")).toBe(false);
    expect(deliveryModeRequiresSecureClient("STANDARD_WEB")).toBe(false);
    expect(deliveryModeRequiresSecureClient("MONITORED_WEB")).toBe(false);
  });

  it("offers-secure-client includes both optional and required modes", () => {
    expect(deliveryModeOffersSecureClient("SEB_OPTIONAL")).toBe(true);
    expect(deliveryModeOffersSecureClient("SEB_REQUIRED")).toBe(true);
    expect(deliveryModeOffersSecureClient("STANDARD_WEB")).toBe(false);
  });
});

describe("resolveEffectiveDeliveryMode", () => {
  it("downgrades TETHER_CLIENT_OPTIONAL to STANDARD_WEB when unavailable", () => {
    expect(resolveEffectiveDeliveryMode("TETHER_CLIENT_OPTIONAL", DEFAULT_SECURE_CLIENT_AVAILABILITY)).toBe("STANDARD_WEB");
  });

  it("downgrades TETHER_CLIENT_REQUIRED to STANDARD_WEB when unavailable", () => {
    expect(resolveEffectiveDeliveryMode("TETHER_CLIENT_REQUIRED", DEFAULT_SECURE_CLIENT_AVAILABILITY)).toBe("STANDARD_WEB");
  });

  it("honours TETHER_CLIENT_OPTIONAL when the availability flag is on", () => {
    expect(resolveEffectiveDeliveryMode("TETHER_CLIENT_OPTIONAL", { tetherClientOptionalAvailable: true, tetherClientRequiredAvailable: false })).toBe(
      "TETHER_CLIENT_OPTIONAL",
    );
  });

  it("leaves SEB modes untouched regardless of Tether availability", () => {
    expect(resolveEffectiveDeliveryMode("SEB_REQUIRED", DEFAULT_SECURE_CLIENT_AVAILABILITY)).toBe("SEB_REQUIRED");
  });
});

describe("buildSecureClientPolicySnapshot", () => {
  it("STANDARD_WEB produces the fully-permissive disabled policy", () => {
    const snapshot = buildSecureClientPolicySnapshot(baseSettings);
    expect(snapshot.deliveryMode).toBe("STANDARD_WEB");
    expect(snapshot.requireVerifiedClient).toBe(false);
    expect(snapshot.studentPreflightRequired).toBe(false);
    expect(snapshot.allowedClientTypes).toEqual([]);
  });

  it("SEB_REQUIRED produces a restrictive snapshot with conservative defaults", () => {
    const snapshot = buildSecureClientPolicySnapshot({ ...baseSettings, deliveryMode: "SEB_REQUIRED" });
    expect(snapshot.requireVerifiedClient).toBe(true);
    expect(snapshot.studentPreflightRequired).toBe(true);
    expect(snapshot.allowedClientTypes).toEqual(["SAFE_EXAM_BROWSER"]);
    // restrictiveDefault forces these false even though the raw settings said true
    expect(snapshot.allowPrinting).toBe(false);
    expect(snapshot.allowExternalNavigation).toBe(false);
    expect(snapshot.allowApplicationSwitching).toBe(false);
  });

  it("SEB_OPTIONAL requires a client but does not force the restrictive defaults", () => {
    const snapshot = buildSecureClientPolicySnapshot({ ...baseSettings, deliveryMode: "SEB_OPTIONAL" });
    expect(snapshot.requireVerifiedClient).toBe(false);
    expect(snapshot.allowedClientTypes).toEqual(["SAFE_EXAM_BROWSER"]);
    expect(snapshot.allowPrinting).toBe(true);
  });

  it("downgrades an unavailable TETHER_CLIENT_REQUIRED mode to the disabled policy", () => {
    const snapshot = buildSecureClientPolicySnapshot({ ...baseSettings, deliveryMode: "TETHER_CLIENT_REQUIRED" }, DEFAULT_SECURE_CLIENT_AVAILABILITY);
    expect(snapshot.deliveryMode).toBe("STANDARD_WEB");
    expect(snapshot.requireVerifiedClient).toBe(false);
  });

  it("clamps out-of-bounds values instead of trusting them verbatim", () => {
    const snapshot = buildSecureClientPolicySnapshot({
      ...baseSettings,
      deliveryMode: "SEB_OPTIONAL",
      secureClientHeartbeatIntervalSeconds: 999999,
      secureClientMaximumDisplays: 999,
    });
    expect(snapshot.heartbeatIntervalSeconds).toBeLessThanOrEqual(120);
    expect(snapshot.maximumDisplays).toBeLessThanOrEqual(3);
  });

  it("derives allowClipboard from blockCopyPaste (inverted)", () => {
    const snapshot = buildSecureClientPolicySnapshot({ ...baseSettings, deliveryMode: "SEB_OPTIONAL", blockCopyPaste: true });
    expect(snapshot.allowClipboard).toBe(false);
  });

  it("stamps createdAt from the provided builtAt", () => {
    const builtAt = new Date("2026-01-01T00:00:00.000Z");
    const snapshot = buildSecureClientPolicySnapshot(baseSettings, DEFAULT_SECURE_CLIENT_AVAILABILITY, builtAt);
    expect(snapshot.createdAt).toBe(builtAt.toISOString());
  });
});

describe("parseSecureClientPolicy", () => {
  it("null/undefined/malformed input always means the disabled policy", () => {
    expect(parseSecureClientPolicy(null)).toEqual(DISABLED_SECURE_CLIENT_POLICY);
    expect(parseSecureClientPolicy(undefined)).toEqual(DISABLED_SECURE_CLIENT_POLICY);
    expect(parseSecureClientPolicy("not an object")).toEqual(DISABLED_SECURE_CLIENT_POLICY);
    expect(parseSecureClientPolicy(42)).toEqual(DISABLED_SECURE_CLIENT_POLICY);
  });

  it("an unrecognised deliveryMode string falls back to STANDARD_WEB, never throws", () => {
    const result = parseSecureClientPolicy({ deliveryMode: "SOMETHING_FUTURE_AND_UNKNOWN" });
    expect(result.deliveryMode).toBe("STANDARD_WEB");
  });

  it("round-trips a snapshot built for SEB_REQUIRED", () => {
    const built = buildSecureClientPolicySnapshot({ ...baseSettings, deliveryMode: "SEB_REQUIRED" });
    const parsed = parseSecureClientPolicy(built);
    expect(parsed).toEqual(built);
  });

  it("re-derives the restrictive defaults from deliveryMode alone, ignoring a tampered flag", () => {
    // Even if stored JSON somehow had studentPreflightRequired: false for a
    // required mode, parsing must re-derive it as true from deliveryMode.
    const tampered = { deliveryMode: "SEB_REQUIRED", studentPreflightRequired: false };
    expect(parseSecureClientPolicy(tampered).studentPreflightRequired).toBe(true);
  });
});

describe("isSecureClientDeliveryEnabled / Required / Offered", () => {
  it("STANDARD_WEB is never enabled, required, or offered", () => {
    expect(isSecureClientDeliveryEnabled({ deliveryMode: "STANDARD_WEB" })).toBe(false);
    expect(isSecureClientRequired({ deliveryMode: "STANDARD_WEB" })).toBe(false);
    expect(isSecureClientOffered({ deliveryMode: "STANDARD_WEB" })).toBe(false);
  });

  it("SEB_REQUIRED is enabled, required, and offered", () => {
    expect(isSecureClientDeliveryEnabled({ deliveryMode: "SEB_REQUIRED" })).toBe(true);
    expect(isSecureClientRequired({ deliveryMode: "SEB_REQUIRED" })).toBe(true);
    expect(isSecureClientOffered({ deliveryMode: "SEB_REQUIRED" })).toBe(true);
  });

  it("MONITORED_WEB is enabled but neither requires nor offers a secure client", () => {
    expect(isSecureClientDeliveryEnabled({ deliveryMode: "MONITORED_WEB" })).toBe(true);
    expect(isSecureClientRequired({ deliveryMode: "MONITORED_WEB" })).toBe(false);
    expect(isSecureClientOffered({ deliveryMode: "MONITORED_WEB" })).toBe(false);
  });
});

describe("bounds clamping", () => {
  it("clampHeartbeatIntervalSeconds clamps to [15, 120]", () => {
    expect(clampHeartbeatIntervalSeconds(1)).toBe(15);
    expect(clampHeartbeatIntervalSeconds(1000)).toBe(120);
    expect(clampHeartbeatIntervalSeconds(60)).toBe(60);
  });

  it("clampMaximumDisplays clamps to [1, 3]", () => {
    expect(clampMaximumDisplays(0)).toBe(1);
    expect(clampMaximumDisplays(10)).toBe(3);
  });

  it("non-finite input falls back to the documented default rather than propagating NaN", () => {
    expect(clampHeartbeatIntervalSeconds(Number.NaN)).toBe(30);
  });
});
