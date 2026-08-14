/**
 * Tether launch/install flow v1 — pure single-display enforcement
 * decision logic. Deliberately free of any Electron import (`electron.screen`
 * cannot run outside the Electron main process, and this repo's test
 * tooling runs under plain vitest/node) — see displayEnforcement.ts for
 * the main-process glue that calls these functions.
 */
import { isBlockingTopology, type WindowsDisplayTopologyClassification } from "./windowsDisplayTopologyClassifier";

export type DisplayEnforcementState = "OK" | "BLOCKED";

/**
 * Requirement 7/8 core decision: BLOCKED whenever the policy requires a
 * single display and more than one is currently connected. `false` for
 * `requireSingleDisplay` always yields OK, regardless of display count —
 * this module never enforces anything the caller hasn't explicitly told
 * it to (the Electron main process has no policy awareness of its own;
 * see displayEnforcement.ts).
 */
export function resolveDisplayEnforcementState(displayCount: number, requireSingleDisplay: boolean): DisplayEnforcementState {
  if (!requireSingleDisplay) return "OK";
  return displayCount > 1 ? "BLOCKED" : "OK";
}

/**
 * Corrective pass v1.2.0, Part 2 — combines Electron's own logical
 * display count (insufficient alone: confirmed by physical testing to
 * continuously report 1 in Windows Duplicate/Clone mode) with the
 * Windows-native topology classification (see
 * windowsDisplayTopologyClassifier.ts). BLOCKED whenever EITHER signal
 * alone would block: Electron count > 1, OR the Windows topology is
 * EXTEND/CLONE_OR_DUPLICATE/MULTIPLE_ACTIVE_TARGETS, OR the topology
 * could not be authoritatively established (ERROR/UNKNOWN — fails
 * closed, never silently passes). This is the ONE function
 * displayEnforcement.ts's evaluate() calls to make the actual
 * block/unblock decision — kept pure and separate from the class so it
 * is directly unit-testable without spawning PowerShell or Electron.
 */
export function resolveCombinedDisplayEnforcementState(
  displayCount: number,
  requireSingleDisplay: boolean,
  topologyClassification: WindowsDisplayTopologyClassification,
): DisplayEnforcementState {
  if (!requireSingleDisplay) return "OK";
  if (displayCount > 1) return "BLOCKED";
  if (isBlockingTopology(topologyClassification)) return "BLOCKED";
  return "OK";
}

/**
 * Corrective pass v1.2.1, Task C — the actual reported root cause: the
 * previous single boolean (`requireSingleDisplay`, defaulting `false`)
 * meant enforcement was silently INACTIVE from window-creation until the
 * hosted page's async `/secure-client/status` fetch resolved and called
 * setDisplayPolicyEnforced(true) — a fail-OPEN gap. A second display
 * already connected during that window (page load, `data` fetch,
 * `status` fetch — plausibly 1-2+ seconds, longer on a slow network)
 * would not be covered even though the exam is a TETHER_CLIENT_REQUIRED
 * exam. This type/function replace that boolean with an explicit
 * three-state contract so "we don't know yet" fails CLOSED, not open.
 *
 * `active` — true whenever the current page is (or is about to become)
 * exam content that this policy might apply to. `false` (dashboard,
 * login, tether-launch acknowledgement screen — see
 * src/app/student/exams/[id]/page.tsx's own-mount effect for exactly
 * when this becomes true) never blocks, regardless of ready/display
 * state — this is what keeps the rest of the app usable.
 *
 * `ready` — true only once the AUTHORITATIVE per-attempt policy has been
 * loaded AND (for TETHER_CLIENT_REQUIRED) a verified secure-client
 * session is confirmed to exist. `active && !ready` always BLOCKS — this
 * is the fail-closed default posture Task C requires ("while the
 * authoritative policy is loading, cover the exam"; "while secure-client
 * verification is incomplete, cover the exam"; a failed/malformed status
 * fetch is also reported as `ready: false` by the page, satisfying
 * "if displayPolicy is missing or invalid, cover the exam").
 *
 * `requireSingleDisplay` — only meaningful once `ready` is true; feeds
 * the existing resolveCombinedDisplayEnforcementState the same as before.
 */
export type SecureClientEnforcementState = {
  active: boolean;
  ready: boolean;
  requireSingleDisplay: boolean;
};

