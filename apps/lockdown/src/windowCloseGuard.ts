/**
 * Tether Windows Hardening v1.8.0, Phase A+B — ordinary window-close
 * interception decision. Pure — no Electron dependency — main.ts's own
 * BrowserWindow "close" listener calls this and conditionally calls
 * event.preventDefault().
 *
 * Deliberately reuses lockdownLifecycle's EXISTING "ACTIVE" state rather
 * than adding a new one (per the task's own "do not perform a large
 * refactor merely for cleanliness" instruction) — this is exactly the
 * same state keyboardHardeningLogic.ts's browser-chrome-shortcut
 * blocking already gates on, so a student is never in a position where
 * Alt+F4 is blocked but the taskbar's own "Close window" menu item (or
 * any other path that fires the BrowserWindow's "close" event) is not,
 * or vice versa.
 *
 * While NOT ACTIVE (PREPARING, RESTORING, RESTORED, RESTORE_FAILED):
 * close behaves completely normally — a failed precheck, a finished
 * exam, or any other non-active state must never trap the student (see
 * main.ts's own "v1 never traps the student — closing the window is
 * always allowed" and lockdownLifecycle.ts's crash-safety philosophy).
 */
import type { LockdownLifecycleState } from "./lockdownLifecycle";

export function shouldPreventOrdinaryClose(lifecycleState: LockdownLifecycleState): boolean {
  return lifecycleState === "ACTIVE";
}
