/**
 * Password Reset v1 — forgot-password page wording/behavior. See
 * docs/password-reset-v1.md. Source-text assertions — see
 * src/app/(auth)/signup/page.test.ts for the established convention.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const pageSource = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");
const flat = pageSource.replace(/\s+/g, " ");

describe("forgot-password page", () => {
  it("shows the specified title and copy", () => {
    expect(flat).toMatch(/Forgot password\?/);
    expect(flat).toMatch(/Enter your email and we&apos;ll send you instructions to reset your password\./);
  });

  it("shows the generic post-submission confirmation, not an existence-revealing message", () => {
    expect(flat).toMatch(/Check your email/);
    expect(flat).toMatch(/If an account exists for that email, we&apos;ve sent password reset instructions\./);
  });

  it("offers 'Back to log in'", () => {
    expect(flat).toMatch(/Back to log in/);
    expect(pageSource).toMatch(/href="\/login"/);
  });

  it("shows the confirmation state unconditionally after submit, regardless of the fetch outcome", () => {
    // The response body is never inspected before flipping to the
    // "submitted" state — that's what keeps this page from ever being
    // able to distinguish an existing account from a nonexistent one.
    expect(pageSource).not.toMatch(/res\.(ok|status|json)/);
    expect(pageSource).toMatch(/setSubmitted\(true\)/);
  });
});
