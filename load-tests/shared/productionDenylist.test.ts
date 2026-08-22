import { describe, it, expect } from "vitest";
import * as productionDenylist from "./productionDenylist.mjs";
import {
  checkLoadTestTargetUrl,
  checkLoadTestDatabaseUrl,
  assertLoadTestEnvironmentIsSafe,
  PRODUCTION_VERCEL_HOSTNAMES,
  LOOPBACK_HOSTNAMES,
} from "./productionDenylist.mjs";

describe("checkLoadTestTargetUrl — production hostname denylist", () => {
  it("rejects every known Production hostname, case-insensitively", () => {
    for (const host of PRODUCTION_VERCEL_HOSTNAMES) {
      for (const candidate of [host, host.toUpperCase(), `https://${host}`]) {
        const url = candidate.startsWith("https://") ? candidate : `https://${candidate}/`;
        const result = checkLoadTestTargetUrl(url);
        expect(result.ok).toBe(false);
      }
    }
  });

  it("rejects the exact canonical Production URL", () => {
    const result = checkLoadTestTargetUrl("https://tether-murex.vercel.app");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("Production");
  });

  it("accepts a distinct dedicated load-test hostname", () => {
    const result = checkLoadTestTargetUrl("https://tether-loadtest-dedicated.vercel.app");
    expect(result.ok).toBe(true);
  });

  it("does NOT block an ordinary per-deployment Preview URL sharing the project's naming scheme — exact match only, never a pattern", () => {
    // This exact hostname was a genuine, legitimate Preview deployment
    // verified earlier in this session — a pattern-based denylist
    // (e.g. /^tether-[a-z0-9]+-tether5\.vercel\.app$/) would have
    // wrongly blocked it too, since ordinary Preview URLs share the same
    // naming scheme as the two non-canonical Production aliases.
    const result = checkLoadTestTargetUrl("https://tether-9yeywfizx-tether5.vercel.app");
    expect(result.ok).toBe(true);
  });

  it("rejects a missing/empty target — there is no default", () => {
    expect(checkLoadTestTargetUrl(undefined).ok).toBe(false);
    expect(checkLoadTestTargetUrl(null).ok).toBe(false);
    expect(checkLoadTestTargetUrl("").ok).toBe(false);
    expect(checkLoadTestTargetUrl("   ").ok).toBe(false);
  });

  it("rejects a malformed URL", () => {
    expect(checkLoadTestTargetUrl("not a url").ok).toBe(false);
  });

  it("rejects a non-https, non-loopback target", () => {
    expect(checkLoadTestTargetUrl("http://tether-loadtest-dedicated.vercel.app").ok).toBe(false);
  });

  it("has no override flag anywhere in the module's exported surface — no ALLOW_PRODUCTION_LOAD_TEST-shaped export exists", () => {
    const moduleExports = Object.keys(productionDenylist);
    for (const name of moduleExports) {
      expect(name.toLowerCase()).not.toContain("allow");
      expect(name.toLowerCase()).not.toContain("override");
      expect(name.toLowerCase()).not.toContain("bypass");
    }
  });
});

