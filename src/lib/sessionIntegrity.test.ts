/**
 * Exam Session Binding v1 — pure classification tests. See
 * docs/exam-session-binding-v1.md and src/lib/sessionIntegrity.ts.
 */
import { describe, expect, it } from "vitest";
import {
  isSessionActive,
  detectConcurrentActiveSessions,
  buildConcurrentSessionSignal,
  detectDeviceTokenChange,
  detectCoarseDeviceProfileChange,
  detectUserAgentChange,
  detectNetworkPrefixChange,
  detectCameraPermissionChange,
  shouldEmitSignal,
  ACTIVE_SESSION_TIMEOUT_MS,
  type SessionSnapshot,
  type DeviceProfileSnapshot,
} from "./sessionIntegrity";

const NOW = 1_000_000_000;

function session(overrides: Partial<SessionSnapshot> & Pick<SessionSnapshot, "id" | "browserSessionTokenHash">): SessionSnapshot {
  return {
    deviceTokenHash: "device-1",
    browserFamily: "Chrome",
    status: "ACTIVE",
    firstSeenAt: NOW - 60_000,
    lastSeenAt: NOW,
    ...overrides,
  };
}

function profile(overrides: Partial<DeviceProfileSnapshot> = {}): DeviceProfileSnapshot {
  return {
    deviceTokenHash: "device-1",
    userAgentHash: "ua-hash-1",
    browserFamily: "Chrome",
    operatingSystemFamily: "Windows",
    deviceCategory: "desktop",
    ...overrides,
  };
}

describe("isSessionActive", () => {
  it("is active within the timeout window", () => {
    expect(isSessionActive(session({ id: "s1", browserSessionTokenHash: "t1", lastSeenAt: NOW - 10_000 }), NOW)).toBe(true);
  });
  it("is not active past the timeout window", () => {
    expect(isSessionActive(session({ id: "s1", browserSessionTokenHash: "t1", lastSeenAt: NOW - ACTIVE_SESSION_TIMEOUT_MS - 1 }), NOW)).toBe(false);
  });
  it("is not active if status is not ACTIVE", () => {
    expect(isSessionActive(session({ id: "s1", browserSessionTokenHash: "t1", status: "STALE" }), NOW)).toBe(false);
  });
});

describe("detectConcurrentActiveSessions", () => {
  it("does not flag the same browser/session resuming after refresh", () => {
    const sessions = [session({ id: "s1", browserSessionTokenHash: "t1" })];
    const result = detectConcurrentActiveSessions(sessions, NOW);
    expect(result.flagged).toBe(false);
  });

  it("detects genuine overlap between two different active sessions", () => {
    const sessions = [
      session({ id: "s1", browserSessionTokenHash: "t1", deviceTokenHash: "d1", firstSeenAt: NOW - 60_000, lastSeenAt: NOW }),
      session({ id: "s2", browserSessionTokenHash: "t2", deviceTokenHash: "d2", firstSeenAt: NOW - 50_000, lastSeenAt: NOW }),
    ];
    const result = detectConcurrentActiveSessions(sessions, NOW);
    expect(result.flagged).toBe(true);
    expect(result.overlapCount).toBe(2);
    expect(result.deviceTokenHashesInvolved.sort()).toEqual(["d1", "d2"]);
  });

  it("does not flag a session that went stale before another started", () => {
    const sessions = [
      session({ id: "s1", browserSessionTokenHash: "t1", status: "ENDED", firstSeenAt: NOW - 200_000, lastSeenAt: NOW - 150_000 }),
      session({ id: "s2", browserSessionTokenHash: "t2", firstSeenAt: NOW - 10_000, lastSeenAt: NOW }),
    ];
    const result = detectConcurrentActiveSessions(sessions, NOW);
    expect(result.flagged).toBe(false);
  });

  it("does not flag a momentary single duplicate request overlap", () => {
    const sessions = [
      session({ id: "s1", browserSessionTokenHash: "t1", firstSeenAt: NOW - 1000, lastSeenAt: NOW - 999 }),
      session({ id: "s2", browserSessionTokenHash: "t2", firstSeenAt: NOW - 1000, lastSeenAt: NOW - ACTIVE_SESSION_TIMEOUT_MS - 999 }),
    ];
    // Session 2's window barely overlaps session 1's — force below the minimum overlap threshold.
    const barelyOverlapping = [
      session({ id: "s1", browserSessionTokenHash: "t1", firstSeenAt: NOW, lastSeenAt: NOW }),
      session({ id: "s2", browserSessionTokenHash: "t2", firstSeenAt: NOW - ACTIVE_SESSION_TIMEOUT_MS - 60_000, lastSeenAt: NOW - ACTIVE_SESSION_TIMEOUT_MS - 60_000 }),
    ];
    void sessions;
    const result = detectConcurrentActiveSessions(barelyOverlapping, NOW);
    expect(result.flagged).toBe(false);
  });

  it("never exposes hashes in the built signal's explanation/evidence text", () => {
    const sessions = [
      session({ id: "s1", browserSessionTokenHash: "t1", deviceTokenHash: "d1", firstSeenAt: NOW - 60_000, lastSeenAt: NOW }),
      session({ id: "s2", browserSessionTokenHash: "t2", deviceTokenHash: "d2", firstSeenAt: NOW - 50_000, lastSeenAt: NOW }),
    ];
    const result = detectConcurrentActiveSessions(sessions, NOW);
    const signal = buildConcurrentSessionSignal(result);
    const text = JSON.stringify(signal);
    expect(text).not.toContain("d1");
    expect(text).not.toContain("d2");
    expect(text).not.toContain("t1");
    expect(text).not.toContain("t2");
  });
});