export const INITIAL_SECURE_CLIENT_ENFORCEMENT_STATE: SecureClientEnforcementState = {
  active: false,
  ready: false,
  requireSingleDisplay: false,
};

/**
 * The ONE function displayEnforcement.ts's evaluate() calls to make the
 * actual block/unblock decision as of v1.2.1 — layers the Task C
 * readiness gate on top of the existing (unchanged)
 * resolveCombinedDisplayEnforcementState, so every scenario the v1.2.0
 * tests already cover (Electron count > 1, EXTEND, CLONE_OR_DUPLICATE,
 * ERROR/UNKNOWN topology) is untouched and still reachable once
 * `ready === true`.
 */
export function resolveReadinessGatedDisplayEnforcementState(
  enforcementState: SecureClientEnforcementState,
  displayCount: number,
  topologyClassification: WindowsDisplayTopologyClassification,
): DisplayEnforcementState {
  if (!enforcementState.active) return "OK";
  if (!enforcementState.ready) return "BLOCKED";
  return resolveCombinedDisplayEnforcementState(displayCount, enforcementState.requireSingleDisplay, topologyClassification);
}

// ---------------------------------------------------------------------------
// v1.7.4 pre-exam readiness — display blocking-reason taxonomy. See
// docs/tether-secure-launch-verification-investigation.md, "BLOCKED ==
// ADDITIONAL_DISPLAY_PRESENT" finding. resolveReadinessGatedDisplayEnforcementState
// above collapses THREE structurally different reasons (a still-loading
// readiness gate, a genuine extra display, an inconclusive/failed
// topology query) into one opaque "BLOCKED" — which
// resolveDisplayEnforcementEventType then unconditionally labels
// ADDITIONAL_DISPLAY_PRESENT regardless of which one fired. The functions
// below are a reason-carrying REPLACEMENT decision path (used by
// displayEnforcement.ts going forward); the plain-state functions above
// are kept unchanged for backward compatibility with anything still
// calling them directly (e.g. existing tests), but no longer drive the
// overlay/event-reporting logic.
// ---------------------------------------------------------------------------

export const DISPLAY_BLOCKING_REASONS = [
  /** enforcementState.active && !enforcementState.ready — a normal, transient loading/verification state, NEVER a display fact. Must never be reported as ADDITIONAL_DISPLAY_PRESENT evidence. */
  "POLICY_NOT_READY",
  /** Electron's own screen.getAllDisplays().length > 1 — the one case with the strongest possible evidence of a genuine second display. */
  "ADDITIONAL_ELECTRON_DISPLAY",
  /** Windows-native topology query classified EXTEND (distinct sources per active path). */
  "WINDOWS_TOPOLOGY_EXTEND",
  /** Windows-native topology query classified CLONE_OR_DUPLICATE (one source driving multiple targets). */
  "WINDOWS_TOPOLOGY_CLONE",
  /** Windows-native topology query classified MULTIPLE_ACTIVE_TARGETS (more than one source, fewer sources than targets — a topology with no cleaner name). */
  "MULTIPLE_ACTIVE_TARGETS",
  /** Windows-native topology query returned ERROR or UNKNOWN — fails closed for SINGLE_DISPLAY_REQUIRED, but this is a TECHNICAL inconclusiveness, never proof an additional display exists. */
  "TOPOLOGY_CHECK_UNAVAILABLE",
] as const;
export type DisplayBlockingReason = (typeof DISPLAY_BLOCKING_REASONS)[number];

export type DisplayDecision = { state: "OK" } | { state: "BLOCKED"; reason: DisplayBlockingReason };

/** Reason-carrying counterpart to resolveCombinedDisplayEnforcementState — same decision, but never discards WHY. */
export function resolveCombinedDisplayDecision(
  displayCount: number,
  requireSingleDisplay: boolean,
  topologyClassification: WindowsDisplayTopologyClassification,
): DisplayDecision {
  if (!requireSingleDisplay) return { state: "OK" };
  if (displayCount > 1) return { state: "BLOCKED", reason: "ADDITIONAL_ELECTRON_DISPLAY" };
  if (topologyClassification === "EXTEND") return { state: "BLOCKED", reason: "WINDOWS_TOPOLOGY_EXTEND" };
  if (topologyClassification === "CLONE_OR_DUPLICATE") return { state: "BLOCKED", reason: "WINDOWS_TOPOLOGY_CLONE" };
  if (topologyClassification === "MULTIPLE_ACTIVE_TARGETS") return { state: "BLOCKED", reason: "MULTIPLE_ACTIVE_TARGETS" };
  if (topologyClassification === "ERROR" || topologyClassification === "UNKNOWN") return { state: "BLOCKED", reason: "TOPOLOGY_CHECK_UNAVAILABLE" };
  return { state: "OK" };
}

