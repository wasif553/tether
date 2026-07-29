import { describe, it, expect } from "vitest";
import { classifyWindowsDisplayTopology, isBlockingTopology, WINDOWS_TOPOLOGY_CLASSIFICATIONS } from "./windowsDisplayTopologyClassifier";

// ---------------------------------------------------------------------------
// Corrective pass v1.2.0, Part 2 — Windows Duplicate/Clone detection.
// screen.getAllDisplays() alone is confirmed (physical testing) to report 1
// in Windows Duplicate/Clone mode; this classifies the real Win32
// QueryDisplayConfig topology from bounded path/source counts only.
// ---------------------------------------------------------------------------

describe("classifyWindowsDisplayTopology", () => {
  it("a single active target classifies as INTERNAL_ONLY by default (single-display + one active target -> allowed)", () => {
    const result = classifyWindowsDisplayTopology({ ok: true, activePathCount: 1, distinctSourceCount: 1 });
    expect(result.classification).toBe("INTERNAL_ONLY");
    expect(result.activeTargetCount).toBe(1);
  });

  it("a single active target is EXTERNAL_ONLY when Electron reports the primary display as non-internal", () => {
    const result = classifyWindowsDisplayTopology(
      { ok: true, activePathCount: 1, distinctSourceCount: 1 },
      { primaryIsInternal: false },
    );
    expect(result.classification).toBe("EXTERNAL_ONLY");
  });

  it("two active paths each with a distinct source classifies as EXTEND", () => {
    const result = classifyWindowsDisplayTopology({ ok: true, activePathCount: 2, distinctSourceCount: 2 });
    expect(result.classification).toBe("EXTEND");
    expect(result.activeTargetCount).toBe(2);
  });

  it("two active paths sharing one source classifies as CLONE_OR_DUPLICATE (Windows Duplicate/Clone mode)", () => {
    const result = classifyWindowsDisplayTopology({ ok: true, activePathCount: 2, distinctSourceCount: 1 });
    expect(result.classification).toBe("CLONE_OR_DUPLICATE");
    expect(result.activeTargetCount).toBe(2);
  });

  it("more targets than can be cleanly attributed to a single clone group classifies as MULTIPLE_ACTIVE_TARGETS", () => {
    const result = classifyWindowsDisplayTopology({ ok: true, activePathCount: 3, distinctSourceCount: 2 });
    expect(result.classification).toBe("MULTIPLE_ACTIVE_TARGETS");
    expect(result.activeTargetCount).toBe(3);
  });

  it("a failed query classifies as ERROR with no target count", () => {
    const result = classifyWindowsDisplayTopology({ ok: false, reason: "spawn_failed" });
    expect(result.classification).toBe("ERROR");
    expect(result.activeTargetCount).toBeNull();
  });

  it("every failure reason maps to ERROR", () => {
    for (const reason of ["spawn_failed", "non_zero_exit", "parse_failed", "timeout"] as const) {
      expect(classifyWindowsDisplayTopology({ ok: false, reason }).classification).toBe("ERROR");
    }
  });

  it("a structurally impossible result (more distinct sources than active paths) classifies as UNKNOWN, never guessed at", () => {
    const result = classifyWindowsDisplayTopology({ ok: true, activePathCount: 1, distinctSourceCount: 2 });
    expect(result.classification).toBe("UNKNOWN");
  });

  it("negative counts classify as UNKNOWN rather than being trusted", () => {
    expect(classifyWindowsDisplayTopology({ ok: true, activePathCount: -1, distinctSourceCount: 0 }).classification).toBe("UNKNOWN");
  });

  it("zero active paths classifies as UNKNOWN (an exam-taking machine always has at least one active path)", () => {
    const result = classifyWindowsDisplayTopology({ ok: true, activePathCount: 0, distinctSourceCount: 0 });
    expect(result.classification).toBe("UNKNOWN");
    expect(result.activeTargetCount).toBe(0);
  });
});

describe("isBlockingTopology", () => {
  it("blocks EXTEND, CLONE_OR_DUPLICATE, MULTIPLE_ACTIVE_TARGETS, ERROR, and UNKNOWN", () => {
    for (const classification of ["EXTEND", "CLONE_OR_DUPLICATE", "MULTIPLE_ACTIVE_TARGETS", "ERROR", "UNKNOWN"] as const) {
      expect(isBlockingTopology(classification)).toBe(true);
    }
  });

  it("never blocks INTERNAL_ONLY or EXTERNAL_ONLY", () => {
    expect(isBlockingTopology("INTERNAL_ONLY")).toBe(false);
    expect(isBlockingTopology("EXTERNAL_ONLY")).toBe(false);
  });

  it("covers every declared classification with no gaps", () => {
    for (const classification of WINDOWS_TOPOLOGY_CLASSIFICATIONS) {
      expect(typeof isBlockingTopology(classification)).toBe("boolean");
    }
  });
});
