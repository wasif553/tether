/**
 * Tether Secure Browser — corrective pass v1.2.0, Part 2. Pure
 * classification of a raw Windows display-topology query result into
 * one of the required topology states. Deliberately separated from
 * windowsDisplayTopology.ts (which spawns PowerShell) so this logic runs
 * under plain vitest without Windows, a display, or a child process.
 *
 * Never infers or accepts a monitor serial number, EDID, manufacturer,
 * model, or device path — the raw query result this consumes carries
 * only path/source counts (see RawWindowsTopologyQueryResult below), so
 * there is structurally nothing identifying to leak even by mistake.
 */

export const WINDOWS_TOPOLOGY_CLASSIFICATIONS = [
  "INTERNAL_ONLY",
  "EXTERNAL_ONLY",
  "EXTEND",
  "CLONE_OR_DUPLICATE",
  "MULTIPLE_ACTIVE_TARGETS",
  "UNKNOWN",
  "ERROR",
] as const;
export type WindowsDisplayTopologyClassification = (typeof WINDOWS_TOPOLOGY_CLASSIFICATIONS)[number];

/**
 * `activePathCount` = number of active DISPLAYCONFIG_PATH_INFO entries
 * from QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS); `distinctSourceCount`
 * = number of distinct (adapterId, sourceInfo.id) pairs among them.
 * Windows assigns clone/duplicate targets to the SAME source (one
 * desktop surface driving multiple outputs); Extend assigns each
 * monitor its own distinct source — this is the standard technique for
 * distinguishing the two from QueryDisplayConfig output alone.
 */
export type RawWindowsTopologyQueryResult =
  | { ok: true; activePathCount: number; distinctSourceCount: number }
  | { ok: false; reason: "spawn_failed" | "non_zero_exit" | "parse_failed" | "timeout" };

export type WindowsTopologyClassificationResult = {
  classification: WindowsDisplayTopologyClassification;
  /** Always present when the query itself succeeded (even for UNKNOWN); null only when the query failed outright (ERROR). */
  activeTargetCount: number | null;
};

/**
 * `electronHint.primaryIsInternal` — Electron's own `Display.internal`
 * flag (available on some platforms/Electron versions) for the sole
 * active display, used ONLY to label a single-display result as
 * INTERNAL_ONLY vs EXTERNAL_ONLY. Never required: defaults to `true`
 * (the common laptop-panel baseline) when unavailable, and this default
 * has no effect on the SINGLE_DISPLAY_REQUIRED enforcement decision
 * either way (see isBlockingTopology — neither INTERNAL_ONLY nor
 * EXTERNAL_ONLY ever blocks).
 */
export function classifyWindowsDisplayTopology(
  raw: RawWindowsTopologyQueryResult,
  electronHint: { primaryIsInternal?: boolean } = {},
): WindowsTopologyClassificationResult {
  if (!raw.ok) {
    return { classification: "ERROR", activeTargetCount: null };
  }
  const { activePathCount, distinctSourceCount } = raw;

  // Structurally nonsensical output (negative counts, or more distinct
  // sources than active paths, which is impossible) — the query
  // succeeded but its content cannot be trusted; fail closed to UNKNOWN
  // rather than guess.
  if (activePathCount < 0 || distinctSourceCount < 0 || distinctSourceCount > activePathCount) {
    return { classification: "UNKNOWN", activeTargetCount: activePathCount >= 0 ? activePathCount : null };
  }

  if (activePathCount === 0) {
    // No active display path at all is itself an anomaly for a
    // machine that is, by definition, currently displaying this exam.
    return { classification: "UNKNOWN", activeTargetCount: 0 };
  }

  if (activePathCount === 1) {
    const isInternal = electronHint.primaryIsInternal ?? true;
    return { classification: isInternal ? "INTERNAL_ONLY" : "EXTERNAL_ONLY", activeTargetCount: 1 };
  }

  if (distinctSourceCount === activePathCount) {
    return { classification: "EXTEND", activeTargetCount: activePathCount };
  }

  if (distinctSourceCount === 1) {
    return { classification: "CLONE_OR_DUPLICATE", activeTargetCount: activePathCount };
  }

  // More than one distinct source but fewer than the active path count,
  // and not a single clean clone group — a topology (e.g. 2 sources
  // driving 3 targets) this classifier has no precise name for.
  // Reported as a defensive catch-all rather than guessed at.
  return { classification: "MULTIPLE_ACTIVE_TARGETS", activeTargetCount: activePathCount };
}

/** Whether SINGLE_DISPLAY_REQUIRED must block given this Windows topology classification alone (independent of Electron's own displayCount, which is checked separately). ERROR/UNKNOWN fail closed — "authoritative topology cannot be established for a final exam" must block, never silently pass. */
export function isBlockingTopology(classification: WindowsDisplayTopologyClassification): boolean {
  return (
    classification === "EXTEND" ||
    classification === "CLONE_OR_DUPLICATE" ||
    classification === "MULTIPLE_ACTIVE_TARGETS" ||
    classification === "ERROR" ||
    classification === "UNKNOWN"
  );
}
