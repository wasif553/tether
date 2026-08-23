/**
 * Production Database Backup Creation v1 — see
 * docs/database-backup-operations-v1.md.
 *
 * Static regression guard over source/documentation content (mirrors
 * src/lib/pilotUiTerminology.test.ts's own pattern: read real files on
 * disk, normalise line-wrapping where needed, assert on
 * substrings/regex). Locks the safety/scope boundaries from this pass
 * so a future edit can't silently reintroduce a restore capability,
 * automatic scheduling, or a premature "gate closed" claim.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

const createBackupSource = read("scripts/create-database-backup.ts");
const packageJson = read("package.json");
const operationsDoc = read("docs/database-backup-operations-v1.md");
const operationsDocFlat = operationsDoc.replace(/\s+/g, " ");
const drRunbook = read("docs/backup-and-disaster-recovery-runbook-v1.md");
const drRunbookFlat = drRunbook.replace(/\s+/g, " ");

describe("[15] backup creation contains no restore capability", () => {
  it("scripts/create-database-backup.ts never calls a restore function", () => {
    expect(createBackupSource).not.toMatch(/pg_restore/i);
    expect(createBackupSource).not.toMatch(/runRestoreRehearsal|runBundleRestoreRehearsal/);
  });

  it("its only mention of --restore is a doc-comment reference to the SEPARATE verification tool, not its own capability", () => {
    const restoreMentions = createBackupSource.match(/--restore\b/g) ?? [];
    expect(restoreMentions.length).toBeLessThanOrEqual(1);
    if (restoreMentions.length === 1) {
      expect(createBackupSource).toMatch(/npm run backup:verify --restore/);
    }
  });

  it("the operations doc states this tool has no restore capability of any kind", () => {
    expect(operationsDocFlat).toMatch(/This tool creates backups only\. It has no restore capability of any\s+kind/i);
  });
});

describe("[16] Storage-object bytes are explicitly outside database-backup scope", () => {
  it("scripts/create-database-backup.ts's own dry-run output says so", () => {
    expect(createBackupSource).toMatch(/does NOT create a backup of Supabase Storage object bytes/i);
  });

  it("the operations doc states a database backup never contains Storage API object bytes", () => {
    expect(operationsDocFlat).toMatch(/a database backup — whether created by this tool, `supabase db dump`, or plain\s+`pg_dump` — never contains Storage API object bytes/i);
  });
});

describe("[17] no scheduling/automatic execution is introduced", () => {
  it("package.json defines backup:create as a plain npm script, not a scheduled/cron job", () => {
    const scripts = JSON.parse(packageJson).scripts as Record<string, string>;
    expect(scripts["backup:create"]).toBe("tsx scripts/create-database-backup.ts");
    expect(scripts["backup:verify-bundle"]).toBe("tsx scripts/verify-backup-bundle.ts");
    // No script name anywhere suggests a scheduler/cron invoking backup:create automatically.
    for (const [name, command] of Object.entries(scripts)) {
      if (name === "backup:create") continue;
      expect(command).not.toMatch(/create-database-backup/);
    }
  });

  it("no application source code (outside scripts/) references create-database-backup.ts", () => {
    // A grep-equivalent check: nothing under src/ imports or invokes this script.
    const srcDir = path.join(REPO_ROOT, "src");
    function walk(dir: string): string[] {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      let matches: string[] = [];
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) matches = matches.concat(walk(full));
        else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
          const content = fs.readFileSync(full, "utf8");
          if (content.includes("create-database-backup")) matches.push(full);
        }
      }
      return matches;
    }
    expect(walk(srcDir)).toEqual([]);
  });

  it("the operations doc states this tool is never invoked automatically", () => {
    expect(operationsDocFlat).toMatch(/\*\*It does not schedule anything\.\*\* `npm run backup:create` is never\s+invoked automatically by this repository/i);
  });
});

describe("[18] off-project gate remains open", () => {
  it("the operations doc explicitly marks the off-project copy gate OPEN", () => {
    expect(operationsDoc).toMatch(/\*\*PRE-PILOT OFF-PROJECT COPY GATE: OPEN\*\*/);
  });

  it("the DR runbook's status table also marks it OPEN, not selected/verified", () => {
    expect(drRunbookFlat).toMatch(/OFF-PROJECT COPY: NOT YET SELECTED \/ VERIFIED/i);
  });

  it("never claims an off-project destination has been chosen", () => {
    expect(operationsDoc).not.toMatch(/off-project (copy )?(destination|location) (has been|is) (selected|chosen|configured)/i);
  });
});

