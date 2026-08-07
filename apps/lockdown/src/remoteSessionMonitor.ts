/**
 * Tether mid-exam remote-session monitoring v1 — main-process polling
 * service. Extends the REMOTE_DESKTOP_SESSION capability
 * (lockdownCapabilityRegistry.ts) from a preflight-only, one-shot check
 * (Part 5 — GET lockdown:get-remote-session-status) to continuous
 * monitoring while an exam is ACTIVE, mirroring ProcessDetection's own
 * start/stop/poll shape so the two enforcement mechanisms stay
 * architecturally consistent — but deliberately kept as a SEPARATE class
 * rather than folded into ProcessDetection's own scan loop, since the
 * underlying detection mechanism (a PowerShell + Add-Type spawn — see
 * windowsSessionDetection.ts) and its natural polling cadence are both
 * fundamentally different from ProcessDetection's Get-Process
 * enumeration (see lockdownConfig.ts's
 * resolveRemoteSessionMonitorIntervalSeconds doc comment).
 *
 * All transition/state-machine decisions are delegated to the pure
 * remoteSessionMonitorLogic.ts module — this class is the thin,
 * Electron-touching adapter that spawns the check, drives the timer, and
 * shows/hides the same kind of blocking overlay ProcessDetection already
 * uses for other BLOCK_DURING_EXAM capabilities (only when the EFFECTIVE
 * action — after TETHER_BLOCK_REMOTE_CONTROL policy toggle resolution —
 * is actually BLOCK_DURING_EXAM; a downgraded-to-DETECT_AND_RECORD
 * toggle state never blocks, matching Required behaviour #8's "continue
 * or block according to configured policy").
 *
 * Never terminates or submits the exam itself, and never makes a
 * misconduct determination — only records the signal and (when policy
 * requires) shows the calm blocking overlay; a lecturer reviews the
 * resulting IntegrityEvent (see lockdownClient.ts's
 * reportRemoteSessionMonitorTransition).
 */
import { BrowserWindow } from "electron";
import {
  getCapabilityById,
  resolveEffectiveAction,
  isDuringExamBlockingAction,
  DEFAULT_LOCKDOWN_POLICY_TOGGLES,
  type LockdownPolicyToggles,
  type LockdownCapabilityAction,
} from "./lockdownCapabilityRegistry";
import { getWindowsSessionClassification } from "./windowsSessionDetection";
import type { WindowsSessionClassification } from "./windowsSessionDetectionLogic";
import {
  computeRemoteSessionMonitorTransitions,
  INITIAL_REMOTE_SESSION_MONITOR_STATE,
  type RemoteSessionMonitorState,
  type RemoteSessionMonitorTransition,
} from "./remoteSessionMonitorLogic";
import { resolveRemoteSessionMonitorIntervalSeconds } from "./lockdownConfig";
import { diagnosticLog } from "./diagnosticLog";

