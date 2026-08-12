import { describe, it, expect } from "vitest";
import { submissionRequiresActivation, isSubmissionContentAccessible, EXAM_NOT_ACTIVATED_CODE } from "./secureClientActivation";

// v1.7.4 pre-exam readiness — Part 13C/D: the single server-side gate
// every content-bearing route and the activation endpoint itself must
// agree on. See docs/tether-preflight-lifecycle-v1.7.4.md.

describe("submissionRequiresActivation", () => {
  it("true only for TETHER_CLIENT_REQUIRED and SEB_REQUIRED", () => {
    expect(submissionRequiresActivation({ deliveryMode: "TETHER_CLIENT_REQUIRED" })).toBe(true);
    expect(submissionRequiresActivation({ deliveryMode: "SEB_REQUIRED" })).toBe(true);
  });

  it("false for STANDARD_WEB/MONITORED_WEB/the two OPTIONAL modes — nothing to gate", () => {
    expect(submissionRequiresActivation({ deliveryMode: "STANDARD_WEB" })).toBe(false);
    expect(submissionRequiresActivation({ deliveryMode: "MONITORED_WEB" })).toBe(false);
    expect(submissionRequiresActivation({ deliveryMode: "SEB_OPTIONAL" })).toBe(false);
    expect(submissionRequiresActivation({ deliveryMode: "TETHER_CLIENT_OPTIONAL" })).toBe(false);
  });
});

describe("isSubmissionContentAccessible — the ONE gate every content-bearing route must pass", () => {
  it("[Part C] a PREPARING TETHER_CLIENT_REQUIRED attempt (activatedAt null) has no accessible content", () => {
    expect(
      isSubmissionContentAccessible({
        activatedAt: null,
        secureClientPolicySnapshotJson: { deliveryMode: "TETHER_CLIENT_REQUIRED" },
      }),
    ).toBe(false);
  });

  it("[Part C] an ACTIVATED TETHER_CLIENT_REQUIRED attempt (activatedAt set) has accessible content", () => {
    expect(
      isSubmissionContentAccessible({
        activatedAt: new Date(),
        secureClientPolicySnapshotJson: { deliveryMode: "TETHER_CLIENT_REQUIRED" },
      }),
    ).toBe(true);
  });

  it("[Part C] a PREPARING SEB_REQUIRED attempt is gated identically to TETHER_CLIENT_REQUIRED", () => {
    expect(
      isSubmissionContentAccessible({
        activatedAt: null,
        secureClientPolicySnapshotJson: { deliveryMode: "SEB_REQUIRED" },
      }),
    ).toBe(false);
  });

  it("a STANDARD_WEB attempt is always accessible regardless of activatedAt — nothing to gate", () => {
    expect(
      isSubmissionContentAccessible({
        activatedAt: null,
        secureClientPolicySnapshotJson: { deliveryMode: "STANDARD_WEB" },
      }),
    ).toBe(true);
  });

  it("a null/missing/malformed policy snapshot parses to STANDARD_WEB (legacy behaviour) — never blocks", () => {
    expect(isSubmissionContentAccessible({ activatedAt: null, secureClientPolicySnapshotJson: null })).toBe(true);
    expect(isSubmissionContentAccessible({ activatedAt: null, secureClientPolicySnapshotJson: undefined })).toBe(true);
    expect(isSubmissionContentAccessible({ activatedAt: null, secureClientPolicySnapshotJson: "not an object" })).toBe(true);
    expect(isSubmissionContentAccessible({ activatedAt: null, secureClientPolicySnapshotJson: { deliveryMode: "NOT_A_REAL_MODE" } })).toBe(true);
  });

  it("[Part E race] a TETHER_CLIENT_OPTIONAL attempt is never gated even with activatedAt null — optional modes have no activation prerequisite", () => {
    expect(
      isSubmissionContentAccessible({
        activatedAt: null,
        secureClientPolicySnapshotJson: { deliveryMode: "TETHER_CLIENT_OPTIONAL" },
      }),
    ).toBe(true);
  });
});

describe("EXAM_NOT_ACTIVATED_CODE", () => {
  it("is a stable, machine-readable code distinct from TETHER_SESSION_REQUIRED", () => {
    expect(EXAM_NOT_ACTIVATED_CODE).toBe("EXAM_NOT_ACTIVATED");
  });
});
