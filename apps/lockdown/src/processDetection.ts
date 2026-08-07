/**
 * Tether Windows Lockdown Hardening v1 — main-process process-detection
 * service (Part 2/3/4). Mirrors displayEnforcement.ts's own class shape
 * (start/stop, policy set from the hosted page, periodic re-evaluation,
 * a main-owned overlay window) so the two enforcement mechanisms stay
 * architecturally consistent and independently reviewable.
 *
 * Zero awareness of exam policy beyond the LockdownPolicyToggles the
 * hosted page relays via setPolicyToggles (Part 12) — this process never
 * fetches or trusts institution config directly, exactly like
 * displayEnforcement.ts's own doc comment states for display policy.
 */
import { BrowserWindow } from "electron";
import {
  LOCKDOWN_CAPABILITY_REGISTRY,
  DEFAULT_LOCKDOWN_POLICY_TOGGLES,
  resolveEffectiveAction,
  isPreflightBlockingAction,
  isDuringExamBlockingAction,
  getCapabilityById,
  type LockdownPolicyToggles,
  type LockdownCapabilityAction,
} from "./lockdownCapabilityRegistry";
import {
  resolveScanOutcome,
  diffDetectionEpisodes,
  resolvePreflightCheckResult,
  type ProcessScanOutcome,
  type ProcessScanUnavailableReason,
  type PreflightCheckResult,
} from "./processDetectionLogic";
import { getWindowsProcessList } from "./windowsProcessList";
import { resolveProcessScanIntervalSeconds, resolveProcessScanTimeoutSeconds, resolveLockdownRecheckSeconds } from "./lockdownConfig";
import { diagnosticLog } from "./diagnosticLog";
import { consumeLockdownFault } from "./lockdownFaultInjection";

const OVERLAY_HTML_TEMPLATE = (applicationNames: string[]) => `<!doctype html>
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
  ul { font-size: 14px; color: #f9fafb; margin: 8px 0 0; padding: 0; list-style: none; }
</style>
</head>
<body>
  <h1>Close applications before continuing</h1>
  <p>Tether found applications that may allow screen sharing, remote access, recording or debugging. Close the listed applications, then check again.</p>
  <ul>${applicationNames.map((n) => `<li>${n.replace(/[<>&]/g, "")}</li>`).join("")}</ul>
</body>
</html>`;

export type ProcessDetectionEventCallbacks = {
  /**
   * Fired once per capability id per continuous episode (never every
   * poll — see diffDetectionEpisodes). `phase` distinguishes the two
   * halves of an episode so the caller can compute duration
   * (clearedAt - detectedAt) without keeping its own timestamp map.
   * `effectiveAction` is included so the page can decide how to record
   * it (BLOCK_DURING_EXAM -> reviewable IntegrityEvent + the overlay
   * already shown by this class; DETECT_AND_RECORD -> INFO-tier
   * IntegrityEvent, never an overlay; WARN_AND_REQUIRE_CLOSE ->
   * PlatformAuditLog only, never an overlay, never an IntegrityEvent —
   * see Part 11's classification rules) — this class itself only ever
   * shows the overlay for the BLOCK_DURING_EXAM subset (see
   * showOverlay's own call site below), regardless of what the page
   * chooses to record for the others.
   */
  onCapabilityTransition?: (capabilityId: string, effectiveAction: LockdownCapabilityAction, phase: "DETECTED" | "CLEARED", detectedAtMsForClear?: number) => void;
  /** Fired whenever a scan cannot complete at all (Part 11: recorded separately from any integrity signal). */
  onScanUnavailable?: (reason: string) => void;
};

export class ProcessDetection {
  private policyToggles: LockdownPolicyToggles = DEFAULT_LOCKDOWN_POLICY_TOGGLES;
  private examActive = false;
  private detectedCapabilityIds = new Set<string>();
  private detectedAtByCapabilityId = new Map<string, number>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private overlayWindow: BrowserWindow | null = null;
  private targetWindow: BrowserWindow | null = null;
  private scanInFlight: Promise<void> | null = null;
  private lastScanOk = true;
  private readonly callbacks: ProcessDetectionEventCallbacks;

  constructor(callbacks: ProcessDetectionEventCallbacks = {}) {
    this.callbacks = callbacks;
  }

  attachTargetWindow(window: BrowserWindow): void {
    this.targetWindow = window;
  }

  /** Part 12 — set by the hosted page, server-resolved. See this module's own doc comment. */
  setPolicyToggles(toggles: LockdownPolicyToggles): void {
    this.policyToggles = toggles;
  }

