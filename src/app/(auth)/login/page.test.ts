/**
 * Password Reset v1 — login page addition. See docs/password-reset-v1.md.
 *
 * No jsdom/React-Testing-Library infrastructure exists in this repo (see
 * src/app/(auth)/signup/page.test.ts for the same convention) — this
 * asserts directly on the page's source text.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const pageSource = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");
const flat = pageSource.replace(/\s+/g, " ");

describe("login page — Forgot password link", () => {
  it("1. shows a 'Forgot password?' link near the password field, pointing at /forgot-password", () => {
    expect(flat).toMatch(/Forgot password\?/);
    expect(pageSource).toMatch(/href="\/forgot-password"/);
  });

  it("preserves existing sign-in/callback/signup-link behavior", () => {
    expect(pageSource).toMatch(/signIn\("credentials", \{ email, password, redirect: false \}\)/);
    expect(pageSource).toMatch(/isSafeAppCallbackUrl/);
    expect(pageSource).toMatch(/href="\/signup"/);
  });
});
