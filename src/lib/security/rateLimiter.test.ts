/**
 * Auth and Token Abuse Protection v1 — core rate-limit primitive tests.
 * See docs/auth-token-abuse-protection-v1.md.
 *
 * Security review v2 rewrote this file to match the reserve/release
 * architecture that replaced the first pass's peek-then-consume pattern,
 * and to cover the new fail-closed enforcement behavior and the
 * cleanup race-condition fix.
 *
 * Requires the local test Postgres instance (run via
 * `npm run release:validate`) — src/lib/prisma.ts's
 * assertSafeDatabaseUrlForTests guard blocks a plain `vitest run`.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const { prisma } = await import("../prisma");
const {
  consumeRateLimit,
  releaseRateLimitSlot,
  resetRateLimitBucket,
  reserveRateLimitSlot,
  safeReleaseRateLimitSlot,
  cleanupExpiredRateLimitBuckets,
} = await import("./rateLimiter");
const { RATE_LIMIT_BUCKET_STALE_AFTER_SECONDS } = await import("./rateLimitScopes");

const stamp = Date.now();
const testScopes: string[] = [];

function uniqueScope(name: string): string {
  const scope = `test.${name}.${stamp}.${Math.random().toString(36).slice(2)}`;
  testScopes.push(scope);
  return scope;
}

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe("releaseRateLimitSlot", () => {
  it("decrements the count by exactly one", async () => {
    const scope = uniqueScope("release-one");
    await consumeRateLimit({ scope, identifier: "id-a", maxAttempts: 5, windowSeconds: 300 });
    await consumeRateLimit({ scope, identifier: "id-a", maxAttempts: 5, windowSeconds: 300 });
    await consumeRateLimit({ scope, identifier: "id-a", maxAttempts: 5, windowSeconds: 300 });
    await releaseRateLimitSlot({ scope, identifier: "id-a" });
    const row = await prisma.securityRateLimitBucket.findFirst({ where: { scope } });
    expect(row?.count).toBe(2);
  });

  it("never underflows below zero", async () => {
    const scope = uniqueScope("release-floor");
    await consumeRateLimit({ scope, identifier: "id-a", maxAttempts: 5, windowSeconds: 300 });
    await releaseRateLimitSlot({ scope, identifier: "id-a" });
    await releaseRateLimitSlot({ scope, identifier: "id-a" }); // one extra release beyond what was reserved
    const row = await prisma.securityRateLimitBucket.findFirst({ where: { scope } });
    expect(row?.count).toBe(0);
  });

  it("releasing a nonexistent bucket is a safe no-op", async () => {
    const scope = uniqueScope("release-missing");
    await expect(releaseRateLimitSlot({ scope, identifier: "never-reserved" })).resolves.toBeUndefined();
  });

  it("never clears a DIFFERENT concurrent reservation on the same shared bucket — only ever its own one slot", async () => {
    // Simulates the exact scenario security review v2 flagged: a bucket
    // shared by concurrent callers (e.g. several in-flight guesses
    // against the same account) must never be bulk-cleared by one
    // request's release. Three "reservations" (e.g. two attacker guesses
    // still in flight, one legitimate request that just resolved) share
    // one bucket; releasing the legitimate one must free exactly one
    // slot, leaving the other two concurrent reservations' budget intact.
    const scope = uniqueScope("release-shared");
    for (let i = 0; i < 3; i++) {
      await consumeRateLimit({ scope, identifier: "shared", maxAttempts: 5, windowSeconds: 300 });
    }
    await releaseRateLimitSlot({ scope, identifier: "shared" });
    const row = await prisma.securityRateLimitBucket.findFirst({ where: { scope } });
    expect(row?.count).toBe(2); // the other two "in-flight" reservations are untouched
  });

  it("concurrent releases cannot underflow the count (Promise.all)", async () => {
    const scope = uniqueScope("release-concurrency");
    for (let i = 0; i < 5; i++) {
      await consumeRateLimit({ scope, identifier: "id-a", maxAttempts: 10, windowSeconds: 300 });
    }
    await Promise.all(Array.from({ length: 8 }, () => releaseRateLimitSlot({ scope, identifier: "id-a" })));
    const row = await prisma.securityRateLimitBucket.findFirst({ where: { scope } });
    expect(row?.count).toBe(0); // floored at zero even though 8 releases raced against only 5 reservations
  });
});

describe("resetRateLimitBucket", () => {
  it("clears only the targeted (scope, identifier) bucket entirely, leaving others untouched", async () => {
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

describe("reserveRateLimitSlot (security review v2)", () => {
  it("returns 'reserved' when under the threshold and 'blocked' once exhausted", async () => {
    const scope = uniqueScope("reserve-basic");
    for (let i = 0; i < 3; i++) {
      const res = await reserveRateLimitSlot({ scope, identifier: "id-a", maxAttempts: 3, windowSeconds: 300 });
      expect(res.status).toBe("reserved");
    }
    const blocked = await reserveRateLimitSlot({ scope, identifier: "id-a", maxAttempts: 3, windowSeconds: 300 });
    expect(blocked.status).toBe("blocked");
    if (blocked.status === "blocked") expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("fails CLOSED — returns 'infrastructure_error', never silently 'reserved' — on an unexpected database error", async () => {
    const scope = uniqueScope("reserve-infra-fail");
    const txSpy = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("simulated infrastructure failure"));
    const result = await reserveRateLimitSlot({ scope, identifier: "id-a", maxAttempts: 5, windowSeconds: 300 });
    expect(result.status).toBe("infrastructure_error");
    txSpy.mockRestore();

    // No row was ever written for this failed attempt — a subsequent
    // real call starts a genuinely fresh bucket.
    const row = await prisma.securityRateLimitBucket.findFirst({ where: { scope } });
    expect(row).toBeNull();
  });

  it("triggers opportunistic cleanup of stale buckets as a side effect (production wiring)", async () => {
    const scope = uniqueScope("prod-cleanup-target");
    await consumeRateLimit({ scope, identifier: "stale-one", maxAttempts: 5, windowSeconds: 300 });
    const staleRow = await prisma.securityRateLimitBucket.findFirst({ where: { scope } });
    await prisma.securityRateLimitBucket.update({
      where: { id: staleRow!.id },
      data: { windowStart: new Date(Date.now() - (RATE_LIMIT_BUCKET_STALE_AFTER_SECONDS + 60) * 1000) },
    });

    // Force the low-probability opportunistic-cleanup check inside
    // reserveRateLimitSlot to fire deterministically for this one call,
    // instead of relying on its real ~1-in-500 chance.
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    await reserveRateLimitSlot({ scope: uniqueScope("prod-cleanup-trigger"), identifier: "x", maxAttempts: 5, windowSeconds: 300 });
    randomSpy.mockRestore();

    const survived = await prisma.securityRateLimitBucket.findUnique({ where: { id: staleRow!.id } });
    expect(survived).toBeNull();
  });
});

describe("safeReleaseRateLimitSlot", () => {
  it("swallows an unexpected database error and never throws (best-effort)", async () => {
    const scope = uniqueScope("safe-release-fail");
    const txSpy = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("simulated infrastructure failure"));
    await expect(safeReleaseRateLimitSlot({ scope, identifier: "id-a" })).resolves.toBeUndefined();
    txSpy.mockRestore();
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

  it("security review v2 (race fix): a bucket refreshed after stale-row selection is not deleted, because the DELETE re-checks staleness against current state", async () => {
    // The first pass's cleanup did `find(where: windowStart<cutoff) then
    // delete(where: id in [...ids from the find])` — a two-step pattern
    // where a real concurrent request refreshing a row in the gap
    // between those two steps would still have it deleted, since the
    // delete only checked "was this id in the earlier stale list", not
    // the row's CURRENT state. The fix adds `windowStart < cutoff`
    // directly to the DELETE's own WHERE clause, which Postgres
    // evaluates against each row's live state at execution time.
    //
    // True concurrent timing can't be forced deterministically in a
    // test, so this reproduces the two phases explicitly, with a
    // deliberate refresh injected between them, and confirms the FIXED
    // delete pattern (matching cleanupExpiredRateLimitBuckets's own
    // query shape) leaves the refreshed row alone.
    // Uses a short 2-second window deliberately — consumeRateLimit only
    // resets windowStart to "now" when the window has GENUINELY expired
    // (elapsed >= windowSeconds); a short window makes it easy to
    // trigger a real reset via a subsequent call, which is what "a real
    // concurrent request refreshes this bucket" means below.
    const scope = uniqueScope("cleanup-race");
    await consumeRateLimit({ scope, identifier: "race", maxAttempts: 5, windowSeconds: 2 });
    const row = await prisma.securityRateLimitBucket.findFirst({ where: { scope } });
    // Backdate the row well past its own 2-second window, so the window
    // has genuinely expired, and past a fixed cutoff captured now.
    await prisma.securityRateLimitBucket.update({
      where: { id: row!.id },
      data: { windowStart: new Date(Date.now() - 10_000) },
    });
    const cutoff = new Date(Date.now() - 5_000);

    // Phase 1 — what cleanup's SELECT does.
    const staleIds = await prisma.securityRateLimitBucket.findMany({
      where: { scope, windowStart: { lt: cutoff } },
      select: { id: true },
    });
    expect(staleIds.map((r) => r.id)).toContain(row!.id);

    // A real concurrent request refreshes this exact bucket in the gap
    // between phase 1 (SELECT) and phase 2 (DELETE) below. Since the
    // window genuinely expired (backdated 10s ago, past its own 2s
    // window), this call resets windowStart to "now" — well AFTER the
    // fixed cutoff captured above.
    await consumeRateLimit({ scope, identifier: "race", maxAttempts: 5, windowSeconds: 2 });

    // Phase 2 — the FIXED delete, re-checking staleness at delete time
    // against the SAME fixed cutoff. The refreshed row's windowStart is
    // now well after cutoff, so it no longer matches and survives.
    await prisma.securityRateLimitBucket.deleteMany({
      where: { id: { in: staleIds.map((r) => r.id) }, windowStart: { lt: cutoff } },
    });

    const survived = await prisma.securityRateLimitBucket.findUnique({ where: { id: row!.id } });
    expect(survived).not.toBeNull();
    expect(survived!.windowStart.getTime()).toBeGreaterThan(cutoff.getTime());
  });
});
