/**
 * Tether launch/install flow v1 — main-process display enforcement.
 *
 * Registers Electron's screen listeners once, at app start, and keeps
 * them live for the whole session (not just a one-shot check at initial
 * page load — see docs/lockdown-browser-known-limitations.md in the
 * main repo for what this replaces). Detection and decision-making stay
 * entirely native — a security property that must not depend on the
 * hosted web page's own JS/React state being responsive — but student-
 * facing blocking (v1.7.6, Native Display State Bridge) is no longer a
 * second native BrowserWindow: physical HDMI-disconnect testing isolated
 * an unrecoverable-screen symptom (requiring a full OS restart) to this
 * separate native overlay's recovery path — the precise Windows window/
 * compositor failure mechanism was never independently established, only
 * that removing the overlay entirely removes the symptom. This module
 * now only pushes/serves a
 * bounded, renderer-facing status (getDisplayEnforcementStatus,
 * onDisplayStateChanged); the exam content page renders its own
 * React/DOM blur+modal from it. Event REPORTING (onEventType, below) is
 * separate and unchanged — page-driven, reusing the page's own
 * authenticated fetch.
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
import { screen, type BrowserWindow } from "electron";
import {
  resolveReadinessGatedDisplayDecision,
  debounceDisplayEvent,
  resolveDisplayDecisionEventType,
  toDisplayEnforcementStatus,
  displayEnforcementStatusesEqual,
  DEFAULT_DISPLAY_EVENT_DEBOUNCE_MS,
  INITIAL_SECURE_CLIENT_ENFORCEMENT_STATE,
  type DisplayEnforcementState,
  type DisplayDecision,
  type DisplayDecisionEventType,
  type DisplayBlockingReason,
  type DisplayEnforcementStatus,
  type SecureClientEnforcementState,
} from "./displayEnforcementLogic";
import { getWindowsDisplayTopology } from "./windowsDisplayTopology";
import { classifyWindowsDisplayTopology, type WindowsDisplayTopologyClassification } from "./windowsDisplayTopologyClassifier";
import { diagnosticLog } from "./diagnosticLog";

/** Windows topology transitions may not always produce the same Electron display event — this periodic recheck is the backstop (Part 2 of the corrective pass). */
const PERIODIC_RECHECK_MS = 2_000;

export type DisplayEnforcementCallbacks = {
  /** v1.7.4 — eventType is now the reason-aware DisplayDecisionEventType (see displayEnforcementLogic.ts); main.ts maps DISPLAY_CHECK_TECHNICAL_FAILURE to the existing CLIENT_TECHNICAL_FAILURE server event type, never a display-presence claim. This is the integrity-EVENT-reporting channel — unrelated to, and unweakened by, onDisplayStateChanged below. */
  onEventType?: (eventType: NonNullable<DisplayDecisionEventType>, displayCount: number) => void;
  /**
   * v1.7.6 — Native Display State Bridge. Fired only when the bounded
   * renderer-facing status actually changes (see
   * displayEnforcementStatusesEqual) — never on every poll tick, and
   * never for a POLICY_NOT_READY transition (folded into "OK" by
   * toDisplayEnforcementStatus). This is the UI-blocking signal; it is
   * deliberately a separate callback from onEventType above so the
   * existing integrity-event-reporting semantics are never touched by
   * this addition.
   */
  onDisplayStateChanged?: (status: DisplayEnforcementStatus) => void;
  /** Task A/B — fired whenever this module's own piece of the diagnostic snapshot changes (decision, display count, topology, active target count). main.ts merges this with page-reported context and does its own change comparison before pushing to the panel / appending to the log file. */
  onDiagnosticsChanged?: (snapshot: ReturnType<DisplayEnforcement["getDiagnosticsSnapshot"]>) => void;
};

export class DisplayEnforcement {
  private enforcementState: SecureClientEnforcementState = INITIAL_SECURE_CLIENT_ENFORCEMENT_STATE;
  private lastHandledAtMs: number | null = null;
  private previousDecision: DisplayDecision | null = null;
  private previousDisplayCount: number | null = null;
  private previousTopology: WindowsDisplayTopologyClassification | null = null;
  private previousActiveTargetCount: number | null = null;
  /** v1.7.6 — the last bounded status pushed/returned via the Native Display State Bridge. Distinct from previousDecision above: this is the folded (POLICY_NOT_READY -> OK), renderer-facing shape, tracked separately so a duplicate fold never re-fires onDisplayStateChanged. */
  private previousStatus: DisplayEnforcementStatus | null = null;
  /** v1.7.6 — no longer used to position a native overlay (that BrowserWindow no longer exists — see this file's top-of-file doc comment), but the parameter is kept on start()/stop() to avoid an unrelated signature churn across every existing call site (main.ts, tests) for a field this module no longer actually needs. */
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
   * v1.7.4 pre-exam readiness — awaitable counterpart to evaluate(), for
   * the native lockdown activation handshake (main.ts's
   * lockdown:activate-secure-exam-lockdown IPC handler / the preload's
   * activateSecureExamLockdown()). `evaluate()`'s other call sites are
   * all fire-and-forget (`void this.evaluate(...)`) because nothing
   * before v1.7.4 needed to know the RESULT of one specific evaluation —
   * only that the live loop kept running. Activation is different: the
   * caller must know, synchronously with respect to its own IPC
   * response, whether the FRESH check (not a stale cached decision) came
   * back OK or BLOCKED, and if BLOCKED, why. Always bypasses the
   * debounce — an explicit activation check must never be silently
   * dropped for arriving too soon after an unrelated OS event.
   */
  async evaluateNowAndGetDecision(): Promise<DisplayDecision> {
    await this.evaluate({ bypassDebounce: true });
    return this.previousDecision ?? { state: "OK" };
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
    /** v1.7.4 — the specific reason the last decision was BLOCKED (null when OK or never evaluated). See displayEnforcementLogic.ts's DisplayBlockingReason. */
    blockingReason: DisplayBlockingReason | null;
    /** v1.7.6 — field name kept for diagnostic-panel/log continuity; no native overlay BrowserWindow exists any more. Now reports whether the renderer's own display-violation modal should currently be visible (i.e. the folded, POLICY_NOT_READY-excluded bridge status is BLOCKED) — the same student-facing meaning "overlay visible" always had. */
    overlayVisible: boolean;
    lastDisplayCheckAt: string | null;
    lastErrorCode: string | null;
  } {
    return {
      enforcementState: this.enforcementState,
      electronDisplayCount: this.getCurrentDisplayCount(),
      windowsTopologyClassification: this.previousTopology,
      activeWindowsTargetCount: this.previousActiveTargetCount,
      currentDecision: this.previousDecision?.state ?? "OK",
      blockingReason: this.previousDecision?.state === "BLOCKED" ? this.previousDecision.reason : null,
      overlayVisible: this.previousStatus?.state === "BLOCKED",
      lastDisplayCheckAt: this.lastDisplayCheckAtMs != null ? new Date(this.lastDisplayCheckAtMs).toISOString() : null,
      lastErrorCode: this.lastErrorCode,
    };
  }

