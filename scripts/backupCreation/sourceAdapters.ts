/**
 * Production database backup creation v1 — source adapters. See
 * docs/database-backup-operations-v1.md.
 *
 * Pure command-construction logic only — no subprocess execution here.
 * Two adapters, each owning both WHICH commands to run and WHICH
 * mechanism actually runs them (`executor`):
 *
 * - **`local-generic`** (`executor: "postgres-toolbox"`): raw
 *   `pg_dump`/`pg_dumpall` run via `docker exec` inside the throwaway
 *   `postgres:16-alpine` toolbox container — this is what was exercised
 *   end to end against synthetic local data, and remains appropriate for
 *   local/generic Postgres testing.
 * - **`supabase-managed`** (`executor: "host-supabase-cli"`): the
 *   project-pinned Supabase CLI's own `supabase db dump --linked`,
 *   invoked directly on the HOST (never inside the Postgres toolbox
 *   container, which does not contain the Supabase CLI runtime — see
 *   scripts/backupCreation/supabaseCliExecutor.ts). `--linked` means the
 *   command never takes a credentialed `--db-url`/connection string as
 *   an argument at all — the CLI resolves the connection itself from a
 *   temporary, previously-`supabase link`-ed local workspace, and
 *   `SUPABASE_ACCESS_TOKEN`/`SUPABASE_DB_PASSWORD` travel only through
 *   that subprocess's own environment (see supabaseCliExecutor.ts).
 *   This module deliberately does NOT hand-roll a list of
 *   Supabase-reserved roles or internal schemas to strip — that list
 *   belongs to Supabase to define and maintain, and the Supabase CLI is
 *   the authoritative, vendor-tested mechanism for applying it. A raw,
 *   unfiltered `pg_dumpall --roles-only` against a real Supabase project
 *   is NOT equivalent to `supabase db dump --role-only` and must never
 *   be used as the Production Supabase path.
 *
 * **`SUPABASE_MANAGED_SOURCE_RUNTIME_TEST: DEFERRED`** — the
 * `supabase-managed` adapter's command construction is unit-tested in
 * `sourceAdapters.test.ts`, and its execution boundary (preflight, link,
 * dump-sequence orchestration, temporary-workspace cleanup) is unit-
 * tested against an injected fake CLI runner in
 * `supabaseCliExecutor.test.ts` — but this pass has never run it against
 * a real Supabase project (no Production contact is permitted, and no
 * disposable/sandbox Supabase project is available in this development
 * environment). Do not treat this pass's successful `local-generic`
 * synthetic exercise as proof that the `supabase-managed` adapter works
 * against a real managed project — it proves bundle mechanics (manifest,
 * hashing, restore rehearsal, atomicity), not Supabase-specific dump
 * semantics or the real Supabase CLI's actual `--linked` connection
 * behaviour.
 */

export type SourceAdapterKind = "local-generic" | "supabase-managed";

/**
 * `postgres-toolbox`: commands run via `docker exec` inside the
 * throwaway Postgres toolbox container — `containerOutputPath` in the
 * builder methods below is a path INSIDE that container.
 * `host-supabase-cli`: commands run directly on the host as the
 * Supabase CLI binary's own argv — `containerOutputPath` is actually the
 * final HOST bundle path (the CLI writes the file there directly; no
 * container, no intermediate copy step).
 */
export type SourceAdapterExecutorKind = "postgres-toolbox" | "host-supabase-cli";

export type DumpStageCommand = {
  /**
   * Safe to log in full — no secret value ever appears in this array,
   * for either adapter. For `local-generic` this is a `pg_dump`/
   * `pg_dumpall` argv, executed via `docker exec` (see
   * dockerExecInvocation.ts for how the PG* connection values reach the
   * subprocess without ever appearing here). For `supabase-managed` this
   * is the Supabase CLI's own argv (e.g. `["db", "dump", "--linked",
   * "-f", <path>, "--role-only"]`) — no `--db-url`, no embedded
   * credential, nothing for a shell to expand; the CLI resolves the
   * connection from the temporary workspace's own `supabase link` state,
   * and reads `SUPABASE_ACCESS_TOKEN`/`SUPABASE_DB_PASSWORD` from its
   * own process environment (see supabaseCliExecutor.ts).
   */
  commandArgs: string[];
};

/**
 * Current official Supabase guidance excludes these two Storage
 * vector-related tables from an ordinary data dump (`-x`/`--exclude`,
 * not `--exclude-table` — that flag does not exist on the current
 * Supabase CLI's `db dump` command; see this module's own tests for the
 * regression guard). **Not verified against a real Supabase CLI/project
 * in this pass** — flagged here as a single, easy-to-find, easy-to-adjust
 * list rather than scattered through the dump commands, specifically so
 * it can be corrected quickly once verified against a real project. This
 * never claims Storage object BYTES are backed up either way — see
 * docs/database-backup-operations-v1.md's own "What this tooling does
 * NOT do" section, unchanged by this list.
 */
