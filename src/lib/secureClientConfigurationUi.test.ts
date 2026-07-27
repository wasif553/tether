import { describe, it, expect } from "vitest";
import { resolveSebConfigurationWorkflowAction, isAddSebKeyDisabled, MIN_SEB_KEY_LENGTH } from "./secureClientConfigurationUi";

// ---------------------------------------------------------------------------
// Lecturer Secure-client session page — SEB configuration create/activate/
// revoke workflow fix. See src/app/lecturer/exams/[id]/secure-client/page.tsx.
// Previously, no SAFE_EXAM_BROWSER configuration existing meant an
// ineffective "Activate" button (activate() returned immediately when
// sebConfig was undefined) and the only path that created a draft
// configuration was addKey() via createDraftIfNeeded() — forcing a
// lecturer to enter a Browser Exam Key or Config Key merely to create the
// configuration. These tests cover the fix: a dedicated CREATE action
// that never depends on key state, plus DRAFT -> ACTIVATE -> ACTIVE ->
// REVOKE driven purely by configuration status.
// ---------------------------------------------------------------------------

describe("resolveSebConfigurationWorkflowAction", () => {
  it("not configured (no SAFE_EXAM_BROWSER configuration): Create button is the action", () => {
    expect(resolveSebConfigurationWorkflowAction(undefined)).toBe("CREATE");
    expect(resolveSebConfigurationWorkflowAction(null)).toBe("CREATE");
  });

  it("DRAFT status: Activate configuration is the action", () => {
    expect(resolveSebConfigurationWorkflowAction("DRAFT")).toBe("ACTIVATE");
  });

  it("ACTIVE status: Revoke is the action", () => {
    expect(resolveSebConfigurationWorkflowAction("ACTIVE")).toBe("REVOKE");
  });

  it("any other non-ACTIVE status also resolves to Activate, never back to Create", () => {
    // A configuration already exists once status is known — PUT
    // .../configuration must never be shown/called again for it.
    expect(resolveSebConfigurationWorkflowAction("REVOKED")).toBe("ACTIVATE");
    expect(resolveSebConfigurationWorkflowAction("SOMETHING_FUTURE_AND_UNKNOWN")).toBe("ACTIVATE");
  });

  it("never returns CREATE once any status string is present, regardless of key state — the action is derived purely from configuration status", () => {
    // resolveSebConfigurationWorkflowAction takes no key-related
    // parameter at all: it is structurally impossible for key
    // presence/absence to influence the create/activate/revoke decision.
    expect(resolveSebConfigurationWorkflowAction("DRAFT")).not.toBe("CREATE");
    expect(resolveSebConfigurationWorkflowAction("ACTIVE")).not.toBe("CREATE");
  });
});

describe("SEB configuration lifecycle transitions", () => {
  it("not configured -> Create button visible", () => {
    expect(resolveSebConfigurationWorkflowAction(undefined)).toBe("CREATE");
  });

  it("Create succeeds -> configuration status becomes DRAFT -> Activate configuration button visible", () => {
    // createDraftConfiguration (src/lib/secureClientRunner.ts) always
    // creates a new configuration with status "DRAFT" — this asserts the
    // UI action that follows once GET .../configuration reflects that.
    const statusAfterCreate = "DRAFT";
    expect(resolveSebConfigurationWorkflowAction(statusAfterCreate)).toBe("ACTIVATE");
  });

  it("DRAFT -> Activate succeeds -> configuration status becomes ACTIVE -> Revoke button visible", () => {
    const statusAfterActivate = "ACTIVE";
    expect(resolveSebConfigurationWorkflowAction(statusAfterActivate)).toBe("REVOKE");
  });
});

describe("isAddSebKeyDisabled", () => {
  it("disabled when the key field is empty", () => {
    expect(isAddSebKeyDisabled("")).toBe(true);
  });

  it("disabled below the minimum key length (mirrors the server's rawKey.min(8) bound)", () => {
    expect(isAddSebKeyDisabled("short")).toBe(true);
    expect(MIN_SEB_KEY_LENGTH).toBe(8);
  });

  it("enabled once the key meets the minimum length", () => {
    expect(isAddSebKeyDisabled("a".repeat(MIN_SEB_KEY_LENGTH))).toBe(false);
    expect(isAddSebKeyDisabled("a-valid-looking-browser-exam-key-value")).toBe(false);
  });

  it("keys are never required for configuration creation or activation — this check only ever gates the Add key button itself", () => {
    // No key value is ever consulted by resolveSebConfigurationWorkflowAction
    // (it doesn't even accept one as a parameter), so an empty/disabled
    // key field can never block creating or activating a configuration.
    expect(resolveSebConfigurationWorkflowAction(undefined)).toBe("CREATE");
    expect(isAddSebKeyDisabled("")).toBe(true);
  });
});
