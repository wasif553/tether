/**
 * Password Reset v1 — DB-backed route tests. See
 * docs/password-reset-v1.md.
 *
 * Requires the local test Postgres instance (run via
 * `npm run release:validate`) — src/lib/prisma.ts's
 * assertSafeDatabaseUrlForTests guard blocks a plain `vitest run`.
 *
 * One flow for STUDENT and LECTURER alike — most tests run against a
 * STUDENT fixture with an explicit LECTURER case to prove the route never
 * branches on role.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";

const { sendPasswordResetEmailMock } = vi.hoisted(() => ({ sendPasswordResetEmailMock: vi.fn() }));
vi.mock("@/lib/mail/sendPasswordResetEmail", () => ({ sendPasswordResetEmail: sendPasswordResetEmailMock }));

const { prisma } = await import("./prisma");

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function forgotPasswordRequest(email: unknown, headers: Record<string, string> = {}) {
  return new Request("http://test.local/api/auth/forgot-password", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ email }),
  });
}

function resetPasswordRequest(token: unknown, password: unknown) {
  return new Request("http://test.local/api/auth/reset-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, password }),
  });
}

const stamp = Date.now();
const cleanupUserIds: string[] = [];

async function createUser(role: "STUDENT" | "LECTURER", emailOverride?: string) {
  const email = emailOverride ?? `pwreset-${role.toLowerCase()}-${stamp}-${randomBytes(4).toString("hex")}@test.invalid`;
  const passwordHash = await bcrypt.hash("OriginalPassw0rd!", 4);
  const user = await prisma.user.create({
    data: { name: "Test", email, passwordHash, role, institutionId: null },
  });
  cleanupUserIds.push(user.id);
  return user;
}

const originalEnv = { APP_URL: process.env.APP_URL, VERCEL_URL: process.env.VERCEL_URL };
function setEnv(appUrl: string | undefined, vercelUrl: string | undefined) {
  if (appUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = appUrl;
  if (vercelUrl === undefined) delete process.env.VERCEL_URL;
  else process.env.VERCEL_URL = vercelUrl;
}

beforeEach(() => {
  sendPasswordResetEmailMock.mockReset();
  sendPasswordResetEmailMock.mockResolvedValue(undefined);
  setEnv("https://app.example.test", undefined);
});

afterEach(() => {
  setEnv(originalEnv.APP_URL, originalEnv.VERCEL_URL);
});

afterAll(async () => {
  setEnv(originalEnv.APP_URL, originalEnv.VERCEL_URL);
  await prisma.platformAuditLog.deleteMany({ where: { actorId: { in: cleanupUserIds } } });
  await prisma.passwordResetToken.deleteMany({ where: { userId: { in: cleanupUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
});

const GENERIC_MESSAGE = "If an account exists for that email, we've sent password reset instructions.";

describe("POST /api/auth/forgot-password", () => {
  it("2. an existing STUDENT can request a reset", async () => {
    const user = await createUser("STUDENT");
    const { POST } = await import("@/app/api/auth/forgot-password/route");
    const res = await POST(forgotPasswordRequest(user.email));
    expect(res.status).toBe(200);
    expect(sendPasswordResetEmailMock).toHaveBeenCalledTimes(1);
    const row = await prisma.passwordResetToken.findFirst({ where: { userId: user.id } });
    expect(row).not.toBeNull();
  });

  it("3. an existing LECTURER can request a reset — same flow, no role branching", async () => {
    const user = await createUser("LECTURER");
    const { POST } = await import("@/app/api/auth/forgot-password/route");
    const res = await POST(forgotPasswordRequest(user.email));
    expect(res.status).toBe(200);
    expect(sendPasswordResetEmailMock).toHaveBeenCalledTimes(1);
  });

  it("4. email is trim/lowercase normalized for lookup", async () => {
    const user = await createUser("STUDENT");
    const { POST } = await import("@/app/api/auth/forgot-password/route");
    const res = await POST(forgotPasswordRequest(`  ${user.email.toUpperCase()}  `));
    expect(res.status).toBe(200);
    expect(sendPasswordResetEmailMock).toHaveBeenCalledTimes(1);
  });

  it("5 & 6. nonexistent email gets an identical response (status + body) to an existing account", async () => {
    const user = await createUser("STUDENT");
    const { POST } = await import("@/app/api/auth/forgot-password/route");

    const existingRes = await POST(forgotPasswordRequest(user.email));
    const existingBody = await existingRes.json();

    const missingRes = await POST(forgotPasswordRequest(`nobody-${stamp}@test.invalid`));
    const missingBody = await missingRes.json();

    expect(missingRes.status).toBe(existingRes.status);
    expect(missingBody).toEqual(existingBody);
    expect(missingBody.message).toBe(GENERIC_MESSAGE);
    // No email ever attempted for the nonexistent account, and no token
    // row is ever created for an email with no matching User.
    expect(sendPasswordResetEmailMock).toHaveBeenCalledTimes(1); // only the existing-account call above
    const orphanRows = await prisma.passwordResetToken.findMany({
      where: { user: { email: `nobody-${stamp}@test.invalid` } },
    });
    expect(orphanRows).toHaveLength(0);
  });

  it("malformed body (missing/invalid email) still returns the generic response, not a validation error", async () => {
    const { POST } = await import("@/app/api/auth/forgot-password/route");
    const res = await POST(forgotPasswordRequest(undefined));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe(GENERIC_MESSAGE);
  });

  it("7 & 8. only a SHA-256 hash is ever stored — never the plaintext token", async () => {
    const user = await createUser("STUDENT");
    const { POST } = await import("@/app/api/auth/forgot-password/route");
    await POST(forgotPasswordRequest(user.email));

    expect(sendPasswordResetEmailMock).toHaveBeenCalledTimes(1);
    const { resetUrl } = sendPasswordResetEmailMock.mock.calls[0][0] as { to: string; resetUrl: string };
    const plaintextToken = new URL(resetUrl).searchParams.get("token")!;

    const row = await prisma.passwordResetToken.findFirst({ where: { userId: user.id } });
    expect(row).not.toBeNull();
    expect(row!.tokenHash).not.toBe(plaintextToken);
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.tokenHash).toBe(hashToken(plaintextToken));
  });

  it("25. the API response body never contains the plaintext reset token", async () => {
    const user = await createUser("STUDENT");
    const { POST } = await import("@/app/api/auth/forgot-password/route");
    const res = await POST(forgotPasswordRequest(user.email));
    const bodyText = await res.text();

    const { resetUrl } = sendPasswordResetEmailMock.mock.calls[0][0] as { to: string; resetUrl: string };
    const plaintextToken = new URL(resetUrl).searchParams.get("token")!;
    expect(bodyText).not.toContain(plaintextToken);
  });

  it("23 & 24. the reset email is built from {to, resetUrl} only — the trusted reset URL, never a password", async () => {
    const user = await createUser("STUDENT");
    const { POST } = await import("@/app/api/auth/forgot-password/route");
    await POST(forgotPasswordRequest(user.email));

    const callArg = sendPasswordResetEmailMock.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(callArg).sort()).toEqual(["resetUrl", "to"]);
    expect(callArg.to).toBe(user.email);
    expect(String(callArg.resetUrl)).toMatch(/^https:\/\/app\.example\.test\/reset-password\?token=/);
  });

  it("27 & 28. per-user request cooldown suppresses a second email within 60s, without changing the public response", async () => {
    const user = await createUser("STUDENT");
    const { POST } = await import("@/app/api/auth/forgot-password/route");

    const first = await POST(forgotPasswordRequest(user.email));
    const firstBody = await first.json();
    expect(sendPasswordResetEmailMock).toHaveBeenCalledTimes(1);

    const second = await POST(forgotPasswordRequest(user.email));
    const secondBody = await second.json();

    expect(second.status).toBe(first.status);
    expect(secondBody).toEqual(firstBody);
    // Still only the one call from the first request — cooldown blocked a second send.
    expect(sendPasswordResetEmailMock).toHaveBeenCalledTimes(1);

    const rows = await prisma.passwordResetToken.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
  });

  it("26. a provider send failure still returns the generic response and does not leave a live orphan token", async () => {
    sendPasswordResetEmailMock.mockRejectedValueOnce(new Error("simulated provider outage"));
    const user = await createUser("STUDENT");
    const { POST } = await import("@/app/api/auth/forgot-password/route");

    const res = await POST(forgotPasswordRequest(user.email));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe(GENERIC_MESSAGE);

    const rows = await prisma.passwordResetToken.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(0); // best-effort delete removed the undeliverable token
  });

  it("29. missing email-provider configuration fails safely — generic response, no crash", async () => {
    sendPasswordResetEmailMock.mockRejectedValueOnce(
      new Error("Password reset email is not configured (RESEND_API_KEY / PASSWORD_RESET_FROM_EMAIL missing)."),
    );
    const user = await createUser("STUDENT");
    const { POST } = await import("@/app/api/auth/forgot-password/route");
    const res = await POST(forgotPasswordRequest(user.email));
    expect(res.status).toBe(200);
    expect((await res.json()).message).toBe(GENERIC_MESSAGE);
  });

  it("30. APP_URL takes precedence for the trusted reset URL origin", async () => {
    setEnv("https://production.example", "preview-deployment-host.vercel.app");
    const user = await createUser("STUDENT");
    const { POST } = await import("@/app/api/auth/forgot-password/route");
    await POST(forgotPasswordRequest(user.email));
    const { resetUrl } = sendPasswordResetEmailMock.mock.calls[0][0] as { resetUrl: string };
    expect(resetUrl.startsWith("https://production.example/reset-password?token=")).toBe(true);
  });

  it("31. VERCEL_URL is used as a normalized https:// fallback when APP_URL is unset", async () => {
    setEnv(undefined, "preview-deployment-host.vercel.app");
    const user = await createUser("STUDENT");
    const { POST } = await import("@/app/api/auth/forgot-password/route");
    await POST(forgotPasswordRequest(user.email));
    const { resetUrl } = sendPasswordResetEmailMock.mock.calls[0][0] as { resetUrl: string };
    expect(resetUrl.startsWith("https://preview-deployment-host.vercel.app/reset-password?token=")).toBe(true);
  });

  it("32. an attacker-controlled Host header cannot influence the emailed reset URL", async () => {
    setEnv("https://production.example", undefined);
    const user = await createUser("STUDENT");
    const { POST } = await import("@/app/api/auth/forgot-password/route");
    await POST(forgotPasswordRequest(user.email, { Host: "evil.attacker.example", "X-Forwarded-Host": "evil.attacker.example" }));
    const { resetUrl } = sendPasswordResetEmailMock.mock.calls[0][0] as { resetUrl: string };
    expect(resetUrl.startsWith("https://production.example/reset-password?token=")).toBe(true);
    expect(resetUrl).not.toContain("evil.attacker.example");
  });

  it("fails closed (no token created, no email attempted) when neither APP_URL nor VERCEL_URL is configured", async () => {
    setEnv(undefined, undefined);
    const user = await createUser("STUDENT");
    const { POST } = await import("@/app/api/auth/forgot-password/route");
    const res = await POST(forgotPasswordRequest(user.email));
    expect(res.status).toBe(200);
    expect((await res.json()).message).toBe(GENERIC_MESSAGE);
    expect(sendPasswordResetEmailMock).not.toHaveBeenCalled();
    const rows = await prisma.passwordResetToken.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(0);
  });
});

describe("POST /api/auth/reset-password", () => {
  async function requestResetAndGetToken(user: { id: string; email: string }): Promise<string> {
    const { POST } = await import("@/app/api/auth/forgot-password/route");
    await POST(forgotPasswordRequest(user.email));
    const { resetUrl } = sendPasswordResetEmailMock.mock.calls[sendPasswordResetEmailMock.mock.calls.length - 1][0] as {
      resetUrl: string;
    };
    return new URL(resetUrl).searchParams.get("token")!;
  }

  it("13. an unknown token is rejected", async () => {
    const { POST } = await import("@/app/api/auth/reset-password/route");
    const res = await POST(resetPasswordRequest("not-a-real-token-value-xyz", "NewPassw0rd!"));
    expect(res.status).toBe(400);
    expect((await res.json()).ok).toBe(false);
  });

  it("20. a too-short password is rejected", async () => {
    const user = await createUser("STUDENT");
    const token = await requestResetAndGetToken(user);
    const { POST } = await import("@/app/api/auth/reset-password/route");
    const res = await POST(resetPasswordRequest(token, "short1"));
    expect(res.status).toBe(400);

    // The token must remain usable — a rejected-for-length attempt is not a "use".
    const row = await prisma.passwordResetToken.findFirst({ where: { userId: user.id } });
    expect(row!.consumedAt).toBeNull();
  });

  it("11. an expired token is rejected", async () => {
    const user = await createUser("STUDENT");
    const plaintext = randomBytes(32).toString("base64url");
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(plaintext),
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    const { POST } = await import("@/app/api/auth/reset-password/route");
    const res = await POST(resetPasswordRequest(plaintext, "NewPassw0rd!"));
    expect(res.status).toBe(400);
  });

  it("14, 15 & 16. a valid token resets the password — old password fails, new password succeeds", async () => {
    const user = await createUser("STUDENT");
    const token = await requestResetAndGetToken(user);
    const { POST } = await import("@/app/api/auth/reset-password/route");

    const res = await POST(resetPasswordRequest(token, "BrandNewPassw0rd!"));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);

    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await bcrypt.compare("OriginalPassw0rd!", fresh.passwordHash)).toBe(false);
    expect(await bcrypt.compare("BrandNewPassw0rd!", fresh.passwordHash)).toBe(true);
  });

  it("12 & 18. a consumed token cannot be reused", async () => {
    const user = await createUser("STUDENT");
    const token = await requestResetAndGetToken(user);
    const { POST } = await import("@/app/api/auth/reset-password/route");

    const first = await POST(resetPasswordRequest(token, "FirstNewPassw0rd!"));
    expect(first.status).toBe(200);

    const second = await POST(resetPasswordRequest(token, "SecondNewPassw0rd!"));
    expect(second.status).toBe(400);

    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await bcrypt.compare("FirstNewPassw0rd!", fresh.passwordHash)).toBe(true);
  });

  it("17. a successful reset invalidates every other outstanding token for the same user", async () => {
    const user = await createUser("STUDENT");
    const tokenA = await requestResetAndGetToken(user);
    // Advance past the per-account cooldown by backdating token A's row so a
    // second request is allowed to issue token B.
    await prisma.passwordResetToken.updateMany({
      where: { userId: user.id },
      data: { createdAt: new Date(Date.now() - 61_000) },
    });
    const tokenB = await requestResetAndGetToken(user);

    const { POST } = await import("@/app/api/auth/reset-password/route");
    const res = await POST(resetPasswordRequest(tokenB, "NewPassw0rd!"));
    expect(res.status).toBe(200);

    const rows = await prisma.passwordResetToken.findMany({ where: { userId: user.id } });
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.consumedAt !== null)).toBe(true);

    // Token A is now consumed too — attempting to use it fails.
    const reuseA = await POST(resetPasswordRequest(tokenA, "AnotherPassw0rd!"));
    expect(reuseA.status).toBe(400);
  });

  it("19. concurrent double-use of the same token results in exactly one successful reset", async () => {
    const user = await createUser("STUDENT");
    const token = await requestResetAndGetToken(user);
    const { POST } = await import("@/app/api/auth/reset-password/route");

    const [resA, resB] = await Promise.all([
      POST(resetPasswordRequest(token, "RaceWinnerPassw0rd!")),
      POST(resetPasswordRequest(token, "RaceLoserPassw0rd!")),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([200, 400]);

    const winningPassword = resA.status === 200 ? "RaceWinnerPassw0rd!" : "RaceLoserPassw0rd!";
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await bcrypt.compare(winningPassword, fresh.passwordHash)).toBe(true);

    const row = await prisma.passwordResetToken.findFirst({ where: { userId: user.id } });
    expect(row!.consumedAt).not.toBeNull();
  });

  it("audit: a completed reset writes exactly one auth.password_reset_completed entry, with no secret in its metadata", async () => {
    const user = await createUser("STUDENT");
    const token = await requestResetAndGetToken(user);
    const { POST } = await import("@/app/api/auth/reset-password/route");
    await POST(resetPasswordRequest(token, "AuditedNewPassw0rd!"));

    const logs = await prisma.platformAuditLog.findMany({ where: { actorId: user.id, action: "auth.password_reset_completed" } });
    expect(logs).toHaveLength(1);
    expect(logs[0].targetId).toBe(user.id);
    expect(JSON.stringify(logs[0].metadata ?? {})).not.toMatch(/AuditedNewPassw0rd!/);
  });
});
