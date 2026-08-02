import { describe, it, expect } from "vitest";
import {
  parseProcessListOutput,
  resolveScanOutcome,
  diffDetectionEpisodes,
  resolveProcessDetectionTransition,
  resolvePreflightCheckResult,
} from "./processDetectionLogic";

describe("parseProcessListOutput", () => {
  it("parses a well-formed JSON array of names", () => {
    expect(parseProcessListOutput('["TeamViewer.exe","chrome.exe"]')).toEqual({ ok: true, rawNames: ["TeamViewer.exe", "chrome.exe"] });
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseProcessListOutput('\r\n  ["a.exe"]  \r\n')).toEqual({ ok: true, rawNames: ["a.exe"] });
  });

  it("5. fails closed (never clean) on invalid JSON — malformed process output", () => {
    expect(parseProcessListOutput("not json")).toEqual({ ok: false, reason: "parse_failed" });
  });

  it("fails closed on empty output", () => {
    expect(parseProcessListOutput("")).toEqual({ ok: false, reason: "parse_failed" });
  });

  it("fails closed when the JSON is not an array", () => {
    expect(parseProcessListOutput('{"ok":true}')).toEqual({ ok: false, reason: "parse_failed" });
  });

  it("drops non-string entries rather than throwing on a mixed array", () => {
    expect(parseProcessListOutput('["a.exe", 42, null, "b.exe"]')).toEqual({ ok: true, rawNames: ["a.exe", "b.exe"] });
  });

  it("27. bounds the number of entries even if the process listing is pathologically large", () => {
    const huge = JSON.stringify(Array.from({ length: 50_000 }, () => "x.exe"));
    const result = parseProcessListOutput(huge);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rawNames.length).toBeLessThanOrEqual(2_000);
  });
});

describe("resolveScanOutcome — 28. never exposes the raw process list, only matched capability ids", () => {
  it("matches known capabilities and returns only their ids", () => {
    const outcome = resolveScanOutcome({ ok: true, rawNames: ["TeamViewer.exe", "explorer.exe", "AnyDesk.exe"] });
    expect(outcome).toEqual({ ok: true, matchedCapabilityIds: expect.arrayContaining(["TEAMVIEWER", "ANYDESK"]) });
    if (outcome.ok) {
      expect(outcome.matchedCapabilityIds).toHaveLength(2);
      // Structurally impossible for this result to contain a raw process
      // name, since matchedCapabilityIds only ever holds registry ids.
      expect(outcome.matchedCapabilityIds).not.toContain("explorer.exe");
      expect(outcome.matchedCapabilityIds).not.toContain("TeamViewer.exe");
    }
  });

  it("4. an unknown process produces zero matches, not a block", () => {
    const outcome = resolveScanOutcome({ ok: true, rawNames: ["notepad.exe", "chrome.exe", "explorer.exe"] });
    expect(outcome).toEqual({ ok: true, matchedCapabilityIds: [] });
  });

  it("5. a parse failure never reports as a clean (empty) result — it is a distinct UNAVAILABLE-shaped outcome", () => {
    const outcome = resolveScanOutcome({ ok: false, reason: "parse_failed" });
    expect(outcome).toEqual({ ok: false, reason: "PARSE_FAILED" });
    // Never `{ ok: true, matchedCapabilityIds: [] }` — that would be
    // indistinguishable from "we checked and found nothing".
    expect(outcome).not.toEqual({ ok: true, matchedCapabilityIds: [] });
  });

  it("6. normalizes process names before matching (case, path, extension)", () => {
    const outcome = resolveScanOutcome({ ok: true, rawNames: ["C:\\Program Files\\TeamViewer\\TEAMVIEWER.EXE"] });
    expect(outcome).toEqual({ ok: true, matchedCapabilityIds: ["TEAMVIEWER"] });
  });

  it("deduplicates a capability matched by more than one of its own executable names in the same scan", () => {
    const outcome = resolveScanOutcome({ ok: true, rawNames: ["procexp.exe", "procexp64.exe"] });
    expect(outcome).toEqual({ ok: true, matchedCapabilityIds: ["PROCESS_INSPECTION_TOOLS"] });
  });
});

