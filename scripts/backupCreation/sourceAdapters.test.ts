/**
 * Production Database Backup Creation v1 — see
 * docs/database-backup-operations-v1.md.
 *
 * Unit tests over the pure source-adapter command-construction logic
 * only — no Docker, no subprocess, no Supabase CLI, no Production
 * contact. See sourceAdapters.ts's own doc comment:
 *
 * These tests prove what BASE command (no `--db-url`, no `--workdir`)
 * would be constructed, never that it actually succeeds against a real
 * Supabase CLI/project — see supabaseCliExecutor.test.ts for tests over
 * the execution boundary (preflight, `init`, the FINAL assembled argv
 * including `--db-url`/`--workdir`, dump sequence, temporary-workspace
 * cleanup) with an injected fake CLI runner, and
 * docs/database-backup-operations-v1.md's "Current status" section for
 * the real disposable-Postgres runtime exercise
 * (`SUPABASE_CLI_DIRECT_RUNTIME_TEST: PASS`).
 * SUPABASE_MANAGED_PRODUCTION_RUNTIME_TEST: DEFERRED — none of this
 * proves Production compatibility.
 */
import { describe, expect, it } from "vitest";
import { localGenericPostgresAdapter, supabaseManagedAdapter, resolveSourceAdapter, autoDetectSourceAdapterKind, SUPABASE_VECTOR_TABLE_EXCLUSIONS } from "./sourceAdapters";

describe("localGenericPostgresAdapter", () => {
  it("uses the postgres-toolbox executor", () => {
    expect(localGenericPostgresAdapter.executor).toBe("postgres-toolbox");
  });

  it("roles dump uses raw pg_dumpall --roles-only (appropriate for a generic/local Postgres source)", () => {
    const command = localGenericPostgresAdapter.rolesDumpCommand("/tmp/roles.sql");
    expect(command.commandArgs).toEqual(["pg_dumpall", "--roles-only", "-f", "/tmp/roles.sql"]);
  });

  it("schema dump uses --schema-only --clean --if-exists, scoped to the given schema", () => {
    const command = localGenericPostgresAdapter.schemaDumpCommand("public", "/tmp/schema.sql");
    expect(command.commandArgs).toEqual(["pg_dump", "--schema-only", "--schema", "public", "--clean", "--if-exists", "-f", "/tmp/schema.sql"]);
  });

  it("data dump uses --data-only, scoped to the given schema", () => {
    const command = localGenericPostgresAdapter.dataDumpCommand("public", "/tmp/data.sql");
    expect(command.commandArgs).toEqual(["pg_dump", "--data-only", "--schema", "public", "-f", "/tmp/data.sql"]);
  });
});

