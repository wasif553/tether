/**
 * Password Reset v1 — reset-password page wording/behavior. See
 * docs/password-reset-v1.md. Source-text assertions — see
 * src/app/(auth)/signup/page.test.ts for the established convention (no
 * jsdom/React-Testing-Library infrastructure in this repo).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const pageSource = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");
const flat = pageSource.replace(/\s+/g, " ");

describe("reset-password page", () => {
  it("21. rejects a client-side password/confirm-password mismatch before submitting", () => {
    expect(pageSource).toMatch(/password !== confirmPassword/);
    expect(flat).toMatch(/Passwords do not match/);
  });

  it("rejects a too-short password client-side, matching the 8-character signup minimum", () => {
    expect(pageSource).toMatch(/password\.length < 8/);
  });

  it("shows the same generic invalid/expired message for missing, unknown, expired, or consumed tokens", () => {
    expect(flat).toMatch(/This password reset link is invalid or has expired\./);
    // No wording anywhere distinguishes "expired" from "already used" from "unknown".
    expect(pageSource.toLowerCase()).not.toMatch(/already (used|consumed)|no longer valid because/);
  });

  it("offers 'Request a new reset link' pointing at /forgot-password", () => {
    expect(flat).toMatch(/Request a new reset link/);
    expect(pageSource).toMatch(/href="\/forgot-password"/);
  });

  it("shows the success state copy and a Log in link, never the token itself", () => {
    expect(flat).toMatch(/Your password has been updated\./);
    expect(pageSource).toMatch(/href="\/login"/);
    // The token is only ever read into a variable and sent in the POST
    // body — never interpolated into any rendered JSX text.
    expect(pageSource).not.toMatch(/\{token\}/);
  });
});