describe("diffDetectionEpisodes — 9. one logical episode per continuous detection, not one per poll", () => {
  it("reports newlyDetected only on the transition into presence", () => {
    const diff = diffDetectionEpisodes(new Set(), new Set(["TEAMVIEWER"]));
    expect(diff).toEqual({ newlyDetected: ["TEAMVIEWER"], newlyCleared: [] });
  });

  it("reports nothing while the same capability stays continuously present across polls", () => {
    const diff = diffDetectionEpisodes(new Set(["TEAMVIEWER"]), new Set(["TEAMVIEWER"]));
    expect(diff).toEqual({ newlyDetected: [], newlyCleared: [] });
  });

  it("10. reports newlyCleared exactly once when a capability stops appearing", () => {
    const diff = diffDetectionEpisodes(new Set(["TEAMVIEWER"]), new Set());
    expect(diff).toEqual({ newlyDetected: [], newlyCleared: ["TEAMVIEWER"] });
  });

  it("reports nothing while continuously absent", () => {
    const diff = diffDetectionEpisodes(new Set(), new Set());
    expect(diff).toEqual({ newlyDetected: [], newlyCleared: [] });
  });

  it("handles simultaneous detection and clearance of different capabilities in one tick", () => {
    const diff = diffDetectionEpisodes(new Set(["TEAMVIEWER"]), new Set(["ANYDESK"]));
    expect(diff.newlyDetected).toEqual(["ANYDESK"]);
    expect(diff.newlyCleared).toEqual(["TEAMVIEWER"]);
  });
});

describe("resolveProcessDetectionTransition — Part 2's four distinguished states", () => {
  it("DETECTED: newly present", () => {
    expect(resolveProcessDetectionTransition(false, true)).toBe("DETECTED");
  });
  it("STILL_DETECTED: continuously present", () => {
    expect(resolveProcessDetectionTransition(true, true)).toBe("STILL_DETECTED");
  });
  it("CLOSED: was present, now absent", () => {
    expect(resolveProcessDetectionTransition(true, false)).toBe("CLOSED");
  });
  it("STILL_CLEAR: continuously absent", () => {
    expect(resolveProcessDetectionTransition(false, false)).toBe("STILL_CLEAR");
  });
});

describe("resolvePreflightCheckResult — Part 3", () => {
  const BLOCKING_IDS = ["TEAMVIEWER", "ANYDESK", "OBS"];

  it("1. a known remote-control process blocks preflight", () => {
    const result = resolvePreflightCheckResult({ ok: true, matchedCapabilityIds: ["TEAMVIEWER"] }, BLOCKING_IDS);
    expect(result).toEqual({ state: "BLOCKED", matchedCapabilityIds: ["TEAMVIEWER"] });
  });

  it("2. a known screen-recording process blocks preflight", () => {
    const result = resolvePreflightCheckResult({ ok: true, matchedCapabilityIds: ["OBS"] }, BLOCKING_IDS);
    expect(result).toEqual({ state: "BLOCKED", matchedCapabilityIds: ["OBS"] });
  });

  it("4. an unknown/non-blocking process does not block preflight", () => {
    const result = resolvePreflightCheckResult({ ok: true, matchedCapabilityIds: ["CLIPBOARD_MANAGERS"] }, BLOCKING_IDS);
    expect(result).toEqual({ state: "CLEAN" });
  });

  it("a genuinely clean scan reports CLEAN", () => {
    expect(resolvePreflightCheckResult({ ok: true, matchedCapabilityIds: [] }, BLOCKING_IDS)).toEqual({ state: "CLEAN" });
  });

  it("5. detection unavailable is never reported as clean", () => {
    const result = resolvePreflightCheckResult({ ok: false, reason: "TIMEOUT" }, BLOCKING_IDS);
    expect(result).toEqual({ state: "UNAVAILABLE", reason: "TIMEOUT" });
    expect(result).not.toEqual({ state: "CLEAN" });
  });

  it("only capabilities in the preflight-blocking set actually block — a DETECT_AND_RECORD-only match is silently excluded here (it still gets recorded elsewhere, just never blocks)", () => {
    const result = resolvePreflightCheckResult({ ok: true, matchedCapabilityIds: ["TEAMVIEWER", "CLIPBOARD_MANAGERS"] }, BLOCKING_IDS);
    expect(result).toEqual({ state: "BLOCKED", matchedCapabilityIds: ["TEAMVIEWER"] });
  });
});
