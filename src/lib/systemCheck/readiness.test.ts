import { describe, it, expect } from "vitest";
import {
  computeOverallStatus,
  compareVersions,
  evaluateClientVersion,
  evaluateOperatingSystem,
  evaluateDisplayTopology,
  evaluateCameraCheck,
  evaluateMicrophoneCheck,
  evaluateNetworkCheck,
  evaluateClockDifference,
  computeExpiresAtMs,
  isRunExpired,
  resolveSystemCheckMode,
  evaluateFinalExamSystemCheckGate,
  classifyGetUserMediaError,
  REQUIRED_CHECK_IDS,
  OPTIONAL_CHECK_IDS,
  TETHER_ONLY_CHECK_IDS,
  SYSTEM_CHECK_IDS,
  type SystemCheckResults,
} from "./readiness";

const ALL_PASS: SystemCheckResults = Object.fromEntries(SYSTEM_CHECK_IDS.map((id) => [id, { status: "PASS" }])) as SystemCheckResults;

describe("1. readiness aggregation", () => {
  it("all checks PASS -> READY", () => {
    expect(computeOverallStatus(ALL_PASS)).toBe("READY");
  });

  it("a required check BLOCKED -> NOT_READY", () => {
    expect(computeOverallStatus({ ...ALL_PASS, secureClient: { status: "BLOCKED" } })).toBe("NOT_READY");
  });

  it("a required check missing (NOT_CHECKED) -> NOT_READY", () => {
    const partial = { ...ALL_PASS };
    delete partial.displayTopology;
    expect(computeOverallStatus(partial)).toBe("NOT_READY");
  });

  it("a required check WARNING (all else PASS) -> READY_WITH_WARNINGS", () => {
    expect(computeOverallStatus({ ...ALL_PASS, clock: { status: "WARNING" } })).toBe("READY_WITH_WARNINGS");
  });
});

describe("2. required versus optional checks", () => {
  it("every check id is classified as exactly one of required/optional", () => {
    for (const id of SYSTEM_CHECK_IDS) {
      expect(REQUIRED_CHECK_IDS.has(id) !== OPTIONAL_CHECK_IDS.has(id)).toBe(true);
    }
  });

  it("camera and microphone are optional — missing entirely still allows READY", () => {
    const partial = { ...ALL_PASS };
    delete partial.camera;
    delete partial.microphone;
    expect(computeOverallStatus(partial)).toBe("READY");
  });

  it("an optional check BLOCKED degrades to READY_WITH_WARNINGS, never NOT_READY", () => {
    expect(computeOverallStatus({ ...ALL_PASS, camera: { status: "BLOCKED" } })).toBe("READY_WITH_WARNINGS");
  });
});

describe("3. warning and blocked precedence", () => {
  it("a BLOCKED required check overrides any number of WARNINGs — warnings never conceal a block", () => {
    const result = computeOverallStatus({
      ...ALL_PASS,
      clock: { status: "WARNING" },
      network: { status: "WARNING" },
      secureClient: { status: "BLOCKED" },
    });
    expect(result).toBe("NOT_READY");
  });

  it("mixing WARNING and BLOCKED on required checks still resolves to NOT_READY, not READY_WITH_WARNINGS", () => {
    expect(computeOverallStatus({ ...ALL_PASS, clock: { status: "WARNING" }, network: { status: "BLOCKED" } })).toBe("NOT_READY");
  });
});

describe("4. result expiry", () => {
  it("computeExpiresAtMs adds validityHours in ms", () => {
    const checkedAt = 1_000_000;
    expect(computeExpiresAtMs(checkedAt, 24)).toBe(checkedAt + 24 * 60 * 60 * 1000);
  });

  it("isRunExpired is false just before expiry and true at/after expiry", () => {
    const expiresAt = 1_000_000;
    expect(isRunExpired(expiresAt, expiresAt - 1)).toBe(false);
    expect(isRunExpired(expiresAt, expiresAt)).toBe(true);
    expect(isRunExpired(expiresAt, expiresAt + 1)).toBe(true);
  });
});

describe("5. semantic client-version comparison", () => {
  it("compareVersions orders numerically, not lexically (1.9.0 < 1.10.0)", () => {
    expect(compareVersions("1.9.0", "1.10.0")).toBe(-1);
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("1.3.0", "1.3.0")).toBe(0);
    expect(compareVersions("1.3", "1.3.0")).toBe(0);
  });

  it("evaluateClientVersion: below minimum -> BLOCKED (unsupported client is never ready)", () => {
    expect(evaluateClientVersion("1.2.2", "1.3.0")).toEqual({ status: "BLOCKED", reasonCode: "VERSION_UNSUPPORTED" });
  });

  it("evaluateClientVersion: at or above minimum -> PASS", () => {
    expect(evaluateClientVersion("1.3.0", "1.3.0").status).toBe("PASS");
    expect(evaluateClientVersion("1.4.0", "1.3.0").status).toBe("PASS");
  });

  it("evaluateClientVersion: missing version -> NOT_CHECKED", () => {
    expect(evaluateClientVersion(null, "1.3.0").status).toBe("NOT_CHECKED");
  });

  it("evaluateClientVersion: unparsable version -> WARNING, not an outright block", () => {
    expect(evaluateClientVersion("not-a-version", "1.3.0").status).toBe("WARNING");
  });
});

