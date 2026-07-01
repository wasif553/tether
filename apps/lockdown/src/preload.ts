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

ipcRenderer.on("lockdown:warning", (_event, message: string) => {
  for (const listener of warningListeners) listener(message);
  showWarningBanner(message);
});

ipcRenderer.on("lockdown:event-recorded", (_event, count: number) => {
  updateStatusBarCount(count);
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

// Relay browser-level online/offline state to the main process so it
// knows when it's safe to attempt uploading queued events.
window.addEventListener("online", () => ipcRenderer.send("lockdown:network-status", true));
window.addEventListener("offline", () => ipcRenderer.send("lockdown:network-status", false));
ipcRenderer.send("lockdown:network-status", navigator.onLine);