describe("checkLoadTestTargetUrl — TETHER_LOCAL_POSTGRES_LOAD_SMOKE_10 loopback exception", () => {
  it("1. accepts http://localhost:<port>", () => {
    const result = checkLoadTestTargetUrl("http://localhost:3001");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.hostname).toBe("localhost");
  });

  it("2. accepts http://127.0.0.1:<port>", () => {
    const result = checkLoadTestTargetUrl("http://127.0.0.1:3001");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.hostname).toBe("127.0.0.1");
  });

  it("3. accepts http://[::1]:<port>", () => {
    const result = checkLoadTestTargetUrl("http://[::1]:3001");
    expect(result.ok).toBe(true);
  });

  it("4. rejects an arbitrary remote http:// host — the loopback exception never widens to a general http:// allowance", () => {
    for (const url of ["http://example.com", "http://198.51.100.7:3001", "http://staging.tether.internal"]) {
      const result = checkLoadTestTargetUrl(url);
      expect(result.ok).toBe(false);
    }
  });

  it("5. still rejects tether-murex.vercel.app even when supplied over http:// — the Production hostname check runs before the loopback branch, never after it", () => {
    const result = checkLoadTestTargetUrl("http://tether-murex.vercel.app");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("Production");
  });

  it("rejects every known Production hostname over http:// too, not only https://", () => {
    for (const host of PRODUCTION_VERCEL_HOSTNAMES) {
      const result = checkLoadTestTargetUrl(`http://${host}`);
      expect(result.ok).toBe(false);
    }
  });

  it("LOOPBACK_HOSTNAMES is exactly the three literal loopback forms — never a network range or wildcard", () => {
    expect([...LOOPBACK_HOSTNAMES].sort()).toEqual(["127.0.0.1", "::1", "localhost"].sort());
  });

  it("https:// continues to work unchanged for a non-Production, non-loopback host", () => {
    expect(checkLoadTestTargetUrl("https://tether-loadtest-dedicated.vercel.app").ok).toBe(true);
  });

  it("http:// on a loopback host with a different port is still accepted — the exception is host-scoped, not port-scoped", () => {
    expect(checkLoadTestTargetUrl("http://127.0.0.1:8080").ok).toBe(true);
    expect(checkLoadTestTargetUrl("http://localhost").ok).toBe(true);
  });
});

describe("checkLoadTestDatabaseUrl — Production Supabase project denylist", () => {
  it("rejects the known Production Supabase project reference embedded in the pooler username", () => {
    const result = checkLoadTestDatabaseUrl("postgresql://postgres.ugckdvbjzauvcovcqebw:pw@aws-0-region.pooler.supabase.com:6543/postgres");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("Production Supabase");
  });

  it("accepts a distinct dedicated Supabase project's connection string", () => {
    const result = checkLoadTestDatabaseUrl("postgresql://postgres.abcdefghijklmnop:pw@aws-0-region.pooler.supabase.com:6543/postgres");
    expect(result.ok).toBe(true);
  });

  it("rejects a missing/empty database URL — there is no fallback to the app's own DATABASE_URL", () => {
    expect(checkLoadTestDatabaseUrl(undefined).ok).toBe(false);
    expect(checkLoadTestDatabaseUrl("").ok).toBe(false);
  });

  it("rejects a non-Postgres protocol", () => {
    expect(checkLoadTestDatabaseUrl("mysql://user:pw@host:3306/db").ok).toBe(false);
  });
});

describe("assertLoadTestEnvironmentIsSafe — combined preflight", () => {
  it("throws when the target URL is Production, even if the database URL is fine", () => {
    expect(() =>
      assertLoadTestEnvironmentIsSafe({
        targetBaseUrl: "https://tether-murex.vercel.app",
        databaseUrl: "postgresql://postgres.abcdefghijklmnop:pw@aws-0-region.pooler.supabase.com:6543/postgres",
      }),
    ).toThrow(/PRODUCTION DENYLIST REFUSED TARGET/);
  });

  it("throws when the database URL is the Production Supabase project, even if the target URL is fine", () => {
    expect(() =>
      assertLoadTestEnvironmentIsSafe({
        targetBaseUrl: "https://tether-loadtest-dedicated.vercel.app",
        databaseUrl: "postgresql://postgres.ugckdvbjzauvcovcqebw:pw@aws-0-region.pooler.supabase.com:6543/postgres",
      }),
    ).toThrow(/PRODUCTION DENYLIST REFUSED DATABASE/);
  });

  it("does not throw when both are genuinely distinct from Production", () => {
    expect(() =>
      assertLoadTestEnvironmentIsSafe({
        targetBaseUrl: "https://tether-loadtest-dedicated.vercel.app",
        databaseUrl: "postgresql://postgres.abcdefghijklmnop:pw@aws-0-region.pooler.supabase.com:6543/postgres",
      }),
    ).not.toThrow();
  });
});
