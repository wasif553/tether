/**
 * Tether Secure Exam Recovery and Resilient Autosave v1 — deterministic
 * development/test-only fault injection (Part 17). See
 * docs/tether-secure-resume-recovery-v1.md.
 *
 * Gated on `process.env.NODE_ENV !== "production"` — Next.js inlines
 * NODE_ENV at build time, and it is "production" for BOTH Preview and
 * Production builds on Vercel (see .env.example's own note on this) — so
 * this is deliberately MORE conservative than "never in Production
 * alone": it is unreachable in Preview too, never just development. Every
 * exported function is a safe no-op when disabled — this module can be
 * imported unconditionally by production code paths without any runtime
 * branch of its own at each call site.
 *
 * Faults are armed via `window.__sesFaultInjection` (a plain object a
 * developer/test sets directly in devtools or a Playwright/vitest
 * browser-mode script — never a URL parameter, never a cookie, never
 * anything a real student's browser could stumble into) and consumed
 * ONE-SHOT — arming a fault fires it exactly once, then it clears itself,
 * so a test can assert "the first save failed, the retry succeeded"
 * deterministically.
 */

export const FAULT_KINDS = [
  "AUTOSAVE_TIMEOUT",
  "AUTOSAVE_HTTP_500",
  "CONNECTION_OFFLINE",
  "CONNECTION_RESTORED",
  "STALE_AUTOSAVE_RESPONSE",
  "DUPLICATE_AUTOSAVE_REQUEST",
  "FINAL_SUBMIT_TIMEOUT_AFTER_COMMIT",
  "RENDERER_RELOAD",
  "STALE_SECURE_CLIENT_SESSION",
  "EXPIRED_RESUME_CHALLENGE",
] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];

declare global {
  interface Window {
    __sesFaultInjection?: Partial<Record<FaultKind, boolean>>;
  }
}

function isEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && typeof window !== "undefined";
}

/** Arms a fault (dev/test only) — a no-op outside dev/test. */
export function armFault(kind: FaultKind): void {
  if (!isEnabled()) return;
  window.__sesFaultInjection = { ...window.__sesFaultInjection, [kind]: true };
}

/** One-shot check-and-clear — returns true exactly once per armFault() call. Always false outside dev/test, and always false if never armed, so production code paths behave identically whether or not this module is imported. */
export function consumeFault(kind: FaultKind): boolean {
  if (!isEnabled()) return false;
  const armed = window.__sesFaultInjection?.[kind] === true;
  if (armed) {
    const next = { ...window.__sesFaultInjection };
    delete next[kind];
    window.__sesFaultInjection = next;
  }
  return armed;
}

export function clearAllFaults(): void {
  if (!isEnabled()) return;
  window.__sesFaultInjection = {};
}
