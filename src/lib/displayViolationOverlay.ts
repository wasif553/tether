/**
 * Tether v1.7.6 — Native Display State Bridge, exam-page presentation.
 * See apps/lockdown/src/displayEnforcementLogic.ts's DisplayEnforcementStatus
 * doc comment for the bounded {state, reason, displayCount} shape this is
 * built from, and apps/lockdown/src/displayEnforcement.ts's top-of-file
 * doc comment for why this exists: physical HDMI-disconnect testing
 * isolated an unrecoverable-screen symptom (requiring a full OS restart)
 * to the previous native, screen-saver-level trapping BrowserWindow's
 * recovery path — the precise Windows window/compositor failure
 * mechanism was never independently established, only that removing the
 * overlay entirely removes the symptom. Detection and the block/unblock
 * decision remain
 * entirely native and unchanged — only the PRESENTATION moved here, to
 * the renderer.
 *
 * Deliberately its OWN state and terminology — never reuses
 * AiCameraViolationOverlayState (src/lib/aiCameraViolationOverlay.ts):
 * conflating a native display-topology fact with a probabilistic AI
 * camera signal would blur two structurally different kinds of evidence.
 * Unlike that overlay, this one is never locally dismissible while native
 * state remains BLOCKED — a real second display is a verifiable native
 * fact, not an inference the student should be able to wave away and
 * have it reopen next tick.
 *
 * Pure, dependency-free helpers — no DOM, no React, no IPC.
 */

export type DisplayEnforcementBridgeReason =
  | "ADDITIONAL_ELECTRON_DISPLAY"
  | "WINDOWS_TOPOLOGY_EXTEND"
  | "WINDOWS_TOPOLOGY_CLONE"
  | "MULTIPLE_ACTIVE_TARGETS"
  | "TOPOLOGY_CHECK_UNAVAILABLE";

/**
 * The bounded shape pushed/returned by window.sesLockdown's Native
 * Display State Bridge (getDisplayEnforcementStatus /
 * onDisplayEnforcementStateChanged). Mirrors
 * apps/lockdown/src/displayEnforcementLogic.ts's DisplayEnforcementStatus
 * shape — duplicated here (rather than imported) because the Electron app
 * and this web app are separate packages with no shared-types dependency
 * between them. `reason` is deliberately a plain string (not the literal
 * union directly), matching this codebase's existing convention for
 * anything crossing the IPC boundary (e.g. onDisplayEnforcementEvent's
 * `eventType: string`) — validated at the one place that interprets it,
 * computeDisplayViolationModal below, rather than trusted blindly at the
 * type level. Never carries EDID, monitor serial numbers, Windows display
 * paths, hardware identifiers, or display names — structurally nowhere to
 * put them.
 */
export type DisplayEnforcementBridgeStatus = {
  state: "OK" | "BLOCKED";
  reason: string | null;
  displayCount: number;
};

export type DisplayViolationModalState = {
  title: string;
  message: string;
  note: string;
  /** true only for TOPOLOGY_CHECK_UNAVAILABLE (or an unrecognized BLOCKED reason) — a technical inconclusiveness, never a claim that a second display exists. */
  neutral: boolean;
};

const GENUINE_DISPLAY_REASONS = new Set<DisplayEnforcementBridgeReason>([
  "ADDITIONAL_ELECTRON_DISPLAY",
  "WINDOWS_TOPOLOGY_EXTEND",
  "WINDOWS_TOPOLOGY_CLONE",
  "MULTIPLE_ACTIVE_TARGETS",
]);

export const DISPLAY_VIOLATION_TITLE = "Additional display detected";
export const DISPLAY_VIOLATION_MESSAGE =
  "This examination requires a single display. Disconnect the additional, extended or mirrored display to continue.";
export const DISPLAY_VIOLATION_UNAVAILABLE_TITLE = "Display configuration could not be verified";
export const DISPLAY_VIOLATION_UNAVAILABLE_MESSAGE = "Tether could not verify your display configuration.";
export const DISPLAY_VIOLATION_NOTE =
  "This has been recorded as an integrity review signal, not an automatic misconduct finding. Your saved answers are preserved and your exam has not been submitted. The timer continues under the existing timer policy. Tether will recheck automatically.";

/**
 * Builds the exam-page modal state for the current bridge status, or null
 * when nothing should be shown (state:"OK", or no status known yet).
 * Genuine multi-display reasons get the specific "Additional display
 * detected" copy; TOPOLOGY_CHECK_UNAVAILABLE — or any other/unrecognized
 * BLOCKED reason, e.g. a future native build reporting a reason this page
 * doesn't yet know about — fails CLOSED with neutral wording rather than
 * hiding the modal, but NEVER claims a second display exists without
 * genuine evidence for it (mirrors the "fail closed, never silently
 * pass" posture already used throughout displayEnforcementLogic.ts).
 * POLICY_NOT_READY never reaches this function at all — the native
 * bridge folds it into state:"OK" before it is ever pushed/returned (see
 * toDisplayEnforcementStatus in apps/lockdown/src/displayEnforcementLogic.ts)
 * — the existing secure-activation/content gate (contentGateState) owns
 * that state, and must never become this modal.
 */
export function computeDisplayViolationModal(status: DisplayEnforcementBridgeStatus | null): DisplayViolationModalState | null {
  if (!status || status.state !== "BLOCKED") return null;
  if (status.reason && isGenuineDisplayViolationReason(status.reason)) {
    return { title: DISPLAY_VIOLATION_TITLE, message: DISPLAY_VIOLATION_MESSAGE, note: DISPLAY_VIOLATION_NOTE, neutral: false };
  }
  return { title: DISPLAY_VIOLATION_UNAVAILABLE_TITLE, message: DISPLAY_VIOLATION_UNAVAILABLE_MESSAGE, note: DISPLAY_VIOLATION_NOTE, neutral: true };
}

/** True only for the four reasons backed by genuine multi-display evidence — mirrors isGenuineMultiDisplayReason in apps/lockdown/src/displayEnforcementLogic.ts. Accepts a plain string (see DisplayEnforcementBridgeStatus's doc comment) and narrows it. */
export function isGenuineDisplayViolationReason(reason: string): reason is DisplayEnforcementBridgeReason {
  return GENUINE_DISPLAY_REASONS.has(reason as DisplayEnforcementBridgeReason);
}
