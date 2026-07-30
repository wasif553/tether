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
// Tether launch/install flow v1 — tetherClientRequiredAvailable is now
// true by default in secureClientAvailability() (see
// src/lib/secureClientAvailability.ts), but this test fixture stays
// explicit rather than importing that module, since this file tests the
// pure policy layer in isolation from the availability-gating layer.
const TETHER_AVAILABLE = { ...DEFAULT_SECURE_CLIENT_AVAILABILITY, tetherClientRequiredAvailable: true, tetherClientOptionalAvailable: true };

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

  it("SINGLE_DISPLAY_REQUIRED is valid with SEB_REQUIRED or SEB_OPTIONAL", () => {
    expect(isDisplayPolicyCombinationValid("SEB_REQUIRED", "SINGLE_DISPLAY_REQUIRED")).toBe(true);
    expect(isDisplayPolicyCombinationValid("SEB_OPTIONAL", "SINGLE_DISPLAY_REQUIRED")).toBe(true);
  });

  it("Tether launch/install flow v1 — SINGLE_DISPLAY_REQUIRED is also valid with TETHER_CLIENT_REQUIRED or TETHER_CLIENT_OPTIONAL", () => {
    expect(isDisplayPolicyCombinationValid("TETHER_CLIENT_REQUIRED", "SINGLE_DISPLAY_REQUIRED")).toBe(true);
    expect(isDisplayPolicyCombinationValid("TETHER_CLIENT_OPTIONAL", "SINGLE_DISPLAY_REQUIRED")).toBe(true);
  });

  it("SINGLE_DISPLAY_REQUIRED is rejected with STANDARD_WEB — never implies enforcement there", () => {
    expect(isDisplayPolicyCombinationValid("STANDARD_WEB", "SINGLE_DISPLAY_REQUIRED")).toBe(false);
  });

  it("SINGLE_DISPLAY_REQUIRED is rejected with MONITORED_WEB (no secure client involved at all)", () => {
    expect(isDisplayPolicyCombinationValid("MONITORED_WEB", "SINGLE_DISPLAY_REQUIRED")).toBe(false);
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

  it("Tether launch/install flow v1 — TETHER_CLIENT_REQUIRED + SINGLE_DISPLAY_REQUIRED freezes the exact 6 required fields into the immutable snapshot", () => {
    const snapshot = buildSecureClientPolicySnapshot(
      { ...baseSettings, deliveryMode: "TETHER_CLIENT_REQUIRED", displayPolicy: "SINGLE_DISPLAY_REQUIRED" },
      TETHER_AVAILABLE,
    );
    expect(snapshot.deliveryMode).toBe("TETHER_CLIENT_REQUIRED");
    expect(snapshot.allowedClientTypes).toEqual(["TETHER_SECURE_CLIENT"]);
    expect(snapshot.requireVerifiedClient).toBe(true);
    expect(snapshot.displayPolicy).toBe("SINGLE_DISPLAY_REQUIRED");
    expect(snapshot.requireDisplayCheck).toBe(true);
    expect(snapshot.maximumDisplays).toBe(1);
    // Round-trips identically through parseSecureClientPolicy, exactly
    // like the SEB case above.
    expect(parseSecureClientPolicy(snapshot)).toEqual(snapshot);
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

  it("Tether launch/install flow v1 — TETHER_CLIENT_REQUIRED + SINGLE_DISPLAY_REQUIRED reports enforcement by the secure exam client with the exact required copy", () => {
    const result = describeDisplayRequirement({ deliveryMode: "TETHER_CLIENT_REQUIRED", displayPolicy: "SINGLE_DISPLAY_REQUIRED" });
    expect(result.status).toBe("ENFORCED_BY_SECURE_CLIENT");
    expect(result.title).toBe("Single display required");
    expect(result.instruction).toBe(
      "Disconnect additional monitors, projectors, televisions and wireless displays before starting the exam.",
    );
  });

  it("TETHER_CLIENT_OPTIONAL + SINGLE_DISPLAY_REQUIRED also reports enforcement by the secure exam client", () => {
    const result = describeDisplayRequirement({ deliveryMode: "TETHER_CLIENT_OPTIONAL", displayPolicy: "SINGLE_DISPLAY_REQUIRED" });
    expect(result.status).toBe("ENFORCED_BY_SECURE_CLIENT");
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

/** Convenience default for tests that only care about the SEB axis — every Tether flag off, matching the pre-Tether-fix test fixtures below unless a test overrides them. */
const NO_TETHER = { tetherClientRequiredAvailable: false, tetherClientOptionalAvailable: false };

describe("resolveDisplayRequirementUiState", () => {
  it("nothing available (SEB nor Tether) + UNRESTRICTED stored: No display restriction stays enabled, only Single display required is disabled, notice is informational (not blocking)", () => {
    const result = resolveDisplayRequirementUiState({
      storedDisplayPolicy: "UNRESTRICTED",
      sebOptionalAvailable: false,
      sebRequiredAvailable: false,
      ...NO_TETHER,
    });
    expect(result.kind).toBe("UNAVAILABLE");
    // Standard web + No display restriction remains a fully valid,
    // saveable configuration — this radio must NOT be disabled.
    expect(result.unrestrictedDisabled).toBe(false);
    expect(result.singleDisplayRequiredDisabled).toBe(true);
    expect(result.notice).not.toBeNull();
    expect(result.notice?.tone).toBe("INFO");
    expect(result.notice?.title).toBe("Single-display enforcement unavailable");
    expect(result.notice?.message).toBe("Tether Secure Browser or Safe Exam Browser is not enabled for this institution or environment.");
    // Must never instruct the lecturer to pick a delivery mode that is
    // itself disabled — this is the exact contradiction being fixed.
    expect(result.notice?.message).not.toMatch(/choose/i);
    expect(result.notice?.message).not.toMatch(/safe exam browser — required/i);
    expect(result.notice?.message).not.toMatch(/safe exam browser — optional/i);
    // isDisplayPolicySaveBlocked (the actual save gate) agrees this must
    // not block saving.
    expect(
      isDisplayPolicySaveBlocked({ deliveryMode: "STANDARD_WEB", displayPolicy: "UNRESTRICTED", sebOptionalAvailable: false, sebRequiredAvailable: false, ...NO_TETHER }),
    ).toBe(false);
  });

  it("only SEB_REQUIRED available: both display choices operate normally (nothing disabled, no notice)", () => {
    const result = resolveDisplayRequirementUiState({
      storedDisplayPolicy: "UNRESTRICTED",
      sebOptionalAvailable: false,
      sebRequiredAvailable: true,
      ...NO_TETHER,
    });
    expect(result.kind).toBe("AVAILABLE");
    expect(result.unrestrictedDisabled).toBe(false);
    expect(result.singleDisplayRequiredDisabled).toBe(false);
    expect(result.notice).toBeNull();
  });

  it("only SEB_OPTIONAL available: both display choices operate normally (nothing disabled, no notice)", () => {
    const result = resolveDisplayRequirementUiState({
      storedDisplayPolicy: "UNRESTRICTED",
      sebOptionalAvailable: true,
      sebRequiredAvailable: false,
      ...NO_TETHER,
    });
    expect(result.kind).toBe("AVAILABLE");
    expect(result.unrestrictedDisabled).toBe(false);
    expect(result.singleDisplayRequiredDisabled).toBe(false);
    expect(result.notice).toBeNull();
  });

  it("both SEB modes available: both display choices operate normally (nothing disabled, no notice), including when SINGLE_DISPLAY_REQUIRED is already stored", () => {
    const result = resolveDisplayRequirementUiState({
      storedDisplayPolicy: "SINGLE_DISPLAY_REQUIRED",
      sebOptionalAvailable: true,
      sebRequiredAvailable: true,
      ...NO_TETHER,
    });
    expect(result.kind).toBe("AVAILABLE");
    expect(result.unrestrictedDisabled).toBe(false);
    expect(result.singleDisplayRequiredDisabled).toBe(false);
    expect(result.notice).toBeNull();
  });

  it("nothing available + stored SINGLE_DISPLAY_REQUIRED: both options locked read-only, notice states it cannot be changed or re-saved, and never claims removal", () => {
    const result = resolveDisplayRequirementUiState({
      storedDisplayPolicy: "SINGLE_DISPLAY_REQUIRED",
      sebOptionalAvailable: false,
      sebRequiredAvailable: false,
      ...NO_TETHER,
    });
    expect(result.kind).toBe("STORED_BUT_UNAVAILABLE");
    // Both options are locked in this exceptional state — the lecturer
    // cannot even switch back to UNRESTRICTED through this control while
    // no display-aware client is available, so the stored policy is
    // never edited out from under it.
    expect(result.unrestrictedDisabled).toBe(true);
    expect(result.singleDisplayRequiredDisabled).toBe(true);
    expect(result.notice).not.toBeNull();
    expect(result.notice?.tone).toBe("LOCKED");
    expect(result.notice?.title).toBe("Single-display enforcement unavailable");
    expect(result.notice?.message).toMatch(/cannot be changed or re-saved/i);
    expect(result.notice?.message).toMatch(/restored/i);
    // The message reassures the lecturer the stored policy has not been
    // silently removed or downgraded, never claims that it HAS been.
    expect(result.notice?.message).not.toMatch(/has been removed|has been cleared|disabled automatically/i);
    // isDisplayPolicySaveBlocked (the actual save gate) agrees this must
    // block saving/re-saving.
    expect(
      isDisplayPolicySaveBlocked({
        deliveryMode: "SEB_REQUIRED",
        displayPolicy: "SINGLE_DISPLAY_REQUIRED",
        sebOptionalAvailable: false,
        sebRequiredAvailable: false,
        ...NO_TETHER,
      }),
    ).toBe(true);
  });

  it("does not repeat the same explanation between the UNAVAILABLE and STORED_BUT_UNAVAILABLE notices' titles vs. their institution/environment-specific detail", () => {
    // Both share the same short title (by design — same underlying
    // reason), but the messages must differ because they describe
    // different lecturer-facing consequences (nothing at stake vs. a
    // stored policy frozen in place).
    const unavailable = resolveDisplayRequirementUiState({ storedDisplayPolicy: "UNRESTRICTED", sebOptionalAvailable: false, sebRequiredAvailable: false, ...NO_TETHER });
    const storedButUnavailable = resolveDisplayRequirementUiState({
      storedDisplayPolicy: "SINGLE_DISPLAY_REQUIRED",
      sebOptionalAvailable: false,
      sebRequiredAvailable: false,
      ...NO_TETHER,
    });
    expect(unavailable.notice?.title).toBe(storedButUnavailable.notice?.title);
    expect(unavailable.notice?.message).not.toBe(storedButUnavailable.notice?.message);
  });

  // -------------------------------------------------------------------------
  // Lecturer availability fix — Tether Secure Browser is the first-party,
  // generally-available client and must gate this control exactly like
  // the SEB booleans always have. Before this fix, resolveDisplayRequirementUiState
  // only ever looked at the SEB booleans, so the lecturer UI showed
  // "Single-display enforcement unavailable" / "Safe Exam Browser is not
  // enabled..." even with TETHER_CLIENT_REQUIRED_DISABLED=false.
  // -------------------------------------------------------------------------

  it("only Tether required available (both SEB modes off): Single display required is selectable, no notice — this is the exact bug report scenario", () => {
    const result = resolveDisplayRequirementUiState({
      storedDisplayPolicy: "UNRESTRICTED",
      sebOptionalAvailable: false,
      sebRequiredAvailable: false,
      tetherClientRequiredAvailable: true,
      tetherClientOptionalAvailable: false,
    });
    expect(result.kind).toBe("AVAILABLE");
    expect(result.unrestrictedDisabled).toBe(false);
    expect(result.singleDisplayRequiredDisabled).toBe(false);
    expect(result.notice).toBeNull();
  });

  it("only Tether optional available: also treated as available", () => {
    const result = resolveDisplayRequirementUiState({
      storedDisplayPolicy: "UNRESTRICTED",
      sebOptionalAvailable: false,
      sebRequiredAvailable: false,
      tetherClientRequiredAvailable: false,
      tetherClientOptionalAvailable: true,
    });
    expect(result.kind).toBe("AVAILABLE");
    expect(result.singleDisplayRequiredDisabled).toBe(false);
  });

  it("Tether required available + stored SINGLE_DISPLAY_REQUIRED: never locked, since Tether is actually enabled", () => {
    const result = resolveDisplayRequirementUiState({
      storedDisplayPolicy: "SINGLE_DISPLAY_REQUIRED",
      sebOptionalAvailable: false,
      sebRequiredAvailable: false,
      tetherClientRequiredAvailable: true,
      tetherClientOptionalAvailable: false,
    });
    expect(result.kind).toBe("AVAILABLE");
    expect(result.singleDisplayRequiredDisabled).toBe(false);
    expect(result.notice).toBeNull();
  });
});

describe("resolveDeliveryModeForSingleDisplayRequired", () => {
  it("SEB_REQUIRED available (with or without SEB_OPTIONAL, no Tether): switches STANDARD_WEB to SEB_REQUIRED", () => {
    const result = resolveDeliveryModeForSingleDisplayRequired({
      currentDeliveryMode: "STANDARD_WEB",
      sebOptionalAvailable: true,
      sebRequiredAvailable: true,
      ...NO_TETHER,
    });
    expect(result).toEqual({ deliveryMode: "SEB_REQUIRED", changed: true });
  });

  it("only SEB_OPTIONAL available: switches STANDARD_WEB to SEB_OPTIONAL", () => {
    const result = resolveDeliveryModeForSingleDisplayRequired({
      currentDeliveryMode: "STANDARD_WEB",
      sebOptionalAvailable: true,
      sebRequiredAvailable: false,
      ...NO_TETHER,
    });
    expect(result).toEqual({ deliveryMode: "SEB_OPTIONAL", changed: true });
  });

  it("switches MONITORED_WEB to a SEB mode too, not just STANDARD_WEB", () => {
    const result = resolveDeliveryModeForSingleDisplayRequired({
      currentDeliveryMode: "MONITORED_WEB",
      sebOptionalAvailable: false,
      sebRequiredAvailable: true,
      ...NO_TETHER,
    });
    expect(result).toEqual({ deliveryMode: "SEB_REQUIRED", changed: true });
  });

  it("already on SEB_REQUIRED or SEB_OPTIONAL: no change reported", () => {
    expect(
      resolveDeliveryModeForSingleDisplayRequired({ currentDeliveryMode: "SEB_REQUIRED", sebOptionalAvailable: true, sebRequiredAvailable: true, ...NO_TETHER }),
    ).toEqual({ deliveryMode: "SEB_REQUIRED", changed: false });
    expect(
      resolveDeliveryModeForSingleDisplayRequired({ currentDeliveryMode: "SEB_OPTIONAL", sebOptionalAvailable: true, sebRequiredAvailable: true, ...NO_TETHER }),
    ).toEqual({ deliveryMode: "SEB_OPTIONAL", changed: false });
  });

  it("nothing available (defensive — UI disables the control before this can be reached): echoes the current mode back unchanged", () => {
    const result = resolveDeliveryModeForSingleDisplayRequired({
      currentDeliveryMode: "STANDARD_WEB",
      sebOptionalAvailable: false,
      sebRequiredAvailable: false,
      ...NO_TETHER,
    });
    expect(result).toEqual({ deliveryMode: "STANDARD_WEB", changed: false });
  });

  // -------------------------------------------------------------------------
  // Lecturer availability fix — Tether Secure Browser is the primary
  // Tether workflow, so it is preferred over SEB when auto-switching.
  // -------------------------------------------------------------------------

  it("Tether required available (even alongside SEB): prefers TETHER_CLIENT_REQUIRED — Tether is the primary workflow, not SEB", () => {
    const result = resolveDeliveryModeForSingleDisplayRequired({
      currentDeliveryMode: "STANDARD_WEB",
      sebOptionalAvailable: true,
      sebRequiredAvailable: true,
      tetherClientRequiredAvailable: true,
      tetherClientOptionalAvailable: true,
    });
    expect(result).toEqual({ deliveryMode: "TETHER_CLIENT_REQUIRED", changed: true });
  });

  it("only Tether optional available (no SEB, no Tether required): switches to TETHER_CLIENT_OPTIONAL", () => {
    const result = resolveDeliveryModeForSingleDisplayRequired({
      currentDeliveryMode: "MONITORED_WEB",
      sebOptionalAvailable: false,
      sebRequiredAvailable: false,
      tetherClientRequiredAvailable: false,
      tetherClientOptionalAvailable: true,
    });
    expect(result).toEqual({ deliveryMode: "TETHER_CLIENT_OPTIONAL", changed: true });
  });

  it("already on TETHER_CLIENT_REQUIRED: no change reported", () => {
    const result = resolveDeliveryModeForSingleDisplayRequired({
      currentDeliveryMode: "TETHER_CLIENT_REQUIRED",
      sebOptionalAvailable: true,
      sebRequiredAvailable: true,
      tetherClientRequiredAvailable: true,
      tetherClientOptionalAvailable: true,
    });
    expect(result).toEqual({ deliveryMode: "TETHER_CLIENT_REQUIRED", changed: false });
  });

  it("SEB_REQUIRED preferred over Tether optional when Tether required is unavailable", () => {
    const result = resolveDeliveryModeForSingleDisplayRequired({
      currentDeliveryMode: "STANDARD_WEB",
      sebOptionalAvailable: false,
      sebRequiredAvailable: true,
      tetherClientRequiredAvailable: false,
      tetherClientOptionalAvailable: true,
    });
    expect(result).toEqual({ deliveryMode: "SEB_REQUIRED", changed: true });
  });
});

describe("isDisplayPolicySaveBlocked", () => {
  it("nothing available (SEB nor Tether): blocks saving SINGLE_DISPLAY_REQUIRED even with a nominally-valid delivery mode", () => {
    expect(
      isDisplayPolicySaveBlocked({
        deliveryMode: "SEB_REQUIRED",
        displayPolicy: "SINGLE_DISPLAY_REQUIRED",
        sebOptionalAvailable: false,
        sebRequiredAvailable: false,
        ...NO_TETHER,
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
        ...NO_TETHER,
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
        ...NO_TETHER,
      }),
    ).toBe(false);
  });

  it("Standard web cannot save Single display required even through manipulated client state (SEB and Tether fully available)", () => {
    // Simulates a manipulated/bypassed disabled-radio state: deliveryMode
    // is STANDARD_WEB even though SEB/Tether are available and normally
    // the UI would have auto-switched it — the combination itself is
    // what's invalid, independent of availability.
    expect(
      isDisplayPolicySaveBlocked({
        deliveryMode: "STANDARD_WEB",
        displayPolicy: "SINGLE_DISPLAY_REQUIRED",
        sebOptionalAvailable: true,
        sebRequiredAvailable: true,
        tetherClientRequiredAvailable: true,
        tetherClientOptionalAvailable: true,
      }),
    ).toBe(true);
  });

  it("Standard web with nothing available is also blocked (both the combination rule and the availability rule agree)", () => {
    expect(
      isDisplayPolicySaveBlocked({
        deliveryMode: "STANDARD_WEB",
        displayPolicy: "SINGLE_DISPLAY_REQUIRED",
        sebOptionalAvailable: false,
        sebRequiredAvailable: false,
        ...NO_TETHER,
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
        ...NO_TETHER,
      }),
    ).toBe(false);
  });

  it("stored Single display required is not silently removed when availability changes: the underlying displayPolicy value is untouched by this check", () => {
    // isDisplayPolicySaveBlocked only reports whether a save attempt
    // should be rejected — it never mutates or clears displayPolicy
    // itself, so a caller that reads it back after availability changes
    // still sees SINGLE_DISPLAY_REQUIRED, never a silently downgraded
    // UNRESTRICTED.
    const draft = { deliveryMode: "SEB_REQUIRED" as const, displayPolicy: "SINGLE_DISPLAY_REQUIRED" as const };
    const blocked = isDisplayPolicySaveBlocked({ ...draft, sebOptionalAvailable: false, sebRequiredAvailable: false, ...NO_TETHER });
    expect(blocked).toBe(true);
    expect(draft.displayPolicy).toBe("SINGLE_DISPLAY_REQUIRED");
  });

  // -------------------------------------------------------------------------
  // Lecturer availability fix — Task 6: "Tether required is enabled ...
  // single display becomes selectable for Tether required."
  // -------------------------------------------------------------------------

  it("Tether required available: does not block saving TETHER_CLIENT_REQUIRED + SINGLE_DISPLAY_REQUIRED", () => {
    expect(
      isDisplayPolicySaveBlocked({
        deliveryMode: "TETHER_CLIENT_REQUIRED",
        displayPolicy: "SINGLE_DISPLAY_REQUIRED",
        sebOptionalAvailable: false,
        sebRequiredAvailable: false,
        tetherClientRequiredAvailable: true,
        tetherClientOptionalAvailable: false,
      }),
    ).toBe(false);
  });

  it("Tether required UNAVAILABLE (kill switch true): blocks saving TETHER_CLIENT_REQUIRED + SINGLE_DISPLAY_REQUIRED", () => {
    expect(
      isDisplayPolicySaveBlocked({
        deliveryMode: "TETHER_CLIENT_REQUIRED",
        displayPolicy: "SINGLE_DISPLAY_REQUIRED",
        sebOptionalAvailable: false,
        sebRequiredAvailable: false,
        tetherClientRequiredAvailable: false,
        tetherClientOptionalAvailable: false,
      }),
    ).toBe(true);
  });

  it("Standard web still cannot claim reliable single-display enforcement even with Tether fully available (Task 3: Standard/Monitored web must stay unable)", () => {
    expect(
      isDisplayPolicySaveBlocked({
        deliveryMode: "STANDARD_WEB",
        displayPolicy: "SINGLE_DISPLAY_REQUIRED",
        sebOptionalAvailable: false,
        sebRequiredAvailable: false,
        tetherClientRequiredAvailable: true,
        tetherClientOptionalAvailable: true,
      }),
    ).toBe(true);
    expect(
      isDisplayPolicySaveBlocked({
        deliveryMode: "MONITORED_WEB",
        displayPolicy: "SINGLE_DISPLAY_REQUIRED",
        sebOptionalAvailable: false,
        sebRequiredAvailable: false,
        tetherClientRequiredAvailable: true,
        tetherClientOptionalAvailable: true,
      }),
    ).toBe(true);
  });
});
