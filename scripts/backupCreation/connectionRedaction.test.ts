/**
 * Production Database Backup Creation v1 — see
 * docs/database-backup-operations-v1.md.
 *
 * Unit tests over the pure connection-string parsing/redaction module
 * only — no database, no Docker, no subprocess.
 */
import { describe, expect, it } from "vitest";
import { redactConnectionStrings, parseBackupSourceUrl, describeConnectionTargetSafely, deriveSupabaseProjectRefSafely, isLoopbackHostname } from "./connectionRedaction";

describe("redactConnectionStrings", () => {
  it("[3][4] scrubs a raw postgres:// connection string out of arbitrary text", () => {
    const text = "connection failed: postgres://myuser:sup3rSecret@db.example.com:5432/mydb — retry later";
    const redacted = redactConnectionStrings(text);
    expect(redacted).not.toContain("sup3rSecret");
    expect(redacted).not.toContain("myuser");
    expect(redacted).not.toContain("db.example.com");
    expect(redacted).toContain("postgres://[REDACTED]");
  });

  it("scrubs a postgresql:// (alternate scheme) connection string", () => {
    const text = "url was postgresql://u:p@host:5432/db and it failed";
    expect(redactConnectionStrings(text)).not.toContain("u:p@host");
  });

  it("scrubs multiple occurrences in the same text", () => {
    const text = "first postgres://a:b@h1:5432/d1 then postgres://c:d@h2:5432/d2";
    const redacted = redactConnectionStrings(text);
    expect(redacted).not.toContain("a:b@h1");
    expect(redacted).not.toContain("c:d@h2");
  });

  it("leaves ordinary text with no connection string unchanged", () => {
    const text = "schema restore failed: relation already exists";
    expect(redactConnectionStrings(text)).toBe(text);
  });
});

describe("parseBackupSourceUrl", () => {
  it("parses a well-formed postgres:// URL", () => {
    const parsed = parseBackupSourceUrl("postgres://myuser:mypass@db.example.com:5432/mydb");
    expect(parsed).not.toBeNull();
    expect(parsed!.hostname).toBe("db.example.com");
    expect(parsed!.port).toBe("5432");
    expect(parsed!.username).toBe("myuser");
    expect(parsed!.password).toBe("mypass");
    expect(parsed!.database).toBe("mydb");
  });

  it("parses postgresql:// as well as postgres://", () => {
    expect(parseBackupSourceUrl("postgresql://u:p@h:5432/d")).not.toBeNull();
  });

  it("returns null for a non-postgres URL", () => {
    expect(parseBackupSourceUrl("https://example.com")).toBeNull();
  });

  it("returns null for a malformed URL", () => {
    expect(parseBackupSourceUrl("not a url at all")).toBeNull();
  });

  it("defaults port to 5432 when omitted", () => {
    const parsed = parseBackupSourceUrl("postgres://u:p@h/d");
    expect(parsed!.port).toBe("5432");
  });
});

describe("describeConnectionTargetSafely", () => {
  it("[3] never includes the username or password", () => {
    const parsed = parseBackupSourceUrl("postgres://secretuser:secretpass@db.example.com:5432/mydb")!;
    const described = describeConnectionTargetSafely(parsed);
    expect(described).not.toContain("secretuser");
    expect(described).not.toContain("secretpass");
    expect(described).toBe("db.example.com:5432/mydb");
  });
});

describe("deriveSupabaseProjectRefSafely", () => {
  it("derives the project ref from a db.<ref>.supabase.co hostname", () => {
    const parsed = parseBackupSourceUrl("postgres://postgres:pw@db.abcdefghijklmnop.supabase.co:5432/postgres")!;
    expect(deriveSupabaseProjectRefSafely(parsed)).toBe("abcdefghijklmnop");
  });

  it("derives the project ref from a pooler username (postgres.<ref>)", () => {
    const parsed = parseBackupSourceUrl("postgres://postgres.abcdefghijklmnop:pw@aws-pooler.supabase.com:6543/postgres")!;
    expect(deriveSupabaseProjectRefSafely(parsed)).toBe("abcdefghijklmnop");
  });

  it("returns null for a non-Supabase host with no matching pattern", () => {
    const parsed = parseBackupSourceUrl("postgres://myuser:pw@localhost:5432/mydb")!;
    expect(deriveSupabaseProjectRefSafely(parsed)).toBeNull();
  });
});

describe("isLoopbackHostname", () => {
  it("recognises localhost, 127.0.0.1, and ::1 as loopback", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
  });

  it("does not treat a real remote hostname as loopback", () => {
    expect(isLoopbackHostname("db.example.com")).toBe(false);
    expect(isLoopbackHostname("db.abcdefghijklmnop.supabase.co")).toBe(false);
  });
});
