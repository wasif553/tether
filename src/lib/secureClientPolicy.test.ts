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
  isDisplayPolicyCombinationValid,
  isValidDisplayPolicy,
  describeDisplayRequirement,
  resolveDisplayRequirementUiState,
  resolveDeliveryModeForSingleDisplayRequired,
  isDisplayPolicySaveBlocked,
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
  displayPolicy: "UNRESTRICTED",
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

// Hardening pass (Part 4): SEB_OPTIONAL/SEB_REQUIRED are now gated by
// availability exactly like the Tether modes always were — tests below
// that exercise SEB-specific snapshot behaviour (not the gating itself)
// must opt in to availability explicitly rather than relying on the
// (now-restrictive-by-default) DEFAULT_SECURE_CLIENT_AVAILABILITY.
const SEB_AVAILABLE = { ...DEFAULT_SECURE_CLIENT_AVAILABILITY, sebOptionalAvailable: true, sebRequiredAvailable: true };

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
    expect(
      resolveEffectiveDeliveryMode("TETHER_CLIENT_OPTIONAL", { ...DEFAULT_SECURE_CLIENT_AVAILABILITY, tetherClientOptionalAvailable: true }),
    ).toBe("TETHER_CLIENT_OPTIONAL");
  });

  it("downgrades SEB_REQUIRED to STANDARD_WEB when unavailable (default availability)", () => {
    expect(resolveEffectiveDeliveryMode("SEB_REQUIRED", DEFAULT_SECURE_CLIENT_AVAILABILITY)).toBe("STANDARD_WEB");
  });

  it("downgrades SEB_OPTIONAL to STANDARD_WEB when unavailable (default availability)", () => {
    expect(resolveEffectiveDeliveryMode("SEB_OPTIONAL", DEFAULT_SECURE_CLIENT_AVAILABILITY)).toBe("STANDARD_WEB");
  });

  it("honours SEB_REQUIRED/SEB_OPTIONAL when explicitly marked available", () => {
    expect(resolveEffectiveDeliveryMode("SEB_REQUIRED", SEB_AVAILABLE)).toBe("SEB_REQUIRED");
    expect(resolveEffectiveDeliveryMode("SEB_OPTIONAL", SEB_AVAILABLE)).toBe("SEB_OPTIONAL");
  });

  it("an ordinary Production institution (default/no availability override) cannot reach SEB_REQUIRED — it always resolves to STANDARD_WEB", () => {
    // DEFAULT_SECURE_CLIENT_AVAILABILITY is exactly what a Production
    // deployment computes (see isSebRequiredAllowed in
    // secureClientAvailability.ts, which is always false in Production) —
    // this is the snapshot-building side of that guarantee.
    expect(resolveEffectiveDeliveryMode("SEB_REQUIRED", DEFAULT_SECURE_CLIENT_AVAILABILITY)).not.toBe("SEB_REQUIRED");
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

  it("SEB_REQUIRED produces a restrictive snapshot with conservative defaults (when available)", () => {
    const snapshot = buildSecureClientPolicySnapshot({ ...baseSettings, deliveryMode: "SEB_REQUIRED" }, SEB_AVAILABLE);
    expect(snapshot.requireVerifiedClient).toBe(true);
    expect(snapshot.studentPreflightRequired).toBe(true);
    expect(snapshot.allowedClientTypes).toEqual(["SAFE_EXAM_BROWSER"]);
    // restrictiveDefault forces these false even though the raw settings said true
    expect(snapshot.allowPrinting).toBe(false);
    expect(snapshot.allowExternalNavigation).toBe(false);
    expect(snapshot.allowApplicationSwitching).toBe(false);
  });

  it("SEB_OPTIONAL requires a client but does not force the restrictive defaults (when available)", () => {
    const snapshot = buildSecureClientPolicySnapshot({ ...baseSettings, deliveryMode: "SEB_OPTIONAL" }, SEB_AVAILABLE);
    expect(snapshot.requireVerifiedClient).toBe(false);
    expect(snapshot.allowedClientTypes).toEqual(["SAFE_EXAM_BROWSER"]);
    expect(snapshot.allowPrinting).toBe(true);
  });

  it("SEB_REQUIRED downgrades to the disabled STANDARD_WEB policy when not available (default/Production availability)", () => {
    const snapshot = buildSecureClientPolicySnapshot({ ...baseSettings, deliveryMode: "SEB_REQUIRED" });
    expect(snapshot.deliveryMode).toBe("STANDARD_WEB");
    expect(snapshot.requireVerifiedClient).toBe(false);
    expect(snapshot.studentPreflightRequired).toBe(false);
  });

  it("SEB_OPTIONAL downgrades to the disabled STANDARD_WEB policy when not available (default/Production availability)", () => {
    const snapshot = buildSecureClientPolicySnapshot({ ...baseSettings, deliveryMode: "SEB_OPTIONAL" });
    expect(snapshot.deliveryMode).toBe("STANDARD_WEB");
    expect(snapshot.allowedClientTypes).toEqual([]);
  });

  it("downgrades an unavailable TETHER_CLIENT_REQUIRED mode to the disabled policy", () => {
    const snapshot = buildSecureClientPolicySnapshot({ ...baseSettings, deliveryMode: "TETHER_CLIENT_REQUIRED" }, DEFAULT_SECURE_CLIENT_AVAILABILITY);
    expect(snapshot.deliveryMode).toBe("STANDARD_WEB");
    expect(snapshot.requireVerifiedClient).toBe(false);
  });

  it("clamps out-of-bounds values instead of trusting them verbatim", () => {
    const snapshot = buildSecureClientPolicySnapshot(
      {
        ...baseSettings,
        deliveryMode: "SEB_OPTIONAL",
        secureClientHeartbeatIntervalSeconds: 999999,
        secureClientMaximumDisplays: 999,
      },
      SEB_AVAILABLE,
    );
    expect(snapshot.heartbeatIntervalSeconds).toBeLessThanOrEqual(120);
    expect(snapshot.maximumDisplays).toBeLessThanOrEqual(3);
  });

  it("derives allowClipboard from blockCopyPaste (inverted)", () => {
    const snapshot = buildSecureClientPolicySnapshot({ ...baseSettings, deliveryMode: "SEB_OPTIONAL", blockCopyPaste: true }, SEB_AVAILABLE);
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
    const built = buildSecureClientPolicySnapshot({ ...baseSettings, deliveryMode: "SEB_REQUIRED" }, SEB_AVAILABLE);
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

// ---------------------------------------------------------------------------
// Single Display Requirement v1 — see docs/secure-client-foundation-seb-v1.md,
// "Display requirement". This does NOT test that SEB itself actually
// blocks a second monitor — see docs/secure-client-foundation-seb-v1.md's
// manual real-device checklist for that. These tests only cover the pure
// policy logic: safe legacy defaults, immutable snapshot behaviour, and
// the STANDARD_WEB/MONITORED_WEB combination guard.
// ---------------------------------------------------------------------------

describe("isValidDisplayPolicy", () => {
  it("accepts only the two documented values", () => {
    expect(isValidDisplayPolicy("UNRESTRICTED")).toBe(true);
    expect(isValidDisplayPolicy("SINGLE_DISPLAY_REQUIRED")).toBe(true);
    expect(isValidDisplayPolicy("MAXIMUM_SECURITY")).toBe(false);
    expect(isValidDisplayPolicy("")).toBe(false);
  });
});

describe("isDisplayPolicyCombinationValid", () => {
  it("UNRESTRICTED is valid with every delivery mode", () => {
    for (const mode of ["STANDARD_WEB", "MONITORED_WEB", "SEB_OPTIONAL", "SEB_REQUIRED", "TETHER_CLIENT_OPTIONAL", "TETHER_CLIENT_REQUIRED"] as const) {
      expect(isDisplayPolicyCombinationValid(mode, "UNRESTRICTED")).toBe(true);
    }
  });

  it("SINGLE_DISPLAY_REQUIRED is valid only with SEB_REQUIRED or SEB_OPTIONAL", () => {
    expect(isDisplayPolicyCombinationValid("SEB_REQUIRED", "SINGLE_DISPLAY_REQUIRED")).toBe(true);
    expect(isDisplayPolicyCombinationValid("SEB_OPTIONAL", "SINGLE_DISPLAY_REQUIRED")).toBe(true);
  });

  it("SINGLE_DISPLAY_REQUIRED is rejected with STANDARD_WEB — never implies enforcement there", () => {
    expect(isDisplayPolicyCombinationValid("STANDARD_WEB", "SINGLE_DISPLAY_REQUIRED")).toBe(false);
  });

  it("SINGLE_DISPLAY_REQUIRED is rejected with MONITORED_WEB and Tether modes (no SEB involved)", () => {
    expect(isDisplayPolicyCombinationValid("MONITORED_WEB", "SINGLE_DISPLAY_REQUIRED")).toBe(false);
    expect(isDisplayPolicyCombinationValid("TETHER_CLIENT_OPTIONAL", "SINGLE_DISPLAY_REQUIRED")).toBe(false);
    expect(isDisplayPolicyCombinationValid("TETHER_CLIENT_REQUIRED", "SINGLE_DISPLAY_REQUIRED")).toBe(false);
  });
});

describe("displayPolicy in buildSecureClientPolicySnapshot / parseSecureClientPolicy", () => {
  it("legacy settings without displayPolicy default to UNRESTRICTED (STANDARD_WEB baseline)", () => {
    const snapshot = buildSecureClientPolicySnapshot(baseSettings);
    expect(snapshot.displayPolicy).toBe("UNRESTRICTED");
  });

  it("a legacy stored snapshot with no displayPolicy key at all parses back as UNRESTRICTED", () => {
    // Simulates a snapshot written before this field existed.
    const legacy = { deliveryMode: "SEB_REQUIRED", requireVerifiedClient: true };
    expect(parseSecureClientPolicy(legacy).displayPolicy).toBe("UNRESTRICTED");
  });

  it("SINGLE_DISPLAY_REQUIRED round-trips through build -> parse when the delivery mode supports it", () => {
    const built = buildSecureClientPolicySnapshot({ ...baseSettings, deliveryMode: "SEB_REQUIRED", displayPolicy: "SINGLE_DISPLAY_REQUIRED" }, SEB_AVAILABLE);
    expect(built.displayPolicy).toBe("SINGLE_DISPLAY_REQUIRED");
    expect(built.requireDisplayCheck).toBe(true);
    expect(built.maximumDisplays).toBe(1);
    const parsed = parseSecureClientPolicy(built);
    expect(parsed).toEqual(built);
  });

  it("an unavailable SEB_REQUIRED downgrade also resets displayPolicy to UNRESTRICTED (never freezes an unenforceable requirement)", () => {
    // DEFAULT_SECURE_CLIENT_AVAILABILITY denies SEB_REQUIRED, so the
    // effective delivery mode downgrades to STANDARD_WEB.
    const snapshot = buildSecureClientPolicySnapshot(
      { ...baseSettings, deliveryMode: "SEB_REQUIRED", displayPolicy: "SINGLE_DISPLAY_REQUIRED" },
      DEFAULT_SECURE_CLIENT_AVAILABILITY,
    );
    expect(snapshot.deliveryMode).toBe("STANDARD_WEB");
    expect(snapshot.displayPolicy).toBe("UNRESTRICTED");
  });

  it("a tampered stored snapshot claiming SINGLE_DISPLAY_REQUIRED for MONITORED_WEB is read back as UNRESTRICTED", () => {
    const tampered = { deliveryMode: "MONITORED_WEB", displayPolicy: "SINGLE_DISPLAY_REQUIRED" };
    expect(parseSecureClientPolicy(tampered).displayPolicy).toBe("UNRESTRICTED");
  });

  it("an unrecognised displayPolicy string falls back to UNRESTRICTED, never throws", () => {
    const tampered = { deliveryMode: "SEB_REQUIRED", displayPolicy: "SOMETHING_FUTURE_AND_UNKNOWN" };
    expect(parseSecureClientPolicy(tampered).displayPolicy).toBe("UNRESTRICTED");
  });

  it("editing the exam's settings after an attempt has started never changes the already-built snapshot (immutability)", () => {
    const built = buildSecureClientPolicySnapshot({ ...baseSettings, deliveryMode: "SEB_REQUIRED", displayPolicy: "SINGLE_DISPLAY_REQUIRED" }, SEB_AVAILABLE);
    // Simulate the lecturer later disabling the requirement — a fresh
    // build call with different settings must not be confused with
    // re-parsing the ALREADY-STORED snapshot from the earlier build.
    const laterSettings = { ...baseSettings, deliveryMode: "SEB_REQUIRED" as const, displayPolicy: "UNRESTRICTED" as const };
    const laterBuild = buildSecureClientPolicySnapshot(laterSettings, SEB_AVAILABLE);
    expect(built.displayPolicy).toBe("SINGLE_DISPLAY_REQUIRED");
    expect(laterBuild.displayPolicy).toBe("UNRESTRICTED");
    // The original snapshot, once parsed back (as if read from the DB),
    // is completely unaffected by the later settings change.
    expect(parseSecureClientPolicy(built).displayPolicy).toBe("SINGLE_DISPLAY_REQUIRED");
  });
});

describe("describeDisplayRequirement", () => {
  it("UNRESTRICTED is NOT_APPLICABLE regardless of delivery mode, with no title/instruction", () => {
    const result = describeDisplayRequirement({ deliveryMode: "SEB_REQUIRED", displayPolicy: "UNRESTRICTED" });
    expect(result.status).toBe("NOT_APPLICABLE");
    expect(result.title).toBeNull();
    expect(result.instruction).toBeNull();
  });

  it("STANDARD_WEB never claims display enforcement, even defensively if displayPolicy were somehow SINGLE_DISPLAY_REQUIRED", () => {
    const result = describeDisplayRequirement({ deliveryMode: "STANDARD_WEB", displayPolicy: "SINGLE_DISPLAY_REQUIRED" });
    expect(result.status).toBe("NOT_ENFORCEABLE_STANDARD_WEB");
    expect(result.instruction).toBe("Not enforceable in standard web mode.");
    expect(result.status).not.toBe("ENFORCED_BY_SECURE_CLIENT");
  });

  it("SEB_REQUIRED + SINGLE_DISPLAY_REQUIRED reports enforcement by the secure exam client with the exact required copy", () => {
    const result = describeDisplayRequirement({ deliveryMode: "SEB_REQUIRED", displayPolicy: "SINGLE_DISPLAY_REQUIRED" });
    expect(result.status).toBe("ENFORCED_BY_SECURE_CLIENT");
    expect(result.title).toBe("Single display required");
    expect(result.instruction).toBe(
      "Disconnect additional monitors, projectors, televisions and wireless displays before starting the exam.",
    );
  });

  it("SEB_OPTIONAL + SINGLE_DISPLAY_REQUIRED also reports enforcement by the secure exam client", () => {
    const result = describeDisplayRequirement({ deliveryMode: "SEB_OPTIONAL", displayPolicy: "SINGLE_DISPLAY_REQUIRED" });
    expect(result.status).toBe("ENFORCED_BY_SECURE_CLIENT");
  });

  it("MONITORED_WEB + SINGLE_DISPLAY_REQUIRED (should not occur, but defensive) is reported as not enforceable, never as enforced", () => {
    const result = describeDisplayRequirement({ deliveryMode: "MONITORED_WEB", displayPolicy: "SINGLE_DISPLAY_REQUIRED" });
    expect(result.status).toBe("NOT_ENFORCEABLE_STANDARD_WEB");
  });
});

// ---------------------------------------------------------------------------
// Lecturer-page availability-gating fix — see
// src/app/lecturer/exams/[id]/page.tsx, "Display requirement". Fixes the
// contradiction where "Single display required" was always selectable and
// unconditionally told the lecturer to choose a Safe Exam Browser delivery
// mode, even when both SEB delivery modes were disabled by
// environment/institution availability gating.
// ---------------------------------------------------------------------------

describe("resolveDisplayRequirementUiState", () => {
  it("SEB unavailable and nothing stored: control is unavailable, with the exact required title/message", () => {
    const result = resolveDisplayRequirementUiState({
      storedDisplayPolicy: "UNRESTRICTED",
      sebOptionalAvailable: false,
      sebRequiredAvailable: false,
    });
    expect(result.kind).toBe("UNAVAILABLE");
    if (result.kind !== "AVAILABLE") {
      expect(result.title).toBe("Single-display enforcement unavailable");
      expect(result.message).toBe(
        "This setting requires Safe Exam Browser, which is not enabled for this institution or environment.",
      );
      // Must never instruct the lecturer to pick a delivery mode that is
      // itself disabled — this is the exact contradiction being fixed.
      expect(result.message).not.toMatch(/choose/i);
      expect(result.message).not.toMatch(/safe exam browser — required/i);
      expect(result.message).not.toMatch(/safe exam browser — optional/i);
    }
  });

  it("only SEB_REQUIRED available: control is available", () => {
    const result = resolveDisplayRequirementUiState({
      storedDisplayPolicy: "UNRESTRICTED",
      sebOptionalAvailable: false,
      sebRequiredAvailable: true,
    });
    expect(result.kind).toBe("AVAILABLE");
  });

  it("only SEB_OPTIONAL available: control is available", () => {
    const result = resolveDisplayRequirementUiState({
      storedDisplayPolicy: "UNRESTRICTED",
      sebOptionalAvailable: true,
      sebRequiredAvailable: false,
    });
    expect(result.kind).toBe("AVAILABLE");
  });

  it("both SEB modes available: control is available", () => {
    const result = resolveDisplayRequirementUiState({
      storedDisplayPolicy: "UNRESTRICTED",
      sebOptionalAvailable: true,
      sebRequiredAvailable: true,
    });
    expect(result.kind).toBe("AVAILABLE");
  });

  it("SINGLE_DISPLAY_REQUIRED already stored but SEB has since become unavailable: reported read-only, not silently cleared", () => {
    const result = resolveDisplayRequirementUiState({
      storedDisplayPolicy: "SINGLE_DISPLAY_REQUIRED",
      sebOptionalAvailable: false,
      sebRequiredAvailable: false,
    });
    expect(result.kind).toBe("STORED_BUT_UNAVAILABLE");
    if (result.kind !== "AVAILABLE") {
      expect(result.title).toBe("Single-display enforcement unavailable");
      expect(result.message).toMatch(/cannot be re-saved/i);
      // The message reassures the lecturer the stored policy has not been
      // silently removed or downgraded, never claims that it HAS been.
      expect(result.message).not.toMatch(/has been removed|has been cleared|disabled automatically/i);
    }
  });
});

describe("resolveDeliveryModeForSingleDisplayRequired", () => {
  it("SEB_REQUIRED available (with or without SEB_OPTIONAL): switches STANDARD_WEB to SEB_REQUIRED", () => {
    const result = resolveDeliveryModeForSingleDisplayRequired({
      currentDeliveryMode: "STANDARD_WEB",
      sebOptionalAvailable: true,
      sebRequiredAvailable: true,
    });
    expect(result).toEqual({ deliveryMode: "SEB_REQUIRED", changed: true });
  });

  it("only SEB_OPTIONAL available: switches STANDARD_WEB to SEB_OPTIONAL", () => {
    const result = resolveDeliveryModeForSingleDisplayRequired({
      currentDeliveryMode: "STANDARD_WEB",
      sebOptionalAvailable: true,
      sebRequiredAvailable: false,
    });
    expect(result).toEqual({ deliveryMode: "SEB_OPTIONAL", changed: true });
  });

  it("switches MONITORED_WEB to a SEB mode too, not just STANDARD_WEB", () => {
    const result = resolveDeliveryModeForSingleDisplayRequired({
      currentDeliveryMode: "MONITORED_WEB",
      sebOptionalAvailable: false,
      sebRequiredAvailable: true,
    });
    expect(result).toEqual({ deliveryMode: "SEB_REQUIRED", changed: true });
  });

  it("already on SEB_REQUIRED or SEB_OPTIONAL: no change reported", () => {
    expect(
      resolveDeliveryModeForSingleDisplayRequired({ currentDeliveryMode: "SEB_REQUIRED", sebOptionalAvailable: true, sebRequiredAvailable: true }),
    ).toEqual({ deliveryMode: "SEB_REQUIRED", changed: false });
    expect(
      resolveDeliveryModeForSingleDisplayRequired({ currentDeliveryMode: "SEB_OPTIONAL", sebOptionalAvailable: true, sebRequiredAvailable: true }),
    ).toEqual({ deliveryMode: "SEB_OPTIONAL", changed: false });
  });

  it("neither SEB mode available (defensive — UI disables the control before this can be reached): echoes the current mode back unchanged", () => {
    const result = resolveDeliveryModeForSingleDisplayRequired({
      currentDeliveryMode: "STANDARD_WEB",
      sebOptionalAvailable: false,
      sebRequiredAvailable: false,
    });
    expect(result).toEqual({ deliveryMode: "STANDARD_WEB", changed: false });
  });
});

describe("isDisplayPolicySaveBlocked", () => {
  it("SEB unavailable: blocks saving SINGLE_DISPLAY_REQUIRED even with a nominally-valid delivery mode", () => {
    expect(
      isDisplayPolicySaveBlocked({
        deliveryMode: "SEB_REQUIRED",
        displayPolicy: "SINGLE_DISPLAY_REQUIRED",
        sebOptionalAvailable: false,
        sebRequiredAvailable: false,
      }),
    ).toBe(true);
  });

  it("SEB required available: does not block saving", () => {
    expect(
      isDisplayPolicySaveBlocked({
        deliveryMode: "SEB_REQUIRED",
        displayPolicy: "SINGLE_DISPLAY_REQUIRED",
        sebOptionalAvailable: false,
        sebRequiredAvailable: true,
      }),
    ).toBe(false);
  });

  it("only SEB optional available: does not block saving when SEB_OPTIONAL is selected", () => {
    expect(
      isDisplayPolicySaveBlocked({
        deliveryMode: "SEB_OPTIONAL",
        displayPolicy: "SINGLE_DISPLAY_REQUIRED",
        sebOptionalAvailable: true,
        sebRequiredAvailable: false,
      }),
    ).toBe(false);
  });

  it("Standard web cannot save Single display required even through manipulated client state (SEB fully available)", () => {
    // Simulates a manipulated/bypassed disabled-radio state: deliveryMode
    // is STANDARD_WEB even though SEB is available and normally the UI
    // would have auto-switched it — the combination itself is what's
    // invalid, independent of availability.
    expect(
      isDisplayPolicySaveBlocked({
        deliveryMode: "STANDARD_WEB",
        displayPolicy: "SINGLE_DISPLAY_REQUIRED",
        sebOptionalAvailable: true,
        sebRequiredAvailable: true,
      }),
    ).toBe(true);
  });

  it("Standard web with SEB unavailable is also blocked (both the combination rule and the availability rule agree)", () => {
    expect(
      isDisplayPolicySaveBlocked({
        deliveryMode: "STANDARD_WEB",
        displayPolicy: "SINGLE_DISPLAY_REQUIRED",
        sebOptionalAvailable: false,
        sebRequiredAvailable: false,
      }),
    ).toBe(true);
  });

  it("UNRESTRICTED is never blocked, regardless of delivery mode or availability", () => {
    expect(
      isDisplayPolicySaveBlocked({
        deliveryMode: "STANDARD_WEB",
        displayPolicy: "UNRESTRICTED",
        sebOptionalAvailable: false,
        sebRequiredAvailable: false,
      }),
    ).toBe(false);
  });

  it("stored Single display required is not silently removed when availability changes: the underlying displayPolicy value is untouched by this check", () => {
    // isDisplayPolicySaveBlocked only reports whether a save attempt
    // should be rejected — it never mutates or clears displayPolicy
    // itself, so a caller that reads it back after SEB becomes
    // unavailable still sees SINGLE_DISPLAY_REQUIRED, never a silently
    // downgraded UNRESTRICTED.
    const draft = { deliveryMode: "SEB_REQUIRED" as const, displayPolicy: "SINGLE_DISPLAY_REQUIRED" as const };
    const blocked = isDisplayPolicySaveBlocked({ ...draft, sebOptionalAvailable: false, sebRequiredAvailable: false });
    expect(blocked).toBe(true);
    expect(draft.displayPolicy).toBe("SINGLE_DISPLAY_REQUIRED");
  });
});
