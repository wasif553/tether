/**
 * Tether launch/install flow v1 — pure single-display enforcement
 * decision logic. Deliberately free of any Electron import (`electron.screen`
 * cannot run outside the Electron main process, and this repo's test
 * tooling runs under plain vitest/node) — see displayEnforcement.ts for
 * the main-process glue that calls these functions.
 */
import { isBlockingTopology, type WindowsDisplayTopologyClassification } from "./windowsDisplayTopologyClassifier";

export type DisplayEnforcementState = "OK" | "BLOCKED";

/**
 * Requirement 7/8 core decision: BLOCKED whenever the policy requires a
 * single display and more than one is currently connected. `false` for
 * `requireSingleDisplay` always yields OK, regardless of display count —
 * this module never enforces anything the caller hasn't explicitly told
 * it to (the Electron main process has no policy awareness of its own;
 * see displayEnforcement.ts).
 */
export function resolveDisplayEnforcementState(displayCount: number, requireSingleDisplay: boolean): DisplayEnforcementState {
  if (!requireSingleDisplay) return "OK";
  return displayCount > 1 ? "BLOCKED" : "OK";
}

/**
 * Corrective pass v1.2.0, Part 2 — combines Electron's own logical
 * display count (insufficient alone: confirmed by physical testing to
 * continuously report 1 in Windows Duplicate/Clone mode) with the
 * Windows-native topology classification (see
 * windowsDisplayTopologyClassifier.ts). BLOCKED whenever EITHER signal
 * alone would block: Electron count > 1, OR the Windows topology is
 * EXTEND/CLONE_OR_DUPLICATE/MULTIPLE_ACTIVE_TARGETS, OR the topology
 * could not be authoritatively established (ERROR/UNKNOWN — fails
 * closed, never silently passes). This is the ONE function
 * displayEnforcement.ts's evaluate() calls to make the actual
 * block/unblock decision — kept pure and separate from the class so it
 * is directly unit-testable without spawning PowerShell or Electron.
 */
export function resolveCombinedDisplayEnforcementState(
  displayCount: number,
  requireSingleDisplay: boolean,
  topologyClassification: WindowsDisplayTopologyClassification,
): DisplayEnforcementState {
  if (!requireSingleDisplay) return "OK";
  if (displayCount > 1) return "BLOCKED";
  if (isBlockingTopology(topologyClassification)) return "BLOCKED";
  return "OK";
}

export const DEFAULT_DISPLAY_EVENT_DEBOUNCE_MS = 500;

/**
 * Debounces rapid-fire duplicate display-change events — a single
 * physical plug/unplug, or a display waking from sleep, can fire several
 * `display-added`/`display-removed`/`display-metrics-changed` events in
 * quick succession. Returns true when this event should actually be
 * processed, false when it should be silently ignored because it
 * arrived within `debounceMs` of the last processed event.
 */
export function debounceDisplayEvent(lastHandledAtMs: number | null, nowMs: number, debounceMs: number = DEFAULT_DISPLAY_EVENT_DEBOUNCE_MS): boolean {
  if (lastHandledAtMs == null) return true;
  return nowMs - lastHandledAtMs >= debounceMs;
}

export type DisplayEnforcementEventType = "ADDITIONAL_DISPLAY_PRESENT" | "DISPLAY_CONFIGURATION_CHANGED" | "DISPLAY_POLICY_RESTORED";

/**
 * Decides which (if any) integrity signal should be reported for a
 * transition from `previousState` to `nextState` — mirrors the event
 * taxonomy already defined server-side in
 * src/lib/secureClient/secureClientEvents.ts (SECURE_CLIENT_EVENT_TYPES):
 * ADDITIONAL_DISPLAY_PRESENT the first time enforcement becomes BLOCKED,
 * DISPLAY_CONFIGURATION_CHANGED for a further change while still
 * BLOCKED, DISPLAY_POLICY_RESTORED when returning to OK after having
 * been BLOCKED. Returns null when no report is warranted (state and
 * count both unchanged, or was already OK and remains OK) — this keeps
 * event volume proportional to actual policy-relevant changes, not to
 * every debounced-through OS event.
 */
export function resolveDisplayEnforcementEventType(params: {
  previousState: DisplayEnforcementState | null;
  nextState: DisplayEnforcementState;
  previousDisplayCount: number | null;
  nextDisplayCount: number;
}): DisplayEnforcementEventType | null {
  if (params.nextState === "BLOCKED") {
    if (params.previousState !== "BLOCKED") return "ADDITIONAL_DISPLAY_PRESENT";
    if (params.previousDisplayCount !== params.nextDisplayCount) return "DISPLAY_CONFIGURATION_CHANGED";
    return null;
  }
  if (params.previousState === "BLOCKED") return "DISPLAY_POLICY_RESTORED";
  return null;
}
