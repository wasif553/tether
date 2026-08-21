#!/usr/bin/env -S npx tsx
/**
 * `npm run evidence:retention -- [--execute] [--retention-days N]` —
 * manual, operator-triggered evidence-retention sweep. See
 * docs/tether-data-and-privacy-register.md and the doc comment on
 * src/lib/evidenceRetentionRunner.ts.
 *
 * Defaults to a DRY RUN — reports what would be deleted without deleting
 * anything. Pass --execute to actually delete. This script is never
 * invoked automatically by anything else in this repo (no cron, no
 * route, no build step) — running it is always a deliberate operator
 * action against whatever DATABASE_URL/evidence-storage configuration is
 * currently in the environment. Running this against Production requires
 * the operator to have deliberately pointed their environment at
 * Production, exactly like any other operational script in this repo
 * (e.g. `npm run seed`) — this script adds no additional safety rail
 * beyond dry-run-by-default, and does NOT attempt to detect or block a
 * Production DATABASE_URL the way release-validate.ts's disposable-only
 * tooling does, because unlike that tooling, this one's entire PURPOSE is
 * to eventually run against a real environment.
 */
import { runEvidenceRetentionSweep, resolveEvidenceRetentionDays } from "../src/lib/evidenceRetentionRunner";

function log(message: string): void {
  console.log(`[evidence:retention] ${message}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");
  const retentionDaysArgIndex = args.indexOf("--retention-days");
  const retentionDaysArg = retentionDaysArgIndex >= 0 ? Number(args[retentionDaysArgIndex + 1]) : undefined;
  const retentionDays = retentionDaysArg && Number.isFinite(retentionDaysArg) && retentionDaysArg > 0 ? retentionDaysArg : undefined;

  log(`Retention window: ${retentionDays ?? resolveEvidenceRetentionDays()} days`);
  log(execute ? "Mode: EXECUTE — matching evidence assets will be permanently deleted." : "Mode: DRY RUN — nothing will be deleted (pass --execute to actually delete).");

  const report = await runEvidenceRetentionSweep({ retentionDays, dryRun: !execute });

  log(`Cutoff: ${report.cutoff.toISOString()}`);
  log(`Evaluated ${report.evaluatedCount} evidence asset(s) captured before the cutoff.`);
  for (const asset of report.eligible) {
    log(`  eligible: ${asset.id} (${asset.kind}, captured ${asset.capturedAt.toISOString()})`);
  }

  if (!execute) {
    log("Dry run complete. Re-run with --execute to actually delete these assets.");
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
