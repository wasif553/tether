import { describe, expect, it } from "vitest";
import { resolveRecoveryState, resolveTrustedTetherVerification, RECOVERY_STATE_COPY, RECOVERY_STATES, type RecoverySessionInput } from "./tetherRecovery";
import { isVerificationStillFresh } from "./secureClient/secureClientSession";

const HEARTBEAT_POLICY = { heartbeatIntervalSeconds: 30, heartbeatGraceSeconds: 90 };
const OFFLINE_CONTINUE_MS = 10 * 60_000;
const NOW = 1_700_000_000_000;

function baseSession(overrides: Partial<RecoverySessionInput> = {}): RecoverySessionInput {
  return {
    status: "ACTIVE",
    verificationStatus: "VERIFIED",
    installationAttestationVerified: false,
    attestationRequirement: "LEGACY",
    lastHeartbeatAtMs: NOW,
    startedAtMs: NOW - 60_000,
    clientInstallationId: null,
    ...overrides,
  };
}

describe("resolveTrustedTetherVerification — freshness-gated verification (Part 6)", () => {
  it("trusts a fresh, verified session", () => {
    expect(
      resolveTrustedTetherVerification({
        sessionRequirement: "LEGACY",
        legacyVerified: true,
        v2Verified: false,
        lastHeartbeatAtMs: NOW,
        sessionStartedAtMs: NOW - 60_000,
        nowMs: NOW,
        heartbeatPolicy: HEARTBEAT_POLICY,
        offlineContinueMs: OFFLINE_CONTINUE_MS,
      }),
    ).toBe(true);
  });

  it("never trusts an unverified session regardless of freshness", () => {
    expect(
      resolveTrustedTetherVerification({
        sessionRequirement: "LEGACY",
        legacyVerified: false,
        v2Verified: false,
        lastHeartbeatAtMs: NOW,
        sessionStartedAtMs: NOW,
        nowMs: NOW,
        heartbeatPolicy: HEARTBEAT_POLICY,
        offlineContinueMs: OFFLINE_CONTINUE_MS,
      }),
    ).toBe(false);
  });

  // The exact gap this feature closes: a session verified long ago, with
  // no heartbeat since, must eventually stop being trusted — "a
  // previously verified SecureClientSession must not be trusted
  // indefinitely after a crash or relaunch".
  it("stops trusting a verified session once contact has gone stale beyond heartbeat grace + the offline-continue window", () => {
    const staleBaseline = NOW - (HEARTBEAT_POLICY.heartbeatIntervalSeconds + HEARTBEAT_POLICY.heartbeatGraceSeconds) * 1000 - OFFLINE_CONTINUE_MS - 1;
    expect(
      resolveTrustedTetherVerification({
        sessionRequirement: "LEGACY",
        legacyVerified: true,
        v2Verified: false,
        lastHeartbeatAtMs: staleBaseline,
        sessionStartedAtMs: staleBaseline,
        nowMs: NOW,
        heartbeatPolicy: HEARTBEAT_POLICY,
        offlineContinueMs: OFFLINE_CONTINUE_MS,
      }),
    ).toBe(false);
  });

  it("still trusts a verified session during an ordinary brief reconnect gap, well within the bounded offline-continue window", () => {
    const briefGapBaseline = NOW - (HEARTBEAT_POLICY.heartbeatIntervalSeconds + HEARTBEAT_POLICY.heartbeatGraceSeconds) * 1000 - 5_000;
    expect(
      resolveTrustedTetherVerification({
        sessionRequirement: "LEGACY",
        legacyVerified: true,
        v2Verified: false,
        lastHeartbeatAtMs: briefGapBaseline,
        sessionStartedAtMs: briefGapBaseline,
        nowMs: NOW,
        heartbeatPolicy: HEARTBEAT_POLICY,
        offlineContinueMs: OFFLINE_CONTINUE_MS,
      }),
    ).toBe(true);
  });

  it("a session that has never sent a heartbeat uses startedAt as the freshness baseline", () => {
    expect(
      isVerificationStillFresh(NOW - 1000, NOW, { ...HEARTBEAT_POLICY, offlineContinueMs: OFFLINE_CONTINUE_MS }),
    ).toBe(true);
  });
});