describe("[19] RPO/RTO remain uncommitted", () => {
  it("the DR runbook's RPO/RTO table still shows all four metrics as not committed", () => {
    for (const metric of ["Database RPO", "Database RTO", "Evidence RPO", "Full-service RTO"]) {
      expect(drRunbook).toMatch(new RegExp(`\\| ${metric} \\| \\*\\*NOT YET CONTRACTUALLY COMMITTED OR VERIFIED\\*\\*`));
    }
  });

  it("the operations doc does not commit a backup cadence (RPO)", () => {
    expect(operationsDocFlat).toMatch(/\*\*No contractual RPO is committed by this document\.\*\*/i);
    expect(operationsDoc).toMatch(/\*\*PRE-PILOT BACKUP CADENCE DECISION: OPEN\*\*/);
  });

  it("only mentions 'daily backups are guaranteed' as an explicit negation, never as a claim", () => {
    expect(operationsDocFlat).toMatch(/does not state "daily backups are guaranteed,"/i);
    expect(operationsDoc).not.toMatch(/^(?!.*does not state).*daily backups are guaranteed/im);
  });
});

describe("[20] product-name/release-metadata files are not modified by this task", () => {
  it("apps/lockdown/src/shared.ts still identifies as v1.7.6, unchanged", () => {
    const shared = read("apps/lockdown/src/shared.ts");
    expect(shared).toMatch(/LOCKDOWN_VERSION = "1\.7\.6"/);
  });

  it("src/lib/tetherReleaseMetadata.ts still identifies the release candidate as v1.7.4, unchanged", () => {
    const releaseMetadata = read("src/lib/tetherReleaseMetadata.ts");
    expect(releaseMetadata).toMatch(/CURRENT_RELEASE_CANDIDATE_VERSION = "1\.7\.4"/);
  });

  it("docs/tether-release-management.md still identifies v1.7.2 as the release candidate, unchanged", () => {
    const releaseManagementDoc = read("docs/tether-release-management.md");
    expect(releaseManagementDoc).toMatch(/\*\*Where v1\.7\.2 sits today:\*\* RELEASE CANDIDATE/);
  });
});

describe("no secret-looking values appear in the new backup-creation source or docs", () => {
  const FORBIDDEN = [/SUPABASE_SERVICE_ROLE_KEY\s*=\s*\S/i, /DATABASE_URL\s*=\s*postgres/i, /BACKUP_SOURCE_DATABASE_URL\s*=\s*postgres/i, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];
  for (const [name, content] of [
    ["scripts/create-database-backup.ts", createBackupSource],
    ["docs/database-backup-operations-v1.md", operationsDoc],
  ] as const) {
    it(`${name} contains no secret-looking assigned values`, () => {
      for (const pattern of FORBIDDEN) {
        expect(content).not.toMatch(pattern);
      }
    });
  }
});