  /**
   * Part 2 — "before secure exam launch" / "before secure resume after
   * crash". One-shot, on-demand scan for the preflight blocking screen
   * (Part 3). Never mutates the episode-tracking state used by the
   * during-exam poll (`detectedCapabilityIds`) — a preflight check run
   * while an exam is not yet active must not itself start counting an
   * "episode" that the during-exam poll would then think it needs to
   * clear.
   */
  async runPreflightScan(): Promise<PreflightCheckResult> {
    const outcome = await this.scanOnce();
    const preflightBlockingIds = LOCKDOWN_CAPABILITY_REGISTRY.filter((c) => isPreflightBlockingAction(resolveEffectiveAction(c, this.policyToggles))).map((c) => c.id);
    return resolvePreflightCheckResult(outcome, preflightBlockingIds);
  }

  /**
   * Part 2 — "periodically during an active exam". Starts/stops the
   * background poll; also re-runs immediately on every call so a
   * transition INTO active state is never left waiting a full interval
   * before its first check (mirrors displayEnforcement.start()'s own
   * "evaluate immediately, never debounced" convention).
   */
  setExamActive(active: boolean): void {
    this.examActive = active;
    if (!active) {
      this.stopPolling();
      this.hideOverlay();
      this.detectedCapabilityIds = new Set();
      this.detectedAtByCapabilityId = new Map();
      return;
    }
    void this.pollOnce();
    this.restartPollingTimer(resolveProcessScanIntervalSeconds() * 1_000);
  }

  /** Part 2 — "after Windows resume/unlock" / "after Tether regains focus". */
  forceRescan(): void {
    if (!this.examActive) return;
    void this.pollOnce();
  }

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

  private async scanOnce(): Promise<ProcessScanOutcome> {
    // Part 17 — dev/test-only fault injection: forces a specific
    // capability to appear/disappear in the NEXT scan result, so the
    // episode-transition path (overlay show/hide, DETECTED/CLEARED
    // reporting, duration computation) can be exercised deterministically
    // without a real TeamViewer.exe process. Checked before the real
    // scan so it always wins when armed, on any platform.
    if (consumeLockdownFault("PROHIBITED_PROCESS_APPEARS")) return { ok: true, matchedCapabilityIds: ["TEAMVIEWER"] };
    if (consumeLockdownFault("PROHIBITED_PROCESS_DISAPPEARS")) return { ok: true, matchedCapabilityIds: [] };

    const timeoutMs = resolveProcessScanTimeoutSeconds() * 1_000;
    const listResult = await getWindowsProcessList(timeoutMs);
    if (!listResult.ok) {
      const reasonMap: Record<typeof listResult.reason, ProcessScanUnavailableReason> = {
        not_windows: "NOT_WINDOWS",
        timeout: "TIMEOUT",
        spawn_failed: "SPAWN_FAILED",
        non_zero_exit: "NON_ZERO_EXIT",
      };
      return { ok: false, reason: reasonMap[listResult.reason] };
    }
    return resolveScanOutcome(listResult.parseResult);
  }

