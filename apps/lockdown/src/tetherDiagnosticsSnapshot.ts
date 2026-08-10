/**
 * Tether Secure Browser — corrective pass v1.2.1, Tasks A/B. Pure
 * type + comparison + formatting logic for the visible diagnostic panel
 * (Task A) and the on-disk diagnostic log (Task B). Kept free of any
 * Electron import so it runs under plain vitest — see main.ts for the
 * glue that actually gathers these values and decides when to push/log.
 *
 * Every field here is deliberately bounded to what Task A explicitly
 * allows: no tokens, cookies, signed manifests, student name/email,
 * signing keys, or full launch URLs ever pass through this type. There is
 * structurally nowhere to put them.
 */

export type TetherDiagnosticsSnapshot = {
  browserVersion: string;
  submissionIdPresent: boolean;
  tetherBrowserDetected: boolean;
  verifiedSecureClientSession: boolean;
  deliveryMode: string | null;
  displayPolicy: string | null;
  requireDisplayCheck: boolean | null;
  maximumDisplays: number | null;
  electronDisplayCount: number | null;
  windowsTopologyClassification: string | null;
  activeWindowsTargetCount: number | null;
  enforcementEnabled: boolean;
  /** v1.7.4 — enforcementState.ready, distinct from enforcementEnabled (which is enforcementState.active). Lets a POLICY_NOT_READY block be distinguished in the diagnostic panel/log from a genuine display block, closing the gap that let BLOCKED read as ADDITIONAL_DISPLAY_PRESENT with no way to tell why. */
  enforcementReady: boolean;
  /** v1.7.4 — enforcementState.requireSingleDisplay, the frozen per-attempt policy this decision was actually made against. */
  requireSingleDisplay: boolean;
  currentDecision: "ALLOW" | "BLOCK";
  /** v1.7.4 — the specific DisplayBlockingReason when currentDecision is BLOCK; null otherwise. See apps/lockdown/src/displayEnforcementLogic.ts. */
  blockingReason: string | null;
  overlayVisible: boolean;
  /** ISO timestamp of the last display-check evaluation. Excluded from equality (see snapshotsEqualIgnoringTimestamp) so a timer tick alone never counts as a "state change". */
  lastDisplayCheckAt: string | null;
  lastErrorCode: string | null;
};

export const INITIAL_TETHER_DIAGNOSTICS_SNAPSHOT: TetherDiagnosticsSnapshot = {
  browserVersion: "",
  submissionIdPresent: false,
  tetherBrowserDetected: true,
  verifiedSecureClientSession: false,
  deliveryMode: null,
  displayPolicy: null,
  requireDisplayCheck: null,
  maximumDisplays: null,
  electronDisplayCount: null,
  windowsTopologyClassification: null,
  activeWindowsTargetCount: null,
  enforcementEnabled: false,
  enforcementReady: false,
  requireSingleDisplay: false,
  currentDecision: "ALLOW",
  blockingReason: null,
  overlayVisible: false,
  lastDisplayCheckAt: null,
  lastErrorCode: null,
};

/**
 * Task B: "Log one line only when state changes, not every polling
 * cycle." The periodic 2s recheck (see displayEnforcement.ts) produces a
 * new `lastDisplayCheckAt` on every tick regardless of whether anything
 * meaningful changed — excluding it here is what keeps the log bounded
 * to genuine transitions instead of growing once every 2 seconds for the
 * whole exam duration.
 */
export function snapshotsEqualIgnoringTimestamp(a: TetherDiagnosticsSnapshot, b: TetherDiagnosticsSnapshot): boolean {
  return (
    a.browserVersion === b.browserVersion &&
    a.submissionIdPresent === b.submissionIdPresent &&
    a.tetherBrowserDetected === b.tetherBrowserDetected &&
    a.verifiedSecureClientSession === b.verifiedSecureClientSession &&
    a.deliveryMode === b.deliveryMode &&
    a.displayPolicy === b.displayPolicy &&
    a.requireDisplayCheck === b.requireDisplayCheck &&
    a.maximumDisplays === b.maximumDisplays &&
    a.electronDisplayCount === b.electronDisplayCount &&
    a.windowsTopologyClassification === b.windowsTopologyClassification &&
    a.activeWindowsTargetCount === b.activeWindowsTargetCount &&
    a.enforcementEnabled === b.enforcementEnabled &&
    a.enforcementReady === b.enforcementReady &&
    a.requireSingleDisplay === b.requireSingleDisplay &&
    a.currentDecision === b.currentDecision &&
    a.blockingReason === b.blockingReason &&
    a.overlayVisible === b.overlayVisible &&
    a.lastErrorCode === b.lastErrorCode
  );
}

/** One bounded, single-line, timestamped record — safe to append to a plain-text log file (Task B). */
export function formatDiagnosticLogLine(snapshot: TetherDiagnosticsSnapshot): string {
  return `${new Date().toISOString()} ${JSON.stringify(snapshot)}`;
}

/** Env-var gate for the diagnostic PANEL (Task A) — distinct from the existing TETHER_DIAGNOSTIC_LOGGING console-log flag. Explicit opt-in, on the local machine only; this module never runs anywhere Vercel does, so "never in Production" is automatic, not something this function needs to check. */
export function isDiagnosticsPanelEnabled(envFlag: string | undefined): boolean {
  return envFlag === "true";
}
