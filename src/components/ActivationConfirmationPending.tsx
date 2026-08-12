"use client";

/**
 * PR #22 release-blocking review, Issue 1 — the dedicated
 * ACTIVATION_CONFIRMATION_PENDING screen. Deliberately NOT
 * LockdownApplicationCheck: every other precheck-failure screen means
 * native lockdown is (or has just been restored to) a known, safe,
 * pre-exam state, so Return to dashboard is always a genuinely safe
 * navigation there. This screen exists for the opposite case —
 * window.sesLockdown.activateSecureExamLockdown() already succeeded
 * (native lockdown is ACTIVE), POST /api/submissions/[id]/activate's own
 * outcome could not be confirmed even after reconciliation retries, and
 * the exam MAY already be genuinely ACTIVE server-side. Offering an
 * ordinary "Return to dashboard" link here would let the student
 * navigate away — unmounting this component — with no way left running
 * to ever resolve the ambiguity or restore native lockdown safely. See
 * tether-launch/page.tsx's ensureSecureActivation and
 * src/lib/tetherLaunch.ts's resolveActivationConfirmationPendingCopy.
 *
 * No overlay (plain page content, same as LockdownApplicationCheck) —
 * Task Manager/Alt+Tab/Windows display settings remain usable. The
 * student's only actions here are Retry (re-attempts the read-only
 * reconciliation check) and closing Tether entirely via the OS (window
 * close / Task Manager / Ctrl+Alt+Delete) — never intercepted by this
 * app — which is covered by main.ts's own unconditional
 * before-quit/window-closed/render-process-gone restoration, a
 * fundamentally different, unavoidable risk category documented
 * separately (closing the client outright is always possible for any
 * locally-installed lockdown client; the server-side authoritative gate,
 * not this native overlay, is what actually protects exam integrity once
 * that happens).
 */

export type ActivationConfirmationPendingProps = {
  title: string;
  message: string;
  retryLabel: string;
  onRetry: () => void;
  checking: boolean;
};

export function ActivationConfirmationPending({ title, message, retryLabel, onRetry, checking }: ActivationConfirmationPendingProps) {
  return (
    <div className="mx-auto mt-16 max-w-md rounded border border-gray-200 p-6 text-center">
      <div role="status" aria-live="polite">
        <h1 className="text-lg font-medium">{title}</h1>
        <p className="mt-3 text-sm text-gray-700">{message}</p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        disabled={checking}
        className="mt-5 w-full rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
      >
        {checking ? "Checking…" : retryLabel}
      </button>
      {/* Deliberately no "Return to dashboard" link — see this
          component's own doc comment above. */}
    </div>
  );
}
