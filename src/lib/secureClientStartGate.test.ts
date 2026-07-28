import { describe, it, expect } from "vitest";
import { resolveSecureClientStartGate, buildTetherLaunchPagePath } from "./secureClientStartGate";

// ---------------------------------------------------------------------------
// Tether launch/install flow v1 — Production start-protection. See
// src/app/api/exams/[id]/start/route.ts and
// src/app/api/submissions/[id]/route.ts.
// ---------------------------------------------------------------------------

describe("resolveSecureClientStartGate", () => {
  it("Production final exam cannot start in Chrome/Edge: TETHER_CLIENT_REQUIRED, no verified session, no bypass -> redirect", () => {
    const result = resolveSecureClientStartGate({
      effectiveDeliveryMode: "TETHER_CLIENT_REQUIRED",
      hasVerifiedTetherSession: false,
      devBypassAllowed: false,
    });
    expect(result.kind).toBe("REDIRECT_TO_TETHER_LAUNCH");
  });

  it("a verified Tether secure-client session allows the ordinary re-entry path through (e.g. resuming after already launching via Tether)", () => {
    const result = resolveSecureClientStartGate({
      effectiveDeliveryMode: "TETHER_CLIENT_REQUIRED",
      hasVerifiedTetherSession: true,
      devBypassAllowed: false,
    });
    expect(result.kind).toBe("ALLOW");
  });

  it("local/Preview authorised development bypass works: TETHER_CLIENT_REQUIRED, no session, bypass allowed -> allow", () => {
    const result = resolveSecureClientStartGate({
      effectiveDeliveryMode: "TETHER_CLIENT_REQUIRED",
      hasVerifiedTetherSession: false,
      devBypassAllowed: true,
    });
    expect(result.kind).toBe("ALLOW");
  });

  it("Production bypass is always denied: devBypassAllowed itself must already be false in Production (isTetherSecureClientBypassAllowed enforces this) — this function still redirects whenever both inputs are false regardless of which environment produced them", () => {
    const result = resolveSecureClientStartGate({
      effectiveDeliveryMode: "TETHER_CLIENT_REQUIRED",
      hasVerifiedTetherSession: false,
      devBypassAllowed: false,
    });
    expect(result.kind).toBe("REDIRECT_TO_TETHER_LAUNCH");
  });

  it("never touches STANDARD_WEB — always ALLOW regardless of session/bypass state", () => {
    expect(
      resolveSecureClientStartGate({ effectiveDeliveryMode: "STANDARD_WEB", hasVerifiedTetherSession: false, devBypassAllowed: false }).kind,
    ).toBe("ALLOW");
  });

  it("never touches MONITORED_WEB — always ALLOW", () => {
    expect(
      resolveSecureClientStartGate({ effectiveDeliveryMode: "MONITORED_WEB", hasVerifiedTetherSession: false, devBypassAllowed: false }).kind,
    ).toBe("ALLOW");
  });

  it("never touches SEB_REQUIRED — that mode keeps its own separate SEB_NOT_CONFIGURED gate, unaffected by this function", () => {
    expect(
      resolveSecureClientStartGate({ effectiveDeliveryMode: "SEB_REQUIRED", hasVerifiedTetherSession: false, devBypassAllowed: false }).kind,
    ).toBe("ALLOW");
  });

  it("never touches SEB_OPTIONAL or TETHER_CLIENT_OPTIONAL — only TETHER_CLIENT_REQUIRED triggers the gate", () => {
    expect(
      resolveSecureClientStartGate({ effectiveDeliveryMode: "SEB_OPTIONAL", hasVerifiedTetherSession: false, devBypassAllowed: false }).kind,
    ).toBe("ALLOW");
    expect(
      resolveSecureClientStartGate({ effectiveDeliveryMode: "TETHER_CLIENT_OPTIONAL", hasVerifiedTetherSession: false, devBypassAllowed: false })
        .kind,
    ).toBe("ALLOW");
  });
});

describe("buildTetherLaunchPagePath", () => {
  it("builds the expected path for a given examId", () => {
    expect(buildTetherLaunchPagePath("exam-123")).toBe("/student/exams/exam-123/tether-launch");
  });
});
