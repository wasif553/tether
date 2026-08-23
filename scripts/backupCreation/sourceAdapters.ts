/**
 * Production database backup creation v1 — source adapters. See
 * docs/database-backup-operations-v1.md.
 *
 * Pure command-construction logic only — no subprocess execution here.
 * Two adapters:
 *
 * - **`local-generic`**: raw `pg_dump`/`pg_dumpall` against any
 *   ordinary Postgres server. This is what was exercised end to end in
 *   this pass's synthetic local test, and remains appropriate for
 *   local/generic Postgres testing.
 * - **`supabase-managed`**: the Supabase CLI's own `supabase db dump`
 *   command, which applies Supabase's own managed-schema exclusions,
 *   reserved-role filtering, and Storage-vector-table handling
 *   internally. **This module deliberately does NOT hand-roll a list
 *   of Supabase-reserved roles or internal schemas to strip** — that
 *   list belongs to Supabase to define and maintain, and the Supabase
 *   CLI is the authoritative, vendor-tested mechanism for applying it.
 *   A raw, unfiltered `pg_dumpall --roles-only` against a real Supabase
 *   project is NOT equivalent to `supabase db dump --role-only` and
 *   must never be used as the Production Supabase path.
 *
 * **`SUPABASE_MANAGED_SOURCE_RUNTIME_TEST: DEFERRED`** — the
 * `supabase-managed` adapter's command construction is unit-tested in
 * `sourceAdapters.test.ts`, but has never been executed against a real
 * Supabase CLI or a real Supabase project in this pass (no Supabase CLI
 * is available in this development environment, and no Production
 * contact is permitted). Do not treat this pass's successful
 * `local-generic` synthetic exercise as proof that the
 * `supabase-managed` adapter works against a real managed project —
 * it proves bundle mechanics (manifest, hashing, restore rehearsal,
 * atomicity), not Supabase-specific dump semantics.
 */

export type SourceAdapterKind = "local-generic" | "supabase-managed";

export type DumpStageCommand = {
  /**
   * Safe to log in full — no secret value ever appears in this array.
   * For `supabase-managed`, this wraps a STATIC shell string (`sh -c
   * '...'`) that references `$PGUSER`/`$PGPASSWORD`/etc. by name —
   * the shell running inside the (throwaway, single-purpose) toolbox
   * container expands those from its own environment at execution
   * time; see the module doc comment for why this is necessary (the
   * Supabase CLI's `--db-url` flag has no environment-variable-based
   * alternative) and what it does and does not protect against.
   */
  commandArgs: string[];
};

/**
 * Current official Supabase guidance calls out these two Storage
 * vector-related tables for exclusion from an ordinary data dump.
 * **Not verified against a real Supabase CLI in this pass** — flagged
 * here as a single, easy-to-find, easy-to-adjust list rather than
 * scattered through the dump commands, specifically so it can be
 * corrected quickly once verified against a real project. This never
 * claims Storage object BYTES are backed up either way — see
 * docs/database-backup-operations-v1.md's own "What this tooling does
 * NOT do" section, unchanged by this list.
 */
export const SUPABASE_VECTOR_TABLE_EXCLUSIONS: readonly string[] = ["storage.buckets_vectors", "storage.vector_indexes"];

const SUPABASE_DB_URL_SHELL_EXPRESSION = '"postgresql://$PGUSER:$PGPASSWORD@$PGHOST:$PGPORT/$PGDATABASE"';

function supabaseExcludeTableFlags(): string {
  return SUPABASE_VECTOR_TABLE_EXCLUSIONS.map((table) => `--exclude-table '${table}'`).join(" ");
}

export interface SourceAdapter {
  readonly kind: SourceAdapterKind;
  rolesDumpCommand(containerOutputPath: string): DumpStageCommand;
  schemaDumpCommand(pgSchema: string, containerOutputPath: string): DumpStageCommand;
  dataDumpCommand(pgSchema: string, containerOutputPath: string): DumpStageCommand;
}

/**
 * `--schema-only`/`--data-only --schema <name>` scoped to the
 * application's own schema (default "public"); `--clean --if-existing`
 * ["--if-exists"] makes the schema dump idempotent against a fresh
 * target — see create-database-backup.ts's own comment on the
 * equivalent line for the "schema already exists" issue this fixes.
 */
export const localGenericPostgresAdapter: SourceAdapter = {
  kind: "local-generic",
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

export const supabaseManagedAdapter: SourceAdapter = {
  kind: "supabase-managed",
  rolesDumpCommand(containerOutputPath) {
    return { commandArgs: ["sh", "-c", `supabase db dump --role-only --db-url ${SUPABASE_DB_URL_SHELL_EXPRESSION} -f ${containerOutputPath}`] };
  },
  schemaDumpCommand(_pgSchema, containerOutputPath) {
    // `supabase db dump` with neither --role-only nor --data-only dumps
    // schema by default, and applies Supabase's own managed-schema
    // exclusions internally — this adapter deliberately does not pass
    // --schema, since which schemas are included by default for a
    // managed project is Supabase's own tooling's decision, not this
    // repository's. The vector-table exclusions are an explicit,
    // documented addition on top of that default filtering — see
    // SUPABASE_VECTOR_TABLE_EXCLUSIONS above.
    return { commandArgs: ["sh", "-c", `supabase db dump ${supabaseExcludeTableFlags()} --db-url ${SUPABASE_DB_URL_SHELL_EXPRESSION} -f ${containerOutputPath}`] };
  },
  dataDumpCommand(_pgSchema, containerOutputPath) {
    // --use-copy: current Supabase guidance's recommended data-dump
    // mode (COPY statements rather than individual INSERTs) — faster
    // and more portable for a managed project's own tooling to restore.
    return { commandArgs: ["sh", "-c", `supabase db dump --data-only --use-copy ${supabaseExcludeTableFlags()} --db-url ${SUPABASE_DB_URL_SHELL_EXPRESSION} -f ${containerOutputPath}`] };
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
