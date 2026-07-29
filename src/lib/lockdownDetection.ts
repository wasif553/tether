/**
 * Tether Secure Browser v1 — client-side detection helpers. See
 * apps/lockdown/README.md and docs/lockdown-browser-known-limitations.md.
 *
 * Detection is informational only — the existing browser-level Secure
 * Exam Mode handlers (window blur, fullscreen, copy/paste, etc. in the
 * student exam page) remain active regardless of whether this returns
 * true, and never get hidden or skipped because Electron is present.
 *
 * User-agent marker: new builds send `TetherSecureBrowser/<version>`.
 * Older packaged installs (built before the Tether rename) still send
 * the legacy `SESLockdown/<version>` marker — both are detected so
 * existing installed builds keep working without a reinstall.
 */

type SesLockdownBridge = {
  version: string;
  platform(): string;
  getSessionInfo(): Promise<{ authenticated: boolean }>;
  setExamContext(context: { examId?: string | null; submissionId?: string | null }): void;
  logEvent(eventType: string, metadata?: Record<string, unknown>): void;
  onWarning(callback: (message: string) => void): void;
  // Tether launch/install flow v1 — see apps/lockdown/src/preload.ts.
  // Optional: older packaged installs (pre-1.1.0) won't expose these —
  // callers must feature-detect before use, never assume presence.
  getDisplayCount?(): Promise<number>;
  onDisplayEnforcementEvent?(callback: (payload: { eventType: string; displayCount: number }) => void): void;
  // Corrective pass v1.2.1, Task C — replaces the old plain-boolean
  // setDisplayPolicyEnforced (removed; no known deployed installs
  // predate this still-unreleased corrective pass, so no dual-method
  // back-compat shim is carried). See
  // apps/lockdown/src/displayEnforcementLogic.ts's SecureClientEnforcementState.
  setSecureClientEnforcementState?(state: { active: boolean; ready: boolean; requireSingleDisplay: boolean }): void;
  // Tasks A/B — bounded, non-secret diagnostic surface. Optional: only
  // meaningfully present in a v1.2.1+ packaged build with
  // TETHER_SECURE_CLIENT_DIAGNOSTICS_ENABLED=true; harmless no-op calls
  // otherwise (older installs won't expose these methods at all).
  reportDiagnosticContext?(context: {
    submissionIdPresent: boolean;
    verifiedSecureClientSession: boolean;
    deliveryMode: string | null;
    displayPolicy: string | null;
    requireDisplayCheck: boolean | null;
    maximumDisplays: number | null;
  }): void;
  isDiagnosticsPanelEnabled?(): Promise<boolean>;
  onDiagnosticsSnapshot?(callback: (snapshot: Record<string, unknown>) => void): void;
};

declare global {
  interface Window {
    sesLockdown?: SesLockdownBridge;
  }
}

export function isRunningInLockdownBrowser(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.sesLockdown !== "undefined") return true;
  return (
    navigator.userAgent.includes("TetherSecureBrowser") ||
    navigator.userAgent.includes("SESLockdown")
  );
}

export function getLockdownVersion(): string | null {
  if (typeof window === "undefined") return null;
  if (window.sesLockdown?.version) return window.sesLockdown.version;
  const match =
    navigator.userAgent.match(/TetherSecureBrowser\/([\d.]+)/) ??
    navigator.userAgent.match(/SESLockdown\/([\d.]+)/);
  return match ? match[1] : null;
}
