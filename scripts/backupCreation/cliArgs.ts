/**
 * Argument parsing and execute-safety gating for
 * `scripts/create-database-backup.ts`. See
 * docs/database-backup-operations-v1.md.
 *
 * Pure, dependency-free, synchronous — no filesystem, no Docker, no
 * network — so it can be unit-tested without touching either (mirrors
 * scripts/evidenceRetention/cliArgs.ts's own pattern for the same
 * reason).
 *
 * Fail-closed by design: `--execute` never runs with an inferred
 * environment or output location — both must be supplied explicitly.
 * `--environment production` additionally requires a separate,
 * explicit `--confirm-production` flag — this is a deliberate
 * operator acknowledgement, never inferred from the connection string
 * (a non-"production" label is trusted as the operator's own
 * statement).
 */

export type ParsedBackupCreateArgs = {
  execute: boolean;
  environment: string | null;
  outputDir: string | null;
  confirmProduction: boolean;
  sourceProjectRef: string | null;
  pgSchema: string;
};

export function parseBackupCreateArgs(argv: readonly string[]): ParsedBackupCreateArgs {
  const execute = argv.includes("--execute");
  const confirmProduction = argv.includes("--confirm-production");

  const envIndex = argv.indexOf("--environment");
  const environment = envIndex >= 0 ? (argv[envIndex + 1] ?? null) : null;

  const outIndex = argv.indexOf("--output-dir");
  const outputDir = outIndex >= 0 ? (argv[outIndex + 1] ?? null) : null;

  const refIndex = argv.indexOf("--source-project-ref");
  const sourceProjectRef = refIndex >= 0 ? (argv[refIndex + 1] ?? null) : null;

  const schemaIndex = argv.indexOf("--pg-schema");
  const pgSchema = schemaIndex >= 0 ? (argv[schemaIndex + 1] ?? "public") : "public";

  return { execute, environment, outputDir, confirmProduction, sourceProjectRef, pgSchema };
}

export type BackupCreateExecuteSafetyResult = { ok: true } | { ok: false; reason: string };

/**
 * Gate applied only when `--execute` is present. A dry run always
 * passes (`{ ok: true }`) — this function's only job is to keep a real
 * backup-creation run from ever starting without an explicit
 * environment label, output location, and (for Production specifically)
 * a separate explicit acknowledgement.
 */
export function checkBackupCreateExecuteSafety(parsed: ParsedBackupCreateArgs): BackupCreateExecuteSafetyResult {
  if (!parsed.execute) return { ok: true };

  const missing: string[] = [];
  if (!parsed.environment) missing.push("--environment <label>");
  if (!parsed.outputDir) missing.push("--output-dir <path>");
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `--execute requires ${missing.join(" and ")} to be supplied explicitly. Run with no arguments for a dry-run explanation.`,
    };
  }

  if (parsed.environment === "production" && !parsed.confirmProduction) {
    return {
      ok: false,
      reason:
        "--environment production requires an additional explicit --confirm-production flag. " +
        "This is a deliberate, separate acknowledgement — never inferred from the connection string or from --environment alone.",
    };
  }

  return { ok: true };
}
