/**
 * Tether Secure Browser v1 — preload script.
 *
 * Exposes a minimal `window.sesLockdown` bridge into the SES web page via
 * contextBridge. The bridge property name is kept as `sesLockdown` for
 * backward compatibility with the detection contract in
 * src/lib/lockdownDetection.ts — only the product's display name and
 * user-agent marker changed with the Tether Secure Browser rename, not
 * this internal API. Never exposes ipcRenderer or any Node API directly
 * to the page — only the specific, validated functions below.
 */
import { contextBridge, ipcRenderer } from "electron";
import { LOCKDOWN_VERSION, type ExamContext, type SessionInfo } from "./shared";

const ALLOWED_LOG_EVENT_TYPES = ["WINDOW_BLUR", "WINDOW_FOCUS_RETURN", "FULLSCREEN_EXIT", "MANUAL_WARNING"];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

type LockdownCapabilityTransitionPayload = {
  capabilityId: string;
  effectiveAction: string;
  phase: "DETECTED" | "CLEARED";
  detectedAtMsForClear: number | null;
};
type LockdownScanUnavailablePayload = { reason: string };
type LockdownRestorationResultPayload = { trigger: string; state: string; errors: string[] };
type RemoteSessionMonitorEventPayload = {
  kind: "BECAME_ACTIVE" | "BECAME_INACTIVE" | "CHECK_UNAVAILABLE" | "CHECK_RECOVERED";
  effectiveAction: string;
  previousState: string | null;
  currentState: string | null;
  detectedAtMsForClear: number | null;
  classification: {
    isRemoteSession: boolean;
    remoteSessionSignalSource: string;
    isLikelyVirtualMachine: boolean;
    vmSignatureMatched: string | null;
  };
};

const warningListeners: Array<(message: string) => void> = [];
const capabilityTransitionListeners: Array<(payload: LockdownCapabilityTransitionPayload) => void> = [];
const scanUnavailableListeners: Array<(payload: LockdownScanUnavailablePayload) => void> = [];
const restorationResultListeners: Array<(payload: LockdownRestorationResultPayload) => void> = [];
const remoteSessionMonitorEventListeners: Array<(payload: RemoteSessionMonitorEventPayload) => void> = [];
// Tether launch/install flow v1 — fed by main's debounced, policy-aware
// display-count evaluation (displayEnforcement.ts). The blocking overlay
// itself is entirely main-owned; this only lets the hosted page report
// the corresponding integrity signal via its own authenticated fetch.
const displayEnforcementListeners: Array<(payload: { eventType: string; displayCount: number }) => void> = [];
// Corrective pass v1.2.1, Task A — pushed by main whenever the bounded
// diagnostic snapshot changes; consumed only by the local diagnostic
// panel injected below (gated on TETHER_SECURE_CLIENT_DIAGNOSTICS_ENABLED).
type TetherDiagnosticsSnapshot = Record<string, unknown>;
const diagnosticsListeners: Array<(snapshot: TetherDiagnosticsSnapshot) => void> = [];

ipcRenderer.on("lockdown:warning", (_event, message: string) => {
  for (const listener of warningListeners) listener(message);
  showWarningBanner(message);
});

ipcRenderer.on("lockdown:event-recorded", (_event, count: number) => {
  updateStatusBarCount(count);
});

ipcRenderer.on("lockdown:display-enforcement-event", (_event, payload: { eventType: string; displayCount: number }) => {
  for (const listener of displayEnforcementListeners) listener(payload);
});

ipcRenderer.on("lockdown:diagnostics-snapshot", (_event, snapshot: TetherDiagnosticsSnapshot) => {
  for (const listener of diagnosticsListeners) listener(snapshot);
  renderDiagnosticsPanel(snapshot);
});

ipcRenderer.on("lockdown:capability-transition", (_event, payload: LockdownCapabilityTransitionPayload) => {
  for (const listener of capabilityTransitionListeners) listener(payload);
});

ipcRenderer.on("lockdown:scan-unavailable", (_event, payload: LockdownScanUnavailablePayload) => {
  for (const listener of scanUnavailableListeners) listener(payload);
});

ipcRenderer.on("lockdown:restoration-result", (_event, payload: LockdownRestorationResultPayload) => {
  for (const listener of restorationResultListeners) listener(payload);
});

ipcRenderer.on("lockdown:remote-session-monitor-event", (_event, payload: RemoteSessionMonitorEventPayload) => {
  for (const listener of remoteSessionMonitorEventListeners) listener(payload);
});

