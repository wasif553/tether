"use client";

/**
 * Tether Windows Lockdown Hardening v1, Part 3 — the "close applications
 * before continuing" preflight gate. See
 * docs/tether-windows-lockdown-hardening-v1.md.
 *
 * v1.7.4 pre-exam readiness — generalised from a two-state
 * (BLOCKED/UNAVAILABLE) process-only screen into the one calm, factual
 * PRE-EXAM READINESS remediation screen for EVERY mandatory native
 * preflight check (prohibited applications, remote session, display
 * topology — see tether-launch/page.tsx's runPrecheck). The caller
 * supplies the exact title/message for whichever specific reason
 * failed — this component never invents wording of its own, and never
 * shows a screen-saver-level overlay: this is plain page content,
 * fully leaving Alt+Tab/Task Manager/Windows display settings usable.
 * role="status" aria-live="polite"; no raw executable names, paths, or
 * internal error detail — only each matched capability's own calm
 * displayName (when applicationNames is supplied).
 */

export type LockdownApplicationCheckProps = {
  title: string;
  message: string;
  applicationNames?: string[];
  onCheckAgain: () => void;
  checking: boolean;
};

export function LockdownApplicationCheck({ title, message, applicationNames, onCheckAgain, checking }: LockdownApplicationCheckProps) {
  return (
    <div className="mx-auto mt-16 max-w-md rounded border border-gray-200 p-6 text-center">
      <div role="status" aria-live="polite">
        <h1 className="text-lg font-medium">{title}</h1>
        <p className="mt-3 text-sm text-gray-700">{message}</p>
        {applicationNames && applicationNames.length > 0 && (
          <ul className="mt-3 list-none space-y-1 text-sm font-medium text-gray-900">
            {applicationNames.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        )}
      </div>
      <button
        type="button"
        onClick={onCheckAgain}
        disabled={checking}
        className="mt-5 w-full rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
      >
        {checking ? "Checking…" : "Recheck"}
      </button>
      <a href="/student" className="mt-3 block text-center text-xs text-gray-500 underline">
        Return to dashboard
      </a>
    </div>
  );
}
