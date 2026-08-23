/**
 * Production Database Backup Creation v1 — see
 * docs/database-backup-operations-v1.md and supabaseDatabaseUrl.ts's own
 * doc comment. Pure, dependency-free tests.
 */
import { describe, expect, it } from "vitest";
import { buildPasswordlessSupabaseCliDatabaseUrl } from "./supabaseDatabaseUrl";

describe("[7][8] buildPasswordlessSupabaseCliDatabaseUrl — structurally valid, safe passwordless URL", () => {
  it("[7] returns a structurally valid postgres URL with the password removed", () => {
    const result = buildPasswordlessSupabaseCliDatabaseUrl("postgres://sourceuser:sup3rSecretPassword@db.example.com:5432/mydb");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(() => new URL(result.url)).not.toThrow();
      expect(result.url).not.toContain("sup3rSecretPassword");
    }
  });

  it("[8] preserves username, hostname, port, and database", () => {
    const result = buildPasswordlessSupabaseCliDatabaseUrl("postgres://sourceuser:sup3rSecretPassword@db.example.com:5432/mydb");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url).toBe("postgres://sourceuser@db.example.com:5432/mydb");
    }
  });

  it("[8] preserves the sslmode query parameter (required TLS option)", () => {
    const result = buildPasswordlessSupabaseCliDatabaseUrl("postgres://sourceuser:sup3rSecretPassword@db.example.com:5432/mydb?sslmode=require");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url).toBe("postgres://sourceuser@db.example.com:5432/mydb?sslmode=require");
    }
  });

  it("works when the source connection has no password to begin with", () => {
    const result = buildPasswordlessSupabaseCliDatabaseUrl("postgres://sourceuser@db.example.com:5432/mydb");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url).toBe("postgres://sourceuser@db.example.com:5432/mydb");
  });

  it("the connection URL containing the password never enters the returned value under any circumstance", () => {
    const result = buildPasswordlessSupabaseCliDatabaseUrl("postgres://sourceuser:anotherSecret999@db.example.com:5432/mydb?sslmode=require");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url).not.toContain("anotherSecret999");
      expect(result.url).not.toContain(":anotherSecret999@");
    }
  });
});

describe("fails closed on malformed or unsafe input", () => {
  it("rejects a non-URL string", () => {
    const result = buildPasswordlessSupabaseCliDatabaseUrl("not a url at all");
    expect(result.ok).toBe(false);
  });

  it("rejects a non-postgres protocol", () => {
    const result = buildPasswordlessSupabaseCliDatabaseUrl("https://sourceuser:pass@db.example.com:5432/mydb");
    expect(result.ok).toBe(false);
  });

  it("rejects a URL with no username", () => {
    const result = buildPasswordlessSupabaseCliDatabaseUrl("postgres://db.example.com:5432/mydb");
    expect(result.ok).toBe(false);
  });

  it("rejects a URL with no database path", () => {
    const result = buildPasswordlessSupabaseCliDatabaseUrl("postgres://sourceuser:pass@db.example.com:5432");
    expect(result.ok).toBe(false);
  });

  it("fails closed on a passfile query parameter (credential/file redirection)", () => {
    const result = buildPasswordlessSupabaseCliDatabaseUrl("postgres://sourceuser:pass@db.example.com:5432/mydb?passfile=/etc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/passfile/i);
  });

  it("fails closed on a servicefile query parameter", () => {
    const result = buildPasswordlessSupabaseCliDatabaseUrl("postgres://sourceuser:pass@db.example.com:5432/mydb?servicefile=/tmp/evil.conf");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/servicefile/i);
  });

  it("fails closed on an sslkey/sslcert query parameter (arbitrary local file reference)", () => {
    const result = buildPasswordlessSupabaseCliDatabaseUrl("postgres://sourceuser:pass@db.example.com:5432/mydb?sslkey=/tmp/attacker-key");
    expect(result.ok).toBe(false);
  });

  it("fails closed on any query parameter outside the reviewed allowlist, even an innocuous-looking one", () => {
    const result = buildPasswordlessSupabaseCliDatabaseUrl("postgres://sourceuser:pass@db.example.com:5432/mydb?application_name=myapp");
    expect(result.ok).toBe(false);
  });
});
