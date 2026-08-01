"use client";

/**
 * Registered Tether Devices and Revocation UI v1 — see
 * docs/tether-system-check-v1.md, "Registered devices UI".
 *
 * A usability and account-safety surface, not a new assurance claim:
 * every installation here remains SOFTWARE_PROTECTED (installation-
 * specific key, encrypted at rest via Windows, trust-on-first-use,
 * individually revocable, NOT TPM-attested) — see
 * SOFTWARE_PROTECTED_EXPLANATION in deviceManagementCopy.ts, the single
 * source of truth for that sentence.
 *
 * Reuses the existing installation list/current/register/revoke API
 * surface entirely — no new API routes were added for this page.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { isRunningInLockdownBrowser } from "@/lib/lockdownDetection";
import { buildTetherDashboardDeepLink } from "@/lib/tetherLaunch";
import { assignDeviceLabels } from "@/lib/secureClient/deviceLabels";
import {
  SOFTWARE_PROTECTED_EXPLANATION,
  describeRegistrationFailure,
  describeRevocationFailure,
  buildRevokeConfirmCopy,
  formatActiveComputersSummary,
} from "@/lib/secureClient/deviceManagementCopy";

type InstallationStatus = "ACTIVE" | "REVOKED" | "REPLACED";

type InstallationRow = {
  id: string;
  status: InstallationStatus;
  keyProtectionLevel: string;
  clientVersion: string | null;
  platform: string | null;
  installedAt: string;
  lastAttestedAt: string | null;
  revokedAt: string | null;
};

const REQUEST_TIMEOUT_MS = 8_000;

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const STATUS_LABELS: Record<InstallationStatus, string> = { ACTIVE: "Active", REVOKED: "Revoked", REPLACED: "Removed" };
const STATUS_STYLES: Record<InstallationStatus, string> = {
  ACTIVE: "bg-green-100 text-green-800",
  REVOKED: "bg-gray-100 text-gray-600",
  REPLACED: "bg-gray-100 text-gray-600",
};

export default function TetherDevicesPage() {
  const [inTether, setInTether] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [installations, setInstallations] = useState<InstallationRow[]>([]);
  const [maxActiveInstallations, setMaxActiveInstallations] = useState(2);
  const [currentInstallationId, setCurrentInstallationId] = useState<string | null>(null);
  const [currentLookupFailed, setCurrentLookupFailed] = useState(false);

  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);

  const [revokeTarget, setRevokeTarget] = useState<InstallationRow | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const revokeCancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const lastFocusedElementRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInTether(isRunningInLockdownBrowser());
  }, []);

  const loadList = useCallback(async () => {
    try {
      const res = await withTimeout(fetch("/api/tether/installation/list"), REQUEST_TIMEOUT_MS);
      if (!res.ok) {
        setLoadError("Could not load your registered computers. Try again.");
        return;
      }
      const body: { installations: InstallationRow[]; maxActiveInstallations: number } = await res.json();
      setInstallations(body.installations);
      setMaxActiveInstallations(body.maxActiveInstallations);
      setLoadError(null);
    } catch {
      setLoadError("Could not reach the server. Check your connection and try again.");
    }
  }, []);

  const loadCurrentDevice = useCallback(async (tether: boolean) => {
    if (!tether || typeof window.sesLockdown?.ensureInstallationKey !== "function") {
      setCurrentInstallationId(null);
      setCurrentLookupFailed(false);
      return;
    }
    try {
      const keyInfo = await withTimeout(window.sesLockdown.ensureInstallationKey(), REQUEST_TIMEOUT_MS);
      if (!keyInfo?.hasKey || !keyInfo.publicKey) {
        setCurrentInstallationId(null);
        setCurrentLookupFailed(true);
        return;
      }
      const res = await withTimeout(
        fetch("/api/tether/installation/current", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ publicKey: keyInfo.publicKey }),
        }),
        REQUEST_TIMEOUT_MS,
      );
      if (!res.ok) {
        setCurrentLookupFailed(true);
        return;
      }
      const body: { installation: { id: string } | null } = await res.json();
      setCurrentInstallationId(body.installation?.id ?? null);
      setCurrentLookupFailed(false);
    } catch {
      setCurrentInstallationId(null);
      setCurrentLookupFailed(true);
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    await Promise.all([loadList(), loadCurrentDevice(inTether === true)]);
    setLoading(false);
  }, [loadList, loadCurrentDevice, inTether]);

  useEffect(() => {
    if (inTether === null) return; // wait for detection to run once
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inTether]);

  const activeCount = installations.filter((i) => i.status === "ACTIVE").length;
  const limitReached = activeCount >= maxActiveInstallations;
  const currentRow = installations.find((i) => i.id === currentInstallationId) ?? null;
  const labels = assignDeviceLabels(installations, currentInstallationId);
  const activeRows = installations.filter((i) => i.status === "ACTIVE");
  const removedRows = installations.filter((i) => i.status !== "ACTIVE");

  async function registerCurrentComputer() {
    if (registering || limitReached) return;
    setRegistering(true);
    setRegisterError(null);
    try {
      if (typeof window.sesLockdown?.ensureInstallationKey !== "function" || typeof window.sesLockdown?.signRegistrationProof !== "function") {
        setRegisterError(describeRegistrationFailure("BRIDGE_UNAVAILABLE", maxActiveInstallations));
        return;
      }
      const keyInfo = await withTimeout(window.sesLockdown.ensureInstallationKey(), REQUEST_TIMEOUT_MS).catch(() => null);
      if (!keyInfo?.hasKey || !keyInfo.publicKey) {
        setRegisterError(describeRegistrationFailure("SECURE_STORAGE_UNAVAILABLE", maxActiveInstallations));
        return;
      }

      const challengeRes = await withTimeout(
        fetch("/api/tether/installation/registration-challenge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ publicKey: keyInfo.publicKey }),
        }),
        REQUEST_TIMEOUT_MS,
      ).catch(() => null);
      if (!challengeRes?.ok) {
        setRegisterError(describeRegistrationFailure("NETWORK_ERROR", maxActiveInstallations));
        return;
      }
      const { challenge, signature: challengeSignature } = await challengeRes.json();

      const proof = await withTimeout(window.sesLockdown.signRegistrationProof(challenge.nonce), REQUEST_TIMEOUT_MS).catch(() => null);
      if (!proof) {
        setRegisterError(describeRegistrationFailure("PROOF_OF_POSSESSION_INVALID", maxActiveInstallations));
        return;
      }

      const registerRes = await withTimeout(
        fetch("/api/tether/installation/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            challenge,
            challengeSignature,
            publicKey: proof.publicKey ?? keyInfo.publicKey,
            keyAlgorithm: proof.keyAlgorithm ?? keyInfo.keyAlgorithm,
            keyProtectionLevel: proof.keyProtectionLevel ?? keyInfo.keyProtectionLevel,
            proofOfPossessionSignature: proof.signature,
            clientVersion: window.sesLockdown?.version ?? null,
            platform: null,
          }),
        }),
        REQUEST_TIMEOUT_MS,
      ).catch(() => null);
      if (!registerRes) {
        setRegisterError(describeRegistrationFailure("NETWORK_ERROR", maxActiveInstallations));
        return;
      }
      const registerBody = await registerRes.json().catch(() => null);
      if (!registerRes.ok || !registerBody?.registered) {
        const reason = typeof registerBody?.reason === "string" ? registerBody.reason : "UNKNOWN";
        setRegisterError(describeRegistrationFailure(reason, maxActiveInstallations));
        return;
      }

      setSuccessMessage("This computer is now registered.");
      await refresh();
    } finally {
      setRegistering(false);
    }
  }

  function openRevokeDialog(row: InstallationRow) {
    lastFocusedElementRef.current = document.activeElement as HTMLElement | null;
    setRevokeError(null);
    setRevokeTarget(row);
  }

  function closeRevokeDialog() {
    setRevokeTarget(null);
    setRevokeError(null);
    lastFocusedElementRef.current?.focus?.();
  }

  useEffect(() => {
    if (revokeTarget) revokeCancelButtonRef.current?.focus();
  }, [revokeTarget]);

  async function confirmRevoke() {
    if (!revokeTarget || revoking) return; // guards against duplicate clicks
    setRevoking(true);
    setRevokeError(null);
    try {
      const res = await withTimeout(
        fetch(`/api/tether/installation/${revokeTarget.id}/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "Removed by student" }),
        }),
        REQUEST_TIMEOUT_MS,
      ).catch(() => null);
      if (!res) {
        setRevokeError(describeRevocationFailure("NETWORK_ERROR"));
        return;
      }
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const reason = typeof body?.reason === "string" ? body.reason : res.status === 404 ? "NOT_FOUND" : "UNKNOWN";
        setRevokeError(describeRevocationFailure(reason));
        return;
      }
      // Server confirmed — only now does the UI update (never optimistic).
      setRevokeTarget(null);
      setSuccessMessage("This computer's access has been removed.");
      lastFocusedElementRef.current?.focus?.();
      await refresh();
    } finally {
      setRevoking(false);
    }
  }

  const currentComputerStatus = (() => {
    if (inTether === false) return "Not running in Tether Secure Browser.";
    if (inTether === null) return "Checking…";
    if (currentLookupFailed) return "This computer's registration status could not be checked. Try again.";
    if (currentRow) return "This computer is registered and active.";
    return "This computer is not yet registered.";
  })();

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-semibold">Registered Tether computers</h1>
      <p className="mt-2 text-sm text-gray-600">Manage computers that have been registered for secure examinations.</p>

      <div className="mt-4 rounded border border-gray-200 bg-gray-50 p-3 text-sm">
        <p className="font-medium">{formatActiveComputersSummary(activeCount, maxActiveInstallations)}</p>
        <p className="mt-1 text-gray-600">Maximum allowed: {maxActiveInstallations}</p>
        <p className="mt-1 text-gray-600">{currentComputerStatus}</p>
        <p className="mt-2 text-xs text-gray-500">
          Removing a computer does not delete any exam submissions or results — it only stops that computer from
          starting or continuing a secure examination until it is registered again.
        </p>
        <p className="mt-2 text-xs text-gray-500">{SOFTWARE_PROTECTED_EXPLANATION}</p>
      </div>

      <div role="status" aria-live="polite" className="sr-only">
        {successMessage}
      </div>
      {successMessage && (
        <div className="mt-3 rounded border border-green-200 bg-green-50 p-2 text-sm text-green-800">{successMessage}</div>
      )}

      {inTether === false && (
        <div className="mt-4 rounded border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
          <p>Open Tether Secure Browser on this computer to register it or check its status.</p>
          <a href={buildTetherDashboardDeepLink()} className="mt-2 inline-block rounded bg-black px-3 py-1.5 text-sm text-white">
            Open Tether Secure Browser
          </a>
        </div>
      )}

      {inTether === true && !currentRow && !currentLookupFailed && (
        <div className="mt-4 rounded border border-gray-200 p-3">
          {limitReached ? (
            <p className="text-sm text-gray-700">{describeRegistrationFailure("LIMIT_REACHED", maxActiveInstallations)}</p>
          ) : (
            <>
              <p className="text-sm text-gray-700">This computer is not yet registered for secure examinations.</p>
              <button
                type="button"
                onClick={() => void registerCurrentComputer()}
                disabled={registering}
                className="mt-2 rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50"
              >
                {registering ? "Registering…" : "Register this computer"}
              </button>
            </>
          )}
          {registerError && (
            <p role="alert" className="mt-2 text-sm text-red-600">
              {registerError}
            </p>
          )}
        </div>
      )}

      {loading && <p className="mt-6 text-gray-500">Loading…</p>}

      {!loading && loadError && (
        <div className="mt-6 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <p>{loadError}</p>
          <button type="button" onClick={() => void refresh()} className="mt-2 rounded border border-gray-300 px-3 py-1 text-sm text-gray-800">
            Retry
          </button>
        </div>
      )}

      {!loading && !loadError && installations.length === 0 && (
        <p className="mt-6 text-sm text-gray-500">No computers have been registered yet.</p>
      )}

      {!loading && !loadError && activeRows.length > 0 && (
        <ul className="mt-6 space-y-3">
          {activeRows.map((row) => (
            <DeviceCard
              key={row.id}
              row={row}
              label={labels[row.id] ?? "Windows computer"}
              isCurrent={row.id === currentInstallationId}
              onRemove={() => openRevokeDialog(row)}
            />
          ))}
        </ul>
      )}

      {!loading && !loadError && removedRows.length > 0 && (
        <details className="mt-6 rounded border border-gray-200">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-gray-700">
            Previously removed ({removedRows.length})
          </summary>
          <ul className="space-y-3 border-t border-gray-200 p-3">
            {removedRows.map((row) => (
              <li key={row.id} className="rounded border border-gray-200 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-600">{labels[row.id] ?? "Computer"}</span>
                  <span className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLES[row.status]}`}>{STATUS_LABELS[row.status]}</span>
                </div>
                <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-gray-500">
                  <dt>Registered</dt>
                  <dd>{formatDate(row.installedAt)}</dd>
                  <dt>Last used</dt>
                  <dd>{formatDate(row.lastAttestedAt)}</dd>
                  <dt>Removed</dt>
                  <dd>{formatDate(row.revokedAt)}</dd>
                </dl>
              </li>
            ))}
          </ul>
        </details>
      )}

      {revokeTarget &&
        (() => {
          const isCurrent = revokeTarget.id === currentInstallationId;
          const copy = buildRevokeConfirmCopy(isCurrent);
          return (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
              onKeyDown={(e) => {
                if (e.key === "Escape") closeRevokeDialog();
              }}
            >
              <div
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="revoke-dialog-title"
                aria-describedby="revoke-dialog-message"
                className="w-full max-w-sm rounded border border-gray-300 bg-white p-5 shadow-lg"
              >
                <p id="revoke-dialog-title" className="text-base font-semibold">
                  {copy.title}
                </p>
                <p id="revoke-dialog-message" className="mt-2 text-sm text-gray-700">
                  {copy.message}
                </p>
                {revokeError && (
                  <p role="alert" className="mt-2 text-sm text-red-600">
                    {revokeError}
                  </p>
                )}
                <div className="mt-4 flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={() => void confirmRevoke()}
                    disabled={revoking}
                    className="rounded bg-red-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
                  >
                    {revoking ? "Removing…" : "Remove access"}
                  </button>
                  <button
                    ref={revokeCancelButtonRef}
                    type="button"
                    onClick={closeRevokeDialog}
                    disabled={revoking}
                    className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-800 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

      <div className="mt-6 flex justify-between">
        <Link href="/student" className="text-sm underline">
          Return to dashboard
        </Link>
        <Link href="/student/system-check" className="text-sm underline">
          Check this computer
        </Link>
      </div>
    </div>
  );
}

function DeviceCard({
  row,
  label,
  isCurrent,
  onRemove,
}: {
  row: InstallationRow;
  label: string;
  isCurrent: boolean;
  onRemove: () => void;
}) {
  return (
    <li className="rounded border border-gray-200 p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">
          {label}
          {isCurrent && <span className="ml-2 rounded bg-blue-100 px-2 py-0.5 text-xs font-normal text-blue-800">This computer</span>}
        </span>
        <span className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLES[row.status]}`}>{STATUS_LABELS[row.status]}</span>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-gray-500">
        <dt>Operating system</dt>
        <dd>{row.platform === "win32" ? "Windows" : (row.platform ?? "Unknown")}</dd>
        <dt>Tether version</dt>
        <dd>{row.clientVersion ?? "Unknown"}</dd>
        <dt>Registered</dt>
        <dd>{formatDate(row.installedAt)}</dd>
        <dt>Last used</dt>
        <dd>{formatDate(row.lastAttestedAt)}</dd>
      </dl>
      <p className="mt-2 text-xs text-gray-500">Software-protected installation identity ({row.keyProtectionLevel === "SOFTWARE_PROTECTED" ? "Windows-protected key" : row.keyProtectionLevel})</p>
      <button
        type="button"
        onClick={onRemove}
        className="mt-3 rounded border border-red-300 px-3 py-1 text-sm text-red-700"
        aria-label={`Remove access for ${label}`}
      >
        Remove access
      </button>
    </li>
  );
}
