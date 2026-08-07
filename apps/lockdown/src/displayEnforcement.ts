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
 * see docs/secure-client-foundation-seb-v1.md). `setEnforcementState` is
 * the one input the hosted page controls, via
 * window.sesLockdown.setSecureClientEnforcementState(...) — see
 * displayEnforcementLogic.ts's SecureClientEnforcementState doc comment
 * for the {active, ready, requireSingleDisplay} contract (corrective
 * pass v1.2.1, Task C: replaces the old plain boolean, which defaulted
 * to "not enforcing" and left a fail-open gap between window creation
 * and the page's first policy determination — the reported root cause
 * of "still does not block a second display").
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
  resolveReadinessGatedDisplayEnforcementState,
  debounceDisplayEvent,
  resolveDisplayEnforcementEventType,
  DEFAULT_DISPLAY_EVENT_DEBOUNCE_MS,
  INITIAL_SECURE_CLIENT_ENFORCEMENT_STATE,
  type DisplayEnforcementState,
  type DisplayEnforcementEventType,
  type SecureClientEnforcementState,
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
  /** Task A/B — fired whenever this module's own piece of the diagnostic snapshot changes (decision, display count, topology, active target count). main.ts merges this with page-reported context and does its own change comparison before pushing to the panel / appending to the log file. */
  onDiagnosticsChanged?: (snapshot: ReturnType<DisplayEnforcement["getDiagnosticsSnapshot"]>) => void;
};

export class DisplayEnforcement {
  private enforcementState: SecureClientEnforcementState = INITIAL_SECURE_CLIENT_ENFORCEMENT_STATE;
  private lastHandledAtMs: number | null = null;
  private previousState: DisplayEnforcementState | null = null;
  private previousDisplayCount: number | null = null;
  private previousTopology: WindowsDisplayTopologyClassification | null = null;
  private previousActiveTargetCount: number | null = null;
  private overlayWindow: BrowserWindow | null = null;
  private targetWindow: BrowserWindow | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private evaluateInFlight: Promise<void> | null = null;
  private lastDisplayCheckAtMs: number | null = null;
  private lastErrorCode: string | null = null;
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
    diagnosticLog("displayEnforcement.start() called", { enforcementState: this.enforcementState });
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

  /**
   * Corrective pass v1.2.1, Task C. Set by the hosted page as soon as it
   * knows enough to say so (see src/app/student/exams/[id]/page.tsx) —
   * `active` becomes true the instant the exam page mounts, before any
   * data has loaded, and `ready`/`requireSingleDisplay` are filled in
   * once the authoritative per-attempt policy and secure-client
   * verification are both confirmed. Always re-evaluates immediately —
   * a deliberate policy-activation call must never be silently dropped
   * by the debounce (the v1.2.0 corrective-pass fix, still in effect).
   */
  setEnforcementState(state: SecureClientEnforcementState): void {
    this.enforcementState = state;
    diagnosticLog("setEnforcementState called", { enforcementState: state });
    void this.evaluate({ bypassDebounce: true });
  }

  getCurrentDisplayCount(): number {
    return screen.getAllDisplays().length;
  }

  /**
   * Tether System Check and Exam Readiness v1 — an on-demand, fresh
   * native topology read for the "getDisplayTopology()" preload method,
   * independent of the live enforcement loop's cached
   * previousTopology/previousActiveTargetCount (those only update on the
   * next debounced/periodic evaluate() tick, which could be stale by up
   * to PERIODIC_RECHECK_MS at the moment a student runs the system
   * check). Never toggles the overlay or enforcement state — read-only.
   */
  async getOnDemandDisplayTopology(): Promise<{ classification: WindowsDisplayTopologyClassification; activeTargetCount: number | null; electronDisplayCount: number }> {
    const electronDisplayCount = this.getCurrentDisplayCount();
    try {
      const topology = await getWindowsDisplayTopology();
      const primaryIsInternal = (screen.getPrimaryDisplay() as { internal?: boolean }).internal;
      const classification = classifyWindowsDisplayTopology(topology, { primaryIsInternal });
      return { classification: classification.classification, activeTargetCount: classification.activeTargetCount, electronDisplayCount };
    } catch {
      return { classification: "ERROR", activeTargetCount: null, electronDisplayCount };
    }
  }

  /** Task A/B — bounded, non-secret snapshot of everything this module currently knows, for the diagnostic panel and log file. Never includes anything beyond counts/enums/booleans/timestamps. */
  getDiagnosticsSnapshot(): {
    enforcementState: SecureClientEnforcementState;
    electronDisplayCount: number;
    windowsTopologyClassification: WindowsDisplayTopologyClassification | null;
    activeWindowsTargetCount: number | null;
    currentDecision: DisplayEnforcementState;
    overlayVisible: boolean;
    lastDisplayCheckAt: string | null;
    lastErrorCode: string | null;
  } {
    return {
      enforcementState: this.enforcementState,
      electronDisplayCount: this.getCurrentDisplayCount(),
      windowsTopologyClassification: this.previousTopology,
      activeWindowsTargetCount: this.previousActiveTargetCount,
      currentDecision: this.previousState ?? "OK",
      overlayVisible: Boolean(this.overlayWindow && !this.overlayWindow.isDestroyed()),
      lastDisplayCheckAt: this.lastDisplayCheckAtMs != null ? new Date(this.lastDisplayCheckAtMs).toISOString() : null,
      lastErrorCode: this.lastErrorCode,
    };
  }

