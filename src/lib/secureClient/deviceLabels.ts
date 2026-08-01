/**
 * Registered Tether Devices and Revocation UI v1 — friendly, privacy-
 * conscious device labels. See docs/tether-system-check-v1.md,
 * "Registered devices UI".
 *
 * Pure, dependency-free: no Prisma, no Next.js, no browser APIs. Never
 * collects or reads a computer name, Windows account name, serial
 * number, MAC address, or any other hardware identifier — labels are
 * synthesised entirely from data already stored
 * (TetherClientInstallation.platform/installedAt) plus which
 * installation (if any) is the CURRENT device, which the caller must
 * resolve authoritatively server-side (see POST
 * /api/tether/installation/current) before calling this function.
 *
 * Deliberately display-only and derived, not persisted — adding a
 * genuine student-editable label would need a new database column
 * (out of scope for this pass; see "Known limitations"). A label's
 * ordinal is stable across the student's FULL registration history
 * (active AND revoked installations, in chronological registration
 * order) so it never shifts merely because an unrelated older device
 * was later removed.
 */

export type DeviceLabelInput = {
  id: string;
  platform: string | null;
  /** ISO-8601 timestamp, or anything Date.parse can read. */
  installedAt: string;
};

function normalisePlatformName(platform: string | null): string {
  if (!platform) return "Computer";
  const lower = platform.toLowerCase();
  if (lower === "win32" || lower === "windows") return "Windows computer";
  if (lower === "darwin" || lower === "mac" || lower === "macos") return "Mac computer";
  if (lower === "linux") return "Linux computer";
  return "Computer";
}

/**
 * Returns a label for every installation in `installations`, keyed by
 * id. `currentInstallationId` (from the authoritative
 * POST /api/tether/installation/current lookup, or null when not
 * running in Tether / not yet registered) gets the special "Current
 * <platform> computer" form; every other installation gets a stable
 * ordinal ("<platform> computer N") based on its registration order
 * among installations of the SAME platform family, oldest first.
 */
export function assignDeviceLabels(installations: DeviceLabelInput[], currentInstallationId: string | null): Record<string, string> {
  const sorted = [...installations].sort((a, b) => Date.parse(a.installedAt) - Date.parse(b.installedAt));
  const countByPlatform: Record<string, number> = {};
  const labels: Record<string, string> = {};
  for (const installation of sorted) {
    const base = normalisePlatformName(installation.platform);
    const ordinal = (countByPlatform[base] ?? 0) + 1;
    countByPlatform[base] = ordinal;
    labels[installation.id] = installation.id === currentInstallationId ? `Current ${base}` : `${base} ${ordinal}`;
  }
  return labels;
}
