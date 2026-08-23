#!/usr/bin/env -S npx tsx
/**
 * `npm run evidence:retention -- [--execute] [--retention-days N]
 * [--institution-id <id>]` — manual, operator-triggered evidence-
 * retention sweep. See docs/tether-data-and-privacy-register.md and the
 * doc comment on src/lib/evidenceRetentionRunner.ts.
 *
 * Defaults to a DRY RUN — reports what would be deleted without deleting
 * anything. A dry run may target a single institution (--institution-id)
 * or preview deployment-wide, and may omit --retention-days to use the
 * configured fallback (`resolveEvidenceRetentionDays()`).
 *
 * `--execute` is fail-closed: BOTH --institution-id and --retention-days
 * must be supplied explicitly (see scripts/evidenceRetention/cliArgs.ts).
 * There is no deployment-wide destructive path in this CLI — a
 * missing/omitted institution scope, or a missing retention period,
 * always aborts before any deletion is attempted. This is a deliberate
 * v1 safety rail, not the historical behaviour: an earlier version of
 * this script allowed `--execute` alone to delete deployment-wide using
 * the default retention window, which is exactly the destructive-default
 * mismatch this rail closes.
 *
 * This script is never invoked automatically by anything else in this
 * repo (no cron, no route, no build step) — running it is always a
 * deliberate operator action against whatever DATABASE_URL/evidence-
 * storage configuration is currently in the environment. Running this
 * against Production requires the operator to have deliberately pointed
 * their environment at Production, exactly like any other operational
 * script in this repo (e.g. `npm run seed`) — this script's safety rail
 * is scope/argument-based, not a Production-target detector the way
 * release-validate.ts's disposable-only tooling is.
 */
import { runEvidenceRetentionSweep, resolveEvidenceRetentionDays } from "../src/lib/evidenceRetentionRunner";
import { checkExecuteSafety, parseEvidenceRetentionArgs } from "./evidenceRetention/cliArgs";

function log(message: string): void {
  console.log(`[evidence:retention] ${message}`);
}

async function main(): Promise<void> {
  const parsed = parseEvidenceRetentionArgs(process.argv.slice(2));

  const safety = checkExecuteSafety(parsed);
  if (!safety.ok) {
    log(`Refusing to run: ${safety.reason}`);
    log("No deletion was attempted.");
    process.exitCode = 1;
    return;
  }

  const { execute, retentionDays, institutionId } = parsed;

  log(`Retention window: ${retentionDays ?? resolveEvidenceRetentionDays()} days`);
  log(`Scope: ${institutionId ?? "deployment-wide (all institutions)"}`);
  log(execute ? "Mode: EXECUTE — matching evidence assets will be permanently deleted." : "Mode: DRY RUN — nothing will be deleted (pass --execute to actually delete).");

  const report = await runEvidenceRetentionSweep({ retentionDays, dryRun: !execute, institutionId });

  log(`Cutoff: ${report.cutoff.toISOString()}`);
  log(`Evaluated ${report.evaluatedCount} evidence asset(s) captured before the cutoff.`);
  for (const asset of report.eligible) {
    log(`  eligible: ${asset.id} (${asset.kind}, captured ${asset.capturedAt.toISOString()})`);
  }

  if (!execute) {
    log("Dry run complete. Re-run with --execute --institution-id <id> --retention-days <n> to actually delete these assets.");
    process.exitCode = 0;
    return;
  }

  const failed = report.outcomes.filter((o) => !o.ok);
  const succeeded = report.outcomes.filter((o) => o.ok);
  log(`Deleted ${succeeded.length}/${report.outcomes.length} eligible asset(s).`);
  for (const outcome of failed) {
    if (!outcome.ok) log(`  FAILED: ${outcome.id} — ${outcome.error}`);
  }
  process.exitCode = failed.length > 0 ? 1 : 0;
}

main().catch((err) => {
  log(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
