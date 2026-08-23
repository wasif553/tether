/**
 * Production Database Backup Creation v1 — see
 * docs/database-backup-operations-v1.md and supabaseCliExecutor.ts's own
 * doc comment.
 *
 * Unit tests over the Supabase-managed execution boundary. No real
 * Supabase CLI is invoked — `runSupabaseManagedDumpSequence` accepts an
 * injected fake `runner`, so these tests prove the ORCHESTRATION
 * (preflight gating, argv/env shape, temporary-workspace lifecycle)
 * without ever running a real subprocess or contacting a real Supabase
 * project. See sourceAdapters.test.ts for the pure command-construction
 * tests these commands are built by.
 *
 * SUPABASE_MANAGED_SOURCE_RUNTIME_TEST: DEFERRED — this file does not
 * (and cannot, in this environment) prove the real Supabase CLI actually
 * succeeds against a real project.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSupabaseCliBinaryPath, preflightSupabaseCli, preflightSupabaseManagedExecution, createTemporarySupabaseWorkspace, removeTemporarySupabaseWorkspace, runSupabaseManagedDumpSequence, type SupabaseCliRunner } from "./supabaseCliExecutor";
import type { DumpStageCommand } from "./sourceAdapters";

describe("resolveSupabaseCliBinaryPath", () => {
  it("resolves to node_modules/.bin/supabase (or supabase.cmd on Windows) under the given repo root — never a bare 'supabase' or an npx invocation", () => {
    const resolved = resolveSupabaseCliBinaryPath("C:/repo");
    expect(resolved).toContain("node_modules");
    expect(resolved).toContain(".bin");
    expect(resolved).toMatch(/supabase(\.cmd)?$/);
    expect(resolved).not.toContain("npx");
  });
});

describe("[3] preflightSupabaseCli requires actual CLI availability", () => {
  it("fails closed when the binary does not exist at the resolved path", async () => {
    const result = await preflightSupabaseCli("C:/definitely-not-a-real-repo-root-xyz123");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/not found/i);
      expect(result.reason).toMatch(/devDependency/i);
    }
  });

  it("succeeds against this actual repository's own pinned CLI (the real devDependency installed by npm install)", async () => {
    const repoRoot = path.resolve(__dirname, "..", "..");
    const result = await preflightSupabaseCli(repoRoot);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.version.length).toBeGreaterThan(0);
      expect(result.binaryPath).toContain("node_modules");
    }
  });
});

describe("[4] preflightSupabaseManagedExecution requires a validated sourceProjectRef", () => {
  it("fails closed before checking the CLI or any environment variable when sourceProjectRef is null", async () => {
    const result = await preflightSupabaseManagedExecution("C:/definitely-not-a-real-repo-root-xyz123", null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/source-project-ref/i);
  });
});

describe("[5][6] SUPABASE_ACCESS_TOKEN / SUPABASE_DB_PASSWORD gating — never logged, never in argv", () => {
  const repoRoot = path.resolve(__dirname, "..", "..");

  it("fails closed when SUPABASE_ACCESS_TOKEN is missing, even with a valid CLI and project ref", async () => {
    const savedToken = process.env.SUPABASE_ACCESS_TOKEN;
    const savedPassword = process.env.SUPABASE_DB_PASSWORD;
    delete process.env.SUPABASE_ACCESS_TOKEN;
    process.env.SUPABASE_DB_PASSWORD = "irrelevant-for-this-test";
    try {
      const result = await preflightSupabaseManagedExecution(repoRoot, "abcdefghijklmnop");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/SUPABASE_ACCESS_TOKEN/);
    } finally {
      if (savedToken !== undefined) process.env.SUPABASE_ACCESS_TOKEN = savedToken;
      else delete process.env.SUPABASE_ACCESS_TOKEN;
      if (savedPassword !== undefined) process.env.SUPABASE_DB_PASSWORD = savedPassword;
      else delete process.env.SUPABASE_DB_PASSWORD;
    }
  });

  it("fails closed when SUPABASE_DB_PASSWORD is missing, even with a valid CLI, project ref, and access token", async () => {
    const savedToken = process.env.SUPABASE_ACCESS_TOKEN;
    const savedPassword = process.env.SUPABASE_DB_PASSWORD;
    process.env.SUPABASE_ACCESS_TOKEN = "irrelevant-for-this-test";
    delete process.env.SUPABASE_DB_PASSWORD;
    try {
      const result = await preflightSupabaseManagedExecution(repoRoot, "abcdefghijklmnop");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/SUPABASE_DB_PASSWORD/);
    } finally {
      if (savedToken !== undefined) process.env.SUPABASE_ACCESS_TOKEN = savedToken;
      else delete process.env.SUPABASE_ACCESS_TOKEN;
      if (savedPassword !== undefined) process.env.SUPABASE_DB_PASSWORD = savedPassword;
      else delete process.env.SUPABASE_DB_PASSWORD;
    }
  });

  it("succeeds once the CLI, project ref, and both env vars are all present", async () => {
    const savedToken = process.env.SUPABASE_ACCESS_TOKEN;
    const savedPassword = process.env.SUPABASE_DB_PASSWORD;
    process.env.SUPABASE_ACCESS_TOKEN = "fake-token-for-preflight-only";
    process.env.SUPABASE_DB_PASSWORD = "fake-password-for-preflight-only";
    try {
      const result = await preflightSupabaseManagedExecution(repoRoot, "abcdefghijklmnop");
      expect(result.ok).toBe(true);
    } finally {
      if (savedToken !== undefined) process.env.SUPABASE_ACCESS_TOKEN = savedToken;
      else delete process.env.SUPABASE_ACCESS_TOKEN;
      if (savedPassword !== undefined) process.env.SUPABASE_DB_PASSWORD = savedPassword;
      else delete process.env.SUPABASE_DB_PASSWORD;
    }
  });
});

describe("createTemporarySupabaseWorkspace / removeTemporarySupabaseWorkspace", () => {
  it("creates a real directory outside the repository and removes it cleanly", async () => {
    const workspace = await createTemporarySupabaseWorkspace();
    expect(fs.existsSync(workspace.dir)).toBe(true);
    const repoRoot = path.resolve(__dirname, "..", "..");
    expect(workspace.dir.startsWith(repoRoot)).toBe(false);
    await removeTemporarySupabaseWorkspace(workspace);
    expect(fs.existsSync(workspace.dir)).toBe(false);
  });

  it("removal is safe to call on an already-removed workspace", async () => {
    const workspace = await createTemporarySupabaseWorkspace();
    await removeTemporarySupabaseWorkspace(workspace);
    await expect(removeTemporarySupabaseWorkspace(workspace)).resolves.toBeUndefined();
  });
});

function stageCommand(commandArgs: string[]): DumpStageCommand {
  return { commandArgs };
}

describe("[12][13] runSupabaseManagedDumpSequence — temporary workspace cleanup", () => {
  it("[12] cleans up the temporary workspace on success", async () => {
    let observedCwd: string | null = null;
    const fakeRunner: SupabaseCliRunner = async (_binaryPath, _args, options) => {
      observedCwd ??= options.cwd ?? null;
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await runSupabaseManagedDumpSequence("fake-supabase-binary", "abcdefghijklmnop", [{ key: "roles", command: stageCommand(["db", "dump", "--linked", "-f", "/tmp/roles.sql", "--role-only"]) }], fakeRunner);
    expect(result.ok).toBe(true);
    expect(observedCwd).not.toBeNull();
    expect(fs.existsSync(observedCwd!)).toBe(false);
  });

  it("[13] cleans up the temporary workspace on failure (link stage fails)", async () => {
    let observedCwd: string | null = null;
    const fakeRunner: SupabaseCliRunner = async (_binaryPath, _args, options) => {
      observedCwd ??= options.cwd ?? null;
      return { code: 1, stdout: "", stderr: "link failed" };
    };
    const result = await runSupabaseManagedDumpSequence("fake-supabase-binary", "abcdefghijklmnop", [{ key: "roles", command: stageCommand(["db", "dump", "--linked", "-f", "/tmp/roles.sql", "--role-only"]) }], fakeRunner);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe("link");
    expect(observedCwd).not.toBeNull();
    expect(fs.existsSync(observedCwd!)).toBe(false);
  });

  it("[13] cleans up the temporary workspace on failure (a later dump stage fails)", async () => {
    let observedCwd: string | null = null;
    let callCount = 0;
    const fakeRunner: SupabaseCliRunner = async (_binaryPath, _args, options) => {
      observedCwd ??= options.cwd ?? null;
      callCount += 1;
      // link succeeds, roles succeeds, schema fails
      if (callCount <= 2) return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "schema dump failed" };
    };
    const result = await runSupabaseManagedDumpSequence(
      "fake-supabase-binary",
      "abcdefghijklmnop",
      [
        { key: "roles", command: stageCommand(["db", "dump", "--linked", "-f", "/tmp/roles.sql", "--role-only"]) },
        { key: "schema", command: stageCommand(["db", "dump", "--linked", "-f", "/tmp/schema.sql"]) },
      ],
      fakeRunner,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe("schema");
    expect(fs.existsSync(observedCwd!)).toBe(false);
  });

  it("runs 'link --project-ref <ref>' first, with the ref as a plain argv value", async () => {
    const calls: { binaryPath: string; args: string[] }[] = [];
    const fakeRunner: SupabaseCliRunner = async (binaryPath, args) => {
      calls.push({ binaryPath, args });
      return { code: 0, stdout: "", stderr: "" };
    };
    await runSupabaseManagedDumpSequence("fake-supabase-binary", "abcdefghijklmnop", [], fakeRunner);
    expect(calls[0].binaryPath).toBe("fake-supabase-binary");
    expect(calls[0].args).toEqual(["link", "--project-ref", "abcdefghijklmnop"]);
  });

  it("[5][6] no call ever carries SUPABASE_ACCESS_TOKEN or SUPABASE_DB_PASSWORD as a literal argv value", async () => {
    const savedToken = process.env.SUPABASE_ACCESS_TOKEN;
    const savedPassword = process.env.SUPABASE_DB_PASSWORD;
    process.env.SUPABASE_ACCESS_TOKEN = "super-secret-access-token-value";
    process.env.SUPABASE_DB_PASSWORD = "super-secret-db-password-value";
    const calls: string[][] = [];
    const fakeRunner: SupabaseCliRunner = async (_binaryPath, args) => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    };
    try {
      await runSupabaseManagedDumpSequence("fake-supabase-binary", "abcdefghijklmnop", [{ key: "roles", command: stageCommand(["db", "dump", "--linked", "-f", "/tmp/roles.sql", "--role-only"]) }], fakeRunner);
      for (const args of calls) {
        expect(args.join(" ")).not.toContain("super-secret-access-token-value");
        expect(args.join(" ")).not.toContain("super-secret-db-password-value");
      }
    } finally {
      if (savedToken !== undefined) process.env.SUPABASE_ACCESS_TOKEN = savedToken;
      else delete process.env.SUPABASE_ACCESS_TOKEN;
      if (savedPassword !== undefined) process.env.SUPABASE_DB_PASSWORD = savedPassword;
      else delete process.env.SUPABASE_DB_PASSWORD;
    }
  });

  it("runs dump stages in the supplied order after a successful link, stopping at the first failure", async () => {
    const stageKeysCalled: string[] = [];
    const fakeRunner: SupabaseCliRunner = async (_binaryPath, args) => {
      if (args[0] === "link") return { code: 0, stdout: "", stderr: "" };
      stageKeysCalled.push(args.join(" "));
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await runSupabaseManagedDumpSequence(
      "fake-supabase-binary",
      "abcdefghijklmnop",
      [
        { key: "roles", command: stageCommand(["db", "dump", "--linked", "-f", "/tmp/roles.sql", "--role-only"]) },
        { key: "schema", command: stageCommand(["db", "dump", "--linked", "-f", "/tmp/schema.sql"]) },
        { key: "data", command: stageCommand(["db", "dump", "--linked", "-f", "/tmp/data.sql", "--data-only", "--use-copy"]) },
      ],
      fakeRunner,
    );
    expect(result.ok).toBe(true);
    expect(stageKeysCalled).toHaveLength(3);
  });
});
