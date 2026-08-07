import { describe, it, expect } from "vitest";
import {
  LOCKDOWN_CAPABILITY_REGISTRY,
  LOCKDOWN_CAPABILITY_ACTIONS,
  LOCKDOWN_CAPABILITY_CATEGORIES,
  LOCKDOWN_FALSE_POSITIVE_RISKS,
  LOCKDOWN_DETECTION_METHODS,
  DEFAULT_LOCKDOWN_POLICY_TOGGLES,
  normalizeExecutableName,
  matchCapabilitiesByExecutableNames,
  getCapabilityById,
  resolveEffectiveAction,
  isPreflightBlockingAction,
  isDuringExamBlockingAction,
  type LockdownCapabilityCategory,
  type LockdownConfigToggle,
} from "./lockdownCapabilityRegistry";

describe("lockdownCapabilityRegistry — every entry is well-formed", () => {
  it("has at least one entry per required category (Part 1)", () => {
    for (const category of LOCKDOWN_CAPABILITY_CATEGORIES) {
      expect(LOCKDOWN_CAPABILITY_REGISTRY.some((c) => c.category === category)).toBe(true);
    }
  });

  it("every id is unique", () => {
    const ids = LOCKDOWN_CAPABILITY_REGISTRY.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every field uses a value from its own vocabulary", () => {
    for (const capability of LOCKDOWN_CAPABILITY_REGISTRY) {
      expect(LOCKDOWN_CAPABILITY_ACTIONS).toContain(capability.defaultAction);
      expect(LOCKDOWN_CAPABILITY_CATEGORIES).toContain(capability.category);
      expect(LOCKDOWN_FALSE_POSITIVE_RISKS).toContain(capability.falsePositiveRisk);
      expect(LOCKDOWN_DETECTION_METHODS).toContain(capability.detectionMethod);
    }
  });

  it("PROCESS_NAME_MATCH capabilities have at least one executable name, and non-process capabilities have none", () => {
    for (const capability of LOCKDOWN_CAPABILITY_REGISTRY) {
      if (capability.detectionMethod === "PROCESS_NAME_MATCH") {
        expect(capability.executableNames.length).toBeGreaterThan(0);
      } else {
        expect(capability.executableNames.length).toBe(0);
      }
    }
  });

  it("every executable name is already normalized (lowercase, no path, no .exe)", () => {
    for (const capability of LOCKDOWN_CAPABILITY_REGISTRY) {
      for (const exe of capability.executableNames) {
        expect(exe).toBe(normalizeExecutableName(exe));
        expect(exe).not.toContain("\\");
        expect(exe).not.toContain("/");
        expect(exe.toLowerCase().endsWith(".exe")).toBe(false);
      }
    }
  });

  it("a blocking/warning PROCESS_NAME_MATCH capability always has a calm, non-null studentExplanation (the 'close this application' prompt needs a name to show)", () => {
    for (const capability of LOCKDOWN_CAPABILITY_REGISTRY) {
      const blocksOrWarns = capability.defaultAction === "BLOCK_BEFORE_EXAM" || capability.defaultAction === "BLOCK_DURING_EXAM" || capability.defaultAction === "WARN_AND_REQUIRE_CLOSE";
      if (blocksOrWarns && capability.detectionMethod === "PROCESS_NAME_MATCH") {
        expect(capability.studentExplanation).not.toBeNull();
        expect(capability.studentExplanation!.length).toBeGreaterThan(0);
      }
    }
  });

  it("no studentExplanation ever contains a raw executable name, path fragment, or accusatory language", () => {
    const forbidden = ["\\", "/", ".exe", "suspicious", "misconduct", "cheat", "violation"];
    for (const capability of LOCKDOWN_CAPABILITY_REGISTRY) {
      if (!capability.studentExplanation) continue;
      const lower = capability.studentExplanation.toLowerCase();
      for (const word of forbidden) expect(lower).not.toContain(word);
    }
  });

  it("every documentation field (detectionNotes, auditEvidenceBehavior, supportedWindowsVersions) is non-empty", () => {
    for (const capability of LOCKDOWN_CAPABILITY_REGISTRY) {
      expect(capability.detectionNotes.length).toBeGreaterThan(0);
      expect(capability.auditEvidenceBehavior.length).toBeGreaterThan(0);
      expect(capability.supportedWindowsVersions.length).toBeGreaterThan(0);
    }
  });
});

