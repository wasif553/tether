import { describe, it, expect } from "vitest";
import {
  isHeartbeatOverdue,
  heartbeatDeadlineMs,
  deriveSessionStatus,
  checkRecoveryGrant,
  isTerminalSessionStatus,
  NON_TERMINAL_SESSION_STATUSES,
  type HeartbeatPolicy,
} from "./secureClientSession";

const policy: HeartbeatPolicy = { heartbeatIntervalSeconds: 30, heartbeatGraceSeconds: 90 };

describe("heartbeatDeadlineMs / isHeartbeatOverdue", () => {
  it("deadline is lastHeartbeat + interval + grace", () => {
    const last = 1_000_000;
    expect(heartbeatDeadlineMs(last, policy)).toBe(last + (30 + 90) * 1000);
  });

  it("is not overdue exactly at the deadline boundary minus one ms, overdue just after", () => {
    const last = 0;
    const deadline = heartbeatDeadlineMs(last, policy);
    expect(isHeartbeatOverdue(last, deadline, policy)).toBe(false);
    expect(isHeartbeatOverdue(last, deadline + 1, policy)).toBe(true);
  });

  it("is not overdue immediately after a heartbeat", () => {
    expect(isHeartbeatOverdue(Date.now(), Date.now(), policy)).toBe(false);
  });
});

describe("deriveSessionStatus", () => {
  it("a non-ACTIVE session is left unchanged regardless of heartbeat timing", () => {
    const stale = Date.now() - 999_999_999;
    expect(deriveSessionStatus({ status: "PREFLIGHT", startedAt: stale, lastHeartbeatAt: null }, policy, Date.now())).toBe("PREFLIGHT");
    expect(deriveSessionStatus({ status: "CREATED", startedAt: stale, lastHeartbeatAt: null }, policy, Date.now())).toBe("CREATED");
    expect(deriveSessionStatus({ status: "ENDED", startedAt: stale, lastHeartbeatAt: null }, policy, Date.now())).toBe("ENDED");
  });

  it("an ACTIVE session with a recent heartbeat stays ACTIVE", () => {
    const now = Date.now();
    expect(deriveSessionStatus({ status: "ACTIVE", startedAt: now - 10_000, lastHeartbeatAt: now - 5_000 }, policy, now)).toBe("ACTIVE");
  });

  it("an ACTIVE session past the interval+grace deadline becomes INTERRUPTED", () => {
    const now = Date.now();
    const longAgo = now - (30 + 90 + 10) * 1000;
    expect(deriveSessionStatus({ status: "ACTIVE", startedAt: longAgo, lastHeartbeatAt: longAgo }, policy, now)).toBe("INTERRUPTED");
  });

  it("uses startedAt as the baseline when no heartbeat has ever been sent", () => {
    const now = Date.now();
    const longAgo = now - (30 + 90 + 10) * 1000;
    expect(deriveSessionStatus({ status: "ACTIVE", startedAt: longAgo, lastHeartbeatAt: null }, policy, now)).toBe("INTERRUPTED");
  });

  it("self-heals: a fresh heartbeat after an overdue window reports ACTIVE again", () => {
    const now = Date.now();
    const recent = now - 1000;
    expect(deriveSessionStatus({ status: "ACTIVE", startedAt: now - 999_999, lastHeartbeatAt: recent }, policy, now)).toBe("ACTIVE");
  });
});

describe("checkRecoveryGrant", () => {
  const nowMs = Date.now();
  function grant(overrides: Partial<{ submissionId: string; expiresAt: number; consumedAt: number | null; revokedAt: number | null }> = {}) {
    return { submissionId: "sub-1", expiresAt: nowMs + 60_000, consumedAt: null, revokedAt: null, ...overrides };
  }

  it("VALID for a fresh, matching, unconsumed, unrevoked, unexpired grant", () => {
    expect(checkRecoveryGrant({ grant: grant(), requestSubmissionId: "sub-1", nowMs })).toBe("VALID");
  });

  it("WRONG_SUBMISSION when the grant belongs to a different submission", () => {
    expect(checkRecoveryGrant({ grant: grant({ submissionId: "sub-2" }), requestSubmissionId: "sub-1", nowMs })).toBe("WRONG_SUBMISSION");
  });

  it("REVOKED takes priority over consumed/expired", () => {
    const g = grant({ revokedAt: nowMs - 1000, consumedAt: nowMs - 1000, expiresAt: nowMs - 1000 });
    expect(checkRecoveryGrant({ grant: g, requestSubmissionId: "sub-1", nowMs })).toBe("REVOKED");
  });

  it("ALREADY_CONSUMED for a one-time grant that was already redeemed", () => {
    expect(checkRecoveryGrant({ grant: grant({ consumedAt: nowMs - 1000 }), requestSubmissionId: "sub-1", nowMs })).toBe("ALREADY_CONSUMED");
  });

  it("EXPIRED for a grant past its expiry", () => {
    expect(checkRecoveryGrant({ grant: grant({ expiresAt: nowMs - 1000 }), requestSubmissionId: "sub-1", nowMs })).toBe("EXPIRED");
  });
});

describe("terminal / non-terminal session statuses", () => {
  it("ENDED and REJECTED are the only terminal statuses", () => {
    expect(isTerminalSessionStatus("ENDED")).toBe(true);
    expect(isTerminalSessionStatus("REJECTED")).toBe(true);
    for (const status of NON_TERMINAL_SESSION_STATUSES) {
      expect(isTerminalSessionStatus(status)).toBe(false);
    }
  });
});