describe("6. OFF, WARN, and REQUIRE modes", () => {
  it("resolveSystemCheckMode passes through valid values", () => {
    expect(resolveSystemCheckMode("OFF")).toBe("OFF");
    expect(resolveSystemCheckMode("WARN")).toBe("WARN");
    expect(resolveSystemCheckMode("REQUIRE")).toBe("REQUIRE");
  });

  it("missing or malformed configuration always falls back to WARN, never REQUIRE — must not accidentally block all students", () => {
    expect(resolveSystemCheckMode(undefined)).toBe("WARN");
    expect(resolveSystemCheckMode(null)).toBe("WARN");
    expect(resolveSystemCheckMode("")).toBe("WARN");
    expect(resolveSystemCheckMode("require")).toBe("WARN");
    expect(resolveSystemCheckMode("garbage")).toBe("WARN");
  });

  it("OFF and WARN never block a final exam regardless of readiness state", () => {
    expect(evaluateFinalExamSystemCheckGate({ mode: "OFF", isFinalExamination: true, latestRun: null, nowMs: 0 })).toEqual({ allowed: true });
    expect(evaluateFinalExamSystemCheckGate({ mode: "WARN", isFinalExamination: true, latestRun: null, nowMs: 0 })).toEqual({ allowed: true });
  });

  it("REQUIRE mode blocks a final exam with no stored run", () => {
    expect(evaluateFinalExamSystemCheckGate({ mode: "REQUIRE", isFinalExamination: true, latestRun: null, nowMs: 1000 })).toEqual({
      allowed: false,
      reason: "SYSTEM_CHECK_REQUIRED",
    });
  });

  it("REQUIRE mode blocks an expired run", () => {
    const result = evaluateFinalExamSystemCheckGate({
      mode: "REQUIRE",
      isFinalExamination: true,
      latestRun: { overallStatus: "READY", expiresAtMs: 1000 },
      nowMs: 2000,
    });
    expect(result).toEqual({ allowed: false, reason: "SYSTEM_CHECK_EXPIRED" });
  });

  it("REQUIRE mode blocks a current NOT_READY run", () => {
    const result = evaluateFinalExamSystemCheckGate({
      mode: "REQUIRE",
      isFinalExamination: true,
      latestRun: { overallStatus: "NOT_READY", expiresAtMs: 5000 },
      nowMs: 1000,
    });
    expect(result).toEqual({ allowed: false, reason: "SYSTEM_CHECK_NOT_READY" });
  });

  it("REQUIRE mode permits both READY and READY_WITH_WARNINGS when current", () => {
    expect(
      evaluateFinalExamSystemCheckGate({ mode: "REQUIRE", isFinalExamination: true, latestRun: { overallStatus: "READY", expiresAtMs: 5000 }, nowMs: 1000 }),
    ).toEqual({ allowed: true });
    expect(
      evaluateFinalExamSystemCheckGate({
        mode: "REQUIRE",
        isFinalExamination: true,
        latestRun: { overallStatus: "READY_WITH_WARNINGS", expiresAtMs: 5000 },
        nowMs: 1000,
      }),
    ).toEqual({ allowed: true });
  });
});

