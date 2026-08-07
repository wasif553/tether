/**
 * Tether mid-exam remote-session monitoring v1 — pure state-transition
 * module. No Electron dependency, no timers — safe to unit-test directly.
 *
 * Extends remote-session detection (windowsSessionDetection.ts /
 * windowsSessionDetectionLogic.ts, previously consulted only at preflight
 * — see lockdownCapabilityRegistry.ts's REMOTE_DESKTOP_SESSION capability)
 * to continuous polling during an active exam. This module owns exactly
 * one decision: given the PREVIOUS tracked state and a FRESH
 * WindowsSessionClassification, what (if any) transition event(s) should
 * fire this poll, and what the new tracked state is.
 *
 * Two independent state axes are tracked, not one collapsed enum:
 * - lastKnownActiveState ("INACTIVE" | "ACTIVE") — whether Tether itself
 *   is believed to be running inside an inbound remote session.
 * - lastCheckAvailable (boolean) — whether the underlying Windows check
 *   itself is currently succeeding (remoteSessionSignalSource !==
 *   "UNAVAILABLE").
 *
 * This lets a single poll correctly emit BOTH a CHECK_RECOVERED fact AND
 * a BECAME_ACTIVE signal (e.g. the check was failing, then recovers
 * directly into observing an active session) without losing information,
 * and — critically — a failed check NEVER changes lastKnownActiveState
 * (fail-closed: matches the existing preflight fail-closed convention in
 * windowsSessionDetectionLogic.ts / windowsSessionDetection.ts, "never
 * clear tracked state on a failed check").
 *
 * Deduplication (Required behaviour #4): a transition is only ever
 * produced when an axis's value actually changes from its previously
 * tracked value — repeated identical poll results produce zero
 * transitions.
 */
import type { WindowsSessionClassification } from "./windowsSessionDetectionLogic";

export type RemoteSessionActiveState = "INACTIVE" | "ACTIVE";

export type RemoteSessionMonitorTransition =
  | { kind: "BECAME_ACTIVE"; previousState: RemoteSessionActiveState; currentState: "ACTIVE"; classification: WindowsSessionClassification }
  | { kind: "BECAME_INACTIVE"; previousState: RemoteSessionActiveState; currentState: "INACTIVE"; classification: WindowsSessionClassification }
  | { kind: "CHECK_UNAVAILABLE"; classification: WindowsSessionClassification }
  | { kind: "CHECK_RECOVERED"; classification: WindowsSessionClassification };

export type RemoteSessionMonitorState = {
  lastKnownActiveState: RemoteSessionActiveState;
  lastCheckAvailable: boolean;
};

/** Starting state for a freshly-created monitor (or after an exam becomes ACTIVE) — assumes inactive/available until the first poll proves otherwise. */
export const INITIAL_REMOTE_SESSION_MONITOR_STATE: RemoteSessionMonitorState = {
  lastKnownActiveState: "INACTIVE",
  lastCheckAvailable: true,
};

export type RemoteSessionMonitorPollResult = {
  nextState: RemoteSessionMonitorState;
  transitions: RemoteSessionMonitorTransition[];
};

/**
 * The single pure decision function. Never throws — classification is
 * assumed to already be a well-formed WindowsSessionClassification
 * (getWindowsSessionClassification() itself never throws or returns
 * null/undefined — see windowsSessionDetection.ts).
 */
export function computeRemoteSessionMonitorTransitions(
  state: RemoteSessionMonitorState,
  classification: WindowsSessionClassification,
): RemoteSessionMonitorPollResult {
  const transitions: RemoteSessionMonitorTransition[] = [];
  const checkAvailable = classification.remoteSessionSignalSource !== "UNAVAILABLE";

  if (!checkAvailable) {
    if (state.lastCheckAvailable) {
      transitions.push({ kind: "CHECK_UNAVAILABLE", classification });
    }
    // Fail-closed: an unavailable check never changes lastKnownActiveState.
    return { nextState: { ...state, lastCheckAvailable: false }, transitions };
  }

  let nextState: RemoteSessionMonitorState = { ...state, lastCheckAvailable: true };
  if (!state.lastCheckAvailable) {
    transitions.push({ kind: "CHECK_RECOVERED", classification });
  }

  const currentActiveState: RemoteSessionActiveState = classification.isRemoteSession ? "ACTIVE" : "INACTIVE";
  if (currentActiveState !== state.lastKnownActiveState) {
    transitions.push(
      currentActiveState === "ACTIVE"
        ? { kind: "BECAME_ACTIVE", previousState: state.lastKnownActiveState, currentState: "ACTIVE", classification }
        : { kind: "BECAME_INACTIVE", previousState: state.lastKnownActiveState, currentState: "INACTIVE", classification },
    );
    nextState = { ...nextState, lastKnownActiveState: currentActiveState };
  }

  return { nextState, transitions };
}