describe("[TETHER_DATABASE_BACKUP_SUPABASE_MANAGED_RUNTIME_CORRECTION] supabaseManagedAdapter", () => {
  it("uses the host-supabase-cli executor, never postgres-toolbox", () => {
    expect(supabaseManagedAdapter.executor).toBe("host-supabase-cli");
    expect(supabaseManagedAdapter.executor).not.toBe(localGenericPostgresAdapter.executor);
  });

  it("[14] roles base command is exactly: db dump -f <path> --role-only (no --linked)", () => {
    const command = supabaseManagedAdapter.rolesDumpCommand("/host/bundle/roles.sql");
    expect(command.commandArgs).toEqual(["db", "dump", "-f", "/host/bundle/roles.sql", "--role-only"]);
  });

  it("[15] schema base command is exactly: db dump -f <path> (no exclusion flags, no --linked)", () => {
    const command = supabaseManagedAdapter.schemaDumpCommand("public", "/host/bundle/schema.sql");
    expect(command.commandArgs).toEqual(["db", "dump", "-f", "/host/bundle/schema.sql"]);
  });

  it("[16] data base command includes --data-only and --use-copy", () => {
    const command = supabaseManagedAdapter.dataDumpCommand("public", "/host/bundle/data.sql");
    expect(command.commandArgs).toContain("--data-only");
    expect(command.commandArgs).toContain("--use-copy");
  });

  it("[17] data base command contains -x storage.buckets_vectors and -x storage.vector_indexes", () => {
    const command = supabaseManagedAdapter.dataDumpCommand("public", "/host/bundle/data.sql");
    expect(command.commandArgs).toEqual(["db", "dump", "-f", "/host/bundle/data.sql", "--data-only", "--use-copy", "-x", "storage.buckets_vectors", "-x", "storage.vector_indexes"]);
  });

  it("[18] --exclude-table does NOT appear anywhere in managed command construction", () => {
    for (const command of [supabaseManagedAdapter.rolesDumpCommand("/tmp/roles.sql"), supabaseManagedAdapter.schemaDumpCommand("public", "/tmp/schema.sql"), supabaseManagedAdapter.dataDumpCommand("public", "/tmp/data.sql")]) {
      expect(command.commandArgs.join(" ")).not.toContain("--exclude-table");
    }
  });

  it("never uses raw unfiltered pg_dumpall as the Production Supabase roles path", () => {
    const command = supabaseManagedAdapter.rolesDumpCommand("/tmp/roles.sql");
    expect(command.commandArgs.join(" ")).not.toContain("pg_dumpall");
    expect(command.commandArgs).toEqual(["db", "dump", "-f", "/tmp/roles.sql", "--role-only"]);
  });

  it("never uses raw pg_dump/pg_dumpall for any managed stage", () => {
    for (const command of [supabaseManagedAdapter.rolesDumpCommand("/tmp/roles.sql"), supabaseManagedAdapter.schemaDumpCommand("public", "/tmp/schema.sql"), supabaseManagedAdapter.dataDumpCommand("public", "/tmp/data.sql")]) {
      expect(command.commandArgs.join(" ")).not.toMatch(/\bpg_dump\b/);
      expect(command.commandArgs.join(" ")).not.toMatch(/\bpg_dumpall\b/);
    }
  });

  it("[1][2] never uses --linked and never invokes supabase link — this adapter's own base commands never embed --db-url either (the executor appends it — see supabaseCliExecutor.test.ts for the FINAL assembled argv)", () => {
    for (const command of [supabaseManagedAdapter.rolesDumpCommand("/tmp/roles.sql"), supabaseManagedAdapter.schemaDumpCommand("public", "/tmp/schema.sql"), supabaseManagedAdapter.dataDumpCommand("public", "/tmp/data.sql")]) {
      expect(command.commandArgs).not.toContain("--linked");
      expect(command.commandArgs).not.toContain("link");
      expect(command.commandArgs.join(" ")).not.toContain("--db-url");
      expect(command.commandArgs.join(" ")).not.toContain("postgres://");
      expect(command.commandArgs.join(" ")).not.toContain("postgresql://");
    }
  });

  it("never wraps the invocation in sh -c or references a $PG* shell variable — plain CLI argv, not a shell template", () => {
    for (const command of [supabaseManagedAdapter.rolesDumpCommand("/tmp/roles.sql"), supabaseManagedAdapter.schemaDumpCommand("public", "/tmp/schema.sql"), supabaseManagedAdapter.dataDumpCommand("public", "/tmp/data.sql")]) {
      expect(command.commandArgs[0]).not.toBe("sh");
      expect(command.commandArgs.join(" ")).not.toContain("$PG");
    }
  });

  it("SUPABASE_VECTOR_TABLE_EXCLUSIONS includes the two documented tables", () => {
    expect(SUPABASE_VECTOR_TABLE_EXCLUSIONS).toContain("storage.buckets_vectors");
    expect(SUPABASE_VECTOR_TABLE_EXCLUSIONS).toContain("storage.vector_indexes");
  });

  it("[3] no command ever contains an ACCESS TOKEN or DB PASSWORD env-var name embedded as a literal argv value (they travel only via subprocess environment, never argv, and are no longer required at all)", () => {
    for (const command of [supabaseManagedAdapter.rolesDumpCommand("/tmp/roles.sql"), supabaseManagedAdapter.schemaDumpCommand("public", "/tmp/schema.sql"), supabaseManagedAdapter.dataDumpCommand("public", "/tmp/data.sql")]) {
      expect(command.commandArgs.join(" ")).not.toContain("SUPABASE_ACCESS_TOKEN");
      expect(command.commandArgs.join(" ")).not.toContain("SUPABASE_DB_PASSWORD");
    }
  });
});

describe("Storage object bytes remain explicitly outside database-backup scope (documentation-level assertion)", () => {
  it("[16] neither adapter's data-dump command ever references the Storage objects table (the one that would actually hold object bytes/metadata)", () => {
    for (const command of [localGenericPostgresAdapter.dataDumpCommand("public", "/tmp/data.sql"), supabaseManagedAdapter.dataDumpCommand("public", "/tmp/data.sql")]) {
      expect(command.commandArgs.join(" ")).not.toMatch(/storage\.objects/i);
    }
    // The Supabase adapter's only "bucket" mention is the -x storage.buckets_vectors exclusion flag, which EXCLUDES a Storage-related table — the opposite of backing it up.
    expect(supabaseManagedAdapter.dataDumpCommand("public", "/tmp/data.sql").commandArgs).toContain("storage.buckets_vectors");
  });
});

describe("resolveSourceAdapter", () => {
  it("resolves 'local-generic' to the local adapter", () => {
    expect(resolveSourceAdapter("local-generic")).toBe(localGenericPostgresAdapter);
  });

  it("resolves 'supabase-managed' to the Supabase adapter", () => {
    expect(resolveSourceAdapter("supabase-managed")).toBe(supabaseManagedAdapter);
  });
});

describe("autoDetectSourceAdapterKind", () => {
  it("detects supabase-managed when a project ref is known", () => {
    expect(autoDetectSourceAdapterKind("abcdefghijklmnop")).toBe("supabase-managed");
  });

  it("detects local-generic when no project ref is known", () => {
    expect(autoDetectSourceAdapterKind(null)).toBe("local-generic");
  });
});
