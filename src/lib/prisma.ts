import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { assertDisposableDatabaseUrl } from "../../scripts/releaseValidation/dbSafetyGuard";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Project-wide database test safety guard (corrective pass — see
 * docs/tether-system-check-v1.md, "Safe DB-backed test execution").
 *
 * This module is the ONE place every Prisma-touching route AND every
 * DB-backed test file gets its client from (directly, or transitively
 * via `./testInstitution`) — so it is also the one correct place to stop
 * a DB-backed test from ever reaching the shared Preview/Production
 * Supabase database, before ANY query or write can happen.
 *
 * Gated on `process.env.VITEST`, which Vitest itself sets to "true" in
 * every test worker process and is never set outside one — this can
 * never affect `next dev`, `next start`, or a real Vercel deployment,
 * only a `vitest run`. Reuses `assertDisposableDatabaseUrl` from
 * scripts/releaseValidation/dbSafetyGuard.ts — the SAME allow/deny list
 * already used by `npm run release:validate`'s own DATABASE_URL check —
 * rather than maintaining a second, inconsistent copy of the Supabase
 * project-ref/pooler-hostname markers.
 *
 * A direct `npx vitest run src/lib/some.routes.test.ts` against this
 * repository's committed `.env`/`.env.local` (which point at the real
 * shared Supabase project) now throws here, at client-construction time,
 * instead of silently connecting — see the error message below for the
 * sanctioned alternative.
 */
function assertSafeDatabaseUrlForTests(): void {
  if (process.env.VITEST !== "true") return;
  const result = assertDisposableDatabaseUrl(process.env.DATABASE_URL);
  if (!result.ok) {
    throw new Error(
      `Refusing to run a DB-backed test against an unsafe DATABASE_URL (${result.reason}). ` +
        `DB-backed tests must be run via "npm run release:validate" (which provisions a disposable, ` +
        `local-only PostgreSQL container) or against a disposable local database you started yourself — ` +
        `never a direct "vitest run" against this repository's committed DATABASE_URL, which points at ` +
        `the shared Preview/Production Supabase project.`,
    );
  }
}

function createPrismaClient() {
  assertSafeDatabaseUrlForTests();
  // Each serverless invocation gets its own connection pool. Vercel can run
  // many concurrent invocations for one deployment, and each pool's default
  // `max` (10) would multiply across them — under live load testing this
  // exhausted Supabase's pooled connection limit and surfaced as submit/
  // analytics/integrity-events requests failing with 500s under concurrency
  // (see docs/concurrent-exam-pilot-capacity.md). Capping `max` low per
  // instance keeps total connections bounded; the Supabase pooler (PgBouncer/
  // Supavisor) is what actually multiplexes many serverless instances onto
  // the database, not this in-process pool.
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.DATABASE_POOL_MAX ?? 3),
    idleTimeoutMillis: 10_000,
  });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
