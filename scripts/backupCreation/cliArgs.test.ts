/**
 * Production Database Backup Creation v1 — see
 * docs/database-backup-operations-v1.md.
 *
 * Unit tests over the pure argument parser/execute-safety gate only —
 * no database, no Docker, no subprocess spawned.
 */
import { describe, expect, it } from "vitest";
import { parseBackupCreateArgs, checkBackupCreateExecuteSafety } from "./cliArgs";

describe("parseBackupCreateArgs", () => {
  it("[1] defaults to execute:false (dry run) with no arguments", () => {
    const parsed = parseBackupCreateArgs([]);
    expect(parsed.execute).toBe(false);
  });

  it("parses --execute, --environment, --output-dir, --confirm-production", () => {
    const parsed = parseBackupCreateArgs(["--execute", "--environment", "production", "--output-dir", "/tmp/x", "--confirm-production"]);
    expect(parsed.execute).toBe(true);
    expect(parsed.environment).toBe("production");
    expect(parsed.outputDir).toBe("/tmp/x");
    expect(parsed.confirmProduction).toBe(true);
  });

  it("defaults pgSchema to 'public' when not supplied", () => {
    expect(parseBackupCreateArgs([]).pgSchema).toBe("public");
  });

  it("honours an explicit --pg-schema value", () => {
    expect(parseBackupCreateArgs(["--pg-schema", "custom_schema"]).pgSchema).toBe("custom_schema");
  });

  it("parses --source-project-ref", () => {
    expect(parseBackupCreateArgs(["--source-project-ref", "abc123"]).sourceProjectRef).toBe("abc123");
  });
});

describe("checkBackupCreateExecuteSafety", () => {
  it("[1] a dry run (execute: false) always passes, regardless of other args", () => {
    expect(checkBackupCreateExecuteSafety(parseBackupCreateArgs([]))).toEqual({ ok: true });
    expect(checkBackupCreateExecuteSafety(parseBackupCreateArgs(["--environment", "production"]))).toEqual({ ok: true });
  });

  it("fails closed when --execute is supplied without --environment", () => {
    const result = checkBackupCreateExecuteSafety(parseBackupCreateArgs(["--execute", "--output-dir", "/tmp/x"]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/--environment/);
  });

  it("fails closed when --execute is supplied without --output-dir", () => {
    const result = checkBackupCreateExecuteSafety(parseBackupCreateArgs(["--execute", "--environment", "local-test"]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/--output-dir/);
  });

  it("fails closed when --execute is supplied with neither required argument", () => {
    const result = checkBackupCreateExecuteSafety(parseBackupCreateArgs(["--execute"]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/--environment/);
      expect(result.reason).toMatch(/--output-dir/);
    }
  });

  it("[2] fails closed when --environment production is given without --confirm-production", () => {
    const result = checkBackupCreateExecuteSafety(parseBackupCreateArgs(["--execute", "--environment", "production", "--output-dir", "/tmp/x"]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/--confirm-production/);
  });

  it("[2] passes when --environment production is given WITH --confirm-production", () => {
    const result = checkBackupCreateExecuteSafety(parseBackupCreateArgs(["--execute", "--environment", "production", "--output-dir", "/tmp/x", "--confirm-production"]));
    expect(result).toEqual({ ok: true });
  });

  it("does not require --confirm-production for a non-production environment label", () => {
    const result = checkBackupCreateExecuteSafety(parseBackupCreateArgs(["--execute", "--environment", "local-test", "--output-dir", "/tmp/x"]));
    expect(result).toEqual({ ok: true });
  });

  it("does not infer production from the mere presence of --execute — only the explicit label matters", () => {
    const result = checkBackupCreateExecuteSafety(parseBackupCreateArgs(["--execute", "--environment", "staging", "--output-dir", "/tmp/x"]));
    expect(result).toEqual({ ok: true });
  });
});
