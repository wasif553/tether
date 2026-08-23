/**
 * Production Database Backup Creation v1 — see
 * docs/database-backup-operations-v1.md and supabaseCliExecutor.ts's own
 * doc comment.
 *
 * Unit tests over the Supabase-managed execution boundary. No real
 * Supabase CLI is invoked here — `runSupabaseManagedDumpSequence`
 * accepts an injected fake `runner`, so these tests prove the
 * ORCHESTRATION (preflight gating, argv/env shape, temporary-workspace
 * lifecycle, no `supabase link`) without ever running a real subprocess
 * or contacting a real Supabase project. See
 * docs/database-backup-operations-v1.md's "Current status" section for
 * the SEPARATE real disposable-Postgres runtime exercise
 * (`SUPABASE_CLI_DIRECT_RUNTIME_TEST: PASS`) that exercises the real CLI
 * end to end. See sourceAdapters.test.ts for the pure command-
 * construction tests these base commands are built by.
 *
 * SUPABASE_MANAGED_PRODUCTION_RUNTIME_TEST: DEFERRED — this file does
 * not (and cannot, in this environment) prove the real Supabase CLI
 * actually succeeds against a real Production project.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSupabaseCliBinaryPath, preflightSupabaseCli, preflightSupabaseManagedExecution, createTemporarySupabaseWorkspace, removeTemporarySupabaseWorkspace, runSupabaseInit, buildManagedDumpInvocationArgs, runSupabaseManagedDumpSequence, type SupabaseCliRunner } from "./supabaseCliExecutor";
import type { DumpStageCommand } from "./sourceAdapters";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

describe("resolveSupabaseCliBinaryPath", () => {
  it("resolves to node_modules/.bin/supabase (or supabase.cmd on Windows) under the given repo root — never a bare 'supabase' or an npx invocation", () => {
    const resolved = resolveSupabaseCliBinaryPath("C:/repo");
    expect(resolved).toContain("node_modules");
    expect(resolved).toContain(".bin");
    expect(resolved).toMatch(/supabase(\.cmd)?$/);
    expect(resolved).not.toContain("npx");
  });
});

describe("preflightSupabaseCli requires actual CLI availability", () => {
  it("fails closed when the binary does not exist at the resolved path", async () => {
    const result = await preflightSupabaseCli("C:/definitely-not-a-real-repo-root-xyz123");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/not found/i);
      expect(result.reason).toMatch(/devDependency/i);
    }
  });

  it("succeeds against this actual repository's own pinned CLI (the real devDependency installed by npm install)", async () => {
    const result = await preflightSupabaseCli(REPO_ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.version.length).toBeGreaterThan(0);
      expect(result.binaryPath).toContain("node_modules");
    }
  });
});

describe("[9][10] preflightSupabaseManagedExecution — Docker checked before any remote operation", () => {
  it("succeeds (Docker is installed and running in this environment; CLI present; password present; safe URL buildable)", async () => {
    const result = await preflightSupabaseManagedExecution(REPO_ROOT, "postgres://user:pass@localhost:5432/db", "pass");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.passwordlessUrl).toBe("postgres://user@localhost:5432/db");
      expect(result.password).toBe("pass");
    }
  });

  it("fails closed when the source connection has no password", async () => {
    const result = await preflightSupabaseManagedExecution(REPO_ROOT, "postgres://user@localhost:5432/db", "");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no password/i);
  });

  it("fails closed when a safe passwordless URL cannot be built (disallowed query parameter)", async () => {
    const result = await preflightSupabaseManagedExecution(REPO_ROOT, "postgres://user:pass@localhost:5432/db?passfile=/etc/passwd", "pass");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/passwordless CLI database URL/i);
  });
});

describe("[3] no SUPABASE_ACCESS_TOKEN or separate SUPABASE_DB_PASSWORD is required", () => {
  it("preflight succeeds with neither SUPABASE_ACCESS_TOKEN nor SUPABASE_DB_PASSWORD set in the environment", async () => {
    const savedToken = process.env.SUPABASE_ACCESS_TOKEN;
    const savedPassword = process.env.SUPABASE_DB_PASSWORD;
    delete process.env.SUPABASE_ACCESS_TOKEN;
    delete process.env.SUPABASE_DB_PASSWORD;
    try {
      const result = await preflightSupabaseManagedExecution(REPO_ROOT, "postgres://user:realSecretPass@localhost:5432/db", "realSecretPass");
      expect(result.ok).toBe(true);
    } finally {
      if (savedToken !== undefined) process.env.SUPABASE_ACCESS_TOKEN = savedToken;
      if (savedPassword !== undefined) process.env.SUPABASE_DB_PASSWORD = savedPassword;
    }
  });
});

describe("createTemporarySupabaseWorkspace / removeTemporarySupabaseWorkspace", () => {
  it("creates a real directory outside the repository and removes it cleanly", async () => {
    const workspace = await createTemporarySupabaseWorkspace();
    expect(fs.existsSync(workspace.dir)).toBe(true);
    expect(workspace.dir.startsWith(REPO_ROOT)).toBe(false);
    await removeTemporarySupabaseWorkspace(workspace);
    expect(fs.existsSync(workspace.dir)).toBe(false);
  });

  it("removal is safe to call on an already-removed workspace", async () => {
    const workspace = await createTemporarySupabaseWorkspace();
    await removeTemporarySupabaseWorkspace(workspace);
    await expect(removeTemporarySupabaseWorkspace(workspace)).resolves.toBeUndefined();
  });
});

describe("[11] runSupabaseInit — purely local scaffolding", () => {
  it("runs 'init --force --yes --workdir <dir>' with no project reference and no credential on argv", async () => {
    const calls: { binaryPath: string; args: string[] }[] = [];
    const fakeRunner: SupabaseCliRunner = async (binaryPath, args) => {
      calls.push({ binaryPath, args });
      return { code: 0, stdout: "", stderr: "" };
    };
    const workspace = { dir: "/fake/workspace" };
    const result = await runSupabaseInit("fake-supabase-binary", workspace, fakeRunner);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["init", "--force", "--yes", "--workdir", "/fake/workspace"]);
    expect(calls[0].args).not.toContain("link");
  });
});

describe("[14][15][16][17][18] buildManagedDumpInvocationArgs — exact final argv shape", () => {
  const workspace = { dir: "/fake/workdir" };

  it("[14] roles: base --role-only command plus --db-url and --workdir, no --linked, no link", () => {
    const args = buildManagedDumpInvocationArgs(["db", "dump", "-f", "/tmp/roles.sql", "--role-only"], "postgresql://user@host:5432/db", workspace);
    expect(args).toEqual(["db", "dump", "-f", "/tmp/roles.sql", "--role-only", "--db-url", "postgresql://user@host:5432/db", "--workdir", "/fake/workdir"]);
    expect(args).not.toContain("--linked");
    expect(args).not.toContain("link");
  });

  it("[15] schema: ordinary db dump command plus --db-url and --workdir", () => {
    const args = buildManagedDumpInvocationArgs(["db", "dump", "-f", "/tmp/schema.sql"], "postgresql://user@host:5432/db", workspace);
    expect(args).toEqual(["db", "dump", "-f", "/tmp/schema.sql", "--db-url", "postgresql://user@host:5432/db", "--workdir", "/fake/workdir"]);
  });

  it("[16][17][18] data: --data-only --use-copy, -x exclusions, no --exclude-table", () => {
    const args = buildManagedDumpInvocationArgs(["db", "dump", "-f", "/tmp/data.sql", "--data-only", "--use-copy", "-x", "storage.buckets_vectors", "-x", "storage.vector_indexes"], "postgresql://user@host:5432/db", workspace);
    expect(args).toContain("--data-only");
    expect(args).toContain("--use-copy");
    expect(args.join(" ")).toContain("-x storage.buckets_vectors");
    expect(args.join(" ")).toContain("-x storage.vector_indexes");
    expect(args.join(" ")).not.toContain("--exclude-table");
  });

  it("[5] the real password never appears in the built argv — only the passwordless URL", () => {
    const args = buildManagedDumpInvocationArgs(["db", "dump", "-f", "/tmp/data.sql"], "postgresql://user@host:5432/db", workspace);
    expect(args.join(" ")).not.toContain(":realSecretPassword@");
  });
});

function stageCommand(commandArgs: string[]): DumpStageCommand {
  return { commandArgs };
}

describe("[1][2][19] runSupabaseManagedDumpSequence — no supabase link, no --linked, no remote-mutating commands", () => {
  it("[1][2] never invokes 'link' — only 'init' then 'db dump' calls reach the runner", async () => {
    const calledSubcommands: string[] = [];
    const fakeRunner: SupabaseCliRunner = async (_binaryPath, args) => {
      calledSubcommands.push(args[0]);
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await runSupabaseManagedDumpSequence(
      "fake-supabase-binary",
      "postgresql://user@host:5432/db",
      "realSecretPassword",
      [{ key: "roles", command: stageCommand(["db", "dump", "-f", "/tmp/roles.sql", "--role-only"]) }],
      fakeRunner,
    );
    expect(result.ok).toBe(true);
    expect(calledSubcommands).toEqual(["init", "db"]);
    expect(calledSubcommands).not.toContain("link");
  });

  it("[19] no call ever carries a remote-mutating Supabase CLI subcommand (push/pull/reset/repair/config push/projects/storage)", async () => {
    const allArgs: string[][] = [];
    const fakeRunner: SupabaseCliRunner = async (_binaryPath, args) => {
      allArgs.push(args);
      return { code: 0, stdout: "", stderr: "" };
    };
    await runSupabaseManagedDumpSequence(
      "fake-supabase-binary",
      "postgresql://user@host:5432/db",
      "realSecretPassword",
      [
        { key: "roles", command: stageCommand(["db", "dump", "-f", "/tmp/roles.sql", "--role-only"]) },
        { key: "schema", command: stageCommand(["db", "dump", "-f", "/tmp/schema.sql"]) },
        { key: "data", command: stageCommand(["db", "dump", "-f", "/tmp/data.sql", "--data-only", "--use-copy"]) },
      ],
      fakeRunner,
    );
    const banned = ["push", "pull", "reset", "repair", "link"];
    for (const args of allArgs) {
      const joined = args.join(" ");
      for (const term of banned) expect(joined).not.toMatch(new RegExp(`\\b${term}\\b`));
      expect(joined).not.toContain("projects create");
      expect(joined).not.toContain("projects delete");
      expect(joined).not.toContain("storage");
    }
  });

  it("[12] cleans up the temporary workspace on success", async () => {
    let observedWorkdir: string | null = null;
    const fakeRunner: SupabaseCliRunner = async (_binaryPath, args) => {
      const idx = args.indexOf("--workdir");
      if (idx >= 0) observedWorkdir ??= args[idx + 1];
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await runSupabaseManagedDumpSequence("fake-supabase-binary", "postgresql://user@host:5432/db", "pw", [{ key: "roles", command: stageCommand(["db", "dump", "-f", "/tmp/roles.sql", "--role-only"]) }], fakeRunner);
    expect(result.ok).toBe(true);
    expect(observedWorkdir).not.toBeNull();
    expect(fs.existsSync(observedWorkdir!)).toBe(false);
  });

  it("[13] cleans up the temporary workspace on failure (init fails)", async () => {
    let observedWorkdir: string | null = null;
    const fakeRunner: SupabaseCliRunner = async (_binaryPath, args) => {
      const idx = args.indexOf("--workdir");
      if (idx >= 0) observedWorkdir ??= args[idx + 1];
      return { code: 1, stdout: "", stderr: "init failed" };
    };
    const result = await runSupabaseManagedDumpSequence("fake-supabase-binary", "postgresql://user@host:5432/db", "pw", [{ key: "roles", command: stageCommand(["db", "dump", "-f", "/tmp/roles.sql", "--role-only"]) }], fakeRunner);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe("init");
    expect(observedWorkdir).not.toBeNull();
    expect(fs.existsSync(observedWorkdir!)).toBe(false);
  });

  it("[13] cleans up the temporary workspace on failure (a later dump stage fails)", async () => {
    let observedWorkdir: string | null = null;
    let callCount = 0;
    const fakeRunner: SupabaseCliRunner = async (_binaryPath, args) => {
      const idx = args.indexOf("--workdir");
      if (idx >= 0) observedWorkdir ??= args[idx + 1];
      callCount += 1;
      // init succeeds, roles succeeds, schema fails
      if (callCount <= 2) return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "schema dump failed" };
    };
    const result = await runSupabaseManagedDumpSequence(
      "fake-supabase-binary",
      "postgresql://user@host:5432/db",
      "pw",
      [
        { key: "roles", command: stageCommand(["db", "dump", "-f", "/tmp/roles.sql", "--role-only"]) },
        { key: "schema", command: stageCommand(["db", "dump", "-f", "/tmp/schema.sql"]) },
      ],
      fakeRunner,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe("schema");
    expect(fs.existsSync(observedWorkdir!)).toBe(false);
  });

  it("[5][6] the real password reaches the runner only via env.PGPASSWORD, never in any args array", async () => {
    const allArgs: string[][] = [];
    const allEnvs: (NodeJS.ProcessEnv | undefined)[] = [];
    const fakeRunner: SupabaseCliRunner = async (_binaryPath, args, options) => {
      allArgs.push(args);
      allEnvs.push(options.env);
      return { code: 0, stdout: "", stderr: "" };
    };
    await runSupabaseManagedDumpSequence("fake-supabase-binary", "postgresql://user@host:5432/db", "super-secret-db-password-value", [{ key: "roles", command: stageCommand(["db", "dump", "-f", "/tmp/roles.sql", "--role-only"]) }], fakeRunner);
    for (const args of allArgs) {
      expect(args.join(" ")).not.toContain("super-secret-db-password-value");
    }
    const dumpCallEnv = allEnvs[1]; // [0] is init, [1] is the roles dump stage
    expect(dumpCallEnv?.PGPASSWORD).toBe("super-secret-db-password-value");
  });

  it("runs dump stages in the supplied order after a successful init, stopping at the first failure", async () => {
    const dumpCallsSeen: string[] = [];
    const fakeRunner: SupabaseCliRunner = async (_binaryPath, args) => {
      if (args[0] === "init") return { code: 0, stdout: "", stderr: "" };
      dumpCallsSeen.push(args.join(" "));
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await runSupabaseManagedDumpSequence(
      "fake-supabase-binary",
      "postgresql://user@host:5432/db",
      "pw",
      [
        { key: "roles", command: stageCommand(["db", "dump", "-f", "/tmp/roles.sql", "--role-only"]) },
        { key: "schema", command: stageCommand(["db", "dump", "-f", "/tmp/schema.sql"]) },
        { key: "data", command: stageCommand(["db", "dump", "-f", "/tmp/data.sql", "--data-only", "--use-copy"]) },
      ],
      fakeRunner,
    );
    expect(result.ok).toBe(true);
    expect(dumpCallsSeen).toHaveLength(3);
  });
});