describe("corrective pass — aggregation invariants (ordinary Chrome must never reach READY or READY_WITH_WARNINGS)", () => {
  const chromeAllWebChecksPass: SystemCheckResults = {
    authentication: { status: "PASS" },
    operatingSystem: { status: "PASS" },
    network: { status: "PASS" },
    clock: { status: "PASS" },
    camera: { status: "PASS" },
    microphone: { status: "PASS" },
    // The four Tether-only checks: guaranteed NOT_CHECKED in an ordinary
    // browser, never supplied at all here — matches production reality.
  };

  it("ordinary Chrome with every web-safe check passing is still NOT_READY, never READY_WITH_WARNINGS", () => {
    expect(computeOverallStatus(chromeAllWebChecksPass)).toBe("NOT_READY");
  });

  it("required NOT_CHECKED overrides optional PASS/WARNING results — the four Tether-only checks alone are enough to force NOT_READY even with everything else PASS", () => {
    const partial: SystemCheckResults = { ...ALL_PASS };
    delete partial.secureClient;
    delete partial.clientVersion;
    delete partial.displayTopology;
    delete partial.bridge;
    // Optional checks still explicitly PASS/WARNING — must not rescue overall status.
    partial.camera = { status: "WARNING" };
    partial.microphone = { status: "PASS" };
    expect(computeOverallStatus(partial)).toBe("NOT_READY");
  });

  it("verified Tether with every required check PASS produces READY", () => {
    expect(computeOverallStatus(ALL_PASS)).toBe("READY");
  });

  it("READY_WITH_WARNINGS is possible only when every required check is PASS or WARNING (never BLOCKED/NOT_CHECKED) and at least one check actually warns", () => {
    // All required checks present and non-blocking; one required check (clock) warns.
    const allRequiredOkOneWarns: SystemCheckResults = { ...ALL_PASS, clock: { status: "WARNING" } };
    expect(computeOverallStatus(allRequiredOkOneWarns)).toBe("READY_WITH_WARNINGS");

    // Same warning, but now a DIFFERENT required check is BLOCKED — must
    // demote straight to NOT_READY, never READY_WITH_WARNINGS.
    const oneRequiredBlockedToo: SystemCheckResults = { ...ALL_PASS, clock: { status: "WARNING" }, network: { status: "BLOCKED" } };
    expect(computeOverallStatus(oneRequiredBlockedToo)).toBe("NOT_READY");

    // Same warning, but now a different required check is missing
    // entirely (NOT_CHECKED) — also must demote to NOT_READY.
    const oneRequiredMissingToo: SystemCheckResults = { ...ALL_PASS, clock: { status: "WARNING" } };
    delete oneRequiredMissingToo.bridge;
    expect(computeOverallStatus(oneRequiredMissingToo)).toBe("NOT_READY");
  });
});

describe("non-final assessments are never blocked by this gate, in any mode", () => {
  it("REQUIRE mode ignores a non-final assessment entirely", () => {
    expect(evaluateFinalExamSystemCheckGate({ mode: "REQUIRE", isFinalExamination: false, latestRun: null, nowMs: 0 })).toEqual({ allowed: true });
  });
});

describe("12. display topology Duplicate and Extend are BLOCKED", () => {
  it("EXTEND blocks", () => {
    expect(evaluateDisplayTopology("EXTEND")).toEqual({ status: "BLOCKED", reasonCode: "EXTENDED_DISPLAY" });
  });
  it("CLONE_OR_DUPLICATE blocks", () => {
    expect(evaluateDisplayTopology("CLONE_OR_DUPLICATE")).toEqual({ status: "BLOCKED", reasonCode: "DUPLICATED_DISPLAY" });
  });
  it("a single internal or external display passes", () => {
    expect(evaluateDisplayTopology("INTERNAL_ONLY").status).toBe("PASS");
    expect(evaluateDisplayTopology("EXTERNAL_ONLY").status).toBe("PASS");
  });
});

describe("13. unknown topology does not pass", () => {
  it("UNKNOWN and ERROR both block, never pass", () => {
    expect(evaluateDisplayTopology("UNKNOWN").status).toBe("BLOCKED");
    expect(evaluateDisplayTopology("ERROR").status).toBe("BLOCKED");
  });
  it("never having checked at all is NOT_CHECKED, not a silent pass", () => {
    expect(evaluateDisplayTopology(null).status).toBe("NOT_CHECKED");
  });
});

describe("14. camera stream failure is never classified as no-person-visible", () => {
  it("a permission-denied error blocks with an explicit PERMISSION_DENIED reason, no visibility concept involved", () => {
    const result = evaluateCameraCheck({ errorClass: "PERMISSION_DENIED", streamProducedFrame: false, frameQuality: null });
    expect(result).toEqual({ status: "BLOCKED", reasonCode: "PERMISSION_DENIED" });
  });

  it("a stream that never produces a frame is STREAM_UNAVAILABLE, not a visibility judgement", () => {
    const result = evaluateCameraCheck({ errorClass: null, streamProducedFrame: false, frameQuality: null });
    expect(result.reasonCode).toBe("STREAM_UNAVAILABLE");
    expect(result.reasonCode).not.toMatch(/person|visible/i);
  });

  it("device busy and no device are distinguished from a generic stream failure", () => {
    expect(evaluateCameraCheck({ errorClass: "DEVICE_BUSY", streamProducedFrame: false, frameQuality: null }).reasonCode).toBe("DEVICE_BUSY");
    expect(evaluateCameraCheck({ errorClass: "NO_DEVICE", streamProducedFrame: false, frameQuality: null }).reasonCode).toBe("NO_DEVICE");
  });

  it("a dark frame warns about lighting, never about a missing person", () => {
    const result = evaluateCameraCheck({ errorClass: null, streamProducedFrame: true, frameQuality: "dark" });
    expect(result).toEqual({ status: "WARNING", reasonCode: "LIGHTING_TOO_LOW" });
  });

  it("an operational stream with a good frame passes", () => {
    expect(evaluateCameraCheck({ errorClass: null, streamProducedFrame: true, frameQuality: "ok" })).toEqual({ status: "PASS", reasonCode: "OPERATIONAL" });
  });

  it("classifyGetUserMediaError maps DOMException names to plain-language classes", () => {
    expect(classifyGetUserMediaError("NotAllowedError")).toBe("PERMISSION_DENIED");
    expect(classifyGetUserMediaError("NotFoundError")).toBe("NO_DEVICE");
    expect(classifyGetUserMediaError("NotReadableError")).toBe("DEVICE_BUSY");
    expect(classifyGetUserMediaError(null)).toBe(null);
  });
});

