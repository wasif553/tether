/**
 * Tether Windows Lockdown Hardening v1 — deterministic development/
 * test-only fault injection (Part 17). Mirrors the web app's own
 * src/lib/tetherFaultInjection.ts convention exactly (see that module's
 * doc comment for the full rationale) — a one-shot, explicitly-armed
 * fault a developer/test sets directly, never anything a real packaged
 * build could stumble into on its own.
 *
 * Gated on `process.env.NODE_ENV !== "production"` — every exported
 * function is a safe no-op when disabled, so this module can be
 * imported unconditionally by production code paths (windowsProcessList.ts,
 * processDetection.ts, lockdownLifecycle usage in main.ts) without any
 * runtime branch of its own at each call site. Callers additionally
 * never wire this in at all inside an `if (app.isPackaged)` branch —
 * belt-and-suspenders, never exposed in a packaged/production build.
 */

export const LOCKDOWN_FAULT_KINDS = [
  "PROCESS_ENUMERATION_TIMEOUT",
  "PROCESS_ENUMERATION_PERMISSION_DENIED",
  "PROCESS_ENUMERATION_MALFORMED_OUTPUT",
  "PROHIBITED_PROCESS_APPEARS",
  "PROHIBITED_PROCESS_DISAPPEARS",
  "RESTORATION_FAILURE",
  "IPC_TIMEOUT",
] as const;
export type LockdownFaultKind = (typeof LOCKDOWN_FAULT_KINDS)[number];

let armedFaults: Partial<Record<LockdownFaultKind, boolean>> = {};

function isEnabled(): boolean {
  return process.env.NODE_ENV !== "production";
}

/** Arms a fault (dev/test only) — a no-op outside dev/test. */
export function armLockdownFault(kind: LockdownFaultKind): void {
  if (!isEnabled()) return;
  armedFaults = { ...armedFaults, [kind]: true };
}

/** One-shot check-and-clear — returns true exactly once per armLockdownFault() call. Always false outside dev/test, and always false if never armed. */
export function consumeLockdownFault(kind: LockdownFaultKind): boolean {
  if (!isEnabled()) return false;
  const armed = armedFaults[kind] === true;
  if (armed) {
    const next = { ...armedFaults };
    delete next[kind];
    armedFaults = next;
  }
  return armed;
}

export function clearAllLockdownFaults(): void {
  armedFaults = {};
}
