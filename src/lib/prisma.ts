import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createPrismaClient() {
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