contextBridge.exposeInMainWorld("sesLockdown", {
  version: LOCKDOWN_VERSION,

  platform(): string {
    return process.platform;
  },

  async getSessionInfo(): Promise<SessionInfo> {
    return ipcRenderer.invoke("lockdown:get-session-info");
  },

  setExamContext(context: { examId?: string | null; submissionId?: string | null }): void {
    const examId = isNonEmptyString(context?.examId) ? context.examId : null;
    const submissionId = isNonEmptyString(context?.submissionId) ? context.submissionId : null;
    const validated: ExamContext = { examId, submissionId };
    ipcRenderer.send("lockdown:set-context", validated);
  },

  logEvent(eventType: string, metadata?: Record<string, unknown>): void {
    if (!isNonEmptyString(eventType) || !ALLOWED_LOG_EVENT_TYPES.includes(eventType)) return;
    const safeMetadata =
      typeof metadata === "object" && metadata !== null ? sanitizeMetadata(metadata) : {};
    ipcRenderer.send("lockdown:log-event", { eventType, metadata: safeMetadata });
  },

  onWarning(callback: (message: string) => void): void {
    if (typeof callback === "function") warningListeners.push(callback);
  },

  /**
   * Corrective pass v1.2.1, Task C (original rationale) / v1.7.5 P0
   * (current call sites) — the hosted page calls this once it has
   * determined the real, authoritative per-attempt policy via
   * GET /api/submissions/[id]/secure-client/status. Main has no policy
   * awareness of its own; this is the one input it accepts from the
   * page. Replaces the old plain-boolean setDisplayPolicyEnforced, which
   * defaulted to "not enforcing" and had no way to represent "we don't
   * know yet, cover the exam".
   *
   * v1.7.5 P0 — the exam content page no longer calls this speculatively
   * with `{active:true, ready:false}` the instant it mounts (the
   * original Task C fail-open-gap fix): that call downgraded an already
   * ACTIVE+READY native state from a successful Phase 2 handoff back to
   * POLICY_NOT_READY, producing the exact P0 this version fixes (see
   * docs/tether-preflight-lifecycle-v1.7.5-policy-not-ready.md). The
   * page now queries getSecureClientEnforcementState (below) first, and
   * only ever calls this setter once it has confirmed either the real
   * policy (non-gated) or that native lockdown is already correctly
   * ACTIVE+READY (gated) — never as a blind, downgrading cover.
   */
  setSecureClientEnforcementState(state: { active: boolean; ready: boolean; requireSingleDisplay: boolean }): void {
    if (typeof state !== "object" || state === null) return;
    ipcRenderer.send("lockdown:set-secure-client-enforcement-state", {
      active: Boolean(state.active),
      ready: Boolean(state.ready),
      requireSingleDisplay: Boolean(state.requireSingleDisplay),
    });
  },

  /**
   * v1.7.5 P0 — the narrow, read-only counterpart to
   * setSecureClientEnforcementState above. See that IPC handler's own doc
   * comment in main.ts for why the exam content page needs this: to tell
   * a genuine Phase 2 handoff (native lockdown already ACTIVE+READY —
   * never re-assert/downgrade it) apart from a direct load/reload/Tether
   * restart (native lockdown was never established in this process — a
   * secure reactivation handshake is required before any content is
   * shown). Never trust a client-held boolean for this; always re-query.
   */
  async getSecureClientEnforcementState(): Promise<{ active: boolean; ready: boolean; requireSingleDisplay: boolean }> {
    return ipcRenderer.invoke("lockdown:get-secure-client-enforcement-state");
  },

  async getDisplayCount(): Promise<number> {
    return ipcRenderer.invoke("lockdown:get-display-count");
  },

  onDisplayEnforcementEvent(callback: (payload: { eventType: string; displayCount: number }) => void): void {
    if (typeof callback === "function") displayEnforcementListeners.push(callback);
  },

  /** Task A/B — bounded, non-secret exam-policy context for the local diagnostic panel/log. No-ops harmlessly when diagnostics are disabled (main still stores it, but never renders or writes it anywhere). */
  reportDiagnosticContext(context: {
    submissionIdPresent: boolean;
    verifiedSecureClientSession: boolean;
    deliveryMode: string | null;
    displayPolicy: string | null;
    requireDisplayCheck: boolean | null;
    maximumDisplays: number | null;
  }): void {
    if (typeof context !== "object" || context === null) return;
    ipcRenderer.send("lockdown:report-diagnostic-context", {
      submissionIdPresent: Boolean(context.submissionIdPresent),
      verifiedSecureClientSession: Boolean(context.verifiedSecureClientSession),
      deliveryMode: typeof context.deliveryMode === "string" ? context.deliveryMode : null,
      displayPolicy: typeof context.displayPolicy === "string" ? context.displayPolicy : null,
      requireDisplayCheck: typeof context.requireDisplayCheck === "boolean" ? context.requireDisplayCheck : null,
      maximumDisplays: typeof context.maximumDisplays === "number" ? context.maximumDisplays : null,
    });
  },

  async isDiagnosticsPanelEnabled(): Promise<boolean> {
    return ipcRenderer.invoke("lockdown:get-diagnostics-enabled");
  },

  onDiagnosticsSnapshot(callback: (snapshot: TetherDiagnosticsSnapshot) => void): void {
    if (typeof callback === "function") diagnosticsListeners.push(callback);
  },

  // Tether System Check and Exam Readiness v1 — see
  // docs/tether-system-check-v1.md. Four narrowly scoped, read-only
  // methods, each backed by a single ipcRenderer.invoke to a specific
  // main-process handler that returns only the named bounded value —
  // never a generic ipcRenderer.invoke passthrough, never shell/fs/
  // process/env access.
  async getClientVersion(): Promise<string> {
    return ipcRenderer.invoke("lockdown:get-client-version");
  },

  async getOperatingSystemInfo(): Promise<{ platform: string; release: string }> {
    return ipcRenderer.invoke("lockdown:get-os-info");
  },

  async getDisplayTopology(): Promise<{ classification: string; activeTargetCount: number | null; electronDisplayCount: number }> {
    return ipcRenderer.invoke("lockdown:get-display-topology");
  },

  async getSecureClientCapabilities(): Promise<{
    getClientVersion: boolean;
    getOperatingSystemInfo: boolean;
    getDisplayTopology: boolean;
    getSecureClientCapabilities: boolean;
  }> {
    return ipcRenderer.invoke("lockdown:get-secure-client-capabilities");
  },

  /**
   * Security hardening pass — genuine client attestation. See
   * docs/tether-system-check-v1.md, "Genuine client attestation". Takes
   * only the server-issued nonce string; every fact in the response
   * (clientVersion/platform/displayTopologyClassification) is gathered
   * by the MAIN process itself and signed there with the embedded
   * client-attestation private key — this preload function never sees
   * that key, never computes the signature itself, and cannot be made
   * to sign arbitrary attacker-chosen data (only this one fixed
   * canonical format, built entirely in main.ts).
   */
  async attestSystemCheck(nonce: string): Promise<{ signature: string; clientVersion: string; platform: string; displayTopologyClassification: string } | null> {
    if (typeof nonce !== "string" || nonce.length === 0) return null;
    return ipcRenderer.invoke("lockdown:attest-system-check", nonce);
  },

  /**
   * Secure Client Attestation v2 — see docs/tether-system-check-v1.md,
   * "Per-installation key". None of these four methods ever return, or
   * accept, a private key or key handle — only public information
   * (getInstallationInfo/ensureInstallationKey) or the RESULT of a
   * purpose-specific signing operation performed entirely inside main.ts
   * (signRegistrationProof/attestExamSession). There is no generic
   * "sign this data" method exposed to the renderer.
   */
  async getInstallationInfo(): Promise<{ hasKey: boolean; publicKey: string | null; keyAlgorithm: string; keyProtectionLevel: string }> {
    return ipcRenderer.invoke("lockdown:get-installation-info");
  },

  async ensureInstallationKey(): Promise<{ hasKey: boolean; publicKey: string | null; keyAlgorithm: string; keyProtectionLevel: string }> {
    return ipcRenderer.invoke("lockdown:ensure-installation-key");
  },

  async signRegistrationProof(nonce: string): Promise<{ signature: string; publicKey: string | null; keyAlgorithm: string; keyProtectionLevel: string } | null> {
    if (typeof nonce !== "string" || nonce.length === 0) return null;
    return ipcRenderer.invoke("lockdown:sign-registration-proof", nonce);
  },

  async attestExamSession(params: {
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
  } | null> {
    if (typeof params !== "object" || params === null) return null;
    const { nonce, examId, submissionId, policyHash, secureClientSessionId } = params;
    if (
      typeof nonce !== "string" || nonce.length === 0 ||
      typeof examId !== "string" || examId.length === 0 ||
      typeof submissionId !== "string" || submissionId.length === 0 ||
      typeof policyHash !== "string" || policyHash.length === 0 ||
      typeof secureClientSessionId !== "string" || secureClientSessionId.length === 0
    ) {
      return null;
    }
    return ipcRenderer.invoke("lockdown:attest-exam-session", { nonce, examId, submissionId, policyHash, secureClientSessionId });
  },

  // Tether Windows Lockdown Hardening v1 — see
  // docs/tether-windows-lockdown-hardening-v1.md. Every method below is
  // narrowly scoped exactly like the Secure Client Attestation v2 group
  // above: no raw process lists, no command-line arguments, no
  // executable paths ever cross this boundary — only capability
  // ids/categories/display names and bounded booleans/enums.

  /** Part 12 — server-resolved policy toggles, relayed from GET /api/tether/lockdown/policy. Never accepts a value this renderer invented on its own beyond the four documented booleans. */
  setLockdownPolicyToggles(toggles: { blockRemoteControl: boolean; blockScreenCaptureTools: boolean; blockDebugTools: boolean; blockVirtualMachines: boolean }): void {
    if (typeof toggles !== "object" || toggles === null) return;
    ipcRenderer.send("lockdown:set-lockdown-policy-toggles", {
      blockRemoteControl: Boolean(toggles.blockRemoteControl),
      blockScreenCaptureTools: Boolean(toggles.blockScreenCaptureTools),
      blockDebugTools: Boolean(toggles.blockDebugTools),
      blockVirtualMachines: Boolean(toggles.blockVirtualMachines),
    });
  },

  /** Part 3 — one-shot preflight scan. */
  async runLockdownPreflightScan(): Promise<
    | { state: "CLEAN" }
    | { state: "BLOCKED"; matchedCapabilityIds: string[] }
    | { state: "UNAVAILABLE"; reason: string }
  > {
    return ipcRenderer.invoke("lockdown:run-preflight-scan");
  },

  /** Part 4 — starts/stops the background during-exam poll. */
  setLockdownExamActive(active: boolean): void {
    ipcRenderer.send("lockdown:set-lockdown-exam-active", Boolean(active));
  },

  /**
   * v1.7.4 pre-exam readiness — the ONE narrow purpose-specific invoke
   * for the Phase 2 secure-activation handshake (never a generic
   * ipcRenderer passthrough). Re-runs fresh native process/remote-
   * session/display checks and, only if every one is clean, atomically
   * activates display enforcement, process detection's during-exam poll,
   * and remote-session monitoring — then resolves. The caller must never
   * treat a resolved promise alone as proof of anything; only
   * `result.ok === true` means native lockdown is actually ACTIVE.
   */
  async activateSecureExamLockdown(params: { requireSingleDisplay: boolean; requireRemoteSessionCheck: boolean }): Promise<
    | { ok: true; displayDecision: string; processDecision: string }
    | { ok: false; reason: string; matchedCapabilityIds?: string[] }
  > {
    if (typeof params !== "object" || params === null) return { ok: false, reason: "INVALID_PARAMS" };
    return ipcRenderer.invoke("lockdown:activate-secure-exam-lockdown", {
      requireSingleDisplay: Boolean(params.requireSingleDisplay),
      requireRemoteSessionCheck: Boolean(params.requireRemoteSessionCheck),
    });
  },

  onLockdownCapabilityTransition(callback: (payload: LockdownCapabilityTransitionPayload) => void): void {
    if (typeof callback === "function") capabilityTransitionListeners.push(callback);
  },

  onLockdownScanUnavailable(callback: (payload: { reason: string }) => void): void {
    if (typeof callback === "function") scanUnavailableListeners.push(callback);
  },

  onLockdownRestorationResult(callback: (payload: { trigger: string; state: string; errors: string[] }) => void): void {
    if (typeof callback === "function") restorationResultListeners.push(callback);
  },

  /** Mid-exam remote-session monitoring v1 — one call per de-duplicated state transition (see remoteSessionMonitor.ts); never fired on every poll. */
  onRemoteSessionMonitorEvent(callback: (payload: RemoteSessionMonitorEventPayload) => void): void {
    if (typeof callback === "function") remoteSessionMonitorEventListeners.push(callback);
  },

  /** Part 5 — remote-session/VM classification, on demand. */
  async getRemoteSessionStatus(): Promise<{
    isRemoteSession: boolean;
    remoteSessionSignalSource: string;
    isLikelyVirtualMachine: boolean;
    vmSignatureMatched: string | null;
  }> {
    return ipcRenderer.invoke("lockdown:get-remote-session-status");
  },

  /** Part 10 — see restoreLockdownControls's own doc comment in main.ts for every automatic trigger; the page additionally calls this explicitly at every normal-exit/failure point it already knows about. */
  restoreLockdownControls(trigger: string): void {
    ipcRenderer.send("lockdown:restore-lockdown-controls", isNonEmptyString(trigger) ? trigger.slice(0, 100) : "page-requested");
  },

  async getLockdownLifecycleState(): Promise<string> {
    return ipcRenderer.invoke("lockdown:get-lockdown-lifecycle-state");
  },

  async getLockdownCapabilityInfo(): Promise<Array<{ id: string; category: string; displayName: string }>> {
    return ipcRenderer.invoke("lockdown:get-lockdown-capability-info");
  },

  /** Part 11 — PlatformAuditLog-only facts the PAGE itself observes (e.g. the preflight screen was shown, the student closed an application before content opened). `action` is re-validated against a fixed allow-list server-side — this is not a trust boundary by itself. */
  reportLockdownAuditFact(action: string, metadata?: Record<string, unknown>): void {
    if (!isNonEmptyString(action)) return;
    ipcRenderer.send("lockdown:report-lockdown-audit-fact", { action, metadata: typeof metadata === "object" && metadata !== null ? sanitizeMetadata(metadata) : {} });
  },
});

/** Drops any value that isn't a plain string/number/boolean — never forwards functions, secrets, or large blobs from the page. */
function sanitizeMetadata(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      result[key] = value;
    }
  }
  return result;
}

