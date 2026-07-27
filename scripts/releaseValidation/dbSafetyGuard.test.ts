import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  assertDisposableDatabaseUrl,
  assertMatchesExpectedPort,
  requireDisposableDatabaseUrl,
} from "./dbSafetyGuard";

describe("assertDisposableDatabaseUrl", () => {
  it("1. accepts localhost", () => {
    const result = assertDisposableDatabaseUrl("postgresql://user:pass@localhost:55432/db");
    expect(result.ok).toBe(true);
  });

  it("2. accepts 127.0.0.1", () => {
    const result = assertDisposableDatabaseUrl("postgresql://user:pass@127.0.0.1:55432/db");
    expect(result.ok).toBe(true);
  });

  it("3. accepts ::1 (IPv6 loopback, bracketed in the URL)", () => {
    const result = assertDisposableDatabaseUrl("postgresql://user:pass@[::1]:55432/db");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.parsed.hostname).toBe("::1");
  });

  it("4. rejects the Supabase direct hostname", () => {
    const result = assertDisposableDatabaseUrl("postgresql://postgres:pass@db.ugckdvbjzauvcovcqebw.supabase.co:5432/postgres");
    expect(result.ok).toBe(false);
  });

  it("5. rejects the Supabase pooler hostname", () => {
    const result = assertDisposableDatabaseUrl("postgresql://postgres.ugckdvbjzauvcovcqebw:pass@aws-1-ap-northeast-1.pooler.supabase.com:6543/postgres");
    expect(result.ok).toBe(false);
  });

  it("6. rejects the production project reference even if it somehow appeared behind a different hostname", () => {
    // The project reference is embedded in the connection USERNAME for
    // Supabase's pooler, not the hostname — a hostname-only check would
    // miss this entirely, so it must be checked independently.
    const result = assertDisposableDatabaseUrl("postgresql://postgres.ugckdvbjzauvcovcqebw:pass@localhost:5432/postgres");
    expect(result.ok).toBe(false);
  });

  it("7. rejects a generic remote PostgreSQL hostname that isn't Supabase at all", () => {
    const result = assertDisposableDatabaseUrl("postgresql://user:pass@some-other-cloud-db.example.com:5432/db");
    expect(result.ok).toBe(false);
  });

  it("8. rejects an empty URL", () => {
    expect(assertDisposableDatabaseUrl("").ok).toBe(false);
    expect(assertDisposableDatabaseUrl(undefined).ok).toBe(false);
    expect(assertDisposableDatabaseUrl(null).ok).toBe(false);
    expect(assertDisposableDatabaseUrl("   ").ok).toBe(false);
  });

  it("9. rejects a malformed URL", () => {
    const result = assertDisposableDatabaseUrl("not a url at all");
    expect(result.ok).toBe(false);
  });

  it("10. rejects a non-PostgreSQL protocol", () => {
    expect(assertDisposableDatabaseUrl("mysql://user:pass@localhost:3306/db").ok).toBe(false);
    expect(assertDisposableDatabaseUrl("http://localhost:55432/db").ok).toBe(false);
    expect(assertDisposableDatabaseUrl("mongodb://localhost:27017/db").ok).toBe(false);
  });

  it("11. never includes the username or password in a rejection reason", () => {
    const secretUrl = "postgresql://super-secret-user:super-secret-password@evil-remote-host.example.com:5432/db";
    const result = assertDisposableDatabaseUrl(secretUrl);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).not.toContain("super-secret-user");
      expect(result.reason).not.toContain("super-secret-password");
      expect(result.reason).not.toContain(secretUrl);
    }
  });

  it("never includes the username or password in an ACCEPTED result beyond the boolean hasPassword flag", () => {
    const result = assertDisposableDatabaseUrl("postgresql://disposable-user:disposable-password@localhost:55432/disposable_db");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parsed.hasPassword).toBe(true);
      expect(JSON.stringify(result.parsed)).not.toContain("disposable-password");
    }
  });

  it("also rejects when only the raw URL (not the parsed hostname) contains a rejected marker", () => {
    // e.g. a path or query string smuggling in the reject substring —
    // the whole raw URL is checked, not just the parsed hostname field.
    const result = assertDisposableDatabaseUrl("postgresql://user:pass@localhost:5432/pooler.supabase.com");
    expect(result.ok).toBe(false);
  });
});

describe("assertMatchesExpectedPort", () => {
  it("passes through an already-rejected result unchanged", () => {
    const rejected = assertDisposableDatabaseUrl("");
    expect(assertMatchesExpectedPort(rejected, 55432)).toBe(rejected);
  });

  it("accepts when the port matches", () => {
    const result = assertDisposableDatabaseUrl("postgresql://user:pass@localhost:55432/db");
    expect(assertMatchesExpectedPort(result, 55432).ok).toBe(true);
  });

  it("rejects when the port does not match the port this validation run allocated", () => {
    const result = assertDisposableDatabaseUrl("postgresql://user:pass@localhost:55432/db");
    expect(assertMatchesExpectedPort(result, 12345).ok).toBe(false);
  });
});

describe("requireDisposableDatabaseUrl", () => {
  it("returns the parsed value for a safe URL", () => {
    const parsed = requireDisposableDatabaseUrl("postgresql://user:pass@localhost:55432/db");
    expect(parsed.hostname).toBe("localhost");
  });

  it("throws (never returns) for an unsafe URL", () => {
    expect(() => requireDisposableDatabaseUrl("postgresql://user:pass@pooler.supabase.com:5432/db")).toThrow();
  });

  it("throws when the port does not match the expected port", () => {
    expect(() => requireDisposableDatabaseUrl("postgresql://user:pass@localhost:55432/db", 9999)).toThrow();
  });
});

describe("12. the validation runner cannot use the normal repository DATABASE_URL accidentally", () => {
  it("rejects this repository's own .env DATABASE_URL (the real shared Supabase project) if present", () => {
    const envPath = path.resolve(__dirname, "../../.env");
    if (!fs.existsSync(envPath)) {
      // No .env in this environment — nothing to assert against, but this
      // is not a reason to fail; the other Supabase-hostname tests above
      // already cover the same rejection logic directly.
      return;
    }
    const envContents = fs.readFileSync(envPath, "utf8");
    const match = envContents.match(/^DATABASE_URL=(.*)$/m);
    if (!match) return;
    // Strip surrounding quotes the same way dotenv would.
    const realDatabaseUrl = match[1].trim().replace(/^"(.*)"$/, "$1");
    const result = assertDisposableDatabaseUrl(realDatabaseUrl);
    // Intentionally asserted WITHOUT ever printing realDatabaseUrl itself.
    expect(result.ok).toBe(false);
  });

  it("rejects this repository's own .env.local DATABASE_URL if present", () => {
    const envPath = path.resolve(__dirname, "../../.env.local");
    if (!fs.existsSync(envPath)) return;
    const envContents = fs.readFileSync(envPath, "utf8");
    const match = envContents.match(/^DATABASE_URL=(.*)$/m);
    if (!match) return;
    const realDatabaseUrl = match[1].trim().replace(/^"(.*)"$/, "$1");
    const result = assertDisposableDatabaseUrl(realDatabaseUrl);
    expect(result.ok).toBe(false);
  });
});
