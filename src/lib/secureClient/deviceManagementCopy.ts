/**
 * Registered Tether Devices and Revocation UI v1 — student-facing copy.
 * See docs/tether-system-check-v1.md, "Registered devices UI".
 *
 * Pure, dependency-free: no Prisma, no Next.js, no browser APIs. Every
 * internal outcome/reason code this feature can produce (from
 * registerInstallation / revokeInstallation in tetherAttestationRunner.ts)
 * maps to plain, non-technical, non-accusatory student-facing text here —
 * an internal code (e.g. "CHALLENGE_ALREADY_CONSUMED", "LIMIT_REACHED")
 * must never reach the page directly. Never uses "cryptographically
 * genuine device", "trusted hardware", "TPM protected", "tamper-proof",
 * "cheat-proof", "suspicious device", or "compromised device" — see the
 * product-language rules in docs/tether-system-check-v1.md.
 */

export const SOFTWARE_PROTECTED_EXPLANATION =
  "Tether uses an installation-specific key protected by Windows for this user account. This helps identify and revoke individual installations. It is not hardware attestation.";

/** Maps POST /api/tether/installation/register's `reason` field (and a few client-side pre-flight failure codes) to plain student-facing text. Never displays the raw code. */
export function describeRegistrationFailure(code: string, maxActiveInstallations: number): string {
  switch (code) {
    case "LIMIT_REACHED":
      return `You already have ${maxActiveInstallations} of ${maxActiveInstallations} active computers registered. Remove an old computer below before registering this one.`;
    case "RATE_LIMITED":
      return "Too many registration attempts. Wait a few minutes and try again.";
    case "CHALLENGE_ALREADY_CONSUMED":
    case "EXPIRED":
    case "NOT_YET_VALID":
    case "WRONG_AUDIENCE":
    case "WRONG_PUBLIC_KEY":
    case "INVALID_SIGNATURE":
    case "UNSUPPORTED_PROTOCOL_VERSION":
      return "This registration request has expired or was already used. Select \"Register this computer\" to try again.";
    case "WRONG_SUBJECT":
      return "This registration request does not belong to your account. Select \"Register this computer\" to try again.";
    case "PROOF_OF_POSSESSION_INVALID":
      return "This computer's identity could not be verified. Restart Tether Secure Browser and try again.";
    case "DUPLICATE_KEY":
      return "This computer is already registered.";
    case "SECURE_STORAGE_UNAVAILABLE":
      return "Windows secure storage is unavailable on this computer. Restart Tether Secure Browser and try again.";
    case "BRIDGE_UNAVAILABLE":
      return "Your Tether Secure Browser installation is too old to register a computer. Download and install the latest version, then try again.";
    case "NETWORK_ERROR":
      return "Could not reach the server. Check your connection and try again.";
    default:
      return "Something went wrong registering this computer. Try again.";
  }
}

/** Maps POST /api/tether/installation/[id]/revoke's failure reason to plain student-facing text. */
export function describeRevocationFailure(code: string): string {
  switch (code) {
    case "ACTIVE_EXAM_IN_PROGRESS":
      return "This computer cannot be removed while a secure examination is in progress.";
    case "NOT_FOUND":
      return "This computer could not be found. It may have already been removed.";
    case "NETWORK_ERROR":
      return "Could not reach the server. Check your connection and try again.";
    default:
      return "Something went wrong removing this computer. Try again.";
  }
}

export type RevokeConfirmCopy = { title: string; message: string };

/** Exact copy required for the revoke confirmation dialog — differs for the current device vs. any other. */
export function buildRevokeConfirmCopy(isCurrentDevice: boolean): RevokeConfirmCopy {
  if (isCurrentDevice) {
    return {
      title: "Remove access from this computer?",
      message: "Tether will need to register this computer again before it can be used for another secure examination.",
    };
  }
  return {
    title: "Remove this computer's access?",
    message: "This computer will no longer be able to complete Tether system checks or start secure examinations until it is registered again.",
  };
}

/** "2 of 2 active computers" — the exact required summary phrasing. */
export function formatActiveComputersSummary(activeCount: number, maxActiveInstallations: number): string {
  return `${activeCount} of ${maxActiveInstallations} active computers`;
}