/** Reason-carrying counterpart to resolveReadinessGatedDisplayEnforcementState — the function displayEnforcement.ts's evaluate() now calls to decide BOTH the block/unblock state and, when BLOCKED, exactly which of the six reasons above caused it. */
export function resolveReadinessGatedDisplayDecision(
  enforcementState: SecureClientEnforcementState,
  displayCount: number,
  topologyClassification: WindowsDisplayTopologyClassification,
): DisplayDecision {
  if (!enforcementState.active) return { state: "OK" };
  if (!enforcementState.ready) return { state: "BLOCKED", reason: "POLICY_NOT_READY" };
  return resolveCombinedDisplayDecision(displayCount, enforcementState.requireSingleDisplay, topologyClassification);
}

/**
 * Student-facing overlay copy per reason — deliberately never claims an
 * additional display exists unless the reason is genuine display
 * evidence (ADDITIONAL_ELECTRON_DISPLAY/WINDOWS_TOPOLOGY_EXTEND/
 * WINDOWS_TOPOLOGY_CLONE/MULTIPLE_ACTIVE_TARGETS). POLICY_NOT_READY and
 * TOPOLOGY_CHECK_UNAVAILABLE use neutral, factual wording that never
 * asserts a fact the evidence doesn't support.
 */
export function displayBlockingReasonCopy(reason: DisplayBlockingReason): { title: string; message: string } {
  switch (reason) {
    case "POLICY_NOT_READY":
      return { title: "Preparing your secure exam session", message: "Please wait — Tether is preparing your secure exam session." };
    case "ADDITIONAL_ELECTRON_DISPLAY":
      return { title: "Additional display connected", message: "Disconnect all additional, mirrored or extended displays to continue." };
    case "WINDOWS_TOPOLOGY_EXTEND":
      return { title: "Extended display detected", message: "An extended display was detected. Disconnect it to continue." };
    case "WINDOWS_TOPOLOGY_CLONE":
      return { title: "Mirrored display detected", message: "A mirrored or duplicated display was detected. Disconnect it to continue." };
    case "MULTIPLE_ACTIVE_TARGETS":
      return { title: "Additional display connected", message: "Disconnect all additional, mirrored or extended displays to continue." };
    case "TOPOLOGY_CHECK_UNAVAILABLE":
      return { title: "Display configuration could not be verified", message: "Tether could not verify the display configuration. Resolve the display check before beginning the examination." };
  }
}

/**
 * Only genuine multi-display evidence may ever produce ADDITIONAL_DISPLAY_PRESENT
 * (or DISPLAY_CONFIGURATION_CHANGED) evidence — POLICY_NOT_READY is not an
 * integrity signal and must never be recorded at all;
 * TOPOLOGY_CHECK_UNAVAILABLE is a technical failure, reported (if at all)
 * as CLIENT_TECHNICAL_FAILURE by the caller — never as a display-presence
 * claim. Mirrors resolveDisplayEnforcementEventType's transition logic
 * (first-time-BLOCKED / still-BLOCKED-but-count-changed / restored-to-OK)
 * but only for reasons backed by real display evidence.
 */
export function isGenuineMultiDisplayReason(reason: DisplayBlockingReason): boolean {
  return (
    reason === "ADDITIONAL_ELECTRON_DISPLAY" ||
    reason === "WINDOWS_TOPOLOGY_EXTEND" ||
    reason === "WINDOWS_TOPOLOGY_CLONE" ||
    reason === "MULTIPLE_ACTIVE_TARGETS"
  );
}

// ---------------------------------------------------------------------------
// v1.7.5 P0 — physical-test failure: a student's exam-content page mount
// re-asserted {active:true, ready:false} on top of an already
// ACTIVE+READY native state (see the exam content page's own fix,
// src/lib/secureExamNativeLockdown.ts), producing a POLICY_NOT_READY
// BLOCKED decision that showOverlay() then rendered as the screen-saver-
// level, non-closable native overlay ("Preparing your secure exam
// session") — with no Recheck/Exit route, requiring a Windows restart.
// POLICY_NOT_READY is a normal, transient loading/verification state,
// NEVER a misconduct condition, and must NEVER be capable of producing
// that overlay, regardless of what caused the readiness gate to reopen.
// This is enforced at the overlay-eligibility layer (not just fixed at
// its one currently-known call site) so no future readiness-gate
// transition can reintroduce this failure mode by a different path.
// ---------------------------------------------------------------------------

