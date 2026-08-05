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
  // Tether System Check and Exam Readiness v1 — see
  // docs/tether-system-check-v1.md. Optional: only present in a
  // v1.3.0+ packaged build; older installs simply don't expose these
  // and every caller must feature-detect first, exactly like the other
  // optional methods above.
  getClientVersion?(): Promise<string>;
  getOperatingSystemInfo?(): Promise<{ platform: string; release: string }>;
  getDisplayTopology?(): Promise<{ classification: string; activeTargetCount: number | null; electronDisplayCount: number }>;
  getSecureClientCapabilities?(): Promise<{
    getClientVersion: boolean;
    getOperatingSystemInfo: boolean;
    getDisplayTopology: boolean;
    getSecureClientCapabilities: boolean;
  }>;
  // Secure Client Attestation v2 — see docs/tether-system-check-v1.md,
  // "Per-installation key" / "Genuine client attestation". Optional:
  // only present in a v1.5.0+ packaged build. None of these ever
  // return, or accept, a private key or key handle.
  attestSystemCheck?(nonce: string): Promise<{ signature: string; clientVersion: string; platform: string; displayTopologyClassification: string } | null>;
  getInstallationInfo?(): Promise<{ hasKey: boolean; publicKey: string | null; keyAlgorithm: string; keyProtectionLevel: string }>;
  ensureInstallationKey?(): Promise<{ hasKey: boolean; publicKey: string | null; keyAlgorithm: string; keyProtectionLevel: string }>;
  signRegistrationProof?(nonce: string): Promise<{ signature: string; publicKey: string | null; keyAlgorithm: string; keyProtectionLevel: string } | null>;
  attestExamSession?(params: {
    nonce: string;
    examId: string;
    submissionId: string;
    policyHash: string;
    secureClientSessionId: string;
  }): Promise<{
    signature: string;
    clientVersion: string;
    platform: string;
    displayTopologyClassification: string;
    displayCount: number;
    capabilities: string;
    timestamp: string;
  } | null>;
  // Tether Windows Lockdown Hardening v1 — see
  // docs/tether-windows-lockdown-hardening-v1.md. Optional: only present
  // in a v1.7.0+ packaged build; older installs simply don't expose
  // these and every caller must feature-detect first, exactly like every
  // other optional method above. No raw process lists, paths, or
  // command-line arguments are ever exposed through any of these.
  setLockdownPolicyToggles?(toggles: { blockRemoteControl: boolean; blockScreenCaptureTools: boolean; blockDebugTools: boolean; blockVirtualMachines: boolean }): void;
  runLockdownPreflightScan?(): Promise<
    | { state: "CLEAN" }
    | { state: "BLOCKED"; matchedCapabilityIds: string[] }
    | { state: "UNAVAILABLE"; reason: string }
  >;
  setLockdownExamActive?(active: boolean): void;
  onLockdownCapabilityTransition?(
    callback: (payload: { capabilityId: string; effectiveAction: string; phase: "DETECTED" | "CLEARED"; detectedAtMsForClear: number | null }) => void,
  ): void;
  onLockdownScanUnavailable?(callback: (payload: { reason: string }) => void): void;
  onLockdownRestorationResult?(callback: (payload: { trigger: string; state: string; errors: string[] }) => void): void;
  getRemoteSessionStatus?(): Promise<{
    isRemoteSession: boolean;
    remoteSessionSignalSource: string;
    isLikelyVirtualMachine: boolean;
    vmSignatureMatched: string | null;
  }>;
  restoreLockdownControls?(trigger: string): void;
  getLockdownLifecycleState?(): Promise<string>;
  getLockdownCapabilityInfo?(): Promise<Array<{ id: string; category: string; displayName: string }>>;
  reportLockdownAuditFact?(action: string, metadata?: Record<string, unknown>): void;
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
