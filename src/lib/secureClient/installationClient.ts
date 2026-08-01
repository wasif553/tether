/**
 * Secure Client Attestation v2 — client-side (renderer) installation
 * bootstrap helper. See docs/tether-system-check-v1.md, "Installation
 * registration". Shared by /student/system-check (SYSTEM_CHECK) and the
 * real exam launch flow (EXAM_SESSION, tether-launch/page.tsx) so both
 * purposes register through the exact same sequence rather than two
 * independently-maintained copies.
 *
 * Browser-only (uses fetch/window.sesLockdown) — never imported from a
 * server module.
 */

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

export const INSTALLATION_CLIENT_TIMEOUT_MS = 8_000;

/**
 * Ensures a genuine, server-registered per-installation key exists for
 * THIS device, registering one (first-time-ever, or after a prior
 * revocation) if needed. Returns the installationId to attest with, or
 * null if registration could not be completed. The private key itself
 * never leaves the Electron main process at any point in this flow.
 *
 * Always resolves the local key FIRST (rather than merely asking the
 * server "does this student have any active installation") — with
 * multi-device support (TETHER_MAX_ACTIVE_INSTALLATIONS_PER_USER) a
 * student may have more than one ACTIVE installation at once, and only
 * the one whose public key THIS device actually holds can produce a
 * signature this device is capable of making.
 */
export async function ensureRegisteredInstallation(): Promise<string | null> {
  if (typeof window.sesLockdown?.ensureInstallationKey !== "function" || typeof window.sesLockdown?.signRegistrationProof !== "function") {
    return null;
  }
  const keyInfo = await withTimeout(window.sesLockdown.ensureInstallationKey(), INSTALLATION_CLIENT_TIMEOUT_MS).catch(() => null);
  if (!keyInfo?.hasKey || !keyInfo.publicKey) return null;

  const current = await withTimeout(
    fetch("/api/tether/installation/current", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicKey: keyInfo.publicKey }),
    }),
    INSTALLATION_CLIENT_TIMEOUT_MS,
  )
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  if (current?.installation?.id) return current.installation.id;

  const challengeRes = await withTimeout(
    fetch("/api/tether/installation/registration-challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicKey: keyInfo.publicKey }),
    }),
    INSTALLATION_CLIENT_TIMEOUT_MS,
  ).catch(() => null);
  if (!challengeRes?.ok) return null;
  const { challenge, signature: challengeSignature } = await challengeRes.json();

  const proof = await withTimeout(window.sesLockdown.signRegistrationProof(challenge.nonce), INSTALLATION_CLIENT_TIMEOUT_MS).catch(() => null);
  if (!proof) return null;

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
    INSTALLATION_CLIENT_TIMEOUT_MS,
  ).catch(() => null);
  if (!registerRes?.ok) return null;
  const registerBody = await registerRes.json().catch(() => null);
  return typeof registerBody?.installationId === "string" ? registerBody.installationId : null;
}