describe("resolveRecoveryState — central deterministic resolver (Part 1)", () => {
  it("SUBMITTED for a finalized submission regardless of session state — a submitted attempt can never reopen", () => {
    for (const submissionStatus of ["SUBMITTED", "GRADED"] as const) {
      expect(
        resolveRecoveryState({
          authenticated: true,
          submissionStatus,
          nowMs: NOW,
          deadlineMs: NOW + 100_000,
          deliveryMode: "TETHER_CLIENT_REQUIRED",
          session: baseSession(),
          heartbeatPolicy: HEARTBEAT_POLICY,
          offlineContinueMs: OFFLINE_CONTINUE_MS,
          requestingInstallationId: null,
        }).state,
      ).toBe("SUBMITTED");
    }
  });

  it("EXPIRED once the frozen deadline has passed, even with an otherwise-healthy session", () => {
    expect(
      resolveRecoveryState({
        authenticated: true,
        submissionStatus: "IN_PROGRESS",
        nowMs: NOW,
        deadlineMs: NOW - 1,
        deliveryMode: "TETHER_CLIENT_REQUIRED",
        session: baseSession(),
        heartbeatPolicy: HEARTBEAT_POLICY,
        offlineContinueMs: OFFLINE_CONTINUE_MS,
        requestingInstallationId: null,
      }).state,
    ).toBe("EXPIRED");
  });

  it("ACTIVE for a non-Tether-required exam regardless of session presence", () => {
    expect(
      resolveRecoveryState({
        authenticated: true,
        submissionStatus: "IN_PROGRESS",
        nowMs: NOW,
        deadlineMs: NOW + 100_000,
        deliveryMode: "STANDARD_WEB",
        session: null,
        heartbeatPolicy: HEARTBEAT_POLICY,
        offlineContinueMs: OFFLINE_CONTINUE_MS,
        requestingInstallationId: null,
      }).state,
    ).toBe("ACTIVE");
  });

  it("RESUME_REQUIRES_TETHER when no session exists yet for a Tether-required exam", () => {
    const result = resolveRecoveryState({
      authenticated: true,
      submissionStatus: "IN_PROGRESS",
      nowMs: NOW,
      deadlineMs: NOW + 100_000,
      deliveryMode: "TETHER_CLIENT_REQUIRED",
      session: null,
      heartbeatPolicy: HEARTBEAT_POLICY,
      offlineContinueMs: OFFLINE_CONTINUE_MS,
      requestingInstallationId: null,
    });
    expect(result.state).toBe("RESUME_REQUIRES_TETHER");
  });

  it("RESUME_REQUIRES_TETHER when the only session on record is terminal (ENDED/REJECTED)", () => {
    for (const status of ["ENDED", "REJECTED"] as const) {
      expect(
        resolveRecoveryState({
          authenticated: true,
          submissionStatus: "IN_PROGRESS",
          nowMs: NOW,
          deadlineMs: NOW + 100_000,
          deliveryMode: "TETHER_CLIENT_REQUIRED",
          session: baseSession({ status }),
          heartbeatPolicy: HEARTBEAT_POLICY,
          offlineContinueMs: OFFLINE_CONTINUE_MS,
          requestingInstallationId: null,
        }).state,
      ).toBe("RESUME_REQUIRES_TETHER");
    }
  });

  it("RESUME_REQUIRES_FRESH_ATTESTATION when the session is not (yet, or no longer) verified", () => {
    expect(
      resolveRecoveryState({
        authenticated: true,
        submissionStatus: "IN_PROGRESS",
        nowMs: NOW,
        deadlineMs: NOW + 100_000,
        deliveryMode: "TETHER_CLIENT_REQUIRED",
        session: baseSession({ verificationStatus: "NOT_CHECKED" }),
        heartbeatPolicy: HEARTBEAT_POLICY,
        offlineContinueMs: OFFLINE_CONTINUE_MS,
        requestingInstallationId: null,
      }).state,
    ).toBe("RESUME_REQUIRES_FRESH_ATTESTATION");
  });

  it("TEMPORARILY_DISCONNECTED for a verified session whose heartbeat is currently overdue but still within the bounded window", () => {
    const overdueButBounded = NOW - (HEARTBEAT_POLICY.heartbeatIntervalSeconds + HEARTBEAT_POLICY.heartbeatGraceSeconds) * 1000 - 5_000;
    expect(
      resolveRecoveryState({
        authenticated: true,
        submissionStatus: "IN_PROGRESS",
        nowMs: NOW,
        deadlineMs: NOW + 100_000,
        deliveryMode: "TETHER_CLIENT_REQUIRED",
        session: baseSession({ lastHeartbeatAtMs: overdueButBounded, startedAtMs: overdueButBounded }),
        heartbeatPolicy: HEARTBEAT_POLICY,
        offlineContinueMs: OFFLINE_CONTINUE_MS,
        requestingInstallationId: null,
      }).state,
    ).toBe("TEMPORARILY_DISCONNECTED");
  });

  it("ACTIVE for a verified session with a recent heartbeat", () => {
    expect(
      resolveRecoveryState({
        authenticated: true,
        submissionStatus: "IN_PROGRESS",
        nowMs: NOW,
        deadlineMs: NOW + 100_000,
        deliveryMode: "TETHER_CLIENT_REQUIRED",
        session: baseSession(),
        heartbeatPolicy: HEARTBEAT_POLICY,
        offlineContinueMs: OFFLINE_CONTINUE_MS,
        requestingInstallationId: null,
      }).state,
    ).toBe("ACTIVE");
  });

  // Part 8 — proactive device-change hint (the authoritative enforcement
  // is verifyExamSessionAttestation's own DEVICE_CHANGE_DETECTED check;
  // this is the read-only UI-facing counterpart).
  it("MANUAL_REVIEW_REQUIRED when the requesting installation differs from the session's bound installation", () => {
    expect(
      resolveRecoveryState({
        authenticated: true,
        submissionStatus: "IN_PROGRESS",
        nowMs: NOW,
        deadlineMs: NOW + 100_000,
        deliveryMode: "TETHER_CLIENT_REQUIRED",
        session: baseSession({ clientInstallationId: "installation-A" }),
        heartbeatPolicy: HEARTBEAT_POLICY,
        offlineContinueMs: OFFLINE_CONTINUE_MS,
        requestingInstallationId: "installation-B",
      }).state,
    ).toBe("MANUAL_REVIEW_REQUIRED");
  });

  it("does NOT flag a device change when the requesting installation matches the bound one", () => {
    expect(
      resolveRecoveryState({
        authenticated: true,
        submissionStatus: "IN_PROGRESS",
        nowMs: NOW,
        deadlineMs: NOW + 100_000,
        deliveryMode: "TETHER_CLIENT_REQUIRED",
        session: baseSession({ clientInstallationId: "installation-A" }),
        heartbeatPolicy: HEARTBEAT_POLICY,
        offlineContinueMs: OFFLINE_CONTINUE_MS,
        requestingInstallationId: "installation-A",
      }).state,
    ).toBe("ACTIVE");
  });

  it("RESUME_REQUIRES_REAUTHENTICATION when the caller could not be authenticated", () => {
    expect(
      resolveRecoveryState({
        authenticated: false,
        submissionStatus: "IN_PROGRESS",
        nowMs: NOW,
        deadlineMs: NOW + 100_000,
        deliveryMode: "TETHER_CLIENT_REQUIRED",
        session: null,
        heartbeatPolicy: HEARTBEAT_POLICY,
        offlineContinueMs: OFFLINE_CONTINUE_MS,
        requestingInstallationId: null,
      }).state,
    ).toBe("RESUME_REQUIRES_REAUTHENTICATION");
  });

  it("every recovery state has approved, non-alarming product-language copy — never the forbidden vocabulary", () => {
    const forbidden = ["suspicious", "misconduct", "cheat", "exam reset", "guaranteed recovery", "proof of misconduct"];
    for (const state of RECOVERY_STATES) {
      const copy = RECOVERY_STATE_COPY[state];
      expect(copy.label.length).toBeGreaterThan(0);
      expect(copy.detail.length).toBeGreaterThan(0);
      const lower = `${copy.label} ${copy.detail}`.toLowerCase();
      for (const word of forbidden) expect(lower).not.toContain(word);
    }
  });
});
