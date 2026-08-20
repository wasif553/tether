/**
 * Auth and Token Abuse Protection v1 — core rate-limit primitive tests.
 * See docs/auth-token-abuse-protection-v1.md.
 *
 * Requires the local test Postgres instance (run via
 * `npm run release:validate`) — src/lib/prisma.ts's
 * assertSafeDatabaseUrlForTests guard blocks a plain `vitest run`.
 */
import { afterAll, describe, expect, it } from "vitest";

const { prisma } = await import("../prisma");
const { consumeRateLimit, peekRateLimitBlocked, resetRateLimitBucket, cleanupExpiredRateLimitBuckets } = await import(
  "./rateLimiter"
);

const stamp = Date.now();
const testScopes: string[] = [];

function uniqueScope(name: string): string {
  const scope = `test.${name}.${stamp}.${Math.random().toString(36).slice(2)}`;
  testScopes.push(scope);
  return scope;
}

afterAll(async () => {
  await prisma.securityRateLimitBucket.deleteMany({ where: { scope: { in: testScopes } } });
  await prisma.$disconnect();
});

describe("consumeRateLimit", () => {
  it("allows requests under the threshold and blocks once it's reached", async () => {
    const scope = uniqueScope("basic");
    for (let i = 0; i < 3; i++) {
      const res = await consumeRateLimit({ scope, identifier: "id-a", maxAttempts: 3, windowSeconds: 300 });
      expect(res.allowed).toBe(true);
    }
    const blocked = await consumeRateLimit({ scope, identifier: "id-a", maxAttempts: 3, windowSeconds: 300 });
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("does not grow the stored count past maxAttempts even with further attempts", async () => {
    const scope = uniqueScope("cap");
    for (let i = 0; i < 6; i++) {
      await consumeRateLimit({ scope, identifier: "id-a", maxAttempts: 3, windowSeconds: 300 });
    }
    const row = await prisma.securityRateLimitBucket.findFirst({ where: { scope } });
    expect(row?.count).toBe(3);
  });

  it("different identifiers within the same scope are independent", async () => {
    const scope = uniqueScope("indep-id");
    for (let i = 0; i < 3; i++) {
      await consumeRateLimit({ scope, identifier: "id-a", maxAttempts: 3, windowSeconds: 300 });
    }
    const blockedA = await consumeRateLimit({ scope, identifier: "id-a", maxAttempts: 3, windowSeconds: 300 });
    const allowedB = await consumeRateLimit({ scope, identifier: "id-b", maxAttempts: 3, windowSeconds: 300 });
    expect(blockedA.allowed).toBe(false);
    expect(allowedB.allowed).toBe(true);
  });

  it("different scopes for the same identifier are independent", async () => {
    const scopeA = uniqueScope("scope-a");
    const scopeB = uniqueScope("scope-b");
    for (let i = 0; i < 3; i++) {
      await consumeRateLimit({ scope: scopeA, identifier: "same-id", maxAttempts: 3, windowSeconds: 300 });
    }
    const blockedA = await consumeRateLimit({ scope: scopeA, identifier: "same-id", maxAttempts: 3, windowSeconds: 300 });
    const allowedB = await consumeRateLimit({ scope: scopeB, identifier: "same-id", maxAttempts: 3, windowSeconds: 300 });
    expect(blockedA.allowed).toBe(false);
    expect(allowedB.allowed).toBe(true);
  });

  it("an expired window resets correctly, allowing new attempts", async () => {
    const scope = uniqueScope("expiry");
    await consumeRateLimit({ scope, identifier: "id-a", maxAttempts: 1, windowSeconds: 1 });
    const blocked = await consumeRateLimit({ scope, identifier: "id-a", maxAttempts: 1, windowSeconds: 1 });
    expect(blocked.allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const afterExpiry = await consumeRateLimit({ scope, identifier: "id-a", maxAttempts: 1, windowSeconds: 1 });
    expect(afterExpiry.allowed).toBe(true);
    const row = await prisma.securityRateLimitBucket.findFirst({ where: { scope } });
    expect(row?.count).toBe(1); // fresh window — reset to 1, not accumulated to 2
  });

  it("concurrent requests cannot bypass the threshold (Promise.all)", async () => {
    const scope = uniqueScope("concurrency");
    const results = await Promise.all(
      Array.from({ length: 12 }, () => consumeRateLimit({ scope, identifier: "id-a", maxAttempts: 5, windowSeconds: 300 })),
    );
    const allowedCount = results.filter((r) => r.allowed).length;
    expect(allowedCount).toBe(5);

    const row = await prisma.securityRateLimitBucket.findFirst({ where: { scope } });
    expect(row?.count).toBe(5);

    // A subsequent sequential attempt remains blocked — the burst did not
    // permanently break enforcement.
    const followUp = await consumeRateLimit({ scope, identifier: "id-a", maxAttempts: 5, windowSeconds: 300 });
    expect(followUp.allowed).toBe(false);
  });
});

describe("peekRateLimitBlocked", () => {
  it("is read-only — never increments the bucket", async () => {
    const scope = uniqueScope("peek");
    await peekRateLimitBlocked({ scope, identifier: "id-a", maxAttempts: 3, windowSeconds: 300 });
    await peekRateLimitBlocked({ scope, identifier: "id-a", maxAttempts: 3, windowSeconds: 300 });
    const row = await prisma.securityRateLimitBucket.findFirst({ where: { scope } });
    expect(row).toBeNull();
  });

  it("reports blocked once the threshold is reached via consumeRateLimit", async () => {
    const scope = uniqueScope("peek-blocked");
    for (let i = 0; i < 2; i++) {
      await consumeRateLimit({ scope, identifier: "id-a", maxAttempts: 2, windowSeconds: 300 });
    }
    const peek = await peekRateLimitBlocked({ scope, identifier: "id-a", maxAttempts: 2, windowSeconds: 300 });
    expect(peek.blocked).toBe(true);
  });
});

describe("resetRateLimitBucket", () => {
  it("clears only the targeted (scope, identifier) bucket, leaving others untouched", async () => {
    const scope = uniqueScope("reset");
    await consumeRateLimit({ scope, identifier: "id-a", maxAttempts: 1, windowSeconds: 300 });
    await consumeRateLimit({ scope, identifier: "id-b", maxAttempts: 1, windowSeconds: 300 });

    await resetRateLimitBucket({ scope, identifier: "id-a" });

    const allowedAfterReset = await consumeRateLimit({ scope, identifier: "id-a", maxAttempts: 1, windowSeconds: 300 });
    const stillBlockedB = await consumeRateLimit({ scope, identifier: "id-b", maxAttempts: 1, windowSeconds: 300 });

    expect(allowedAfterReset.allowed).toBe(true); // id-a's bucket was cleared
    expect(stillBlockedB.allowed).toBe(false); // id-b's own bucket is unaffected
  });
});

describe("cleanupExpiredRateLimitBuckets", () => {
  it("deletes only buckets whose window closed before the stale cutoff", async () => {
    const scope = uniqueScope("cleanup");
    await consumeRateLimit({ scope, identifier: "old", maxAttempts: 5, windowSeconds: 300 });
    const oldRow = await prisma.securityRateLimitBucket.findFirst({ where: { scope } });
    await prisma.securityRateLimitBucket.update({
      where: { id: oldRow!.id },
      data: { windowStart: new Date(Date.now() - 999_000) },
    });
    await consumeRateLimit({ scope, identifier: "fresh", maxAttempts: 5, windowSeconds: 300 });

    const deleted = await cleanupExpiredRateLimitBuckets(500);
    expect(deleted).toBeGreaterThanOrEqual(1);

    const remaining = await prisma.securityRateLimitBucket.findMany({ where: { scope } });
    expect(remaining).toHaveLength(1); // only "fresh" survives
    expect(remaining[0].id).not.toBe(oldRow!.id);
  });
});