export function isOverlayEligibleBlockingReason(reason: DisplayBlockingReason): boolean {
  return reason !== "POLICY_NOT_READY";
}

// ---------------------------------------------------------------------------
// v1.7.6 — Native Display State Bridge. Physical HDMI-disconnect testing
// isolated an unrecoverable-screen symptom (a visual remnant requiring a
// full OS restart to clear) to the second, screen-saver-level
// BrowserWindow created by isOverlayEligibleBlockingReason's caller
// (displayEnforcement.ts's showOverlay/hideOverlay) — the precise
// Windows window/compositor failure mechanism was never independently
// established, only that removing that overlay removes the symptom.
// Detection and decision-making (everything above this point in the
// file) were already correct. The fix replaces that native trapping
// window with a bounded
// state pushed to the renderer, which shows its own React/DOM blur+modal
// instead — see the exam content page's display-violation modal. Nothing
// above this line changes: decision computation, event semantics
// (resolveDisplayDecisionEventType), and diagnostics are untouched.
// ---------------------------------------------------------------------------

/** The renderer-facing reason enum — identical to DisplayBlockingReason minus POLICY_NOT_READY, which this bridge folds into state:"OK" (see toDisplayEnforcementStatus below). */
export type DisplayEnforcementBlockingReason = Exclude<DisplayBlockingReason, "POLICY_NOT_READY">;

/**
 * Bounded, renderer-facing display state — the ONE shape pushed over IPC
 * and returned by the read-only status query. Deliberately excludes
 * everything the page must never see: EDID, monitor serial numbers,
 * Windows display paths, hardware identifiers, or display names.
 * POLICY_NOT_READY is never exposed here — that transient loading/
 * verification state is handled entirely by the exam page's existing
 * secure-activation/content-gate flow and must never become a
 * display-violation modal.
 */
export type DisplayEnforcementStatus = {
  state: "OK" | "BLOCKED";
  reason: DisplayEnforcementBlockingReason | null;
  displayCount: number;
};

export const INITIAL_DISPLAY_ENFORCEMENT_STATUS: DisplayEnforcementStatus = { state: "OK", reason: null, displayCount: 0 };

/** Reshapes a DisplayDecision (+ the display count it was computed from) into the bounded renderer-facing status — the one place POLICY_NOT_READY is folded into OK, via the same isOverlayEligibleBlockingReason test that used to gate the native overlay. */
export function toDisplayEnforcementStatus(decision: DisplayDecision, displayCount: number): DisplayEnforcementStatus {
  if (decision.state !== "BLOCKED") return { state: "OK", reason: null, displayCount };
  if (!isOverlayEligibleBlockingReason(decision.reason)) return { state: "OK", reason: null, displayCount };
  return { state: "BLOCKED", reason: decision.reason as DisplayEnforcementBlockingReason, displayCount };
}

/** True when two statuses carry the same student-facing meaning — used to suppress a duplicate push when repeated OS events (or duplicate debounced ticks) resolve to an identical bounded status, so the renderer never sees duplicate UI state for one real transition. */
export function displayEnforcementStatusesEqual(a: DisplayEnforcementStatus, b: DisplayEnforcementStatus): boolean {
  return a.state === b.state && a.reason === b.reason && a.displayCount === b.displayCount;
}

export type DisplayDecisionEventType = "ADDITIONAL_DISPLAY_PRESENT" | "DISPLAY_CONFIGURATION_CHANGED" | "DISPLAY_POLICY_RESTORED" | "DISPLAY_CHECK_TECHNICAL_FAILURE" | null;

