"use client";

/**
 * Tether Windows Lockdown Hardening v1, Part 3 — the "close applications
 * before continuing" preflight gate. See
 * docs/tether-windows-lockdown-hardening-v1.md.
 *
 * Renders one of two required states with the EXACT specified copy —
 * never invents its own wording. `state: "UNAVAILABLE"` (process
 * inspection could not be verified) is deliberately a DIFFERENT screen
 * from `state: "BLOCKED"` (a specific list of applications was found) —
 * "unable to inspect" must never be shown or treated as "nothing
 * found" (Part 3). role="status" aria-live="polite"; no raw
 * executable names, paths, or internal error detail — only each
 * matched capability's own calm displayName.
 */

export type LockdownApplicationCheckProps =
  | { state: "BLOCKED"; applicationNames: string[]; onCheckAgain: () => void; checking: boolean }
  | { state: "UNAVAILABLE"; onCheckAgain: () => void; checking: boolean };

export function LockdownApplicationCheck(props: LockdownApplicationCheckProps) {
  const title = props.state === "BLOCKED" ? "Close applications before continuing" : "Application check could not be completed";
  const message =
    props.state === "BLOCKED"
      ? "Tether found applications that may allow screen sharing, remote access, recording or debugging. Close the listed applications, then check again."
      : "Tether could not verify that prohibited applications are closed. Restart Tether or contact exam support.";

  return (
    <div className="mx-auto mt-16 max-w-md rounded border border-gray-200 p-6 text-center">
      <div role="status" aria-live="polite">
        <h1 className="text-lg font-medium">{title}</h1>
        <p className="mt-3 text-sm text-gray-700">{message}</p>
        {props.state === "BLOCKED" && props.applicationNames.length > 0 && (
          <ul className="mt-3 list-none space-y-1 text-sm font-medium text-gray-900">
            {props.applicationNames.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        )}
      </div>
      <button
        type="button"
        onClick={props.onCheckAgain}
        disabled={props.checking}
        className="mt-5 w-full rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
      >
        {props.checking ? "Checking…" : "Check again"}
      </button>
      <a href="/student" className="mt-3 block text-center text-xs text-gray-500 underline">
        Return to dashboard
      </a>
    </div>
  );
}
