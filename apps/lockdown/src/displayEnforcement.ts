/**
 * Tether launch/install flow v1 — main-process display enforcement.
 *
 * Registers Electron's screen listeners once, at app start, and keeps
 * them live for the whole session (not just a one-shot check at initial
 * page load — see docs/lockdown-browser-known-limitations.md in the
 * main repo for what this replaces). Owns a second, always-on-top
 * BrowserWindow that covers the exam window whenever policy requires a
 * single display and more than one is connected — a security property
 * that must not depend on the hosted web page's own JS/React state
 * being responsive, unlike event REPORTING (see main.ts, which is
 * page-driven and reuses the page's own authenticated fetch).
 *
 * This module has zero awareness of exam policy on its own — the
 * Electron main process never fetches or trusts secureSettings/policy
 * directly (that trust boundary lives entirely server-side/web-app-side,
 * see docs/secure-client-foundation-seb-v1.md). `setRequireSingleDisplay`
 * is the one input the hosted page controls, via
 * window.sesLockdown.setDisplayPolicyEnforced(true) once it has learned
 * from the server that this exam's display requirement applies.
 */
import { screen, BrowserWindow } from "electron";
import {
  resolveDisplayEnforcementState,
  debounceDisplayEvent,
  resolveDisplayEnforcementEventType,
  DEFAULT_DISPLAY_EVENT_DEBOUNCE_MS,
  type DisplayEnforcementState,
  type DisplayEnforcementEventType,
} from "./displayEnforcementLogic";

// Bundled inline (a data: URL) rather than a separate packaged asset, so
// the overlay renders even if offline and packaging never needs to know
// about an extra file. No external requests, no network dependency.
const OVERLAY_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #111827; color: #f9fafb; }
  body {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    font-family: system-ui, sans-serif; text-align: center; padding: 24px; box-sizing: border-box;
  }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p { font-size: 14px; color: #d1d5db; margin: 0; max-width: 480px; }
</style>
</head>
<body>
  <h1>Additional display connected</h1>
  <p>Disconnect all additional, mirrored or extended displays to continue.</p>
</body>
</html>`;

export type DisplayEnforcementCallbacks = {
  onEventType?: (eventType: DisplayEnforcementEventType, displayCount: number) => void;
};

export class DisplayEnforcement {
  private requireSingleDisplay = false;
  private lastHandledAtMs: number | null = null;
  private previousState: DisplayEnforcementState | null = null;
  private previousDisplayCount: number | null = null;
  private overlayWindow: BrowserWindow | null = null;
  private targetWindow: BrowserWindow | null = null;
  private readonly callbacks: DisplayEnforcementCallbacks;
  private readonly handleChange = () => this.evaluate();

  constructor(callbacks: DisplayEnforcementCallbacks = {}) {
    this.callbacks = callbacks;
  }

  /** Registers the live listeners and evaluates the current state immediately. Call once per app session, as soon as the exam window exists — not gated on the page finishing load. */
  start(targetWindow: BrowserWindow): void {
    this.targetWindow = targetWindow;
    screen.on("display-added", this.handleChange);
    screen.on("display-removed", this.handleChange);
    screen.on("display-metrics-changed", this.handleChange);
    this.evaluate();
  }

  stop(): void {
    screen.removeListener("display-added", this.handleChange);
    screen.removeListener("display-removed", this.handleChange);
    screen.removeListener("display-metrics-changed", this.handleChange);
    this.hideOverlay();
    this.targetWindow = null;
  }

  /** Set by the hosted page once it knows (from the server) that this exam's display requirement applies. Re-evaluates immediately with the new policy. */
  setRequireSingleDisplay(required: boolean): void {
    this.requireSingleDisplay = required;
    this.evaluate();
  }

  getCurrentDisplayCount(): number {
    return screen.getAllDisplays().length;
  }

  private evaluate(): void {
    const now = Date.now();
    if (!debounceDisplayEvent(this.lastHandledAtMs, now)) return;
    this.lastHandledAtMs = now;

    const displayCount = this.getCurrentDisplayCount();
    const nextState = resolveDisplayEnforcementState(displayCount, this.requireSingleDisplay);
    const eventType = resolveDisplayEnforcementEventType({
      previousState: this.previousState,
      nextState,
      previousDisplayCount: this.previousDisplayCount,
      nextDisplayCount: displayCount,
    });

    if (nextState === "BLOCKED") this.showOverlay();
    else this.hideOverlay();

    if (eventType) this.callbacks.onEventType?.(eventType, displayCount);

    this.previousState = nextState;
    this.previousDisplayCount = displayCount;
  }

  private showOverlay(): void {
    if (!this.targetWindow || this.targetWindow.isDestroyed()) return;
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      this.overlayWindow.show();
      return;
    }
    const bounds = this.targetWindow.getBounds();
    const overlay = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      frame: false,
      alwaysOnTop: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      skipTaskbar: true,
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    overlay.setAlwaysOnTop(true, "screen-saver");
    overlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(OVERLAY_HTML)}`);
    overlay.on("closed", () => {
      if (this.overlayWindow === overlay) this.overlayWindow = null;
    });
    this.overlayWindow = overlay;
  }

  private hideOverlay(): void {
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      this.overlayWindow.close();
    }
    this.overlayWindow = null;
  }
}
