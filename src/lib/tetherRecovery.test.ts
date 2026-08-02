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
    isRecoverySession: false,
    priorSessionTrustedInstallationId: null,
    priorSessionEverVerified: false,
    installationAttestationFailureReason: null,
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
        isRecoverySession: false,
        priorSessionTrustedInstallationId: null,
        priorSessionEverVerified: false,
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
        isRecoverySession: false,
        priorSessionTrustedInstallationId: null,
        priorSessionEverVerified: false,
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
        isRecoverySession: false,
        priorSessionTrustedInstallationId: null,
        priorSessionEverVerified: false,
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
        isRecoverySession: false,
        priorSessionTrustedInstallationId: null,
        priorSessionEverVerified: false,
      }),
    ).toBe(true);
  });

  it("a session that has never sent a heartbeat uses startedAt as the freshness baseline", () => {
    expect(
      isVerificationStillFresh(NOW - 1000, NOW, { ...HEARTBEAT_POLICY, offlineContinueMs: OFFLINE_CONTINUE_MS }),
    ).toBe(true);
  });
});

describe("resolveTrustedTetherVerification — secure-recovery hardening v1, Part A (fail-closed unbound recovery)", () => {
  const RECOVERY_BASE = {
    sessionRequirement: "LEGACY" as const,
    lastHeartbeatAtMs: NOW,
    sessionStartedAtMs: NOW - 60_000,
    nowMs: NOW,
    heartbeatPolicy: HEARTBEAT_POLICY,
    offlineContinueMs: OFFLINE_CONTINUE_MS,
    // Most tests below are about a prior attempt that genuinely reached
    // VERIFIED (by some means) but was never installation-bound — the
    // core Part A scenario. The dedicated test further down overrides
    // this to false to cover the OTHER case (never verified at all).
    priorSessionEverVerified: true,
  };

  // Item 3 — the exact defect this hardening pass closes: a LEGACY-only
  // original attempt has no genuine device reference to check a new
  // attestation against, so a recovery session can never be trusted
  // automatically no matter what it presents.
  it("3. an unbound (LEGACY-only) original attempt can never be trusted automatically, even with legacyVerified true", () => {
    expect(
      resolveTrustedTetherVerification({
        ...RECOVERY_BASE,
        legacyVerified: true,
        v2Verified: false,
        isRecoverySession: true,
        priorSessionTrustedInstallationId: null,
      }),
    ).toBe(false);
  });

  // Item 4 — "LEGACY verification alone cannot restore content": even
  // with a genuine prior installation binding, legacyVerified=true /
  // v2Verified=false must still fail for a recovery session — only the
  // v2, installation-bound RESULT is ever trusted for a recovery.
  it("4. a recovery session with a trusted prior installation is still refused if only LEGACY (never v2) verified", () => {
    expect(
      resolveTrustedTetherVerification({
        ...RECOVERY_BASE,
        legacyVerified: true,
        v2Verified: false,
        isRecoverySession: true,
        priorSessionTrustedInstallationId: "installation-A",
      }),
    ).toBe(false);
  });

  it("1. a recovery session with a trusted prior installation AND fresh v2 verification is trusted", () => {
    expect(
      resolveTrustedTetherVerification({
        ...RECOVERY_BASE,
        legacyVerified: false,
        v2Verified: true,
        isRecoverySession: true,
        priorSessionTrustedInstallationId: "installation-A",
      }),
    ).toBe(true);
  });

  // Requirement 4 — ordinary, non-recovery sessions are completely
  // unaffected: the existing LEGACY/DUAL/V2_REQUIRED truth table alone
  // decides, regardless of priorSessionTrustedInstallationId (which is
  // meaningless — and always null in practice — for a first-ever launch).
  it("requirement 4: a non-recovery (first-launch) session is governed only by the existing truth table, unaffected by Part A", () => {
    expect(
      resolveTrustedTetherVerification({
        ...RECOVERY_BASE,
        legacyVerified: true,
        v2Verified: false,
        isRecoverySession: false,
        priorSessionTrustedInstallationId: null,
        priorSessionEverVerified: false,
      }),
    ).toBe(true);
  });

  // A prior session that crashed before ever completing its OWN first
  // attestation never unlocked any content — recovering it is
  // indistinguishable from an ordinary first launch and must fall
  // straight through to the unmodified truth table, NOT manual review.
  // This is the exact distinction the "Immutable timing-policy" DB-backed
  // regression test depends on (see tetherRecovery.routes.test.ts,
  // "10/11/12/38").
  it("a recovery session whose prior attempt was NEVER verified by any means falls through to the ordinary truth table, not fail-closed", () => {
    expect(
      resolveTrustedTetherVerification({
        ...RECOVERY_BASE,
        legacyVerified: true,
        v2Verified: false,
        isRecoverySession: true,
        priorSessionTrustedInstallationId: null,
        priorSessionEverVerified: false,
      }),
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

  // Secure-recovery hardening v1, Part A — checked before every other
  // recovery signal (see resolveRecoveryState's own doc comment): an
  // unbound original attempt can never resolve to anything but manual
  // review, regardless of what this new session's own fields show.
  it("3. MANUAL_REVIEW_REQUIRED for a recovery session whose original attempt was never installation-bound (LEGACY-only)", () => {
    expect(
      resolveRecoveryState({
        authenticated: true,
        submissionStatus: "IN_PROGRESS",
        nowMs: NOW,
        deadlineMs: NOW + 100_000,
        deliveryMode: "TETHER_CLIENT_REQUIRED",
        session: baseSession({
          isRecoverySession: true,
          priorSessionTrustedInstallationId: null,
          priorSessionEverVerified: true,
          // Even a fully fresh v2 attestation on THIS session must not matter.
          installationAttestationVerified: true,
          verificationStatus: "VERIFIED",
        }),
        heartbeatPolicy: HEARTBEAT_POLICY,
        offlineContinueMs: OFFLINE_CONTINUE_MS,
        requestingInstallationId: null,
      }).state,
    ).toBe("MANUAL_REVIEW_REQUIRED");
  });

  // The regression this distinction protects: a session that crashed
  // before ever completing its OWN first attestation (never LEGACY- or
  // v2-verified) never unlocked any content — relaunching it is just a
  // retried first launch, not a recovery of a genuinely-started attempt,
  // so it must NOT become MANUAL_REVIEW_REQUIRED.
  it("does not require manual review when the prior attempt was never verified by any means at all", () => {
    expect(
      resolveRecoveryState({
        authenticated: true,
        submissionStatus: "IN_PROGRESS",
        nowMs: NOW,
        deadlineMs: NOW + 100_000,
        deliveryMode: "TETHER_CLIENT_REQUIRED",
        session: baseSession({
          isRecoverySession: true,
          priorSessionTrustedInstallationId: null,
          priorSessionEverVerified: false,
        }),
        heartbeatPolicy: HEARTBEAT_POLICY,
        offlineContinueMs: OFFLINE_CONTINUE_MS,
        requestingInstallationId: null,
      }).state,
    ).toBe("ACTIVE");
  });

  it("1. ACTIVE for a recovery session whose original attempt WAS installation-bound, once freshly v2-verified", () => {
    expect(
      resolveRecoveryState({
        authenticated: true,
        submissionStatus: "IN_PROGRESS",
        nowMs: NOW,
        deadlineMs: NOW + 100_000,
        deliveryMode: "TETHER_CLIENT_REQUIRED",
        session: baseSession({
          isRecoverySession: true,
          priorSessionTrustedInstallationId: "installation-A",
          priorSessionEverVerified: true,
          installationAttestationVerified: true,
          verificationStatus: "NOT_CHECKED",
        }),
        heartbeatPolicy: HEARTBEAT_POLICY,
        offlineContinueMs: OFFLINE_CONTINUE_MS,
        requestingInstallationId: null,
      }).state,
    ).toBe("ACTIVE");
  });

  // Item 2/7 (server-derived counterpart to the proactive client-hint
  // test above) — a DIFFERENT installation already attempted this
  // recovery and was authoritatively denied by verifyExamSessionAttestation,
  // which recorded it on the session itself; this must resolve to manual
  // review even with no requestingInstallationId claim from the caller.
  it("2. MANUAL_REVIEW_REQUIRED once a device-change denial has been recorded on the session, independent of any client-claimed installation id", () => {
    expect(
      resolveRecoveryState({
        authenticated: true,
        submissionStatus: "IN_PROGRESS",
        nowMs: NOW,
        deadlineMs: NOW + 100_000,
        deliveryMode: "TETHER_CLIENT_REQUIRED",
        session: baseSession({
          isRecoverySession: true,
          priorSessionTrustedInstallationId: "installation-A",
          installationAttestationFailureReason: "DEVICE_CHANGE_DETECTED",
        }),
        heartbeatPolicy: HEARTBEAT_POLICY,
        offlineContinueMs: OFFLINE_CONTINUE_MS,
        requestingInstallationId: null,
      }).state,
    ).toBe("MANUAL_REVIEW_REQUIRED");
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
