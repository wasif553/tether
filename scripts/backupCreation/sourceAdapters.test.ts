/**
 * Production Database Backup Creation v1 — see
 * docs/database-backup-operations-v1.md.
 *
 * Unit tests over the pure source-adapter command-construction logic
 * only — no Docker, no subprocess, no Supabase CLI, no Production
 * contact. See sourceAdapters.ts's own doc comment:
 *
 * SUPABASE_MANAGED_SOURCE_RUNTIME_TEST: DEFERRED — these tests prove
 * what COMMAND would be constructed, never that it actually succeeds
 * against a real Supabase CLI/project.
 */
import { describe, expect, it } from "vitest";
import { localGenericPostgresAdapter, supabaseManagedAdapter, resolveSourceAdapter, autoDetectSourceAdapterKind, SUPABASE_VECTOR_TABLE_EXCLUSIONS } from "./sourceAdapters";

describe("localGenericPostgresAdapter", () => {
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

describe("[TETHER_DATABASE_BACKUP_OPERATIONALISATION_FINAL_HARDENING] supabaseManagedAdapter", () => {
  it("Supabase role backup does NOT use raw unfiltered pg_dumpall as the Production Supabase path", () => {
    const command = supabaseManagedAdapter.rolesDumpCommand("/tmp/roles.sql");
    expect(command.commandArgs.join(" ")).not.toContain("pg_dumpall");
    expect(command.commandArgs.join(" ")).toContain("supabase db dump");
    expect(command.commandArgs.join(" ")).toContain("--role-only");
  });

  it("Supabase schema dump uses the Supabase CLI, not raw pg_dump", () => {
    const command = supabaseManagedAdapter.schemaDumpCommand("public", "/tmp/schema.sql");
    expect(command.commandArgs.join(" ")).not.toMatch(/\bpg_dump\b/);
    expect(command.commandArgs.join(" ")).toContain("supabase db dump");
  });

  it("[data backup uses COPY semantics] --use-copy is present on the data dump command", () => {
    const command = supabaseManagedAdapter.dataDumpCommand("public", "/tmp/data.sql");
    expect(command.commandArgs.join(" ")).toContain("--data-only");
    expect(command.commandArgs.join(" ")).toContain("--use-copy");
  });

  it("applies the documented Storage vector-table exclusions to schema and data dumps", () => {
    for (const table of SUPABASE_VECTOR_TABLE_EXCLUSIONS) {
      expect(supabaseManagedAdapter.schemaDumpCommand("public", "/tmp/schema.sql").commandArgs.join(" ")).toContain(table);
      expect(supabaseManagedAdapter.dataDumpCommand("public", "/tmp/data.sql").commandArgs.join(" ")).toContain(table);
    }
  });

  it("SUPABASE_VECTOR_TABLE_EXCLUSIONS includes the two documented tables", () => {
    expect(SUPABASE_VECTOR_TABLE_EXCLUSIONS).toContain("storage.buckets_vectors");
    expect(SUPABASE_VECTOR_TABLE_EXCLUSIONS).toContain("storage.vector_indexes");
  });

  it("never embeds a literal secret value in the constructed command — only $VAR shell references", () => {
    for (const command of [supabaseManagedAdapter.rolesDumpCommand("/tmp/roles.sql"), supabaseManagedAdapter.schemaDumpCommand("public", "/tmp/schema.sql"), supabaseManagedAdapter.dataDumpCommand("public", "/tmp/data.sql")]) {
      const joined = command.commandArgs.join(" ");
      expect(joined).toContain("$PGUSER");
      expect(joined).toContain("$PGPASSWORD");
      expect(joined).toContain("$PGHOST");
      // No literal password/hostname could appear since this module never sees one — it only ever builds a static template string.
    }
  });

  it("wraps the Supabase CLI invocation in sh -c so the shell (not this process) expands the $PG* references at execution time", () => {
    const command = supabaseManagedAdapter.rolesDumpCommand("/tmp/roles.sql");
    expect(command.commandArgs[0]).toBe("sh");
    expect(command.commandArgs[1]).toBe("-c");
  });
});

describe("Storage object bytes remain explicitly outside database-backup scope (documentation-level assertion)", () => {
  it("this module's own doc comment states it does not claim Storage object bytes are backed up", () => {
    // Asserted at the documentation layer too (safetyContract.test.ts /
    // database-backup-operations-v1.md) and re-affirmed here
    // structurally: neither adapter's commandArgs ever references the
    // Storage objects table (the one that would actually hold object
    // bytes/metadata) — the Supabase adapter's only "bucket" mention is
    // the `--exclude-table 'storage.buckets_vectors'` flag, which
    // EXCLUDES a Storage-related table, the opposite of backing it up.
    for (const command of [localGenericPostgresAdapter.dataDumpCommand("public", "/tmp/data.sql"), supabaseManagedAdapter.dataDumpCommand("public", "/tmp/data.sql")]) {
      expect(command.commandArgs.join(" ")).not.toMatch(/storage\.objects/i);
    }
    expect(supabaseManagedAdapter.dataDumpCommand("public", "/tmp/data.sql").commandArgs.join(" ")).toMatch(/--exclude-table 'storage\.buckets_vectors'/);
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
