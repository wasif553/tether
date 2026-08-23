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

  it("parses --source-type", () => {
    expect(parseBackupCreateArgs(["--source-type", "supabase-managed"]).sourceType).toBe("supabase-managed");
  });

  it("sourceType is null when not supplied (auto-detect)", () => {
    expect(parseBackupCreateArgs([]).sourceType).toBeNull();
  });
});

describe("checkBackupCreateExecuteSafety", () => {
  it("[1] a dry run (execute: false) always passes, regardless of other args, with no validated values", () => {
    expect(checkBackupCreateExecuteSafety(parseBackupCreateArgs([]))).toEqual({ ok: true, environment: null, sourceProjectRef: null });
    expect(checkBackupCreateExecuteSafety(parseBackupCreateArgs(["--environment", "production"]))).toEqual({ ok: true, environment: null, sourceProjectRef: null });
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

  it("[2] passes when --environment production is given WITH --confirm-production, returning the canonical validated environment", () => {
    const result = checkBackupCreateExecuteSafety(parseBackupCreateArgs(["--execute", "--environment", "production", "--output-dir", "/tmp/x", "--confirm-production"]));
    expect(result).toEqual({ ok: true, environment: "production", sourceProjectRef: null });
  });

  it("does not require --confirm-production for a non-production environment label", () => {
    const result = checkBackupCreateExecuteSafety(parseBackupCreateArgs(["--execute", "--environment", "local-test", "--output-dir", "/tmp/x"]));
    expect(result).toEqual({ ok: true, environment: "local-test", sourceProjectRef: null });
  });

  it("does not infer production from the mere presence of --execute — only the explicit label matters", () => {
    const result = checkBackupCreateExecuteSafety(parseBackupCreateArgs(["--execute", "--environment", "staging", "--output-dir", "/tmp/x"]));
    expect(result).toEqual({ ok: true, environment: "staging", sourceProjectRef: null });
  });

  describe("[TETHER_DATABASE_BACKUP_OPERATIONALISATION_FINAL_HARDENING] Production confirmation is not bypassable via casing/whitespace", () => {
    const PRODUCTION_VARIANTS = ["production", "Production", "PRODUCTION", " production ", "production "];

    for (const variant of PRODUCTION_VARIANTS) {
      it(`requires --confirm-production for the environment label ${JSON.stringify(variant)}`, () => {
        const result = checkBackupCreateExecuteSafety(parseBackupCreateArgs(["--execute", "--environment", variant, "--output-dir", "/tmp/x"]));
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toMatch(/--confirm-production/);
      });

      it(`passes for ${JSON.stringify(variant)} WITH --confirm-production, and normalises to the canonical "production" label`, () => {
        const result = checkBackupCreateExecuteSafety(parseBackupCreateArgs(["--execute", "--environment", variant, "--output-dir", "/tmp/x", "--confirm-production"]));
        expect(result).toEqual({ ok: true, environment: "production", sourceProjectRef: null });
      });
    }

    it("rejects an empty/whitespace-only environment label even though a flag value was technically supplied", () => {
      const result = checkBackupCreateExecuteSafety(parseBackupCreateArgs(["--execute", "--environment", "   ", "--output-dir", "/tmp/x"]));
      expect(result.ok).toBe(false);
    });

    it("rejects an environment label that looks like a URL/connection string", () => {
      const result = checkBackupCreateExecuteSafety(parseBackupCreateArgs(["--execute", "--environment", "postgres://user:pass@host/db", "--output-dir", "/tmp/x"]));
      expect(result.ok).toBe(false);
    });

    it("rejects an oversized environment label", () => {
      const result = checkBackupCreateExecuteSafety(parseBackupCreateArgs(["--execute", "--environment", "a".repeat(200), "--output-dir", "/tmp/x"]));
      expect(result.ok).toBe(false);
    });
  });

  describe("[TETHER_DATABASE_BACKUP_OPERATIONALISATION_FINAL_HARDENING] malicious --source-project-ref is rejected before manifest creation", () => {
    it("rejects a full postgres:// connection string passed as --source-project-ref", () => {
      const result = checkBackupCreateExecuteSafety(parseBackupCreateArgs(["--execute", "--environment", "local-test", "--output-dir", "/tmp/x", "--source-project-ref", "postgresql://user:password@host/db"]));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/--source-project-ref/);
    });

    it("rejects a project ref containing '@'", () => {
      const result = checkBackupCreateExecuteSafety(parseBackupCreateArgs(["--execute", "--environment", "local-test", "--output-dir", "/tmp/x", "--source-project-ref", "user@host"]));
      expect(result.ok).toBe(false);
    });

    it("rejects a project ref containing whitespace", () => {
      const result = checkBackupCreateExecuteSafety(parseBackupCreateArgs(["--execute", "--environment", "local-test", "--output-dir", "/tmp/x", "--source-project-ref", "abc 123"]));
      expect(result.ok).toBe(false);
    });

    it("rejects a project ref containing a path separator", () => {
      const result = checkBackupCreateExecuteSafety(parseBackupCreateArgs(["--execute", "--environment", "local-test", "--output-dir", "/tmp/x", "--source-project-ref", "abc/123"]));
      expect(result.ok).toBe(false);
    });

    it("accepts a plain alphanumeric project ref", () => {
      const result = checkBackupCreateExecuteSafety(parseBackupCreateArgs(["--execute", "--environment", "local-test", "--output-dir", "/tmp/x", "--source-project-ref", "abcdefghijklmnop"]));
      expect(result).toEqual({ ok: true, environment: "local-test", sourceProjectRef: "abcdefghijklmnop" });
    });
  });

  describe("--source-type validation", () => {
    it("rejects an unrecognised --source-type value", () => {
      const result = checkBackupCreateExecuteSafety(parseBackupCreateArgs(["--execute", "--environment", "local-test", "--output-dir", "/tmp/x", "--source-type", "not-a-real-adapter"]));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/--source-type/);
    });

    it("accepts 'local-generic' and 'supabase-managed'", () => {
      expect(checkBackupCreateExecuteSafety(parseBackupCreateArgs(["--execute", "--environment", "local-test", "--output-dir", "/tmp/x", "--source-type", "local-generic"])).ok).toBe(true);
      expect(checkBackupCreateExecuteSafety(parseBackupCreateArgs(["--execute", "--environment", "local-test", "--output-dir", "/tmp/x", "--source-type", "supabase-managed"])).ok).toBe(true);
    });
  });
});
