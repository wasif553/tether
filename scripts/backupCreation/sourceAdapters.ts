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
 *   project-pinned Supabase CLI's own `supabase db dump --db-url
 *   <passwordless-url>`, invoked directly on the HOST (never inside the
 *   Postgres toolbox container, which does not contain the Supabase CLI
 *   runtime — see scripts/backupCreation/supabaseCliExecutor.ts). **No
 *   `supabase link`, no `--linked`, no `SUPABASE_ACCESS_TOKEN`** — an
 *   earlier version of this adapter used `supabase link
 *   --project-ref <ref>` before dumping, which is not a guaranteed
 *   read-only operation (observed Supabase CLI behaviour includes
 *   issuing `CREATE SCHEMA IF NOT EXISTS supabase_migrations` /
 *   `CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations`
 *   statements as a side effect of linking) and was withdrawn — a
 *   Production database BACKUP tool must not modify Production
 *   migration metadata as a side effect of preparing to read it. The
 *   base commands this module builds below never embed `--db-url` or a
 *   secret themselves (see `DumpStageCommand`'s own doc comment) —
 *   `scripts/backupCreation/supabaseCliExecutor.ts` appends the
 *   PASSWORDLESS `--db-url` (built by
 *   `scripts/backupCreation/supabaseDatabaseUrl.ts`) and a `--workdir`
 *   pointing at a temporary, unlinked-to-the-repo workspace, while the
 *   real source password travels only through that subprocess's own
 *   `PGPASSWORD` environment variable.
 *   This module deliberately does NOT hand-roll a list of
 *   Supabase-reserved roles or internal schemas to strip — that list
 *   belongs to Supabase to define and maintain, and the Supabase CLI is
 *   the authoritative, vendor-tested mechanism for applying it. A raw,
 *   unfiltered `pg_dumpall --roles-only` against a real Supabase project
 *   is NOT equivalent to `supabase db dump --role-only` and must never
 *   be used as the Production Supabase path.
 *
 * **`SUPABASE_MANAGED_PRODUCTION_RUNTIME_TEST: DEFERRED`** — the
 * `supabase-managed` adapter's command construction is unit-tested in
 * `sourceAdapters.test.ts`, and its execution boundary (preflight, init,
 * dump-sequence orchestration, temporary-workspace cleanup) is unit-
 * tested against an injected fake CLI runner in
 * `supabaseCliExecutor.test.ts`. The full mechanism (temporary
 * workspace → `supabase init` → passwordless `--db-url` + `PGPASSWORD`
 * → `db dump`) has additionally been exercised end to end against a
 * **disposable local Postgres container** using this repository's own
 * pinned CLI — see `docs/database-backup-operations-v1.md`'s "Current
 * status" section for `SUPABASE_CLI_DIRECT_RUNTIME_TEST: PASS`. What
 * remains untested is a real **Production Supabase project** — no
 * Production contact is permitted, and this repository does not create
 * or use a sandbox Supabase project. Do not treat either the
 * `local-generic` synthetic exercise or the disposable-Postgres
 * `supabase-managed` runtime test as proof that this adapter works
 * against a real managed Production project's own hosted infrastructure
 * (connection pooling quirks, IPv6-only networking, Supabase-specific
 * schema/role shape, etc.) — both prove the mechanism, neither proves
 * Production compatibility.
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
   * is the BASE Supabase CLI argv only (e.g. `["db", "dump", "-f",
   * <path>, "--role-only"]`) — no `--db-url`, no `--workdir`, no
   * embedded credential; `scripts/backupCreation/supabaseCliExecutor.ts`'s
   * `buildManagedDumpInvocationArgs` appends the PASSWORDLESS `--db-url`
   * and `--workdir` around this base command, and the real password
   * reaches the subprocess only via that subprocess's own `PGPASSWORD`
   * environment variable (see supabaseCliExecutor.ts).
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
 * `outputPath` here is the FINAL host bundle path (e.g.
 * `<bundleDir>/roles.sql`); the CLI writes directly there. These are
 * BASE commands only — no `--db-url`, no `--workdir`, no `--linked`
 * (never used anywhere in this adapter): `supabaseCliExecutor.ts`'s
 * `buildManagedDumpInvocationArgs` appends the passwordless `--db-url`
 * and `--workdir` around whatever this module returns.
 *
 * Flag set mirrors current official Supabase guidance exactly (with
 * `--db-url <passwordless-url> --workdir <temp-workspace>` appended by
 * the executor):
 *   roles.sql:  supabase db dump -f <path> --role-only
 *   schema.sql: supabase db dump -f <path>
 *   data.sql:   supabase db dump -f <path> --data-only --use-copy
 *               -x "storage.buckets_vectors" -x "storage.vector_indexes"
 * Note the vector-table exclusions apply to the DATA dump only — the
 * schema dump intentionally carries no `-x` flags, matching current
 * guidance (a schema-only dump has no data to exclude).
 */
export const supabaseManagedAdapter: SourceAdapter = {
  kind: "supabase-managed",
  executor: "host-supabase-cli",
  rolesDumpCommand(hostOutputPath) {
    return { commandArgs: ["db", "dump", "-f", hostOutputPath, "--role-only"] };
  },
  schemaDumpCommand(_pgSchema, hostOutputPath) {
    // No --schema flag and no -x exclusions: which schemas/tables are
    // included by default for a managed project, and the managed-schema
    // exclusions applied to them, are the Supabase CLI's own decision —
    // not this repository's to second-guess.
    return { commandArgs: ["db", "dump", "-f", hostOutputPath] };
  },
  dataDumpCommand(_pgSchema, hostOutputPath) {
    // --use-copy: current Supabase guidance's recommended data-dump
    // mode (COPY statements rather than individual INSERTs) — faster
    // and more portable for a managed project's own tooling to restore.
    return { commandArgs: ["db", "dump", "-f", hostOutputPath, "--data-only", "--use-copy", ...supabaseExcludeFlags()] };
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
