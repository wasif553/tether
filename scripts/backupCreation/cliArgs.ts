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
 * environment or output location — both must be supplied explicitly,
 * and both are validated (`manifestMetadataValidation.ts`), not merely
 * checked for presence. `--environment production` (in ANY case/
 * whitespace variant — "Production", "PRODUCTION", " production " all
 * normalise to the one canonical label "production" before this
 * decision is made) additionally requires a separate, explicit
 * `--confirm-production` flag — this is a deliberate operator
 * acknowledgement, never inferred from the connection string (a
 * non-"production" label is trusted as the operator's own statement).
 */
import { validateEnvironmentLabel, validateSourceProjectRef, isProductionLabel } from "./manifestMetadataValidation";

export type ParsedBackupCreateArgs = {
  execute: boolean;
  /** Raw, as typed by the operator — not yet trimmed/validated. Use the `environment` field on a successful checkBackupCreateExecuteSafety() result for the canonical, validated value. */
  environment: string | null;
  outputDir: string | null;
  confirmProduction: boolean;
  /** Raw, as typed by the operator — not yet validated. */
  sourceProjectRef: string | null;
  pgSchema: string;
  /** "local-generic" | "supabase-managed" | null (null = auto-detect from sourceProjectRef — see sourceAdapters.ts's autoDetectSourceAdapterKind). Not validated here; the caller passes it through to resolveSourceAdapter after checking it's one of the two known values. */
  sourceType: string | null;
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

  const sourceTypeIndex = argv.indexOf("--source-type");
  const sourceType = sourceTypeIndex >= 0 ? (argv[sourceTypeIndex + 1] ?? null) : null;

  return { execute, environment, outputDir, confirmProduction, sourceProjectRef, pgSchema, sourceType };
}

export type BackupCreateExecuteSafetyResult =
  | { ok: true; environment: string | null; sourceProjectRef: string | null }
  | { ok: false; reason: string };

/**
 * Gate applied only when `--execute` is present. A dry run always
 * passes with no validated values (`{ ok: true, environment: null,
 * sourceProjectRef: null }`) — this function's only job is to keep a
 * real backup-creation run from ever starting without an explicit,
 * VALID environment label, output location, and (for Production
 * specifically) a separate explicit acknowledgement. On success for a
 * real `--execute` run, `environment` is always the canonical,
 * trimmed, lowercased label — never the operator's raw casing/
 * whitespace variant — and `sourceProjectRef` is either `null` (not
 * supplied) or the validated, trimmed, lowercased token. Neither an
 * invalid environment label nor an invalid `--source-project-ref` is
 * ever silently accepted or redacted — both cause `--execute` to
 * refuse outright, before any Docker/network action.
 */
export function checkBackupCreateExecuteSafety(parsed: ParsedBackupCreateArgs): BackupCreateExecuteSafetyResult {
  if (!parsed.execute) return { ok: true, environment: null, sourceProjectRef: null };

  const missing: string[] = [];
  if (!parsed.environment) missing.push("--environment <label>");
  if (!parsed.outputDir) missing.push("--output-dir <path>");
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `--execute requires ${missing.join(" and ")} to be supplied explicitly. Run with no arguments for a dry-run explanation.`,
    };
  }

  const environmentResult = validateEnvironmentLabel(parsed.environment);
  if (!environmentResult.ok) {
    return { ok: false, reason: `Invalid --environment: ${environmentResult.reason}.` };
  }
  const environment = environmentResult.value;

  const projectRefResult = validateSourceProjectRef(parsed.sourceProjectRef);
  if (!projectRefResult.ok) {
    return { ok: false, reason: `Invalid --source-project-ref: ${projectRefResult.reason}.` };
  }
  const sourceProjectRef = projectRefResult.value;

  if (parsed.sourceType != null && parsed.sourceType !== "local-generic" && parsed.sourceType !== "supabase-managed") {
    return { ok: false, reason: `Invalid --source-type "${parsed.sourceType}" — must be "local-generic" or "supabase-managed" (or omitted, to auto-detect).` };
  }

  if (isProductionLabel(environment) && !parsed.confirmProduction) {
    return {
      ok: false,
      reason:
        '--environment "production" (in any case/whitespace variant) requires an additional explicit --confirm-production flag. ' +
        "This is a deliberate, separate acknowledgement — never inferred from the connection string or from --environment alone.",
    };
  }

  return { ok: true, environment, sourceProjectRef };
}