// --- Minimal DOM overlay (status bar + warning banner) ---
// Injected directly by the preload script rather than a separate
// renderer bundle, since the SES web app is loaded directly into this
// BrowserWindow (see apps/lockdown/README.md, Part 5).

let eventCount = 0;

function updateStatusBarCount(count: number) {
  eventCount = count;
  const el = document.getElementById("ses-lockdown-status-count");
  if (el) el.textContent = `Events recorded: ${eventCount}`;
}

function showWarningBanner(message: string) {
  const banner = document.getElementById("ses-lockdown-warning-banner");
  if (!banner) return;
  banner.textContent = message;
  banner.style.display = "block";
  window.clearTimeout((banner as unknown as { _hideTimer?: number })._hideTimer);
  const timer = window.setTimeout(() => {
    banner.style.display = "none";
  }, 5000);
  (banner as unknown as { _hideTimer?: number })._hideTimer = timer;
}

function injectOverlay() {
  if (document.getElementById("ses-lockdown-status-bar")) return;

  const statusBar = document.createElement("div");
  statusBar.id = "ses-lockdown-status-bar";
  statusBar.style.cssText = [
    "position:fixed",
    "left:0",
    "right:0",
    "bottom:0",
    "z-index:2147483647",
    "background:#111827",
    "color:#f9fafb",
    "font-family:system-ui,sans-serif",
    "font-size:12px",
    "padding:6px 12px",
    "display:flex",
    "gap:16px",
    "align-items:center",
    "pointer-events:none",
  ].join(";");

  const label = document.createElement("span");
  label.textContent = "Tether Secure Browser Active";
  label.style.fontWeight = "600";

  const countLabel = document.createElement("span");
  countLabel.id = "ses-lockdown-status-count";
  countLabel.textContent = "Events recorded: 0";

  const platformLabel = document.createElement("span");
  platformLabel.textContent = `Platform: ${process.platform}`;

  statusBar.appendChild(label);
  statusBar.appendChild(countLabel);
  statusBar.appendChild(platformLabel);

  const banner = document.createElement("div");
  banner.id = "ses-lockdown-warning-banner";
  banner.style.cssText = [
    "position:fixed",
    "top:0",
    "left:0",
    "right:0",
    "z-index:2147483647",
    "background:#fef3c7",
    "color:#92400e",
    "font-family:system-ui,sans-serif",
    "font-size:13px",
    "padding:8px 16px",
    "display:none",
    "text-align:center",
    "pointer-events:none",
  ].join(";");

  document.body.appendChild(statusBar);
  document.body.appendChild(banner);
}

