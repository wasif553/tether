/**
 * Corrective pass — proves the project-wide database test safety guard
 * in src/lib/prisma.ts. See docs/tether-system-check-v1.md, "Safe
 * DB-backed test execution".
 *
 * Deliberately never lets a real connection attempt happen: an unsafe
 * DATABASE_URL must throw INSIDE createPrismaClient(), before
 * `new PrismaClient(...)` is ever constructed — and a safe (disposable)
 * DATABASE_URL only needs the client to be constructed successfully
 * (Prisma/pg connection pools are lazy — construction alone never
 * dials out), never an actual query. Each test forces a fresh module
 * evaluation via vi.resetModules() AND clears the module's own
 * globalThis cache (see prisma.ts's `globalForPrisma` dev-mode cache) —
 * otherwise a later test could silently observe an earlier test's
 * already-cached client and never re-run the guard at all.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

function clearPrismaGlobalCache(): void {
  delete (globalThis as unknown as { prisma?: unknown }).prisma;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  clearPrismaGlobalCache();
});

describe("src/lib/prisma.ts — project-wide DB-backed test safety guard", () => {
  it("1. throws, before any query, when DATABASE_URL is the shared Supabase pooler URL and VITEST=true", async () => {
    vi.resetModules();
    clearPrismaGlobalCache();
    vi.stubEnv("VITEST", "true");
    vi.stubEnv("DATABASE_URL", "postgresql://postgres.ugckdvbjzauvcovcqebw:fake-password@aws-1-ap-northeast-1.pooler.supabase.com:6543/postgres");
    await expect(import("./prisma")).rejects.toThrow(/release:validate|disposable/i);
  });

  it("also throws for the Supabase direct (non-pooler) hostname", async () => {
    vi.resetModules();
    clearPrismaGlobalCache();
    vi.stubEnv("VITEST", "true");
    vi.stubEnv("DATABASE_URL", "postgresql://postgres:fake-password@db.ugckdvbjzauvcovcqebw.supabase.co:5432/postgres");
    await expect(import("./prisma")).rejects.toThrow(/release:validate|disposable/i);
  });

  it("also throws for a completely unrelated remote Postgres host — only loopback is ever accepted under VITEST", async () => {
    vi.resetModules();
    clearPrismaGlobalCache();
    vi.stubEnv("VITEST", "true");
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@some-other-cloud-db.example.com:5432/db");
    await expect(import("./prisma")).rejects.toThrow(/release:validate|disposable/i);
  });

  it("2. does not throw for a disposable localhost DATABASE_URL under VITEST=true — the sanctioned release:validate shape", async () => {
    vi.resetModules();
    clearPrismaGlobalCache();
    vi.stubEnv("VITEST", "true");
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:55432/disposable_db");
    await expect(import("./prisma")).resolves.toBeDefined();
  });

  it("never runs outside a Vitest process — an unset VITEST env never triggers the guard, so real app runtime (next dev/start, Vercel) is unaffected", async () => {
    vi.resetModules();
    clearPrismaGlobalCache();
    vi.stubEnv("VITEST", "");
    vi.stubEnv("DATABASE_URL", "postgresql://postgres.ugckdvbjzauvcovcqebw:fake-password@aws-1-ap-northeast-1.pooler.supabase.com:6543/postgres");
    await expect(import("./prisma")).resolves.toBeDefined();
  });

  it("the failure message directs the developer to npm run release:validate or a disposable database", async () => {
    vi.resetModules();
    clearPrismaGlobalCache();
    vi.stubEnv("VITEST", "true");
    vi.stubEnv("DATABASE_URL", "postgresql://postgres.ugckdvbjzauvcovcqebw:fake-password@aws-1-ap-northeast-1.pooler.supabase.com:6543/postgres");
    try {
      await import("./prisma");
      expect.unreachable("expected prisma.ts import to throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toMatch(/npm run release:validate/);
      expect(message).toMatch(/disposable/i);
      // Never leaks the fake credentials either.
      expect(message).not.toContain("fake-password");
    }
  });
});
