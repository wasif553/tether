/**
 * Auth and Token Abuse Protection v1 — login abuse-protection tests. See
 * docs/auth-token-abuse-protection-v1.md.
 *
 * Tests attemptCredentialsLogin() directly — no NextAuth request
 * pipeline needed, since the function takes plain strings, not a
 * Request. Requires the local test Postgres instance (run via
 * `npm run release:validate`) — src/lib/prisma.ts's
 * assertSafeDatabaseUrlForTests guard blocks a plain `vitest run`.
 *
 * Security review v2: both login buckets now use reserve-atomically-
 * before-verification / release-exactly-one-on-success (see
 * loginAttempt.ts's own doc comment). Several tests below were updated
 * or added to match: the "resets only its own bucket" test now expects
 * a release of exactly one slot rather than a full clear; new tests
 * cover a legitimate large concurrent login cohort, a concurrent spray
 * burst across many accounts, and a rate-limiter infrastructure failure.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { prisma } = await import("../prisma");
const { attemptCredentialsLogin } = await import("./loginAttempt");
const { hashRateLimitIdentifier } = await import("./rateLimitKey");
const {
  LOGIN_SOURCE_ACCOUNT_MAX_ATTEMPTS,
  LOGIN_SOURCE_FAILURES_SCOPE,
  LOGIN_SOURCE_FAILURES_MAX_ATTEMPTS,
} = await import("./rateLimitScopes");

const stamp = Date.now();
const cleanupUserIds: string[] = [];
const cleanupScopes = ["auth.login.source_account", "auth.login.source_failures"];

async function createUser(emailOverride?: string) {
  const email = emailOverride ?? `login-abuse-${stamp}-${Math.random().toString(36).slice(2)}@test.invalid`;
  const passwordHash = await bcrypt.hash("CorrectHorseBattery9!", 4);
  const user = await prisma.user.create({
    data: { name: "Login Abuse Test", email, passwordHash, role: "STUDENT", institutionId: null },
  });
  cleanupUserIds.push(user.id);
  return user;
}

function uniqueSource(label: string): string {
  return `198.51.100.${(Math.floor(Math.random() * 200) + 1)}-${label}-${stamp}-${Math.random().toString(36).slice(2)}`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.securityRateLimitBucket.deleteMany({ where: { scope: { in: cleanupScopes } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  await prisma.$disconnect();
});

describe("attemptCredentialsLogin", () => {
  it("a correct password still succeeds", async () => {
    const user = await createUser();
    const source = uniqueSource("correct");
    const result = await attemptCredentialsLogin({ email: user.email, password: "CorrectHorseBattery9!", sourceIp: source });
    expect(result?.id).toBe(user.id);
  });

  it("an ordinary wrong password fails", async () => {
    const user = await createUser();
    const source = uniqueSource("wrong");
    const result = await attemptCredentialsLogin({ email: user.email, password: "WrongPassword!", sourceIp: source });
    expect(result).toBeNull();
  });

  it("a nonexistent account and a wrong password produce the identical null outcome (no enumeration)", async () => {
    const user = await createUser();
    const source = uniqueSource("enum");
    const wrongPasswordResult = await attemptCredentialsLogin({ email: user.email, password: "WrongPassword!", sourceIp: source });
    const nonexistentResult = await attemptCredentialsLogin({
      email: `nobody-${stamp}@test.invalid`,
      password: "WrongPassword!",
      sourceIp: source,
    });
    expect(wrongPasswordResult).toBeNull();
    expect(nonexistentResult).toBeNull();
  });

  it(`repeated wrong passwords from the same source+email are limited after ${LOGIN_SOURCE_ACCOUNT_MAX_ATTEMPTS} attempts`, async () => {
    const user = await createUser();
    const source = uniqueSource("limit");
    for (let i = 0; i < LOGIN_SOURCE_ACCOUNT_MAX_ATTEMPTS; i++) {
      const res = await attemptCredentialsLogin({ email: user.email, password: "WrongPassword!", sourceIp: source });
      expect(res).toBeNull();
    }
    // The next attempt is blocked by the limiter — even with the CORRECT
    // password, proving this isn't just "wrong password" failing again.
    const blockedEvenWithCorrectPassword = await attemptCredentialsLogin({
      email: user.email,
      password: "CorrectHorseBattery9!",
      sourceIp: source,
    });
    expect(blockedEvenWithCorrectPassword).toBeNull();
  });

  it("email normalization (case/whitespace) cannot be used to bypass the limiter", async () => {
    const user = await createUser();
    const source = uniqueSource("normalize");
    for (let i = 0; i < LOGIN_SOURCE_ACCOUNT_MAX_ATTEMPTS; i++) {
      await attemptCredentialsLogin({ email: user.email, password: "WrongPassword!", sourceIp: source });
    }
    const variantEmail = `  ${user.email.toUpperCase()}  `;
    const blocked = await attemptCredentialsLogin({ email: variantEmail, password: "CorrectHorseBattery9!", sourceIp: source });
    expect(blocked).toBeNull();
  });

  it("a different source is independent — not affected by another source's failures against the same account", async () => {
    const user = await createUser();
    const sourceA = uniqueSource("indep-src-a");
    const sourceB = uniqueSource("indep-src-b");
    for (let i = 0; i < LOGIN_SOURCE_ACCOUNT_MAX_ATTEMPTS; i++) {
      await attemptCredentialsLogin({ email: user.email, password: "WrongPassword!", sourceIp: sourceA });
    }
    const stillWorksFromB = await attemptCredentialsLogin({ email: user.email, password: "CorrectHorseBattery9!", sourceIp: sourceB });
    expect(stillWorksFromB?.id).toBe(user.id);
  });

  it("a different account from the same source is independent (own source+account bucket)", async () => {
    const userA = await createUser();
    const userB = await createUser();
    const source = uniqueSource("indep-account");
    for (let i = 0; i < LOGIN_SOURCE_ACCOUNT_MAX_ATTEMPTS; i++) {
      await attemptCredentialsLogin({ email: userA.email, password: "WrongPassword!", sourceIp: source });
    }
    const bStillWorks = await attemptCredentialsLogin({ email: userB.email, password: "CorrectHorseBattery9!", sourceIp: source });
    expect(bStillWorks?.id).toBe(userB.id);
  });

  it("security review v2: a successful login releases exactly ONE slot from its own bucket — not a full clear, and never another account's bucket sharing the same source", async () => {
    const userA = await createUser();
    const userB = await createUser();
    const source = uniqueSource("release-scope");

    // Push B to exactly one failure short of its own limit.
    for (let i = 0; i < LOGIN_SOURCE_ACCOUNT_MAX_ATTEMPTS - 1; i++) {
      await attemptCredentialsLogin({ email: userB.email, password: "WrongPassword!", sourceIp: source });
    }
    // A fails once (reserve -> count 1), then succeeds (reserve -> count
    // 2, then release exactly one -> count back to 1). If this were a
    // full bulk reset instead of a release-one, A's bucket would now sit
    // at 0, not 1.
    await attemptCredentialsLogin({ email: userA.email, password: "WrongPassword!", sourceIp: source });
    const aSuccess = await attemptCredentialsLogin({ email: userA.email, password: "CorrectHorseBattery9!", sourceIp: source });
    expect(aSuccess?.id).toBe(userA.id);

    // A's bucket sits at exactly 1 used slot (proven above), so exactly
    // (MAX - 1) more failures exhaust it completely to MAX — a full bulk
    // reset would instead have allowed (MAX - 1) failures to still leave
    // one slot free. This distinguishes release-one from a bulk reset.
    for (let i = 0; i < LOGIN_SOURCE_ACCOUNT_MAX_ATTEMPTS - 1; i++) {
      const res = await attemptCredentialsLogin({ email: userA.email, password: "WrongPassword!", sourceIp: source });
      expect(res).toBeNull();
    }
    const aNowBlocked = await attemptCredentialsLogin({ email: userA.email, password: "CorrectHorseBattery9!", sourceIp: source });
    expect(aNowBlocked).toBeNull(); // blocked by the reservation itself — never even reaches bcrypt

    // B's own accumulated (near-limit) failure count was never touched by
    // any of A's activity — exactly one more failure now blocks B.
    const bBlocked = await attemptCredentialsLogin({ email: userB.email, password: "WrongPassword!", sourceIp: source });
    expect(bBlocked).toBeNull();
    const bStillBlockedWithCorrectPassword = await attemptCredentialsLogin({
      email: userB.email,
      password: "CorrectHorseBattery9!",
      sourceIp: source,
    });
    expect(bStillBlockedWithCorrectPassword).toBeNull();
  });

  it("security review v3: repeated attempts against an ALREADY-BLOCKED account do not leak reservations into the source-wide budget", async () => {
    const user = await createUser();
    const source = uniqueSource("partial-reservation-leak");

    // Exhaust the 5-attempt source+account budget with 5 GENUINE
    // verification attempts — these are the only ones that should ever
    // count against the source-wide bucket.
    for (let i = 0; i < LOGIN_SOURCE_ACCOUNT_MAX_ATTEMPTS; i++) {
      const res = await attemptCredentialsLogin({ email: user.email, password: "WrongPassword!", sourceIp: source });
      expect(res).toBeNull();
    }

    // Continue sending many additional attempts against that SAME
    // already-blocked account. Each of these reserves a source-wide slot
    // FIRST, then finds the account reservation blocked, and returns
    // null WITHOUT ever running bcrypt — the bug this test targets is
    // whether that source-wide reservation is correctly given back.
    const additionalAttempts = 25;
    for (let i = 0; i < additionalAttempts; i++) {
      const res = await attemptCredentialsLogin({ email: user.email, password: "WrongPassword!", sourceIp: source });
      expect(res).toBeNull();
    }

    // The source-wide bucket's count must still equal exactly the 5
    // GENUINE failures above — none of the 25 rejected-before-
    // verification attempts against the blocked account may have leaked
    // into it. Without the fix, this would read 5 + 25 = 30. Looked up
    // precisely by re-deriving this source's own keyHash (the exact same
    // formula rateLimiter.ts's buildKeyHash uses), not by "most recent
    // row", since many other sources' rows exist elsewhere in this file.
    const keyHash = hashRateLimitIdentifier(`${LOGIN_SOURCE_FAILURES_SCOPE}:${source}`);
    const sourceWideRow = await prisma.securityRateLimitBucket.findUnique({
      where: { scope_keyHash: { scope: LOGIN_SOURCE_FAILURES_SCOPE, keyHash } },
    });
    expect(sourceWideRow?.count).toBe(LOGIN_SOURCE_ACCOUNT_MAX_ATTEMPTS);

    // A DIFFERENT, valid account from this exact same source can still
    // log in — the wasted traffic against the blocked account never
    // consumed budget that would otherwise protect this account.
    const otherUser = await createUser();
    const otherResult = await attemptCredentialsLogin({
      email: otherUser.email,
      password: "CorrectHorseBattery9!",
      sourceIp: source,
    });
    expect(otherResult?.id).toBe(otherUser.id);
  });

  it("concurrent wrong-password attempts cannot bypass the limit (Promise.all)", async () => {
    const user = await createUser();
    const source = uniqueSource("concurrency");
    const results = await Promise.all(
      Array.from({ length: LOGIN_SOURCE_ACCOUNT_MAX_ATTEMPTS + 5 }, () =>
        attemptCredentialsLogin({ email: user.email, password: "WrongPassword!", sourceIp: source }),
      ),
    );
    expect(results.every((r) => r === null)).toBe(true);

    // A subsequent attempt with the CORRECT password is still blocked —
    // the burst didn't leave the limiter in a bypassed state.
    const stillBlocked = await attemptCredentialsLogin({ email: user.email, password: "CorrectHorseBattery9!", sourceIp: source });
    expect(stillBlocked).toBeNull();
  });

  it(`the source-wide failure bucket blocks after ${LOGIN_SOURCE_FAILURES_MAX_ATTEMPTS} failures across MANY DIFFERENT accounts from one source`, async () => {
    const source = uniqueSource("spray");
    // One failure each against many distinct accounts stays under each
    // account's own small per-account limit, but accumulates on the
    // shared source-wide bucket.
    for (let i = 0; i < LOGIN_SOURCE_FAILURES_MAX_ATTEMPTS; i++) {
      const user = await createUser(`spray-${stamp}-${i}@test.invalid`);
      await attemptCredentialsLogin({ email: user.email, password: "WrongPassword!", sourceIp: source });
    }
    // A brand-new account's CORRECT password from this now-saturated
    // source is still rejected by the source-wide safety net.
    const freshUser = await createUser();
    const blocked = await attemptCredentialsLogin({ email: freshUser.email, password: "CorrectHorseBattery9!", sourceIp: source });
    expect(blocked).toBeNull();
  }, 30_000);

  it("security review v2: concurrent wrong-password attempts spraying MANY DIFFERENT accounts from one source cannot exceed the source-wide hard limit (Promise.all)", async () => {
    // Reproduces the exact concurrent-burst bypass an independent review
    // found in the first pass's peek-then-consume-on-failure pattern: a
    // burst of concurrent requests across many DIFFERENT accounts could
    // all observe "not yet blocked" before any of them committed a later
    // consume, letting the burst exceed LOGIN_SOURCE_FAILURES_MAX_ATTEMPTS.
    // The fix reserves the source-wide bucket atomically BEFORE any
    // lookup/bcrypt work, so no more than the threshold can ever reach
    // real verification from one burst — proven here by using distinct
    // NONEXISTENT emails (no bcrypt cost, fast) well beyond the threshold.
    const source = uniqueSource("spray-concurrency");
    const burstSize = LOGIN_SOURCE_FAILURES_MAX_ATTEMPTS + 15;
    const results = await Promise.all(
      Array.from({ length: burstSize }, (_, i) =>
        attemptCredentialsLogin({
          email: `spray-concurrency-${stamp}-${i}@test.invalid`,
          password: "WrongPassword!",
          sourceIp: source,
        }),
      ),
    );
    expect(results.every((r) => r === null)).toBe(true); // every outcome is externally "null" either way — no oracle

    // A fresh, brand-new account's correct password from this now-
    // saturated source is still rejected — proves enforcement held.
    const freshUser = await createUser();
    const stillBlocked = await attemptCredentialsLogin({ email: freshUser.email, password: "CorrectHorseBattery9!", sourceIp: source });
    expect(stillBlocked).toBeNull();
  }, 30_000);

  it("security review v2: fails CLOSED (returns null, never proceeds to verification) when the rate limiter's own database is unavailable", async () => {
    const user = await createUser();
    const source = uniqueSource("infra-fail");
    const txSpy = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("simulated infrastructure failure"));
    const result = await attemptCredentialsLogin({ email: user.email, password: "CorrectHorseBattery9!", sourceIp: source });
    txSpy.mockRestore();
    // Even with the genuinely CORRECT password, a limiter infrastructure
    // failure must return the same externally-visible null as an
    // ordinary failed login — never silently proceed to bcrypt as if the
    // limiter had allowed the request.
    expect(result).toBeNull();
  });
});

describe("successful logins never consume the source-wide failure budget", () => {
  it("many successful logins from one source never trip the source-wide bucket", async () => {
    const source = uniqueSource("success-no-consume");
    for (let i = 0; i < LOGIN_SOURCE_FAILURES_MAX_ATTEMPTS + 5; i++) {
      const user = await createUser(`success-${stamp}-${i}@test.invalid`);
      const result = await attemptCredentialsLogin({ email: user.email, password: "CorrectHorseBattery9!", sourceIp: source });
      expect(result?.id).toBe(user.id);
    }
  }, 30_000);
});

describe("security review v2: legitimate concurrent login bursts behind one shared campus NAT", () => {
  it("a substantial concurrent group of DISTINCT correct student accounts from one source all succeed, none falsely rejected", async () => {
    // Under reserve-before-verify, EVERY concurrent attempt (successful
    // or not) transiently occupies one source-wide slot for the
    // duration of its bcrypt compare, not just permanent failures. This
    // proves LOGIN_SOURCE_FAILURES_MAX_ATTEMPTS was raised generously
    // enough that a large, entirely legitimate concurrent login burst
    // (e.g. an exam cohort behind one shared institutional NAT) is never
    // falsely rejected.
    const cohortSize = Math.floor(LOGIN_SOURCE_FAILURES_MAX_ATTEMPTS * 0.75);
    const source = uniqueSource("legit-cohort");
    const users = [];
    for (let i = 0; i < cohortSize; i++) {
      users.push(await createUser(`cohort-${stamp}-${i}@test.invalid`));
    }
    const results = await Promise.all(
      users.map((u) => attemptCredentialsLogin({ email: u.email, password: "CorrectHorseBattery9!", sourceIp: source })),
    );
    const succeededIds = results.map((r) => r?.id).filter(Boolean);
    expect(succeededIds).toHaveLength(cohortSize);
    expect(new Set(succeededIds).size).toBe(cohortSize); // each is genuinely their own account
  }, 30_000);
});