document.addEventListener("DOMContentLoaded", injectOverlay);

// --- Diagnostic panel (Task A, corrective pass v1.2.1) ---
// Temporary, development-only. Gated on
// TETHER_SECURE_CLIENT_DIAGNOSTICS_ENABLED=true, checked in the MAIN
// process (never in anything Vercel/the hosted web app controls) — see
// main.ts's isDiagnosticsPanelEnabled wiring. Renders only the bounded
// fields in TetherDiagnosticsSnapshot; never tokens, cookies, signed
// manifests, student name/email, signing keys, or full launch URLs — the
// type that snapshot is built from structurally has no field for any of
// those (see tetherDiagnosticsSnapshot.ts).

const DIAGNOSTIC_FIELD_ORDER: Array<[key: string, label: string]> = [
  ["browserVersion", "Browser version"],
  ["submissionIdPresent", "Submission ID present"],
  ["tetherBrowserDetected", "Tether browser detected"],
  ["verifiedSecureClientSession", "Verified secure-client session"],
  ["deliveryMode", "Delivery mode"],
  ["displayPolicy", "Display policy"],
  ["requireDisplayCheck", "Require display check"],
  ["maximumDisplays", "Maximum displays"],
  ["electronDisplayCount", "Electron logical display count"],
  ["windowsTopologyClassification", "Windows topology classification"],
  ["activeWindowsTargetCount", "Active Windows target count"],
  ["enforcementEnabled", "Enforcement enabled"],
  ["currentDecision", "Current decision"],
  ["overlayVisible", "Overlay visible"],
  ["lastDisplayCheckAt", "Last display-check timestamp"],
  ["lastErrorCode", "Last error code"],
];