  /**
   * `bypassDebounce: false` is used ONLY by the raw `screen.on(...)`
   * listener (rapid-fire duplicate OS events genuinely need debouncing);
   * every other caller (start, setRequireSingleDisplay, the periodic
   * recheck) always bypasses — see the corrective-pass doc comment above
   * for why conflating these was the actual Extend-mode bug.
   *
   * v1.7.2 poll-serialization fix — a native topology query can be in
   * flight when another evaluate() call arrives (e.g. the periodic timer
   * firing while a raw event's async check is still resolving). Assigns
   * evaluateInFlight to evaluateNow()'s own promise directly (never a
   * `.finally()`-wrapped one) and clears it unconditionally once that
   * promise settles — see processDetection.ts's pollOnce()/
   * remoteSessionMonitor.ts's pollOnce() for the identical fix applied
   * there first. `.finally()` always returns a NEW promise object — the
   * previous self-clearing check here compared `this.evaluateInFlight ===
   * run` against a `.finally()`-wrapped value, which could never be true,
   * leaving evaluateInFlight permanently non-null after the very first
   * evaluation and silently freezing display-topology enforcement at that
   * evaluation's result for the rest of the exam. A concurrent caller
   * never starts its own second evaluation — it only awaits the one
   * already running, and never re-throws its failure (the owning caller
   * below already logs it), so the SAME underlying rejection can never
   * surface as an unhandled promise rejection at more than one `void
   * this.evaluate(...)` call site.
   */
  private async evaluate(options: { bypassDebounce: boolean }): Promise<void> {
    const now = Date.now();
    if (!options.bypassDebounce && !debounceDisplayEvent(this.lastHandledAtMs, now, DEFAULT_DISPLAY_EVENT_DEBOUNCE_MS)) return;
    this.lastHandledAtMs = now;

    if (this.evaluateInFlight) {
      try {
        await this.evaluateInFlight;
      } catch {
        // Already logged by the owning caller below.
      }
      return;
    }
    const run = this.evaluateNow();
    this.evaluateInFlight = run;
    try {
      await run;
    } catch (err) {
      // evaluateNow() itself never throws for any EXPECTED failure mode —
      // a failed topology query is caught internally and reported as an
      // ERROR classification, which fails closed. A rejection here is
      // genuinely unexpected (e.g. a destroyed-window overlay call, or a
      // caller-supplied callback throwing). Every call site of evaluate()
      // is `void this.evaluate(...)` (fire-and-forget, never awaited or
      // .catch()'d by its caller), so letting this propagate would become
      // an unhandled promise rejection — never let one bad evaluation
      // destabilize Tether; log and continue, exactly like a failed scan
      // already does in processDetection.ts.
      diagnosticLog("displayEnforcement: evaluate failed unexpectedly", {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (this.evaluateInFlight === run) this.evaluateInFlight = null;
    }
  }

  private async evaluateNow(): Promise<void> {
    this.lastDisplayCheckAtMs = Date.now();
    let displayCount = 0;
    let classification: { classification: WindowsDisplayTopologyClassification; activeTargetCount: number | null } = {
      classification: "ERROR",
      activeTargetCount: null,
    };
    try {
      displayCount = this.getCurrentDisplayCount();
      const topology = await getWindowsDisplayTopology();
      // Display.internal is only populated on some platforms/Electron
      // versions — undefined falls back to the classifier's own
      // conservative "assume internal" default, which never affects the
      // SINGLE_DISPLAY_REQUIRED enforcement decision either way (neither
      // INTERNAL_ONLY nor EXTERNAL_ONLY ever blocks — see isBlockingTopology).
      const primaryIsInternal = (screen.getPrimaryDisplay() as { internal?: boolean }).internal;
      classification = classifyWindowsDisplayTopology(topology, { primaryIsInternal });
      this.lastErrorCode = classification.classification === "ERROR" ? "TOPOLOGY_QUERY_FAILED" : null;
    } catch {
      // A thrown exception (rather than the topology module's own
      // {ok:false} result) is itself an authoritative-topology failure —
      // fail closed the same way ERROR classification does below, and
      // record it for the diagnostic panel/log (Task A/D "last error code").
      classification = { classification: "ERROR", activeTargetCount: null };
      this.lastErrorCode = "EVALUATE_THREW";
    }

    const nextState: DisplayEnforcementState = resolveReadinessGatedDisplayEnforcementState(
      this.enforcementState,
      displayCount,
      classification.classification,
    );

    const eventType = resolveDisplayEnforcementEventType({
      previousState: this.previousState,
      nextState,
      previousDisplayCount: this.previousDisplayCount,
      nextDisplayCount: displayCount,
    });

    diagnosticLog("evaluate: decision", {
      enforcementState: this.enforcementState,
      electronDisplayCount: displayCount,
      windowsTopology: classification.classification,
      windowsActiveTargetCount: classification.activeTargetCount,
      nextState,
      previousState: this.previousState,
    });

    if (nextState === "BLOCKED") this.showOverlay();
    else this.hideOverlay();

    if (eventType) this.callbacks.onEventType?.(eventType, displayCount);

    const changed =
      nextState !== this.previousState ||
      displayCount !== this.previousDisplayCount ||
      classification.classification !== this.previousTopology ||
      classification.activeTargetCount !== this.previousActiveTargetCount;

    this.previousState = nextState;
    this.previousDisplayCount = displayCount;
    this.previousTopology = classification.classification;
    this.previousActiveTargetCount = classification.activeTargetCount;

    if (changed) this.callbacks.onDiagnosticsChanged?.(this.getDiagnosticsSnapshot());
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
