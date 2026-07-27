#!/usr/bin/env -S npx tsx
/**
 * `npm run release:validate` — automated, repeatable reproduction of the
 * manual disposable-database validation workflow. See
 * docs/release-validation.md for the full write-up; this file is the
 * orchestrator only, the actual safety logic lives in
 * scripts/releaseValidation/dbSafetyGuard.ts (unit-tested separately).
 *
 * NEVER reads from, writes to, or modifies the shared Preview/Production
 * Supabase database. Every database-backed stage runs against a
 * throwaway local Docker Postgres container that is created at the start
 * of this run and removed at the end, on success OR failure, and on
 * Ctrl+C/SIGTERM. `.env` / `.env.local` are never opened for writing,
 * and the disposable DATABASE_URL is only ever passed into child-process
 * environments — this process's own `process.env` (and therefore the
 * parent PowerShell session's environment) is never mutated.
 */
import crypto from "node:crypto";
import {
  isDockerInstalled,
  isDockerDaemonRunning,
  findFreeLocalPort,
  startDisposablePostgresContainer,
  removeContainer,
  waitForPostgresReady,
} from "./releaseValidation/docker";
import { requireDisposableDatabaseUrl } from "./releaseValidation/dbSafetyGuard";
import { pushSchemaToDisposableDatabase, seedDisposableDatabase, applyRequiredPartialIndexes, verifyPartialIndexesExist } from "./releaseValidation/disposableSchema";
import { runInherit } from "./releaseValidation/processUtil";

type StageResult = { name: string; ok: boolean; durationMs: number; skipped?: boolean };

const stages: StageResult[] = [];
let containerName: string | null = null;
let cleanedUp = false;

function log(message: string): void {
  console.log(`[release:validate] ${message}`);
}