function formatDiagnosticValue(value: unknown): string {
  if (value === null || value === undefined) return "(unknown)";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

function renderDiagnosticsPanel(snapshot: TetherDiagnosticsSnapshot) {
  const panel = document.getElementById("ses-lockdown-diagnostics-panel");
  if (!panel) return;
  panel.innerHTML = "";
  const title = document.createElement("div");
  title.textContent = "Tether Secure Browser diagnostics (dev only)";
  title.style.cssText = "font-weight:700;margin-bottom:6px;";
  panel.appendChild(title);
  for (const [key, label] of DIAGNOSTIC_FIELD_ORDER) {
    const row = document.createElement("div");
    row.textContent = `${label}: ${formatDiagnosticValue(snapshot[key])}`;
    panel.appendChild(row);
  }
}

function injectDiagnosticsPanel() {
  if (document.getElementById("ses-lockdown-diagnostics-panel")) return;
  const panel = document.createElement("div");
  panel.id = "ses-lockdown-diagnostics-panel";
  panel.style.cssText = [
    "position:fixed",
    "top:0",
    "right:0",
    "z-index:2147483647",
    "background:rgba(17,24,39,0.92)",
    "color:#f9fafb",
    "font-family:ui-monospace,monospace",
    "font-size:11px",
    "line-height:1.5",
    "padding:10px 12px",
    "max-width:340px",
    "pointer-events:none",
    "white-space:pre-wrap",
  ].join(";");
  panel.textContent = "Tether Secure Browser diagnostics (dev only) — waiting for first snapshot…";
  document.body.appendChild(panel);
}

async function maybeInjectDiagnosticsPanel() {
  let enabled = false;
  try {
    enabled = await ipcRenderer.invoke("lockdown:get-diagnostics-enabled");
  } catch {
    enabled = false;
  }
  if (!enabled) return;
  injectDiagnosticsPanel();
  try {
    const initial = await ipcRenderer.invoke("lockdown:get-diagnostics-snapshot");
    if (initial) renderDiagnosticsPanel(initial);
  } catch {
    // First push (on the next state change) will populate the panel instead.
  }
}

document.addEventListener("DOMContentLoaded", () => {
  void maybeInjectDiagnosticsPanel();
});

// Relay browser-level online/offline state to the main process so it
// knows when it's safe to attempt uploading queued events.
window.addEventListener("online", () => ipcRenderer.send("lockdown:network-status", true));
window.addEventListener("offline", () => ipcRenderer.send("lockdown:network-status", false));
ipcRenderer.send("lockdown:network-status", navigator.onLine);
