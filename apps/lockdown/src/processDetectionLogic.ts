/**
 * Tether Windows Lockdown Hardening v1 — pure process-detection decision
 * logic (Part 2/4). No Electron, no Node child_process — safe to unit
 * test directly, mirrors displayEnforcementLogic.ts's own convention.
 * processDetection.ts (the actual PowerShell-spawning service) is the
 * only caller.
 */
import {
  matchCapabilitiesByExecutableNames,
  normalizeExecutableName,
  type LockdownCapability,
} from "./lockdownCapabilityRegistry";

// ---------------------------------------------------------------------------
// Raw scan-result parsing — the boundary between the spawned PowerShell
// process's stdout and the rest of the app. Mirrors
// windowsDisplayTopology.ts's parseTopologyOutput: never trusts stdout
// structurally, fails closed (never "clean") on anything malformed.
// ---------------------------------------------------------------------------

export type ProcessListParseResult =
  | { ok: true; rawNames: string[] }
  | { ok: false; reason: "parse_failed" };

/**
 * Parses the JSON array of raw process names the PowerShell script
 * prints (Part 2: "handle permission-denied results safely" — a process
 * this account cannot see simply never appears in the list; there is no
 * separate per-process error to surface, only a whole-scan-level
 * unavailable result — see resolveScanOutcome below for that boundary).
 * Bounded: only ever returns an array of at most MAX_PROCESS_NAMES
 * strings, each already length-capped by normalizeExecutableName, so a
 * pathological/adversarial stdout can never balloon memory or matching
 * time — Part 2 "avoid unbounded polling" / "apply timeouts" and Part 16
 * item 27 (process polling is bounded).
 */
const MAX_PROCESS_NAMES = 2_000;

export function parseProcessListOutput(stdout: string): ProcessListParseResult {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    if (!Array.isArray(parsed)) return { ok: false, reason: "parse_failed" };
    const rawNames = parsed
      .filter((v): v is string => typeof v === "string")
      .slice(0, MAX_PROCESS_NAMES);
    return { ok: true, rawNames };
  } catch {
    return { ok: false, reason: "parse_failed" };
  }
}

// ---------------------------------------------------------------------------
// Scan outcome — the four states Part 2 asks this service to distinguish:
// detected / detection unavailable / process closed / process restarted.
// "closed" and "restarted" are expressed as episode transitions (see
// diffDetectionEpisodes) rather than as a scan-level enum value, since
// they are inherently about the DIFFERENCE between two scans, not a
// single scan's own result.
// ---------------------------------------------------------------------------

export type ProcessScanUnavailableReason = "TIMEOUT" | "SPAWN_FAILED" | "PARSE_FAILED" | "NON_ZERO_EXIT" | "NOT_WINDOWS";

export type ProcessScanOutcome =
  | { ok: true; matchedCapabilityIds: string[] }
  | { ok: false; reason: ProcessScanUnavailableReason };

/**
 * The one place raw process names become matched capability ids. Part 2:
 * "do not send full process lists to the web app" / "expose only
 * matched capability IDs and minimal metadata" — this function's own
 * signature enforces that structurally: it never returns the input
 * names themselves, only the ids of registry entries that matched.
 */
export function resolveScanOutcome(parseResult: ProcessListParseResult): ProcessScanOutcome {
  if (!parseResult.ok) return { ok: false, reason: "PARSE_FAILED" };
  const normalized = parseResult.rawNames.map(normalizeExecutableName).filter((n) => n.length > 0);
  const matched: LockdownCapability[] = matchCapabilitiesByExecutableNames(normalized);
  return { ok: true, matchedCapabilityIds: [...new Set(matched.map((c) => c.id))] };
}

// ---------------------------------------------------------------------------
// Episode tracking (Part 4: "record detection start, restoration and
// duration" / "do not repeatedly create the same event every polling
// cycle"). A capability id transitions DETECTED exactly once per
// continuous episode (first scan that finds it after not having found
// it), and CLEARED exactly once when it stops appearing — never on every
// intermediate poll while it remains present or remains absent. Mirrors
// the camera-integrity "sustained episode" pattern in
// src/lib/cameraIntegrityDetection.ts (resolveCameraIntegrityState /
// CAMERA_VISIBILITY_RESTORED) — see that module's own doc comment.
// ---------------------------------------------------------------------------

export type DetectionEpisodeDiff = {
  /** Capability ids present in `current` but not in `previous` — report PROHIBITED_APPLICATION_DETECTED for each, exactly once. */
  newlyDetected: string[];
  /** Capability ids present in `previous` but not in `current` — report PROHIBITED_APPLICATION_CLOSED for each, exactly once. */
  newlyCleared: string[];
};

export function diffDetectionEpisodes(previous: ReadonlySet<string>, current: ReadonlySet<string>): DetectionEpisodeDiff {
  const newlyDetected: string[] = [];
  const newlyCleared: string[] = [];
  for (const id of current) if (!previous.has(id)) newlyDetected.push(id);
  for (const id of previous) if (!current.has(id)) newlyCleared.push(id);
  return { newlyDetected, newlyCleared };
}

/**
 * Part 2's four distinguished states, expressed as a single decision per
 * capability id across two consecutive scans — used by the IPC layer to
 * decide what (if anything) to tell the renderer this tick, without the
 * renderer having to re-derive episode logic itself.
 */
export type ProcessDetectionTransition = "DETECTED" | "STILL_DETECTED" | "CLOSED" | "STILL_CLEAR";

export function resolveProcessDetectionTransition(wasDetected: boolean, isDetected: boolean): ProcessDetectionTransition {
  if (isDetected) return wasDetected ? "STILL_DETECTED" : "DETECTED";
  return wasDetected ? "CLOSED" : "STILL_CLEAR";
}

// ---------------------------------------------------------------------------
// Preflight decision (Part 3). "Unable to inspect processes" must never
// be treated as "no prohibited processes found" — modeled as a distinct
// third outcome, not folded into the boolean "blocked" result.
// ---------------------------------------------------------------------------

export type PreflightCheckResult =
  | { state: "CLEAN" }
  | { state: "BLOCKED"; matchedCapabilityIds: string[] }
  | { state: "UNAVAILABLE"; reason: ProcessScanUnavailableReason };

export function resolvePreflightCheckResult(scan: ProcessScanOutcome, preflightBlockingCapabilityIds: readonly string[]): PreflightCheckResult {
  if (!scan.ok) return { state: "UNAVAILABLE", reason: scan.reason };
  const blockingSet = new Set(preflightBlockingCapabilityIds);
  const blocking = scan.matchedCapabilityIds.filter((id) => blockingSet.has(id));
  if (blocking.length > 0) return { state: "BLOCKED", matchedCapabilityIds: blocking };
  return { state: "CLEAN" };
}
