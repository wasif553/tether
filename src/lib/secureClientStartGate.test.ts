import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
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

// ---------------------------------------------------------------------------
// Corrective pass v1.2.1, Task E — "direct dashboard launch activates the
// same policy as protocol launch". Both the tether-launch page's own
// POST /api/exams/[id]/start (protocol/dashboard-with-known-exam path)
// and GET /api/submissions/[id] (the actual content-serving route, hit
// regardless of how the student navigated there — including "launch the
// .exe directly, sign in, pick the exam from the dashboard, click
// Continue") call this exact same pure function with the same inputs.
// There is no second, divergent gate implementation for either path —
// this is what makes "activates the same policy" true by construction,
// not by convention.
// ---------------------------------------------------------------------------

describe("Task E — start-gate parity between protocol and direct-dashboard launch", () => {
  it("both the /start route (protocol/tether-launch path) and the content-serving /submissions/[id] route (direct-launch/dashboard path) import and call resolveSecureClientStartGate — no separate/divergent gate exists for either path", () => {
    const startRouteSource = fs.readFileSync(
      path.join(__dirname, "..", "app", "api", "exams", "[id]", "start", "route.ts"),
      "utf8",
    );
    const submissionsRouteSource = fs.readFileSync(
      path.join(__dirname, "..", "app", "api", "submissions", "[id]", "route.ts"),
      "utf8",
    );
    expect(startRouteSource).toMatch(/resolveSecureClientStartGate\(/);
    expect(submissionsRouteSource).toMatch(/resolveSecureClientStartGate\(/);
  });

  it("given identical inputs, the decision a direct-dashboard student sees (via submissions/[id]) is identical to what a protocol-launch student sees (via /start) — same function, same result", () => {
    const inputs = { effectiveDeliveryMode: "TETHER_CLIENT_REQUIRED" as const, hasVerifiedTetherSession: false, devBypassAllowed: false };
    const viaStartRoutePath = resolveSecureClientStartGate(inputs);
    const viaDirectDashboardPath = resolveSecureClientStartGate(inputs);
    expect(viaDirectDashboardPath).toEqual(viaStartRoutePath);
    expect(viaDirectDashboardPath.kind).toBe("REDIRECT_TO_TETHER_LAUNCH");
  });
});
