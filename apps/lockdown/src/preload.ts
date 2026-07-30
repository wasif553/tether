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

const warningListeners: Array<(message: string) => void> = [];
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
   * Corrective pass v1.2.1, Task C — the hosted page calls this as soon
   * as it knows enough to say so: `active: true` the instant the exam
   * page mounts (before any fetch has resolved — this is what closes the
   * fail-open gap that let a real second display go unblocked), then
   * `ready`/`requireSingleDisplay` filled in once the authoritative
   * per-attempt policy and secure-client verification are both
   * confirmed via GET /api/submissions/[id]/secure-client/status. Main
   * has no policy awareness of its own; this is the one input it accepts
   * from the page. Replaces the old plain-boolean
   * setDisplayPolicyEnforced, which defaulted to "not enforcing" and had
   * no way to represent "we don't know yet, cover the exam".
   */
  setSecureClientEnforcementState(state: { active: boolean; ready: boolean; requireSingleDisplay: boolean }): void {
    if (typeof state !== "object" || state === null) return;
    ipcRenderer.send("lockdown:set-secure-client-enforcement-state", {
      active: Boolean(state.active),
      ready: Boolean(state.ready),
      requireSingleDisplay: Boolean(state.requireSingleDisplay),
    });
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
