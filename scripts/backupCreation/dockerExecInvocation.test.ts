/**
 * Production Database Backup Creation v1 — see
 * docs/database-backup-operations-v1.md.
 *
 * Unit tests over the pure docker-exec invocation builder — no Docker,
 * no subprocess spawned. This is the test that actually proves the
 * source password never reaches the host process's own argument
 * vector: it inspects the constructed `args`/`env` directly, the same
 * shape `scripts/create-database-backup.ts` hands to `runCapture`.
 */
import { describe, expect, it } from "vitest";
import { buildContainerExecInvocation, buildDisposablePasswordExecInvocation } from "./dockerExecInvocation";
import { parseBackupSourceUrl } from "./connectionRedaction";

const SOURCE = parseBackupSourceUrl("postgres://sourceuser:sup3rSecretPassword@db.example.com:5432/mydb")!;

describe("buildContainerExecInvocation", () => {
  const invocation = buildContainerExecInvocation("toolbox-container", SOURCE, ["pg_dumpall", "--roles-only", "-f", "/tmp/roles.sql"], {});

  it("[argv proof] source.password is absent from args", () => {
    expect(invocation.args.join(" ")).not.toContain("sup3rSecretPassword");
  });

  it("[argv proof] the full connection URL is absent from args", () => {
    const joined = invocation.args.join(" ");
    expect(joined).not.toContain("postgres://");
    expect(joined).not.toContain("sourceuser");
    expect(joined).not.toContain("db.example.com");
  });

  it("[argv proof] PG variable NAMES appear as bare flags, never with '='", () => {
    expect(invocation.args).toContain("PGHOST");
    expect(invocation.args).toContain("PGPORT");
    expect(invocation.args).toContain("PGUSER");
    expect(invocation.args).toContain("PGPASSWORD");
    expect(invocation.args).toContain("PGDATABASE");
    for (const arg of invocation.args) {
      expect(arg.startsWith("PGPASSWORD=")).toBe(false);
      expect(arg.startsWith("PGHOST=")).toBe(false);
    }
  });

  it("args begins with 'exec', includes the container name, and ends with the actual command", () => {
    expect(invocation.args[0]).toBe("exec");
    expect(invocation.args).toContain("toolbox-container");
    expect(invocation.args.slice(-4)).toEqual(["pg_dumpall", "--roles-only", "-f", "/tmp/roles.sql"]);
  });

  it("[execution-boundary proof] env carries the actual PG* values — this is the ONLY place they appear", () => {
    expect(invocation.env.PGHOST).toBe("db.example.com");
    expect(invocation.env.PGPORT).toBe("5432");
    expect(invocation.env.PGUSER).toBe("sourceuser");
    expect(invocation.env.PGPASSWORD).toBe("sup3rSecretPassword");
    expect(invocation.env.PGDATABASE).toBe("mydb");
  });

  it("spreads the supplied base env underneath the PG* values, without leaking them into args either", () => {
    const withBase = buildContainerExecInvocation("c", SOURCE, ["pg_dump"], { PATH: "/usr/bin", UNRELATED_VAR: "x" });
    expect(withBase.env.PATH).toBe("/usr/bin");
    expect(withBase.env.UNRELATED_VAR).toBe("x");
    expect(withBase.env.PGPASSWORD).toBe("sup3rSecretPassword");
    expect(withBase.args.join(" ")).not.toContain("sup3rSecretPassword");
  });
});

describe("buildDisposablePasswordExecInvocation", () => {
  const invocation = buildDisposablePasswordExecInvocation("disposable-container", "randomLocalPass123", ["psql", "-U", "someuser", "-d", "somedb", "-f", "/tmp/schema.sql"], {});

  it("the disposable password is absent from args", () => {
    expect(invocation.args.join(" ")).not.toContain("randomLocalPass123");
  });

  it("PGPASSWORD appears as a bare flag, never with '='", () => {
    expect(invocation.args).toContain("PGPASSWORD");
    for (const arg of invocation.args) expect(arg.startsWith("PGPASSWORD=")).toBe(false);
  });

  it("the disposable password is carried only in env", () => {
    expect(invocation.env.PGPASSWORD).toBe("randomLocalPass123");
  });

  it("non-secret username/database remain as plain command args (unchanged behaviour)", () => {
    expect(invocation.args).toContain("someuser");
    expect(invocation.args).toContain("somedb");
  });
});