  private async pollOnce(): Promise<void> {
    // Serialize — a slow scan must never overlap with the next timer
    // tick's own scan. Assigns scanInFlight to pollOnceNow()'s own
    // promise directly (never a `.finally()`-wrapped one) and clears it
    // unconditionally once that promise settles, success or failure.
    // `.finally()` always returns a NEW promise object — a self-clearing
    // check comparing `this.scanInFlight === run` against a
    // `.finally()`-wrapped value would never be true (verified: `const
    // run = Promise.resolve(); run.finally(() => {}) !== run`), leaving
    // scanInFlight permanently non-null after the very first scan and
    // silently freezing detection at that scan's result for the rest of
    // the exam — every later timer tick would just re-await the same,
    // long-since-resolved promise and return without ever calling
    // pollOnceNow() again. See remoteSessionMonitor.ts's pollOnce for the
    // same fix applied there first. No race is possible here despite the
    // lack of an identity check: this method only ever yields control at
    // its own `await`, by which point scanInFlight is already assigned,
    // so a concurrent call always observes it set.
    if (this.scanInFlight) {
      // A merely-waiting concurrent caller must never re-throw a failure
      // the owning caller below already logs — otherwise the SAME
      // underlying rejection would surface as an unhandled promise
      // rejection at whichever `void this.pollOnce()` call site (the
      // timer callback, forceRescan()) happened to lose the race to
      // start the scan.
      try {
        await this.scanInFlight;
      } catch {
        // Already logged by the owning caller below.
      }
      return;
    }
    this.scanInFlight = this.pollOnceNow();
    try {
      await this.scanInFlight;
    } catch (err) {
      // scanOnce() itself never throws for any EXPECTED failure mode
      // (not_windows/timeout/spawn_failed/non_zero_exit all come back as
      // a discriminated { ok: false } result) — a rejection here is
      // genuinely unexpected (e.g. a caller-supplied callback throwing).
      // Every call site of pollOnce() is `void this.pollOnce()`
      // (fire-and-forget, never awaited or .catch()'d by its caller), so
      // letting this propagate would become an unhandled promise
      // rejection — never let one bad poll destabilize Tether; log and
      // continue, exactly like a failed scan already does.
      diagnosticLog("processDetection: pollOnce failed unexpectedly", {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.scanInFlight = null;
    }
  }

  private async pollOnceNow(): Promise<void> {
    const outcome = await this.scanOnce();
    diagnosticLog("processDetection: scan", { ok: outcome.ok });

    if (!outcome.ok) {
      this.lastScanOk = false;
      this.callbacks.onScanUnavailable?.(outcome.reason);
      // Part 3/4 — "do not treat 'unable to inspect processes' as 'no
      // prohibited processes found'": a failed scan neither clears nor
      // adds to the currently-tracked detected set; whatever was showing
      // stays showing (fail closed) until a scan actually succeeds.
      return;
    }
    this.lastScanOk = true;

    // Every capability whose EFFECTIVE action is worth recording at all
    // during an active exam — BLOCK_DURING_EXAM (blocks + records),
    // DETECT_AND_RECORD (records only), or WARN_AND_REQUIRE_CLOSE
    // (records only, via PlatformAuditLog — the page decides that split
    // using the effectiveAction this reports, never this class). A
    // capability downgraded to DETECT_AND_RECORD by a policy toggle
    // (Part 12) is still tracked here — "prefer detection plus
    // controlled remediation" (Part 4) means a toggle turning BLOCKING
    // off must never also turn RECORDING off.
    const effectiveActionById = new Map(LOCKDOWN_CAPABILITY_REGISTRY.map((c) => [c.id, resolveEffectiveAction(c, this.policyToggles)] as const));
    const recordableIds = new Set(
      [...effectiveActionById.entries()].filter(([, action]) => action !== "NOT_SUPPORTED" && action !== "BLOCK_BEFORE_EXAM").map(([id]) => id),
    );
    const nextDetected = new Set(outcome.matchedCapabilityIds.filter((id) => recordableIds.has(id)));

    const diff = diffDetectionEpisodes(this.detectedCapabilityIds, nextDetected);
    const now = Date.now();
    for (const id of diff.newlyDetected) {
      this.detectedAtByCapabilityId.set(id, now);
      this.callbacks.onCapabilityTransition?.(id, effectiveActionById.get(id) ?? "DETECT_AND_RECORD", "DETECTED");
    }
    for (const id of diff.newlyCleared) {
      const detectedAt = this.detectedAtByCapabilityId.get(id);
      this.detectedAtByCapabilityId.delete(id);
      this.callbacks.onCapabilityTransition?.(id, effectiveActionById.get(id) ?? "DETECT_AND_RECORD", "CLEARED", detectedAt);
    }

    this.detectedCapabilityIds = nextDetected;

    // The live blocking overlay (Part 4) is shown ONLY for the
    // BLOCK_DURING_EXAM subset of what was just detected — a
    // DETECT_AND_RECORD/WARN_AND_REQUIRE_CLOSE match is recorded (via
    // the callback above) but never covers exam content.
    const blockingNow = [...nextDetected].filter((id) => isDuringExamBlockingAction(effectiveActionById.get(id) ?? "NOT_SUPPORTED"));
    if (blockingNow.length > 0) {
      this.showOverlay(blockingNow);
      // Faster recheck cadence while actively blocking (Part 4/12) —
      // never lets a student who already closed the app wait a full
      // background-scan interval to be released.
      this.restartPollingTimer(resolveLockdownRecheckSeconds() * 1_000);
    } else {
      this.hideOverlay();
      this.restartPollingTimer(resolveProcessScanIntervalSeconds() * 1_000);
    }
  }

  private showOverlay(capabilityIds: string[]): void {
    const names = capabilityIds.map((id) => getCapabilityById(id)?.studentExplanation ?? "an application").sort();
    if (!this.targetWindow || this.targetWindow.isDestroyed()) return;
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      this.overlayWindow.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(OVERLAY_HTML_TEMPLATE(names))}`);
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
    overlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(OVERLAY_HTML_TEMPLATE(names))}`);
    overlay.on("closed", () => {
      if (this.overlayWindow === overlay) this.overlayWindow = null;
    });
    this.overlayWindow = overlay;
    diagnosticLog("processDetection: overlay shown", { capabilityIds });
  }

  private hideOverlay(): void {
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      this.overlayWindow.close();
    }
    this.overlayWindow = null;
  }

  /** Diagnostic/status snapshot — never includes raw process names or command-line data, only bounded counts/ids/booleans. */
  getStatusSnapshot(): { examActive: boolean; lastScanOk: boolean; detectedCapabilityIds: string[]; overlayVisible: boolean } {
    return {
      examActive: this.examActive,
      lastScanOk: this.lastScanOk,
      detectedCapabilityIds: [...this.detectedCapabilityIds],
      overlayVisible: Boolean(this.overlayWindow && !this.overlayWindow.isDestroyed()),
    };
  }
}