export const REMOTE_SESSION_CAPABILITY_ID = "REMOTE_DESKTOP_SESSION";

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
  p { font-size: 14px; color: #d1d5db; margin: 0 0 8px; max-width: 480px; }
</style>
</head>
<body>
  <h1>Remote Desktop connection detected</h1>
  <p>This computer appears to be connected to over Remote Desktop. Disconnect the remote session, then continue.</p>
</body>
</html>`;

/** getWindowsSessionClassification() never throws by its own contract — this is only a defensive fallback if that contract is ever violated. */
const FAIL_SAFE_UNAVAILABLE_CLASSIFICATION: WindowsSessionClassification = {
  isRemoteSession: false,
  remoteSessionSignalSource: "UNAVAILABLE",
  isLikelyVirtualMachine: false,
  vmSignatureMatched: null,
};

export type RemoteSessionMonitorEventCallbacks = {
  /**
   * Fired once per de-duplicated transition (see
   * remoteSessionMonitorLogic.ts) — never on every poll. `detectedAtMsForClear`
   * is populated only for BECAME_INACTIVE — the timestamp (this process's
   * own Date.now(), captured at the matching BECAME_ACTIVE) the caller can
   * subtract from now to compute how long the session was active, mirroring
   * ProcessDetectionEventCallbacks.onCapabilityTransition's own
   * detectedAtMsForClear.
   */
  onTransition?: (transition: RemoteSessionMonitorTransition, effectiveAction: LockdownCapabilityAction, detectedAtMsForClear: number | null) => void;
};

export class RemoteSessionMonitor {
  private policyToggles: LockdownPolicyToggles = DEFAULT_LOCKDOWN_POLICY_TOGGLES;
  private examActive = false;
  private state: RemoteSessionMonitorState = INITIAL_REMOTE_SESSION_MONITOR_STATE;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollInFlight: Promise<void> | null = null;
  private overlayWindow: BrowserWindow | null = null;
  private targetWindow: BrowserWindow | null = null;
  private activatedAtMs: number | null = null;
  private readonly callbacks: RemoteSessionMonitorEventCallbacks;

  constructor(callbacks: RemoteSessionMonitorEventCallbacks = {}) {
    this.callbacks = callbacks;
  }

  attachTargetWindow(window: BrowserWindow): void {
    this.targetWindow = window;
  }

  /** Server-resolved policy toggles, relayed from the same lockdown:set-lockdown-policy-toggles channel ProcessDetection already consumes. */
  setPolicyToggles(toggles: LockdownPolicyToggles): void {
    this.policyToggles = toggles;
  }

  /**
   * Starts/stops the background poll. Re-evaluates immediately on every
   * call (never debounced), matching ProcessDetection.setExamActive's own
   * convention, so a transition INTO active exam state is never left
   * waiting a full interval for its first check.
   */
  setExamActive(active: boolean): void {
    this.examActive = active;
    if (!active) {
      this.stopPolling();
      this.hideOverlay();
      this.state = INITIAL_REMOTE_SESSION_MONITOR_STATE;
      this.activatedAtMs = null;
      return;
    }
    void this.pollOnce();
    this.restartPollingTimer(resolveRemoteSessionMonitorIntervalSeconds() * 1_000);
  }

  /** Idempotent — safe to call multiple times, from any state (window closed, Tether quitting, lockdownLifecycle restore). */
  stop(): void {
    this.stopPolling();
    this.hideOverlay();
    this.targetWindow = null;
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private restartPollingTimer(intervalMs: number): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => void this.pollOnce(), intervalMs);
  }

  private async pollOnce(): Promise<void> {
    // Serialize — a slow check must never overlap with the next timer
    // tick's own check. Assigns pollInFlight to pollOnceNow()'s own
    // promise directly (not a `.finally()`-wrapped one) and clears it
    // unconditionally once that promise settles — `.finally()` always
    // returns a NEW promise object, so a self-clearing check comparing
    // `this.pollInFlight === run` against a `.finally()`-wrapped value
    // would never be true and would leave pollInFlight permanently
    // non-null after the very first poll, silently freezing this monitor
    // at its first result for the rest of the exam. No race is possible
    // here despite the lack of an identity check: this method only ever
    // yields control at its own `await`, by which point pollInFlight is
    // already assigned, so a concurrent call always observes it set.
    if (this.pollInFlight) {
      await this.pollInFlight;
      return;
    }
    this.pollInFlight = this.pollOnceNow();
    try {
      await this.pollInFlight;
    } finally {
      this.pollInFlight = null;
    }
  }

  private async pollOnceNow(): Promise<void> {
    if (!this.examActive) return;

    let classification: WindowsSessionClassification;
    try {
      classification = await getWindowsSessionClassification();
    } catch {
      classification = FAIL_SAFE_UNAVAILABLE_CLASSIFICATION;
    }
    diagnosticLog("remoteSessionMonitor: poll", {
      source: classification.remoteSessionSignalSource,
      isRemoteSession: classification.isRemoteSession,
    });

    const { nextState, transitions } = computeRemoteSessionMonitorTransitions(this.state, classification);
    this.state = nextState;

    const capability = getCapabilityById(REMOTE_SESSION_CAPABILITY_ID);
    const effectiveAction: LockdownCapabilityAction = capability ? resolveEffectiveAction(capability, this.policyToggles) : "DETECT_AND_RECORD";

    for (const transition of transitions) {
      let detectedAtMsForClear: number | null = null;
      if (transition.kind === "BECAME_ACTIVE") {
        this.activatedAtMs = Date.now();
      } else if (transition.kind === "BECAME_INACTIVE") {
        detectedAtMsForClear = this.activatedAtMs;
        this.activatedAtMs = null;
      }
      try {
        this.callbacks.onTransition?.(transition, effectiveAction, detectedAtMsForClear);
      } catch {
        // A reporting callback failure (e.g. an IPC send racing a
        // destroyed window) must never crash the poll loop or take down
        // Tether — see windowLifecycleGuard.ts and the destroyed-window
        // crash-fix work this monitor must not regress.
      }
    }

    // The blocking overlay only ever reflects the CURRENT tracked active
    // state and effective action — never the transient "unavailable"
    // signal itself (Required behaviour #8: only record + optionally warn
    // on an unavailable check, never newly block because of it). Because
    // a failed check never changes state.lastKnownActiveState, recomputing
    // this decision after a failed poll is naturally fail-closed: whatever
    // the overlay was already doing keeps doing it.
    if (this.state.lastKnownActiveState === "ACTIVE" && isDuringExamBlockingAction(effectiveAction)) {
      this.showOverlay();
    } else {
      this.hideOverlay();
    }
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
    diagnosticLog("remoteSessionMonitor: overlay shown", {});
  }

  private hideOverlay(): void {
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      this.overlayWindow.close();
    }
    this.overlayWindow = null;
  }

  /** Diagnostic/status snapshot — never includes raw classification detail beyond the bounded fields already exposed elsewhere. */
  getStatusSnapshot(): { examActive: boolean; lastKnownActiveState: string; lastCheckAvailable: boolean; overlayVisible: boolean } {
    return {
      examActive: this.examActive,
      lastKnownActiveState: this.state.lastKnownActiveState,
      lastCheckAvailable: this.state.lastCheckAvailable,
      overlayVisible: Boolean(this.overlayWindow && !this.overlayWindow.isDestroyed()),
    };
  }
}
