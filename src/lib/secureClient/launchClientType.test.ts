import { describe, it, expect } from "vitest";
import { resolveLaunchClientType } from "./launchClientType";

// ---------------------------------------------------------------------------
// Tether launch/install flow v1 — fixes a bug in
// src/app/api/submissions/[id]/secure-client/launch/route.ts where a
// TETHER_CLIENT_REQUIRED/OPTIONAL exam with no SecureClientConfiguration
// row (Tether needs none) silently issued an SEB-typed launch manifest.
// ---------------------------------------------------------------------------

describe("resolveLaunchClientType", () => {
  it("TETHER_CLIENT_REQUIRED with no configuration row resolves to TETHER_SECURE_CLIENT — never falls back to SEB", () => {
    expect(resolveLaunchClientType({ deliveryMode: "TETHER_CLIENT_REQUIRED" }, null)).toBe("TETHER_SECURE_CLIENT");
  });

  it("TETHER_CLIENT_OPTIONAL with no configuration row also resolves to TETHER_SECURE_CLIENT", () => {
    expect(resolveLaunchClientType({ deliveryMode: "TETHER_CLIENT_OPTIONAL" }, null)).toBe("TETHER_SECURE_CLIENT");
  });

  it("Tether modes resolve to TETHER_SECURE_CLIENT even if a stray SEB configuration row exists — deliveryMode is authoritative, not the config row", () => {
    expect(resolveLaunchClientType({ deliveryMode: "TETHER_CLIENT_REQUIRED" }, "SAFE_EXAM_BROWSER")).toBe("TETHER_SECURE_CLIENT");
  });

  it("SEB_REQUIRED with an active SEB configuration resolves to SAFE_EXAM_BROWSER (unchanged prior behaviour)", () => {
    expect(resolveLaunchClientType({ deliveryMode: "SEB_REQUIRED" }, "SAFE_EXAM_BROWSER")).toBe("SAFE_EXAM_BROWSER");
  });

  it("SEB_REQUIRED with an active Tether configuration resolves to TETHER_SECURE_CLIENT (unchanged prior fallback behaviour)", () => {
    expect(resolveLaunchClientType({ deliveryMode: "SEB_REQUIRED" }, "TETHER_SECURE_CLIENT")).toBe("TETHER_SECURE_CLIENT");
  });

  it("a mode with no configuration at all defaults harmlessly to SAFE_EXAM_BROWSER (route already 403s before reaching here for STANDARD_WEB)", () => {
    expect(resolveLaunchClientType({ deliveryMode: "STANDARD_WEB" }, null)).toBe("SAFE_EXAM_BROWSER");
  });
});