export const SUPABASE_VECTOR_TABLE_EXCLUSIONS: readonly string[] = ["storage.buckets_vectors", "storage.vector_indexes"];

function supabaseExcludeFlags(): string[] {
  return SUPABASE_VECTOR_TABLE_EXCLUSIONS.flatMap((table) => ["-x", table]);
}

export interface SourceAdapter {
  readonly kind: SourceAdapterKind;
  readonly executor: SourceAdapterExecutorKind;
  rolesDumpCommand(outputPath: string): DumpStageCommand;
  schemaDumpCommand(pgSchema: string, outputPath: string): DumpStageCommand;
  dataDumpCommand(pgSchema: string, outputPath: string): DumpStageCommand;
}

/**
 * `--schema-only`/`--data-only --schema <name>` scoped to the
 * application's own schema (default "public"); `--clean --if-exists`
 * makes the schema dump idempotent against a fresh target — see
 * create-database-backup.ts's own comment on the equivalent line for the
 * "schema already exists" issue this fixes.
 */
export const localGenericPostgresAdapter: SourceAdapter = {
  kind: "local-generic",
  executor: "postgres-toolbox",
  rolesDumpCommand(containerOutputPath) {
    return { commandArgs: ["pg_dumpall", "--roles-only", "-f", containerOutputPath] };
  },
  schemaDumpCommand(pgSchema, containerOutputPath) {
    return { commandArgs: ["pg_dump", "--schema-only", "--schema", pgSchema, "--clean", "--if-exists", "-f", containerOutputPath] };
  },
  dataDumpCommand(pgSchema, containerOutputPath) {
    return { commandArgs: ["pg_dump", "--data-only", "--schema", pgSchema, "-f", containerOutputPath] };
  },
};

/**
 * `--linked` dumps from whatever project the CLI's current working
 * directory (a temporary workspace — see supabaseCliExecutor.ts) was
 * most recently `supabase link`-ed to — never a `--db-url`/connection
 * string argument. `outputPath` here is the FINAL host bundle path
 * (e.g. `<bundleDir>/roles.sql`); the CLI writes directly there.
 *
 * Flag set mirrors current official Supabase guidance exactly:
 *   roles.sql:  supabase db dump --linked -f <path> --role-only
 *   schema.sql: supabase db dump --linked -f <path>
 *   data.sql:   supabase db dump --linked -f <path> --data-only --use-copy
 *               -x "storage.buckets_vectors" -x "storage.vector_indexes"
 * Note the vector-table exclusions apply to the DATA dump only — the
 * schema dump intentionally carries no `-x` flags, matching current
 * guidance (a schema-only dump has no data to exclude).
 */
export const supabaseManagedAdapter: SourceAdapter = {
  kind: "supabase-managed",
  executor: "host-supabase-cli",
  rolesDumpCommand(hostOutputPath) {
    return { commandArgs: ["db", "dump", "--linked", "-f", hostOutputPath, "--role-only"] };
  },
  schemaDumpCommand(_pgSchema, hostOutputPath) {
    // No --schema flag and no -x exclusions: which schemas/tables are
    // included by default for a managed project, and the managed-schema
    // exclusions applied to them, are the Supabase CLI's own decision —
    // not this repository's to second-guess.
    return { commandArgs: ["db", "dump", "--linked", "-f", hostOutputPath] };
  },
  dataDumpCommand(_pgSchema, hostOutputPath) {
    // --use-copy: current Supabase guidance's recommended data-dump
    // mode (COPY statements rather than individual INSERTs) — faster
    // and more portable for a managed project's own tooling to restore.
    return { commandArgs: ["db", "dump", "--linked", "-f", hostOutputPath, "--data-only", "--use-copy", ...supabaseExcludeFlags()] };
  },
};

export function resolveSourceAdapter(kind: SourceAdapterKind): SourceAdapter {
  return kind === "supabase-managed" ? supabaseManagedAdapter : localGenericPostgresAdapter;
}

/**
 * Auto-detection: a source with a derivable/supplied Supabase project
 * reference is treated as a managed Supabase source by default — this
 * is about which DUMP TOOLING is safe to use (a factual question about
 * the source's own nature), not the `--environment production`
 * confirmation gate, which remains driven solely by the operator's
 * explicit `--environment` label (see cliArgs.ts) and is never
 * inferred here or anywhere else from the connection string.
 */
export function autoDetectSourceAdapterKind(sourceProjectRef: string | null): SourceAdapterKind {
  return sourceProjectRef != null ? "supabase-managed" : "local-generic";
}