/**
 * Reason-aware replacement for resolveDisplayEnforcementEventType. A
 * transition into BLOCKED for POLICY_NOT_READY produces no event at all
 * (not an integrity signal); a transition into BLOCKED for
 * TOPOLOGY_CHECK_UNAVAILABLE produces DISPLAY_CHECK_TECHNICAL_FAILURE
 * (mapped by the caller to the existing CLIENT_TECHNICAL_FAILURE server
 * event type — never ADDITIONAL_DISPLAY_PRESENT); only the four genuine
 * multi-display reasons ever produce ADDITIONAL_DISPLAY_PRESENT /
 * DISPLAY_CONFIGURATION_CHANGED, exactly mirroring the previous
 * (reason-blind) function's transition shape.
 */
export function resolveDisplayDecisionEventType(params: {
  previousDecision: DisplayDecision | null;
  nextDecision: DisplayDecision;
  previousDisplayCount: number | null;
  nextDisplayCount: number;
}): DisplayDecisionEventType {
  const { previousDecision, nextDecision, previousDisplayCount, nextDisplayCount } = params;
  if (nextDecision.state === "BLOCKED") {
    const wasBlockedSameReason = previousDecision?.state === "BLOCKED" && previousDecision.reason === nextDecision.reason;
    if (nextDecision.reason === "POLICY_NOT_READY") return null;
    if (nextDecision.reason === "TOPOLOGY_CHECK_UNAVAILABLE") {
      return wasBlockedSameReason ? null : "DISPLAY_CHECK_TECHNICAL_FAILURE";
    }
    // Genuine multi-display reason.
    if (!wasBlockedSameReason) return "ADDITIONAL_DISPLAY_PRESENT";
    if (previousDisplayCount !== nextDisplayCount) return "DISPLAY_CONFIGURATION_CHANGED";
    return null;
  }
  // nextDecision.state === "OK" — only report DISPLAY_POLICY_RESTORED when
  // recovering from a genuine multi-display block (never from
  // POLICY_NOT_READY or a technical failure — neither of those were ever
  // reported as a display-presence problem in the first place, so there
  // is nothing display-related to report as "restored").
  if (previousDecision?.state === "BLOCKED" && isGenuineMultiDisplayReason(previousDecision.reason)) return "DISPLAY_POLICY_RESTORED";
  return null;
}

export const DEFAULT_DISPLAY_EVENT_DEBOUNCE_MS = 500;

/**
 * Debounces rapid-fire duplicate display-change events — a single
 * physical plug/unplug, or a display waking from sleep, can fire several
 * `display-added`/`display-removed`/`display-metrics-changed` events in
 * quick succession. Returns true when this event should actually be
 * processed, false when it should be silently ignored because it
 * arrived within `debounceMs` of the last processed event.
 */
export function debounceDisplayEvent(lastHandledAtMs: number | null, nowMs: number, debounceMs: number = DEFAULT_DISPLAY_EVENT_DEBOUNCE_MS): boolean {
  if (lastHandledAtMs == null) return true;
  return nowMs - lastHandledAtMs >= debounceMs;
}

export type DisplayEnforcementEventType = "ADDITIONAL_DISPLAY_PRESENT" | "DISPLAY_CONFIGURATION_CHANGED" | "DISPLAY_POLICY_RESTORED";

/**
 * Decides which (if any) integrity signal should be reported for a
 * transition from `previousState` to `nextState` — mirrors the event
 * taxonomy already defined server-side in
 * src/lib/secureClient/secureClientEvents.ts (SECURE_CLIENT_EVENT_TYPES):
 * ADDITIONAL_DISPLAY_PRESENT the first time enforcement becomes BLOCKED,
 * DISPLAY_CONFIGURATION_CHANGED for a further change while still
 * BLOCKED, DISPLAY_POLICY_RESTORED when returning to OK after having
 * been BLOCKED. Returns null when no report is warranted (state and
 * count both unchanged, or was already OK and remains OK) — this keeps
 * event volume proportional to actual policy-relevant changes, not to
 * every debounced-through OS event.
 */
export function resolveDisplayEnforcementEventType(params: {
  previousState: DisplayEnforcementState | null;
  nextState: DisplayEnforcementState;
  previousDisplayCount: number | null;
  nextDisplayCount: number;
}): DisplayEnforcementEventType | null {
  if (params.nextState === "BLOCKED") {
    if (params.previousState !== "BLOCKED") return "ADDITIONAL_DISPLAY_PRESENT";
    if (params.previousDisplayCount !== params.nextDisplayCount) return "DISPLAY_CONFIGURATION_CHANGED";
    return null;
  }
  if (params.previousState === "BLOCKED") return "DISPLAY_POLICY_RESTORED";
  return null;
}