async function withStage<T>(name: string, fn: () => Promise<T>): Promise<T> {
  log(`▶ ${name}`);
  const startedAt = Date.now();
  try {
    const value = await fn();
    stages.push({ name, ok: true, durationMs: Date.now() - startedAt });
    log(`✓ ${name} (${Date.now() - startedAt}ms)`);
    return value;
  } catch (err) {
    stages.push({ name, ok: false, durationMs: Date.now() - startedAt });
    log(`✗ ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

async function cleanup(): Promise<void> {
  if (cleanedUp) return;
  cleanedUp = true;
  if (!containerName) return;
  log(`Removing disposable container "${containerName}"...`);
  const { removed } = await removeContainer(containerName);
  log(removed ? "Disposable container removed." : "Disposable container was already gone (nothing to remove).");
}

function printSummary(overallOk: boolean): void {
  log("── Summary ──────────────────────────────────────");
  for (const stage of stages) {
    const icon = stage.skipped ? "–" : stage.ok ? "✓" : "✗";
    log(`  ${icon} ${stage.name}${stage.skipped ? " (skipped)" : ` — ${stage.durationMs}ms`}`);
  }
  log(overallOk ? "release:validate PASSED" : "release:validate FAILED");
  log("─────────────────────────────────────────────────");
}

/** Internal test-only escape hatch used to verify cleanup-on-failure — never documented as an operator-facing feature. Unset in normal use. */
function maybeForceFailure(stageName: string): void {
  if (process.env.RELEASE_VALIDATE_FORCE_FAIL_AT === stageName) {
    throw new Error(`Forced failure at stage "${stageName}" (RELEASE_VALIDATE_FORCE_FAIL_AT).`);
  }
}

async function main(): Promise<void> {
  const runId = crypto.randomBytes(6).toString("hex");
  containerName = `tether-release-validate-${runId}`;
  const databaseName = `tether_rv_${runId}`;
  const username = `rv_user_${runId}`;
  const password = crypto.randomBytes(24).toString("base64url");

  await withStage("Docker installed", async () => {
    if (!(await isDockerInstalled())) {
      throw new Error("Docker does not appear to be installed. Install Docker Desktop and try again.");
    }
  });

  await withStage("Docker daemon running", async () => {
    if (!(await isDockerDaemonRunning())) {
      throw new Error("Docker is installed but the daemon is not running. Start Docker Desktop and try again.");
    }
  });

  const hostPort = await withStage("Allocate local port", () => findFreeLocalPort());

  await withStage("Start disposable PostgreSQL container", () =>
    startDisposablePostgresContainer({ containerName: containerName!, runId, databaseName, username, password, hostPort }),
  );

  // Constructed once, in-process only — never written to .env/.env.local,
  // never exported to this process's own process.env, only ever passed
  // via the `env` option of child-process spawns below.
  const disposableDatabaseUrl = `postgresql://${username}:${password}@localhost:${hostPort}/${databaseName}`;

  await withStage("Validate disposable DATABASE_URL safety guard", async () => {
    // Runs unconditionally, before ANY Prisma/psql command — this is the
    // check that would catch a synthetic/accidental Supabase URL.
    requireDisposableDatabaseUrl(disposableDatabaseUrl, hostPort);
  });

  await withStage("Wait for PostgreSQL readiness", () => waitForPostgresReady(disposableDatabaseUrl, 30_000));

  await withStage("Apply Prisma schema (db push)", async () => {
    maybeForceFailure("Apply Prisma schema (db push)");
    await pushSchemaToDisposableDatabase(disposableDatabaseUrl, hostPort, log);
  });

  await withStage("Run synthetic seed (prisma/seed.ts)", async () => {
    maybeForceFailure("Run synthetic seed (prisma/seed.ts)");
    await seedDisposableDatabase(disposableDatabaseUrl, hostPort, log);
  });

  await withStage("Apply required partial indexes", async () => {
    maybeForceFailure("Apply required partial indexes");
    await applyRequiredPartialIndexes(disposableDatabaseUrl, hostPort, log);
    const verification = await verifyPartialIndexesExist(disposableDatabaseUrl);
    const missing = verification.filter((v) => !v.exists);
    if (missing.length > 0) {
      throw new Error(`Partial index verification failed for: ${missing.map((m) => m.name).join(", ")}`);
    }
    for (const v of verification) log(`  confirmed partial index: ${v.name}`);
  });

  const childEnv = { ...process.env, DATABASE_URL: disposableDatabaseUrl };

  await withStage("Run full Vitest suite (against disposable database)", async () => {
    maybeForceFailure("Run full Vitest suite (against disposable database)");
    const result = await runInherit("npm", ["run", "validate:tests"], { env: childEnv });
    if (result.code !== 0) throw new Error(`Vitest suite failed (exit code ${result.code}).`);
  });

  await withStage("Typecheck", async () => {
    maybeForceFailure("Typecheck");
    const result = await runInherit("npm", ["run", "validate:typecheck"], { env: childEnv });
    if (result.code !== 0) throw new Error(`Typecheck failed (exit code ${result.code}).`);
  });

  await withStage("Lint", async () => {
    maybeForceFailure("Lint");
    const result = await runInherit("npm", ["run", "validate:lint"], { env: childEnv });
    if (result.code !== 0) throw new Error(`Lint failed (exit code ${result.code}).`);
  });

  await withStage("Production build", async () => {
    maybeForceFailure("Production build");
    // The disposable container is kept alive through this stage — see
    // docs/release-validation.md, "Build environment" — in case any
    // module touched during Next's build-time page-data collection
    // constructs a Prisma/pg connection object (it does not currently
    // query the database, but this keeps the guarantee cheap and certain
    // rather than assumed).
    const result = await runInherit("npm", ["run", "validate:build"], { env: childEnv });
    if (result.code !== 0) throw new Error(`Build failed (exit code ${result.code}).`);
  });
}

let exiting = false;
async function handleSignal(signal: string): Promise<void> {
  if (exiting) return;
  exiting = true;
  log(`Received ${signal} — cleaning up disposable container before exit...`);
  await cleanup();
  process.exit(signal === "SIGINT" ? 130 : 143);
}
process.on("SIGINT", () => void handleSignal("SIGINT"));
process.on("SIGTERM", () => void handleSignal("SIGTERM"));

main()
  .then(async () => {
    await cleanup();
    printSummary(true);
    process.exitCode = 0;
  })
  .catch(async (err) => {
    log(err instanceof Error ? err.message : String(err));
    await cleanup();
    printSummary(false);
    process.exitCode = 1;
  });
