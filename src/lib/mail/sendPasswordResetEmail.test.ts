/**
 * Password Reset v1 — mail adapter unit test (no network call). See
 * docs/password-reset-v1.md.
 *
 * Only exercises the fail-closed configuration guard, which runs before
 * any Resend SDK call is made — no fetch/network mocking is needed for
 * this case. Sending a real email is never exercised in this test suite;
 * route-level tests mock this whole module instead (see
 * src/lib/passwordReset.routes.test.ts).
 */
import { afterEach, describe, expect, it } from "vitest";

const originalEnv = {
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  PASSWORD_RESET_FROM_EMAIL: process.env.PASSWORD_RESET_FROM_EMAIL,
};

afterEach(() => {
  if (originalEnv.RESEND_API_KEY === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = originalEnv.RESEND_API_KEY;
  if (originalEnv.PASSWORD_RESET_FROM_EMAIL === undefined) delete process.env.PASSWORD_RESET_FROM_EMAIL;
  else process.env.PASSWORD_RESET_FROM_EMAIL = originalEnv.PASSWORD_RESET_FROM_EMAIL;
});

describe("sendPasswordResetEmail — fails closed on missing configuration", () => {
  it("29. throws (never sends) when RESEND_API_KEY is missing", async () => {
    delete process.env.RESEND_API_KEY;
    process.env.PASSWORD_RESET_FROM_EMAIL = "Tether <no-reply@example.com>";
    const { sendPasswordResetEmail } = await import("./sendPasswordResetEmail");
    await expect(sendPasswordResetEmail({ to: "user@example.com", resetUrl: "https://app.example/reset-password?token=x" })).rejects.toThrow(
      /not configured/,
    );
  });

  it("29. throws (never sends) when PASSWORD_RESET_FROM_EMAIL is missing", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    delete process.env.PASSWORD_RESET_FROM_EMAIL;
    const { sendPasswordResetEmail } = await import("./sendPasswordResetEmail");
    await expect(sendPasswordResetEmail({ to: "user@example.com", resetUrl: "https://app.example/reset-password?token=x" })).rejects.toThrow(
      /not configured/,
    );
  });
});