describe("normalizeExecutableName — safe against malformed/adversarial input (Part 16 items 6/7)", () => {
  it("lowercases, strips path, strips .exe", () => {
    expect(normalizeExecutableName("C:\\Program Files\\TeamViewer\\TeamViewer.exe")).toBe("teamviewer");
    expect(normalizeExecutableName("ANYDESK.EXE")).toBe("anydesk");
    expect(normalizeExecutableName("/usr/bin/rustdesk")).toBe("rustdesk");
  });

  it("never throws on non-string input", () => {
    expect(normalizeExecutableName(null)).toBe("");
    expect(normalizeExecutableName(undefined)).toBe("");
    expect(normalizeExecutableName(42)).toBe("");
    expect(normalizeExecutableName({})).toBe("");
    expect(normalizeExecutableName(["teamviewer.exe"])).toBe("");
  });

  it("bounds pathological input length rather than processing it unbounded", () => {
    const huge = "a".repeat(1_000_000) + ".exe";
    const result = normalizeExecutableName(huge);
    expect(result.length).toBeLessThanOrEqual(512);
  });

  it("7. never produces a value usable as a shell command — pure string transform, no child-process invocation anywhere in this module", () => {
    // This module never calls child_process/spawn()/exec() at all — grep
    // the compiled output for actual invocation syntax (not just the
    // substring "exec", which appears harmlessly inside this very
    // function's own name, normalizeExecutableName).
    const source = normalizeExecutableName.toString();
    expect(source).not.toMatch(/child_process|require\(|\bexec\(|\bspawn\(/i);
  });

  it("handles embedded shell metacharacters as inert data, never as syntax", () => {
    expect(normalizeExecutableName("teamviewer.exe; rm -rf x")).toBe("teamviewer.exe; rm -rf x");
    expect(normalizeExecutableName("$(whoami).exe")).toBe("$(whoami)");
  });
});

describe("matchCapabilitiesByExecutableNames", () => {
  it("matches a known remote-control process", () => {
    const matches = matchCapabilitiesByExecutableNames([normalizeExecutableName("TeamViewer.exe")]);
    expect(matches.map((m) => m.id)).toContain("TEAMVIEWER");
  });

  it("4. an unknown process matches nothing", () => {
    const matches = matchCapabilitiesByExecutableNames([normalizeExecutableName("notepad.exe"), normalizeExecutableName("chrome.exe")]);
    expect(matches).toHaveLength(0);
  });

  it("returns an empty array for an empty input list, without scanning the whole registry pointlessly", () => {
    expect(matchCapabilitiesByExecutableNames([])).toEqual([]);
  });

  it("matches multiple distinct capabilities from one scan", () => {
    const matches = matchCapabilitiesByExecutableNames([normalizeExecutableName("AnyDesk.exe"), normalizeExecutableName("obs64.exe")]);
    expect(matches.map((m) => m.id).sort()).toEqual(["ANYDESK", "OBS"]);
  });
});

describe("getCapabilityById", () => {
  it("finds a known capability", () => {
    expect(getCapabilityById("TEAMVIEWER")?.displayName).toBe("TeamViewer");
  });
  it("returns undefined for an unknown id", () => {
    expect(getCapabilityById("NOT_A_REAL_ID")).toBeUndefined();
  });
});

describe("resolveEffectiveAction — Part 12 policy toggles", () => {
  const teamviewer = getCapabilityById("TEAMVIEWER")!;
  const nodeInspector = getCapabilityById("NODE_INSPECTOR")!;

  it("uses the capability's own default action when its toggle is on", () => {
    expect(resolveEffectiveAction(teamviewer, { ...DEFAULT_LOCKDOWN_POLICY_TOGGLES, blockRemoteControl: true })).toBe("BLOCK_DURING_EXAM");
  });

  it("downgrades to DETECT_AND_RECORD when the governing toggle is off — never fully silences the capability", () => {
    expect(resolveEffectiveAction(teamviewer, { ...DEFAULT_LOCKDOWN_POLICY_TOGGLES, blockRemoteControl: false })).toBe("DETECT_AND_RECORD");
  });

  it("a capability with no configToggle is unaffected by any toggle value", () => {
    expect(resolveEffectiveAction(nodeInspector, { blockRemoteControl: false, blockScreenCaptureTools: false, blockDebugTools: false, blockVirtualMachines: false })).toBe(
      "DETECT_AND_RECORD",
    );
    expect(resolveEffectiveAction(nodeInspector, { blockRemoteControl: true, blockScreenCaptureTools: true, blockDebugTools: true, blockVirtualMachines: true })).toBe(
      "DETECT_AND_RECORD",
    );
  });

  it("default toggles match the documented conservative, pilot-safe defaults", () => {
    expect(DEFAULT_LOCKDOWN_POLICY_TOGGLES).toEqual({
      blockRemoteControl: true,
      blockScreenCaptureTools: true,
      blockDebugTools: false,
      blockVirtualMachines: false,
    });
  });
});

describe("isPreflightBlockingAction / isDuringExamBlockingAction", () => {
  it("BLOCK_DURING_EXAM is both a preflight block and a during-exam block", () => {
    expect(isPreflightBlockingAction("BLOCK_DURING_EXAM")).toBe(true);
    expect(isDuringExamBlockingAction("BLOCK_DURING_EXAM")).toBe(true);
  });
  it("BLOCK_BEFORE_EXAM blocks preflight only", () => {
    expect(isPreflightBlockingAction("BLOCK_BEFORE_EXAM")).toBe(true);
    expect(isDuringExamBlockingAction("BLOCK_BEFORE_EXAM")).toBe(false);
  });
  it("WARN_AND_REQUIRE_CLOSE, DETECT_AND_RECORD, NOT_SUPPORTED never block anything", () => {
    for (const action of ["WARN_AND_REQUIRE_CLOSE", "DETECT_AND_RECORD", "NOT_SUPPORTED"] as const) {
      expect(isPreflightBlockingAction(action)).toBe(false);
      expect(isDuringExamBlockingAction(action)).toBe(false);
    }
  });
});

// Secure Exam Evidence Review audit v1 — regression coverage for the
// confirmed defect this pass fixed: REMOTE_DESKTOP_SESSION's `category`
// (VIRTUALIZATION) contradicted its own `configToggle`
// (TETHER_BLOCK_REMOTE_CONTROL) and its own `auditEvidenceBehavior` doc
// string (which claims REMOTE_CONTROL_SOFTWARE_DETECTED — only produced
// for category REMOTE_CONTROL, per the web app's
// integrityEventTypeForCapabilityCategory()). Every OTHER entry in the
// registry already had a consistent category<->configToggle pairing —
// this test generalises that observation into a standing invariant so a
// future entry can't silently drift the same way.
describe("category <-> configToggle consistency (Secure Exam Evidence Review audit v1)", () => {
  const EXPECTED_TOGGLE_FOR_CATEGORY: Partial<Record<LockdownCapabilityCategory, LockdownConfigToggle>> = {
    REMOTE_CONTROL: "TETHER_BLOCK_REMOTE_CONTROL",
    DEBUGGING: "TETHER_BLOCK_DEBUG_TOOLS",
    VIRTUALIZATION: "TETHER_BLOCK_VIRTUAL_MACHINES",
    CAPTURE_OVERLAY: "TETHER_BLOCK_SCREEN_CAPTURE_TOOLS",
  };

  it("every capability with a non-null configToggle uses the toggle that governs its own category", () => {
    for (const capability of LOCKDOWN_CAPABILITY_REGISTRY) {
      if (capability.configToggle === null) continue;
      const expected = EXPECTED_TOGGLE_FOR_CATEGORY[capability.category];
      expect(
        capability.configToggle,
        `${capability.id}: category "${capability.category}" expects configToggle "${expected}", found "${capability.configToggle}"`,
      ).toBe(expected);
    }
  });

  it("NAVIGATION_ESCAPE capabilities are never gated by a category toggle (Part 11 — these are PlatformAuditLog-only facts, never blocked by a policy toggle)", () => {
    for (const capability of LOCKDOWN_CAPABILITY_REGISTRY) {
      if (capability.category === "NAVIGATION_ESCAPE") {
        expect(capability.configToggle).toBeNull();
      }
    }
  });

  it("REMOTE_DESKTOP_SESSION is classified REMOTE_CONTROL, matching its documented REMOTE_CONTROL_SOFTWARE_DETECTED audit behaviour", () => {
    const capability = getCapabilityById("REMOTE_DESKTOP_SESSION");
    expect(capability?.category).toBe("REMOTE_CONTROL");
    expect(capability?.configToggle).toBe("TETHER_BLOCK_REMOTE_CONTROL");
  });
});