describe("microphone check", () => {
  it("distinguishes permission denied, no device, device busy, and operational", () => {
    expect(evaluateMicrophoneCheck({ errorClass: "PERMISSION_DENIED", streamStarted: false }).reasonCode).toBe("PERMISSION_DENIED");
    expect(evaluateMicrophoneCheck({ errorClass: "NO_DEVICE", streamStarted: false }).reasonCode).toBe("NO_DEVICE");
    expect(evaluateMicrophoneCheck({ errorClass: "DEVICE_BUSY", streamStarted: false }).reasonCode).toBe("DEVICE_BUSY");
    expect(evaluateMicrophoneCheck({ errorClass: null, streamStarted: true })).toEqual({ status: "PASS", reasonCode: "OPERATIONAL" });
  });
});

describe("network connectivity", () => {
  it("unreachable endpoint blocks regardless of latency", () => {
    expect(evaluateNetworkCheck({ allEndpointsReachable: false, approxLatencyMs: 10 }).status).toBe("BLOCKED");
  });
  it("low latency passes; high latency warns; very high latency blocks", () => {
    expect(evaluateNetworkCheck({ allEndpointsReachable: true, approxLatencyMs: 100 }).status).toBe("PASS");
    expect(evaluateNetworkCheck({ allEndpointsReachable: true, approxLatencyMs: 1_000 }).status).toBe("WARNING");
    expect(evaluateNetworkCheck({ allEndpointsReachable: true, approxLatencyMs: 6_000 }).status).toBe("BLOCKED");
  });
  it("never claims a guaranteed exam experience — reason codes stay factual, not promissory", () => {
    const result = evaluateNetworkCheck({ allEndpointsReachable: true, approxLatencyMs: 1_000 });
    expect(result.reasonCode).not.toMatch(/guarantee/i);
  });
});

describe("operating system support", () => {
  it("Windows passes; every other platform is a clear unsupported block", () => {
    expect(evaluateOperatingSystem("win32").status).toBe("PASS");
    expect(evaluateOperatingSystem("darwin").status).toBe("BLOCKED");
    expect(evaluateOperatingSystem("linux").status).toBe("BLOCKED");
    expect(evaluateOperatingSystem(null).status).toBe("NOT_CHECKED");
  });
});

describe("7. ordinary browser cannot produce READY", () => {
  it("the four Tether-only checks are exactly the ones a browser can never establish, and all four are required", () => {
    for (const id of TETHER_ONLY_CHECK_IDS) {
      expect(REQUIRED_CHECK_IDS.has(id)).toBe(true);
    }
    expect(TETHER_ONLY_CHECK_IDS.size).toBe(4);
  });

  it("with every Tether-only check NOT_CHECKED (the guaranteed browser state) overall is always NOT_READY, no matter what every other check reports", () => {
    const browserResults: SystemCheckResults = { ...ALL_PASS };
    for (const id of TETHER_ONLY_CHECK_IDS) delete browserResults[id];
    expect(computeOverallStatus(browserResults)).toBe("NOT_READY");
  });
});

describe("clock difference", () => {
  it("small differences pass, material differences warn, severe differences block", () => {
    expect(evaluateClockDifference(1_000_000, 1_000_000).status).toBe("PASS");
    expect(evaluateClockDifference(1_000_000 + 90_000, 1_000_000).status).toBe("WARNING");
    expect(evaluateClockDifference(1_000_000 + 300_000, 1_000_000).status).toBe("BLOCKED");
  });
  it("block threshold stays comfortably inside the secure-launch token TTL (300s) so BLOCKED means a real launch would fail", () => {
    // 240s default block threshold < 300s token TTL.
    expect(evaluateClockDifference(1_000_000 + 241_000, 1_000_000).status).toBe("BLOCKED");
  });
});
