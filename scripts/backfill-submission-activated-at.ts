#!/usr/bin/env -S npx tsx
/**
 * `npm run backfill:activated-at` (verification / dry run — the
 * intended, safe, day-to-day use) or `-- --execute` (emergency-recovery
 * only — see the warning below) for the v1.7.4 pre-exam readiness
 * Submission.activatedAt column. See prisma/schema.prisma's own doc
 * comment on that field.
 *
 * SUPERSEDED AS THE PRIMARY BACKFILL MECHANISM: the real, production
 * backfill now lives INSIDE
 * docs/tether-preflight-lifecycle-v1.7.4-migration.sql (Block 2 — an
 * `UPDATE ... WHERE "activatedAt" IS NULL` run as part of the same
 * manually-applied migration that adds the column — see
 * docs/migration-ledger.md's "Deployment procedure" for that file). That
 * migration is applied BEFORE the v1.7.4 application code is ever
 * deployed (see docs/tether-preflight-lifecycle-v1.7.4.md's "Production
 * rollout order"), so by the time any student can create a genuinely
 * PREPARING (activatedAt IS NULL, intentionally) row, every historical
 * row has already been backfilled by the migration itself — this script
 * is no longer required for that to happen correctly, and deploying
 * v1.7.4 code does NOT depend on anyone remembering to run it.
 *
 * The same migration's Block 3 (`ALTER COLUMN "activatedAt" SET DEFAULT
 * CURRENT_TIMESTAMP`, applied after Block 2) independently protects any
 * NEW row the OLD application code creates during the deploy cutover
 * window — see prisma/schema.prisma's doc comment on this field. This
 * script's role is unaffected by that: it is still read-only
 * verification of the ONE-TIME historical backfill, not a substitute for
 * the ongoing per-insert protection Block 3 provides.
 *
 * This script's remaining, SAFE role is read-only verification: a
 * DRY RUN reports how many rows currently have activatedAt IS NULL —
 * confirming the migration's backfill fully applied (expect 0
 * immediately after migrating, before any v1.7.4-flow attempt exists;
 * a small, growing nonzero count afterwards is normal and simply
 * reflects real PREPARING attempts in progress, not a backfill gap).
 *
 * *** --execute is DANGEROUS once v1.7.4 code is live — read this. ***
 * Once the v1.7.4 application code is deployed, a row with
 * activatedAt IS NULL can mean EITHER "a rare historical row the
 * migration's backfill somehow missed" OR "a genuine, currently in-
 * progress PREPARING attempt whose student has not finished secure
 * activation yet" — this script has NO way to tell those apart, because
 * both look identical in the schema. Running --execute in that state
 * would silently "activate" a real in-progress student's attempt
 * WITHOUT them ever passing through native lockdown confirmation
 * (POST /api/submissions/[id]/activate's own real gate) — exactly the
 * security property v1.7.4 exists to enforce. Only ever run --execute
 * in the narrow, pre-v1.7.4-code-deploy window this script was
 * originally written for (immediately after the migration adds the
 * column, before any student can reach the new Begin-examination flow)
 * — which the migration file's own Block 2 already covers, making a
 * manual --execute run here unnecessary in the first place. Treat
 * --execute as an emergency-recovery tool only, never a routine step.
 *
 * Idempotent and safe to re-run in DRY RUN mode at any time — only ever
 * reports a count, never writes.
 *
 * Never invoked automatically by anything else in this repo (no cron, no
 * build step) — running it is always a deliberate operator action
 * against whatever DATABASE_URL is currently in the environment, exactly
 * like scripts/run-evidence-retention.ts.
 */
import { prisma } from "../src/lib/prisma";

function log(message: string): void {
  console.log(`[backfill:activated-at] ${message}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");

  log(execute ? "Mode: EXECUTE — matching rows will be updated." : "Mode: DRY RUN — nothing will be updated (pass --execute to actually update).");

  const pendingCount = await prisma.submission.count({ where: { activatedAt: null } });
  log(`Rows with activatedAt IS NULL: ${pendingCount}`);

  if (pendingCount === 0) {
    log("Nothing to backfill.");
    process.exitCode = 0;
    return;
  }

  if (!execute) {
    log("Dry run complete. Re-run with --execute to set activatedAt = startedAt for these rows.");
    process.exitCode = 0;
    return;
  }

  const result = await prisma.$executeRaw`UPDATE "Submission" SET "activatedAt" = "startedAt" WHERE "activatedAt" IS NULL`;
  log(`Updated ${result} row(s).`);
  process.exitCode = 0;
}

main()
  .catch((err) => {
    log(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
