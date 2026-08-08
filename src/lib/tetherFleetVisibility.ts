/**
 * Production administration hardening v1 — Tether version fleet
 * visibility. See docs/tether-broad-rollout-readiness.md.
 *
 * Derives "what Tether versions are actually in use" from the ONE
 * genuinely persisted source: `TetherClientInstallation.clientVersion`
 * (populated at registration, updated on each successful attestation —
 * see registerInstallation/verifySystemCheckAttestation in
 * tetherAttestationRunner.ts). Does NOT touch or change
 * `minimumSupportedTetherVersion()` (systemCheckConfig.ts) — this module
 * only classifies against it, using the exact same `compareVersions`
 * comparator already relied on for real enforcement decisions
 * (src/lib/systemCheck/readiness.ts), never a second, drifting
 * implementation.
 */
import { prisma } from "@/lib/prisma";
import { compareVersions } from "@/lib/systemCheck/readiness";
import { minimumSupportedTetherVersion } from "@/lib/systemCheckConfig";
import { resolveTetherReleaseMetadata } from "@/lib/tetherReleaseMetadata";

export type TetherFleetVersionClassification = "SUPPORTED" | "OUTDATED_BUT_ALLOWED" | "UPDATE_REQUIRED" | "UNKNOWN";

/**
 * Same invariant as resolveTetherCompatibilityState in
 * tetherReleaseMetadata.ts (never UPDATE_REQUIRED unless downloads are
 * actually enabled — an "impossible update loop" must never be reachable
 * from a fleet-visibility view either), intentionally re-derived here
 * rather than imported: that function takes a single reported version
 * and is student-facing; this one classifies a version STRING against
 * the fleet, admin-facing, and must handle unparseable/malformed values
 * distinctly (UNKNOWN) without ever throwing.
 */
export function classifyFleetVersion(clientVersion: string | null, minimumVersion: string, downloadsEnabled: boolean): TetherFleetVersionClassification {
  if (!clientVersion || clientVersion.trim().length === 0) return "UNKNOWN";
  let cmp: number;
  try {
    cmp = compareVersions(clientVersion, minimumVersion);
  } catch {
    return "UNKNOWN";
  }
  if (!Number.isFinite(cmp)) return "UNKNOWN";
  if (cmp >= 0) return "SUPPORTED";
  return downloadsEnabled ? "UPDATE_REQUIRED" : "OUTDATED_BUT_ALLOWED";
}

export type TetherFleetVersionCount = {
  clientVersion: string | null;
  classification: TetherFleetVersionClassification;
  installationCount: number;
};

export type TetherFleetSummary = {
  minimumSupportedVersion: string;
  downloadsEnabled: boolean;
  totalInstallations: number;
  byVersion: TetherFleetVersionCount[];
  byClassification: Record<TetherFleetVersionClassification, number>;
};

/**
 * `institutionId` — when provided, scopes to that institution only
 * (a lecturer/institution-admin-safe view, though this module itself
 * does no authorization — the caller route enforces that). When
 * omitted, aggregates across every institution — callers MUST only do
 * this for a PLATFORM_ADMIN session; this function has no way to enforce
 * that itself and does not try to (authorization is the route's job, not
 * a data-layer concern here — mirrors every other module in this
 * codebase, e.g. institutionWhere()).
 *
 * Counts ACTIVE installations only — a revoked/replaced installation's
 * last-known version is historical noise for "what's currently in use",
 * not current fleet state.
 */
export async function summarizeTetherFleet(institutionId?: string): Promise<TetherFleetSummary> {
  const minimumSupportedVersion = minimumSupportedTetherVersion();
  const downloadsEnabled = resolveTetherReleaseMetadata().downloadsEnabled;

  const grouped = await prisma.tetherClientInstallation.groupBy({
    by: ["clientVersion"],
    where: { status: "ACTIVE", ...(institutionId ? { institutionId } : {}) },
    _count: { _all: true },
  });

  const byVersion: TetherFleetVersionCount[] = grouped
    .map((row) => ({
      clientVersion: row.clientVersion,
      classification: classifyFleetVersion(row.clientVersion, minimumSupportedVersion, downloadsEnabled),
      installationCount: row._count._all,
    }))
    .sort((a, b) => b.installationCount - a.installationCount);

  const byClassification: Record<TetherFleetVersionClassification, number> = {
    SUPPORTED: 0,
    OUTDATED_BUT_ALLOWED: 0,
    UPDATE_REQUIRED: 0,
    UNKNOWN: 0,
  };
  for (const row of byVersion) byClassification[row.classification] += row.installationCount;

  return {
    minimumSupportedVersion,
    downloadsEnabled,
    totalInstallations: byVersion.reduce((sum, row) => sum + row.installationCount, 0),
    byVersion,
    byClassification,
  };
}