describe("[TETHER_DATABASE_BACKUP_OPERATIONALISATION_FINAL_HARDENING] documentation reflects the actual hardened mechanism", () => {
  it("documents that the source password is never in the host subprocess argv, and describes the bare-name -e forwarding mechanism", () => {
    expect(operationsDocFlat).toMatch(/Source password is never in this process's own subprocess argument\s+list/i);
    expect(operationsDocFlat).toMatch(/docker exec -e PGPASSWORD \.\.\.` \(the bare variable\s+NAME, no `=value`\)/i);
  });

  it("documents Production-confirmation casing/whitespace normalisation", () => {
    expect(operationsDocFlat).toMatch(/"Production", "PRODUCTION", " production ",\s+"production " all normalise \(trim \+\s+lowercase\) to the one canonical label "production"/i);
  });

  it("documents the local-generic vs supabase-managed source-adapter split and the deferred Supabase Production runtime-test status", () => {
    expect(operationsDoc).toMatch(/## Source adapters — local\/generic vs\. Supabase-managed/);
    expect(operationsDocFlat).toMatch(/\*\*`SUPABASE_MANAGED_PRODUCTION_RUNTIME_TEST: DEFERRED`\*\*/);
  });

  it("documents that raw pg_dumpall is not used for the Supabase-managed path", () => {
    expect(operationsDocFlat).toMatch(/a raw, unfiltered `pg_dumpall --roles-only` against a real\s+Supabase project is not equivalent to `supabase db dump --role-only`\s+and must never be used as the Production Supabase path/i);
  });

  it("documents --use-copy for the Supabase-managed data dump", () => {
    expect(operationsDocFlat).toMatch(/--data-only --use-copy/);
  });

  it("documents the manifest metadata validation correction (allowlist, not type-level, non-secret guarantee)", () => {
    expect(operationsDocFlat).toMatch(/This\s+is enforced by validation, not merely by the field types being\s+`string`/i);
  });

  it("the manifest module's own doc comment reflects the same correction", () => {
    const manifestSource = read("scripts/backupCreation/backupBundleManifest.ts");
    expect(manifestSource).toMatch(/This module's own types do NOT, by themselves, prevent a secret/i);
    expect(manifestSource).toMatch(/from ending up in this manifest/i);
    expect(manifestSource).toMatch(/validated against a strict ALLOWLIST/i);
  });
});

describe("[TETHER_DATABASE_BACKUP_OPERATIONALISATION_FINAL_HARDENING] no hand-rolled Supabase reserved-role list", () => {
  it("the source adapter module explicitly states it does not hand-roll reserved-role/schema exclusions", () => {
    const sourceAdaptersSource = read("scripts/backupCreation/sourceAdapters.ts");
    expect(sourceAdaptersSource).toMatch(/This module deliberately does NOT hand-roll a/i);
    expect(sourceAdaptersSource).toMatch(/Supabase-reserved roles or internal schemas to strip/i);
  });
});

describe("[TETHER_DATABASE_BACKUP_SUPABASE_MANAGED_RUNTIME_CORRECTION] the supabase-managed adapter is a genuinely separate, host-level execution mechanism", () => {
  const supabaseCliExecutorSource = read("scripts/backupCreation/supabaseCliExecutor.ts");
  const packageJsonParsed = JSON.parse(packageJson) as { devDependencies?: Record<string, string> };

  it("the Supabase CLI is a pinned devDependency, never an unpinned npx download", () => {
    expect(packageJsonParsed.devDependencies?.supabase).toBeTruthy();
    expect(packageJsonParsed.devDependencies!.supabase).not.toMatch(/^\^|~/);
    expect(supabaseCliExecutorSource).toMatch(/never an unpinned `npx supabase`/i);
  });

  it("[1][2] the local-generic adapter still uses the postgres toolbox, and supabase-managed does not run inside it", () => {
    expect(createBackupSource).toMatch(/executor === "postgres-toolbox"/);
    expect(supabaseCliExecutorSource).toMatch(/never inside the/i);
    expect(supabaseCliExecutorSource).toMatch(/`postgres:16-alpine` toolbox container/);
  });

  it("documents the temporary, unlinked-to-the-repo Supabase CLI workspace and its unconditional cleanup", () => {
    expect(supabaseCliExecutorSource).toMatch(/OUTSIDE this repository/);
    expect(supabaseCliExecutorSource).toMatch(/workspace is removed/i);
    expect(supabaseCliExecutorSource).toMatch(/unconditionally \(`finally`\)/i);
  });
});

describe("[TETHER_DATABASE_BACKUP_READ_ONLY_SUPABASE_CORRECTION] supabase link removed — read-only, passwordless --db-url + PGPASSWORD design", () => {
  const supabaseCliExecutorSource = read("scripts/backupCreation/supabaseCliExecutor.ts");
  const sourceAdaptersSource = read("scripts/backupCreation/sourceAdapters.ts");
  const supabaseDatabaseUrlSource = read("scripts/backupCreation/supabaseDatabaseUrl.ts");

  it("[1][2] no source file constructs a literal '--linked' or 'link' argv array element — the precise 'no link subcommand ever reaches the runner' guarantee is proven at runtime by supabaseCliExecutor.test.ts and sourceAdapters.test.ts's array-level checks; this only guards against a re-introduced literal argv token", () => {
    for (const [name, content] of [
      ["scripts/create-database-backup.ts", createBackupSource],
      ["scripts/backupCreation/sourceAdapters.ts", sourceAdaptersSource],
      ["scripts/backupCreation/supabaseCliExecutor.ts", supabaseCliExecutorSource],
    ] as const) {
      expect(content, `${name} must not construct a "--linked" argv array element`).not.toMatch(/"--linked"/);
      expect(content, `${name} must not construct a "link" argv array element`).not.toMatch(/"link"/);
    }
  });

  it("documents 'No supabase link. No --linked.' as an explicit design statement", () => {
    expect(supabaseCliExecutorSource).toMatch(/READ-ONLY BY CONSTRUCTION — NO `supabase link`/);
    expect(operationsDocFlat).toMatch(/\*\*No\s+`supabase link`\. No `--linked`\. No `SUPABASE_ACCESS_TOKEN`\.\*\*/);
  });

  it("documents why supabase link was removed (not guaranteed read-only)", () => {
    expect(supabaseCliExecutorSource).toMatch(/not a guaranteed\s+read-only operation/i);
    expect(supabaseCliExecutorSource).toMatch(/CREATE SCHEMA IF NOT EXISTS supabase_migrations/);
  });

  it("[3] no SUPABASE_ACCESS_TOKEN or separate SUPABASE_DB_PASSWORD is read from the environment any more (the code no longer checks either)", () => {
    expect(supabaseCliExecutorSource).not.toMatch(/process\.env\.SUPABASE_ACCESS_TOKEN/);
    expect(supabaseCliExecutorSource).not.toMatch(/process\.env\.SUPABASE_DB_PASSWORD/);
    expect(operationsDocFlat).toMatch(/No\s+`SUPABASE_ACCESS_TOKEN` and no separate\s+`SUPABASE_DB_PASSWORD`/i);
  });

  it("[5][6] documents that the real password reaches the CLI only via PGPASSWORD, never --db-url or a CLI flag", () => {
    expect(supabaseCliExecutorSource).toMatch(/PGPASSWORD/);
    expect(supabaseCliExecutorSource).toMatch(/never as a CLI flag \(`--password`\/`-p` would put the value/i);
  });

  it("[7][8] the passwordless-URL builder module documents its allowlist design", () => {
    expect(supabaseDatabaseUrlSource).toMatch(/Allowlist, not denylist/i);
    expect(supabaseDatabaseUrlSource).toMatch(/passfile[\s\S]*servicefile/);
  });

  it("the operations doc documents --db-url and the corrected -x exclusion flag (not --exclude-table as a used flag)", () => {
    expect(operationsDocFlat).toMatch(/supabase db dump --db-url <passwordless-url> --workdir <tmp> -f <path> --role-only/);
    expect(operationsDocFlat).toMatch(/-x "storage\.buckets_vectors" -x "storage\.vector_indexes"/);
    expect(operationsDoc).not.toMatch(/--exclude-table 'storage/);
  });

  it("[9][10] the operations doc documents Docker checked before any remote operation", () => {
    expect(operationsDocFlat).toMatch(/Docker is installed and \(2\)\s+its daemon is running/i);
    expect(operationsDocFlat).toMatch(/must fail BEFORE any remote/i);
  });

  it("[11] the operations doc documents supabase init runs before any dump", () => {
    expect(operationsDocFlat).toMatch(/supabase init --force --yes --workdir <dir>/);
  });

  it("[19] the execution boundary module documents the exact allowed subcommand set (init, db dump) and no others", () => {
    expect(supabaseCliExecutorSource).toMatch(/It never invokes `link`, `db push`, `db/);
    expect(supabaseCliExecutorSource).toMatch(/pull`, `db reset`, `migration repair`, `migration up`, `config push`,/);
    expect(supabaseCliExecutorSource).toMatch(/`projects create`\/`delete`, or any Storage-mutating command/);
  });

  it("the DR runbook documents the read-only correction and remains SUPABASE_MANAGED_PRODUCTION_RUNTIME_TEST: DEFERRED", () => {
    expect(drRunbookFlat).toMatch(/Read-only correction \(`supabase link` removed\)/i);
    expect(drRunbookFlat).toMatch(/This\s+remains `SUPABASE_MANAGED_PRODUCTION_RUNTIME_TEST: DEFERRED`/i);
  });

  it("the operations doc's Current status table uses the exact required status labels", () => {
    expect(operationsDoc).toMatch(/\*\*DATABASE BACKUP CREATION TOOLING\*\* \| \*\*IMPLEMENTED\*\*/);
    expect(operationsDoc).toMatch(/\*\*LOCAL-GENERIC END-TO-END\*\* \| \*\*VERIFIED\*\*/);
    expect(operationsDoc).toMatch(/\*\*PINNED SUPABASE CLI DIRECT DUMP PATH\*\* \| \*\*VERIFIED AGAINST DISPOSABLE LOCAL POSTGRES\*\*/);
    expect(operationsDoc).toMatch(/\*\*SUPABASE MANAGED PRODUCTION RUNTIME\*\* \| \*\*NOT YET EXECUTED\*\*/);
    expect(operationsDoc).toMatch(/\*\*PRODUCTION BACKUP\*\* \| \*\*NOT YET EXECUTED\*\*/);
    expect(operationsDoc).toMatch(/\*\*OFF-PROJECT COPY\*\* \| \*\*OPEN\*\*/);
    expect(operationsDoc).toMatch(/\*\*BACKUP CADENCE\*\* \| \*\*OPEN\*\*/);
    expect(operationsDoc).toMatch(/\*\*RPO\/RTO\*\* \| \*\*UNCOMMITTED\*\*/);
  });

  it("SUPABASE_CLI_DIRECT_RUNTIME_TEST: PASS is stated, distinct from the still-deferred Production runtime test", () => {
    expect(operationsDocFlat).toMatch(/SUPABASE_CLI_DIRECT_RUNTIME_TEST: PASS/);
    expect(operationsDocFlat).toMatch(/SUPABASE_MANAGED_PRODUCTION_RUNTIME_TEST: DEFERRED/);
  });
});
