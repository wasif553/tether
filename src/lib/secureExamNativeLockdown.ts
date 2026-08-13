/**
 * v1.7.5 P0 — pure decision logic for src/app/student/exams/[id]/page.tsx's
 * native-lockdown reconciliation on mount. See
 * docs/tether-preflight-lifecycle-v1.7.5-policy-not-ready.md.
 *
 * Root cause this exists to fix: the exam content page used to call
 * window.sesLockdown.setSecureClientEnforcementState({active:true,
 * ready:false, ...}) unconditionally on every mount — including when the
 * page was reached via a successful Phase 2 handoff, where native
 * lockdown was ALREADY confirmed ACTIVE+READY moments earlier by
 * tether-launch/page.tsx. That downgraded an already-correct state back
 * to POLICY_NOT_READY, which (pre-fix) produced the screen-saver-level,
 * non-closable native overlay with no Recheck/Exit route — requiring a
 * Windows restart.
 *
 * Deliberately never trusts a client-held boolean as security evidence:
 * `nativeState` must always come from a FRESH query of the Electron main
 * process's own live enforcement state (window.sesLockdown.
 * getSecureClientEnforcementState()) — the same state
 * displayEnforcement.ts's own overlay decision reads, never a second,
 * independently-tracked copy.
 */

export type SecureClientEnforcementNativeState = {
  active: boolean;
  ready: boolean;
  requireSingleDisplay: boolean;
};

/**
 * The steady-state (post-determination) outcomes. Two further states —
 * "still waiting on the policy fetch" and "the policy fetch itself
 * failed" — are page-level concerns layered on top of this (see
 * page.tsx's own ContentGateState), not part of this pure classification.
 */
export const NATIVE_LOCKDOWN_CONFIRMATIONS = ["NOT_APPLICABLE", "CONFIRMED", "REACTIVATION_REQUIRED", "UNSUPPORTED_BUILD"] as const;
export type NativeLockdownConfirmation = (typeof NATIVE_LOCKDOWN_CONFIRMATIONS)[number];

/**
 * `gated` — whether THIS attempt's frozen per-attempt policy requires a
 * secure client (TETHER_CLIENT_REQUIRED) — a non-gated exam never needs
 * any native-lockdown confirmation at all, matching pre-v1.7.5 behaviour
 * exactly.
 *
 * `bridgeAvailable` — whether window.sesLockdown.
 * getSecureClientEnforcementState exists at all. A build old enough to
 * predate this v1.7.5 method (but new enough to have activated native
 * lockdown via the v1.7.4 handshake) cannot be asked whether that
 * lockdown is still genuinely active — fails closed
 * (UNSUPPORTED_BUILD) rather than guessing either way, mirroring
 * tether-launch/page.tsx's own "no fail-open path for a missing
 * security-critical bridge method" convention.
 *
 * `nativeState` — the FRESH result of that query, or null if the query
 * itself could not be completed (e.g. it threw) — treated identically to
 * "not confirmed", never assumed active.
 *
 * `requireSingleDisplay` — THIS attempt's own frozen per-attempt policy
 * requirement (from GET /secure-client/status's displayRequirement,
 * never a live/mutable exam setting). Release-blocking follow-up review
 * — active+ready alone is not sufficient: native lockdown could be
 * genuinely ACTIVE+READY but enforcing a DIFFERENT (weaker) display
 * policy than THIS attempt actually requires (e.g. left over from a
 * prior attempt, or a race with a policy change). The native state is
 * only ever "compatible" when it is at least as strict as required:
 * `requireSingleDisplay: false` (not required) accepts any native
 * value; `requireSingleDisplay: true` (required) demands
 * `nativeState.requireSingleDisplay === true` — never trusted as
 * satisfied merely because active+ready are true.
 */
export function resolveNativeLockdownConfirmation(params: {
  gated: boolean;
  bridgeAvailable: boolean;
  nativeState: SecureClientEnforcementNativeState | null;
  requireSingleDisplay: boolean;
}): NativeLockdownConfirmation {
  if (!params.gated) return "NOT_APPLICABLE";
  if (!params.bridgeAvailable) return "UNSUPPORTED_BUILD";
  if (
    params.nativeState != null &&
    params.nativeState.active &&
    params.nativeState.ready &&
    (!params.requireSingleDisplay || params.nativeState.requireSingleDisplay)
  ) {
    return "CONFIRMED";
  }
  return "REACTIVATION_REQUIRED";
}

/**
 * The full page-level gate state — resolveNativeLockdownConfirmation's
 * four outcomes, plus the two async-lifecycle states around it. Kept as
 * one union so page.tsx has a single source of truth to render from
 * (never two separately-tracked booleans that could disagree).
 */
export const CONTENT_GATE_STATES = ["PENDING", "STATUS_UNAVAILABLE", ...NATIVE_LOCKDOWN_CONFIRMATIONS] as const;
export type ContentGateState = (typeof CONTENT_GATE_STATES)[number];

/**
 * Whether protected question content must currently be withheld.
 * `inLockdownBrowser: false` (an ordinary, non-Tether browser session)
 * always renders — none of this v1.7.5 machinery applies outside Tether,
 * matching pre-v1.7.5 behaviour exactly for STANDARD_WEB/ordinary access.
 */
export function shouldBlockExamContentRendering(inLockdownBrowser: boolean, state: ContentGateState): boolean {
  if (!inLockdownBrowser) return false;
  return state !== "NOT_APPLICABLE" && state !== "CONFIRMED";
}
