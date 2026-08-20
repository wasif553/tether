/**
 * Auth and Token Abuse Protection v1 — login abuse-protection tests. See
 * docs/auth-token-abuse-protection-v1.md.
 *
 * Tests attemptCredentialsLogin() directly — no NextAuth request
 * pipeline needed, since the function takes plain strings, not a
 * Request. Requires the local test Postgres instance (run via
 * `npm run release:validate`) — src/lib/prisma.ts's
 * assertSafeDatabaseUrlForTests guard blocks a plain `vitest run`.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";

const { prisma } = await import("../prisma");
const { attemptCredentialsLogin } = await import("./loginAttempt");
const {
  LOGIN_SOURCE_ACCOUNT_MAX_ATTEMPTS,
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
  return `198.51.100.${(Math.floor(Math.random() * 200) + 1)}-${label}-${stamp}`;
}

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

  it("a successful login resets only its own source+account bucket, not another account's bucket sharing the same source", async () => {
    const userA = await createUser();
    const userB = await createUser();
    const source = uniqueSource("reset-scope");

    // Push B to exactly one failure short of its own limit.
    for (let i = 0; i < LOGIN_SOURCE_ACCOUNT_MAX_ATTEMPTS - 1; i++) {
      await attemptCredentialsLogin({ email: userB.email, password: "WrongPassword!", sourceIp: source });
    }
    // A fails once, then succeeds — A's bucket should be reset to empty.
    await attemptCredentialsLogin({ email: userA.email, password: "WrongPassword!", sourceIp: source });
    const aSuccess = await attemptCredentialsLogin({ email: userA.email, password: "CorrectHorseBattery9!", sourceIp: source });
    expect(aSuccess?.id).toBe(userA.id);

    // A can immediately be "attacked" again from scratch — proving its
    // bucket was genuinely cleared, not just satisfied for one request.
    for (let i = 0; i < LOGIN_SOURCE_ACCOUNT_MAX_ATTEMPTS - 1; i++) {
      const res = await attemptCredentialsLogin({ email: userA.email, password: "WrongPassword!", sourceIp: source });
      expect(res).toBeNull();
    }
    const aStillHasOneAttemptLeft = await attemptCredentialsLogin({
      email: userA.email,
      password: "CorrectHorseBattery9!",
      sourceIp: source,
    });
    expect(aStillHasOneAttemptLeft?.id).toBe(userA.id); // A's post-reset budget was the full amount, not partially consumed

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
  });
});
