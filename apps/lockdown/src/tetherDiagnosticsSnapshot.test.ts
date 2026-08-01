import { describe, it, expect } from "vitest";
import {
  INITIAL_TETHER_DIAGNOSTICS_SNAPSHOT,
  snapshotsEqualIgnoringTimestamp,
  formatDiagnosticLogLine,
  isDiagnosticsPanelEnabled,
  type TetherDiagnosticsSnapshot,
} from "./tetherDiagnosticsSnapshot";

// ---------------------------------------------------------------------------
// Corrective pass v1.2.1, Tasks A/B — pure snapshot comparison/formatting
// logic for the diagnostic panel and the on-disk diagnostic log.
// ---------------------------------------------------------------------------

describe("isDiagnosticsPanelEnabled", () => {
  it("requires the exact string \"true\" — never activates on undefined, empty string, or any other value", () => {
    expect(isDiagnosticsPanelEnabled("true")).toBe(true);
    expect(isDiagnosticsPanelEnabled(undefined)).toBe(false);
    expect(isDiagnosticsPanelEnabled("")).toBe(false);
    expect(isDiagnosticsPanelEnabled("1")).toBe(false);
    expect(isDiagnosticsPanelEnabled("TRUE")).toBe(false);
  });
});

describe("snapshotsEqualIgnoringTimestamp", () => {
  it("Task B: two snapshots differing only in lastDisplayCheckAt are considered equal (a poll tick alone is never a state change)", () => {
    const a: TetherDiagnosticsSnapshot = { ...INITIAL_TETHER_DIAGNOSTICS_SNAPSHOT, lastDisplayCheckAt: "2026-01-01T00:00:00.000Z" };
    const b: TetherDiagnosticsSnapshot = { ...INITIAL_TETHER_DIAGNOSTICS_SNAPSHOT, lastDisplayCheckAt: "2026-01-01T00:00:02.000Z" };
    expect(snapshotsEqualIgnoringTimestamp(a, b)).toBe(true);
  });

  it("a genuine decision change (ALLOW -> BLOCK) is never treated as equal, even with the same timestamp", () => {
    const a: TetherDiagnosticsSnapshot = { ...INITIAL_TETHER_DIAGNOSTICS_SNAPSHOT, currentDecision: "ALLOW" };
    const b: TetherDiagnosticsSnapshot = { ...INITIAL_TETHER_DIAGNOSTICS_SNAPSHOT, currentDecision: "BLOCK" };
    expect(snapshotsEqualIgnoringTimestamp(a, b)).toBe(false);
  });

  it("a display-count change is never treated as equal", () => {
    const a: TetherDiagnosticsSnapshot = { ...INITIAL_TETHER_DIAGNOSTICS_SNAPSHOT, electronDisplayCount: 1 };
    const b: TetherDiagnosticsSnapshot = { ...INITIAL_TETHER_DIAGNOSTICS_SNAPSHOT, electronDisplayCount: 2 };
    expect(snapshotsEqualIgnoringTimestamp(a, b)).toBe(false);
  });

  it("a topology classification change is never treated as equal", () => {
    const a: TetherDiagnosticsSnapshot = { ...INITIAL_TETHER_DIAGNOSTICS_SNAPSHOT, windowsTopologyClassification: "INTERNAL_ONLY" };
    const b: TetherDiagnosticsSnapshot = { ...INITIAL_TETHER_DIAGNOSTICS_SNAPSHOT, windowsTopologyClassification: "EXTEND" };
    expect(snapshotsEqualIgnoringTimestamp(a, b)).toBe(false);
  });

  it("a page-reported policy field change (e.g. deliveryMode becoming known) is never treated as equal", () => {
    const a: TetherDiagnosticsSnapshot = { ...INITIAL_TETHER_DIAGNOSTICS_SNAPSHOT, deliveryMode: null };
    const b: TetherDiagnosticsSnapshot = { ...INITIAL_TETHER_DIAGNOSTICS_SNAPSHOT, deliveryMode: "TETHER_CLIENT_REQUIRED" };
    expect(snapshotsEqualIgnoringTimestamp(a, b)).toBe(false);
  });

  it("an error-code change is never treated as equal", () => {
    const a: TetherDiagnosticsSnapshot = { ...INITIAL_TETHER_DIAGNOSTICS_SNAPSHOT, lastErrorCode: null };
    const b: TetherDiagnosticsSnapshot = { ...INITIAL_TETHER_DIAGNOSTICS_SNAPSHOT, lastErrorCode: "TOPOLOGY_QUERY_FAILED" };
    expect(snapshotsEqualIgnoringTimestamp(a, b)).toBe(false);
  });
});

describe("formatDiagnosticLogLine", () => {
  it("produces one single-line, JSON-parseable record prefixed with an ISO timestamp", () => {
    const line = formatDiagnosticLogLine({ ...INITIAL_TETHER_DIAGNOSTICS_SNAPSHOT, browserVersion: "1.2.1" });
    expect(line).not.toMatch(/\n/);
    const spaceIndex = line.indexOf(" ");
    const timestamp = line.slice(0, spaceIndex);
    const jsonPart = line.slice(spaceIndex + 1);
    expect(() => new Date(timestamp).toISOString()).not.toThrow();
    const parsed = JSON.parse(jsonPart);
    expect(parsed.browserVersion).toBe("1.2.1");
  });

  it("never includes a token/cookie/manifest/name/email/signing-key/full-URL field — the type has structurally none of those", () => {
    const line = formatDiagnosticLogLine({ ...INITIAL_TETHER_DIAGNOSTICS_SNAPSHOT });
    for (const forbidden of ["token", "cookie", "manifest", "email", "signingKey", "signature", "http://", "https://"]) {
      expect(line.toLowerCase()).not.toMatch(forbidden.toLowerCase());
    }
  });
});
