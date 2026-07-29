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
 *
 * Corrective pass v1.2.0 — fixes a real bug found by physical testing:
 * the previous version applied the same 500ms debounce to EVERY call to
 * evaluate(), including the deliberate, single, authoritative calls from
 * start() and setRequireSingleDisplay(). A real Extend/Duplicate mode
 * transition fires several raw display-added/display-removed/
 * display-metrics-changed events over 1-2+ seconds as Windows settles,
 * and setDisplayPolicyEnforced(true)'s
 * IPC call can easily land inside that same debounce window — silently
 * dropping the one evaluation that actually mattered (requireSingleDisplay
 * got set, but the overlay never showed for an already-connected second
 * display). Policy activation, startup, and the periodic recheck below
 * now always bypass the debounce; only raw OS event callbacks debounce.
 * Also adds a periodic ~2s recheck (bypassing debounce) as a second line
 * of defense and to satisfy the Windows-topology polling requirement
 * (Part 2 of the corrective pass) via the same code path.
 */
import { screen, BrowserWindow } from "electron";
import {
  resolveCombinedDisplayEnforcementState,
  debounceDisplayEvent,
  resolveDisplayEnforcementEventType,
  DEFAULT_DISPLAY_EVENT_DEBOUNCE_MS,
  type DisplayEnforcementState,
  type DisplayEnforcementEventType,
} from "./displayEnforcementLogic";
import { getWindowsDisplayTopology } from "./windowsDisplayTopology";
import { classifyWindowsDisplayTopology, type WindowsDisplayTopologyClassification } from "./windowsDisplayTopologyClassifier";
import { diagnosticLog } from "./diagnosticLog";

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

/** Windows topology transitions may not always produce the same Electron display event — this periodic recheck is the backstop (Part 2 of the corrective pass). */
const PERIODIC_RECHECK_MS = 2_000;

export type DisplayEnforcementCallbacks = {
  onEventType?: (eventType: DisplayEnforcementEventType, displayCount: number) => void;
};

export class DisplayEnforcement {
  private requireSingleDisplay = false;
  private lastHandledAtMs: number | null = null;
  private previousState: DisplayEnforcementState | null = null;
  private previousDisplayCount: number | null = null;
  private previousTopology: WindowsDisplayTopologyClassification | null = null;
  private overlayWindow: BrowserWindow | null = null;
  private targetWindow: BrowserWindow | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private evaluateInFlight: Promise<void> | null = null;
  private readonly callbacks: DisplayEnforcementCallbacks;
  private readonly handleChange = () => {
    void this.evaluate({ bypassDebounce: false });
  };

  constructor(callbacks: DisplayEnforcementCallbacks = {}) {
    this.callbacks = callbacks;
  }

  /** Registers the live listeners, evaluates the current state immediately (never debounced — see corrective-pass note above), and starts the periodic native-topology recheck. Call once per app session, as soon as the exam window exists — not gated on the page finishing load. */
  start(targetWindow: BrowserWindow): void {
    this.targetWindow = targetWindow;
    screen.on("display-added", this.handleChange);
    screen.on("display-removed", this.handleChange);
    screen.on("display-metrics-changed", this.handleChange);
    diagnosticLog("displayEnforcement.start() called", { requireSingleDisplay: this.requireSingleDisplay });
    void this.evaluate({ bypassDebounce: true });
    this.pollTimer = setInterval(() => {
      void this.evaluate({ bypassDebounce: true });
    }, PERIODIC_RECHECK_MS);
  }

  stop(): void {
    screen.removeListener("display-added", this.handleChange);
    screen.removeListener("display-removed", this.handleChange);
    screen.removeListener("display-metrics-changed", this.handleChange);
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.hideOverlay();
    this.targetWindow = null;
  }

  /** Set by the hosted page once it knows (from the server) that this exam's display requirement applies. Always re-evaluates immediately — a deliberate policy-activation call must never be silently dropped by the debounce (the corrective-pass fix). */
  setRequireSingleDisplay(required: boolean): void {
    this.requireSingleDisplay = required;
    diagnosticLog("setRequireSingleDisplay called", { required });
    void this.evaluate({ bypassDebounce: true });
  }

  getCurrentDisplayCount(): number {
    return screen.getAllDisplays().length;
  }

  /**
   * `bypassDebounce: false` is used ONLY by the raw `screen.on(...)`
   * listener (rapid-fire duplicate OS events genuinely need debouncing);
   * every other caller (start, setRequireSingleDisplay, the periodic
   * recheck) always bypasses — see the corrective-pass doc comment above
   * for why conflating these was the actual Extend-mode bug.
   */
  private async evaluate(options: { bypassDebounce: boolean }): Promise<void> {
    const now = Date.now();
    if (!options.bypassDebounce && !debounceDisplayEvent(this.lastHandledAtMs, now, DEFAULT_DISPLAY_EVENT_DEBOUNCE_MS)) return;
    this.lastHandledAtMs = now;

    // A native topology query can be in flight when another evaluate()
    // call arrives (e.g. the periodic timer firing while a raw event's
    // async check is still resolving) — serialise rather than overlap,
    // so two concurrent PowerShell spawns never race each other's
    // overlay show/hide decisions.
    if (this.evaluateInFlight) {
      await this.evaluateInFlight;
    }
    const run = this.evaluateNow();
    this.evaluateInFlight = run.finally(() => {
      if (this.evaluateInFlight === run) this.evaluateInFlight = null;
    });
    await run;
  }

  private async evaluateNow(): Promise<void> {
    const displayCount = this.getCurrentDisplayCount();
    const topology = await getWindowsDisplayTopology();
    // Display.internal is only populated on some platforms/Electron
    // versions — undefined falls back to the classifier's own
    // conservative "assume internal" default, which never affects the
    // SINGLE_DISPLAY_REQUIRED enforcement decision either way (neither
    // INTERNAL_ONLY nor EXTERNAL_ONLY ever blocks — see isBlockingTopology).
    const primaryIsInternal = (screen.getPrimaryDisplay() as { internal?: boolean }).internal;
    const classification = classifyWindowsDisplayTopology(topology, { primaryIsInternal });

    const nextState: DisplayEnforcementState = resolveCombinedDisplayEnforcementState(
      displayCount,
      this.requireSingleDisplay,
      classification.classification,
    );

    const eventType = resolveDisplayEnforcementEventType({
      previousState: this.previousState,
      nextState,
      previousDisplayCount: this.previousDisplayCount,
      nextDisplayCount: displayCount,
    });

    diagnosticLog("evaluate: decision", {
      requireSingleDisplay: this.requireSingleDisplay,
      electronDisplayCount: displayCount,
      windowsTopology: classification.classification,
      windowsActiveTargetCount: classification.activeTargetCount,
      nextState,
      previousState: this.previousState,
    });

    if (nextState === "BLOCKED") this.showOverlay();
    else this.hideOverlay();

    if (eventType) this.callbacks.onEventType?.(eventType, displayCount);

    this.previousState = nextState;
    this.previousDisplayCount = displayCount;
    this.previousTopology = classification.classification;
  }

  private showOverlay(): void {
    if (!this.targetWindow || this.targetWindow.isDestroyed()) return;
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      this.overlayWindow.show();
      diagnosticLog("overlay: show (already existed)", { result: "shown" });
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
    diagnosticLog("overlay: create", { result: "created", bounds: { width: bounds.width, height: bounds.height } });
  }

  private hideOverlay(): void {
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      this.overlayWindow.close();
      diagnosticLog("overlay: hide", { result: "closed" });
    }
    this.overlayWindow = null;
  }
}