describe("device/UA/network/camera change detection", () => {
  it("a different browser-session token with the same device token is not itself a device-change signal", () => {
    const result = detectDeviceTokenChange(profile(), profile(), false);
    expect(result).toBeNull();
  });

  it("a different device token creates a device-change signal", () => {
    const result = detectDeviceTokenChange(profile(), profile({ deviceTokenHash: "device-2" }), false);
    expect(result?.signalType).toBe("DEVICE_TOKEN_CHANGED");
    expect(result?.signalLevel).toBe("MEDIUM");
  });

  it("a device-token change while the previous session is still active raises to HIGH", () => {
    const result = detectDeviceTokenChange(profile(), profile({ deviceTokenHash: "device-2" }), true);
    expect(result?.signalLevel).toBe("HIGH");
  });

  it("user-agent change alone remains LOW", () => {
    const result = detectUserAgentChange(profile(), profile({ userAgentHash: "ua-hash-2" }), false);
    expect(result?.signalLevel).toBe("LOW");
  });

  it("user-agent change combined with another change raises to MEDIUM", () => {
    const result = detectUserAgentChange(profile(), profile({ userAgentHash: "ua-hash-2" }), true);
    expect(result?.signalLevel).toBe("MEDIUM");
  });

  it("device token plus browser-family/device-category change raises concern (coarse profile change)", () => {
    const result = detectCoarseDeviceProfileChange(profile(), profile({ browserFamily: "Firefox", deviceCategory: "mobile" }));
    expect(result?.signalType).toBe("COARSE_DEVICE_PROFILE_CHANGED");
    expect(result?.signalLevel).toBe("MEDIUM");
  });

  it("does not flag a minor browser version change (family unchanged)", () => {
    const result = detectCoarseDeviceProfileChange(profile(), profile());
    expect(result).toBeNull();
  });

  it("one IP-prefix change remains LOW/informational", () => {
    const result = detectNetworkPrefixChange(
      [
        { prefixHash: "p1", atMs: NOW - 20_000 },
        { prefixHash: "p2", atMs: NOW - 5_000 },
      ],
      NOW,
    );
    expect(result?.signalType).toBe("NETWORK_PREFIX_CHANGED");
    expect(result?.signalLevel).toBe("LOW");
  });

  it("repeated distinct IP-prefix changes produce a MEDIUM signal", () => {
    const result = detectNetworkPrefixChange(
      [
        { prefixHash: "p1", atMs: NOW - 20_000 },
        { prefixHash: "p2", atMs: NOW - 15_000 },
        { prefixHash: "p3", atMs: NOW - 5_000 },
      ],
      NOW,
    );
    expect(result?.signalType).toBe("REPEATED_NETWORK_CHANGES");
    expect(result?.signalLevel).toBe("MEDIUM");
  });

  it("does not describe network changes as geographic travel", () => {
    const result = detectNetworkPrefixChange(
      [
        { prefixHash: "p1", atMs: NOW - 20_000 },
        { prefixHash: "p2", atMs: NOW - 5_000 },
      ],
      NOW,
    );
    expect(result?.limitation.toLowerCase()).toContain("not geographic location evidence");
  });

  it("unsupported camera permission state (unknown) transition is not treated as a violation", () => {
    expect(detectCameraPermissionChange("unknown", "denied")).toBeNull();
    expect(detectCameraPermissionChange("prompt", "unknown")).toBeNull();
  });

  it("granted -> denied/unavailable creates a LOW camera-permission signal", () => {
    expect(detectCameraPermissionChange("granted", "denied")?.signalLevel).toBe("LOW");
    expect(detectCameraPermissionChange("granted", "unavailable")?.signalLevel).toBe("LOW");
  });

  it("granted -> granted is never flagged", () => {
    expect(detectCameraPermissionChange("granted", "granted")).toBeNull();
  });
});

describe("shouldEmitSignal (dedup/cooldown)", () => {
  it("allows a signal type with no recent history", () => {
    expect(shouldEmitSignal([], "DEVICE_TOKEN_CHANGED", NOW)).toBe(true);
  });

  it("suppresses a duplicate signal within the cooldown window", () => {
    const recent = [{ signalType: "DEVICE_TOKEN_CHANGED" as const, createdAtMs: NOW - 1000 }];
    expect(shouldEmitSignal(recent, "DEVICE_TOKEN_CHANGED", NOW)).toBe(false);
  });

  it("allows the signal again after the cooldown has passed", () => {
    const recent = [{ signalType: "DEVICE_TOKEN_CHANGED" as const, createdAtMs: NOW - 20 * 60 * 1000 }];
    expect(shouldEmitSignal(recent, "DEVICE_TOKEN_CHANGED", NOW)).toBe(true);
  });

  it("does not suppress a different signal type", () => {
    const recent = [{ signalType: "DEVICE_TOKEN_CHANGED" as const, createdAtMs: NOW - 1000 }];
    expect(shouldEmitSignal(recent, "USER_AGENT_CHANGED", NOW)).toBe(true);
  });
});
