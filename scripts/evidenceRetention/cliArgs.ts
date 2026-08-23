/**
 * Argument parsing and execute-safety gating for
 * `scripts/run-evidence-retention.ts`. See
 * docs/evidence-retention-operations-v1.md and
 * docs/privacy-and-evidence-retention-v1.md, Section 20.
 *
 * Pure, dependency-free, synchronous — no Prisma, no filesystem, no
 * network — so it can be unit-tested without a database (mirrors
 * scripts/releaseValidation/dbSafetyGuard.ts's own pattern).
 *
 * Fail-closed by design: `--execute` must never fall back to a default
 * retention period or run deployment-wide. Both `--institution-id` and
 * `--retention-days` must be supplied explicitly, and `--institution-id
 * all` is rejected outright — a deployment-wide destructive execution is
 * not supported by this v1 CLI. Dry runs have no such restriction: an
 * operator may preview with neither flag (deployment-wide, fallback
 * retention window), either flag alone, or both.
 */

export type ParsedEvidenceRetentionArgs = {
  execute: boolean;
  /** Only set when a valid positive number followed --retention-days. */
  retentionDays?: number;
  /** Only set when a value followed --institution-id (not yet validated against "all"). */
  institutionId?: string;
};

export function parseEvidenceRetentionArgs(args: readonly string[]): ParsedEvidenceRetentionArgs {
  const execute = args.includes("--execute");

  const retentionDaysArgIndex = args.indexOf("--retention-days");
  const rawRetentionDays = retentionDaysArgIndex >= 0 ? args[retentionDaysArgIndex + 1] : undefined;
  const parsedRetentionDays = rawRetentionDays != null ? Number(rawRetentionDays) : NaN;
  const retentionDays = Number.isFinite(parsedRetentionDays) && parsedRetentionDays > 0 ? parsedRetentionDays : undefined;

  const institutionIdArgIndex = args.indexOf("--institution-id");
  const rawInstitutionId = institutionIdArgIndex >= 0 ? args[institutionIdArgIndex + 1] : undefined;
  const institutionId = rawInstitutionId != null && rawInstitutionId.trim().length > 0 ? rawInstitutionId.trim() : undefined;

  return { execute, retentionDays, institutionId };
}

export type ExecuteSafetyResult = { ok: true } | { ok: false; reason: string };

/**
 * Gate applied only when `--execute` is present. Dry runs always pass
 * (`{ ok: true }`) — this function's only job is to keep a destructive
 * run from ever silently defaulting to deployment-wide scope or a
 * fallback retention window.
 */
export function checkExecuteSafety(parsed: ParsedEvidenceRetentionArgs): ExecuteSafetyResult {
  if (!parsed.execute) return { ok: true };

  const missing: string[] = [];
  if (!parsed.institutionId) missing.push("--institution-id <institutionId>");
  if (parsed.retentionDays == null) missing.push("--retention-days <positive integer>");

  if (missing.length > 0) {
    return {
      ok: false,
      reason:
        `--execute requires ${missing.join(" and ")} to be supplied explicitly. ` +
        "A deployment-wide destructive run using a default retention period is not supported by this CLI.",
    };
  }

  if (parsed.institutionId!.toLowerCase() === "all") {
    return {
      ok: false,
      reason:
        '--execute does not accept --institution-id "all". A deployment-wide destructive run is not ' +
        "supported by this CLI — pass the specific institution id to scope this sweep to.",
    };
  }

  return { ok: true };
}