  /**
   * v1.7.6 — Native Display State Bridge, read-only query. Lets a
   * renderer that just mounted or reloaded pick up an ALREADY-active
   * display violation immediately, instead of only ever learning about
   * state changes going forward (which onDisplayStateChanged alone
   * cannot provide — it only fires on the next transition). Returns the
   * same bounded {state, reason, displayCount} shape pushed by that
   * callback; never EDID, monitor serial numbers, Windows display paths,
   * hardware identifiers, or display names. Falls back to state:"OK"
   * before the very first evaluate() has completed (the brief window
   * between start() being called and its initial, non-debounced
   * evaluation resolving) — the same fail-safe-for-UI-purposes default
   * the native overlay implicitly had (no overlay existed until the
   * first evaluateNow() resolved either).
   */
  getDisplayEnforcementStatus(): DisplayEnforcementStatus {
    return this.previousStatus ?? { state: "OK", reason: null, displayCount: this.getCurrentDisplayCount() };
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

    const nextDecision: DisplayDecision = resolveReadinessGatedDisplayDecision(this.enforcementState, displayCount, classification.classification);

    const eventType = resolveDisplayDecisionEventType({
      previousDecision: this.previousDecision,
      nextDecision,
      previousDisplayCount: this.previousDisplayCount,
      nextDisplayCount: displayCount,
    });

    diagnosticLog("evaluate: decision", {
      enforcementState: this.enforcementState,
      electronDisplayCount: displayCount,
      windowsTopology: classification.classification,
      windowsActiveTargetCount: classification.activeTargetCount,
      nextDecision,
      previousDecision: this.previousDecision,
    });

    // v1.7.6 — Native Display State Bridge. No second, always-on-top
    // trapping BrowserWindow is created for a display-policy violation
    // any more (see this file's top-of-file doc comment for why —
    // physical testing isolated an unrecoverable-screen symptom to that
    // overlay's recovery path; the precise Windows compositor mechanism
    // was never independently established). Student-facing blocking is
    // now entirely renderer-based: toDisplayEnforcementStatus folds
    // POLICY_NOT_READY into "OK" (that transient loading/verification
    // state is handled by the exam page's existing content gate, never a
    // display-violation modal) exactly as isOverlayEligibleBlockingReason
    // used to gate the old overlay. The push is deduped against the last
    // status so repeated/duplicate OS events never produce duplicate UI
    // state for the renderer.
    // The very first evaluation ever (previousStatus still null — this
    // module starts running at app boot, long before any exam page has
    // mounted or registered a listener) only pushes if it is already
    // BLOCKED, mirroring resolveDisplayDecisionEventType's own established
    // "first transition into BLOCKED still fires, first transition into
    // OK does not" convention just below. An initial OK has nothing for a
    // not-yet-listening renderer to usefully receive — a fresh mount/
    // reload instead relies on getDisplayEnforcementStatus()'s read-only
    // query, which is authoritative regardless of whether a push was ever
    // sent.
    const nextStatus = toDisplayEnforcementStatus(nextDecision, displayCount);
    const statusChanged = this.previousStatus ? !displayEnforcementStatusesEqual(this.previousStatus, nextStatus) : nextStatus.state === "BLOCKED";
    if (statusChanged) {
      this.callbacks.onDisplayStateChanged?.(nextStatus);
    }
    this.previousStatus = nextStatus;

    if (eventType) this.callbacks.onEventType?.(eventType, displayCount);

    const changed =
      nextDecision.state !== this.previousDecision?.state ||
      (nextDecision.state === "BLOCKED" && nextDecision.reason !== (this.previousDecision?.state === "BLOCKED" ? this.previousDecision.reason : undefined)) ||
      displayCount !== this.previousDisplayCount ||
      classification.classification !== this.previousTopology ||
      classification.activeTargetCount !== this.previousActiveTargetCount;

    this.previousDecision = nextDecision;
    this.previousDisplayCount = displayCount;
    this.previousTopology = classification.classification;
    this.previousActiveTargetCount = classification.activeTargetCount;

    if (changed) this.callbacks.onDiagnosticsChanged?.(this.getDiagnosticsSnapshot());
  }
}
