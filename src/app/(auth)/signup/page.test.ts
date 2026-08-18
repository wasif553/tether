/**
 * Self-Service Account Onboarding v1 — signup page wording/behavior. See
 * docs/self-service-account-onboarding-v1.md.
 *
 * No jsdom/React-Testing-Library infrastructure exists in this repo (see
 * other *.test.ts files for the same convention) — these assert directly
 * on the page's source text.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const pageSource = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");
const flat = pageSource.replace(/\s+/g, " ");

describe("signup page — role toggle and field sets", () => {
  it("offers a Student/Lecturer toggle, not a raw select", () => {
    expect(pageSource).toMatch(/>\s*Student\s*</);
    expect(pageSource).toMatch(/>\s*Lecturer\s*</);
  });

  it("only shows the organisation-name field for LECTURER", () => {
    expect(pageSource).toMatch(/role === "LECTURER" &&[\s\S]*organisationName/);
  });

  it("shows the correct helper copy per role, never overclaiming an unimplemented connection mechanism", () => {
    expect(flat).toMatch(/Your account is ready immediately\. Exams will appear when you are given access\./);
    expect(flat).toMatch(/This creates a new Tether workspace for your organisation\./);
    expect(pageSource.toLowerCase()).not.toMatch(/canvas.*(already|connect|sync)|course access is already/);
  });

  it("shows the existing-institution note pointing to the invitation flow", () => {
    expect(flat).toMatch(/Already joining an existing Tether institution\? Use the invitation provided by your institution\./);
  });

  it("never exposes institution ID, slug, plan, or technical tenant terminology", () => {
    expect(pageSource.toLowerCase()).not.toMatch(/institutionid|\bslug\b|\bplan\b|\btenant\b/);
  });
});

describe("signup page — preserved behavior", () => {
  it("still auto-signs-in after successful signup", () => {
    expect(pageSource).toMatch(/signIn\("credentials", \{ email, password, redirect: false \}\)/);
  });

  it("still redirects STUDENT to /student and LECTURER to /lecturer", () => {
    expect(pageSource).toMatch(/router\.push\(role === "LECTURER" \? "\/lecturer" : "\/student"\)/);
  });

  it("still has an 'Already have an account? Log in' link", () => {
    expect(flat).toMatch(/Already have an account\?/);
    expect(pageSource).toMatch(/href="\/login"/);
  });

  it("submits role-specific bodies — organisationName only sent for LECTURER", () => {
    const bodyBlock = pageSource.slice(pageSource.indexOf("const body ="), pageSource.indexOf("const res = await fetch"));
    expect(bodyBlock).toMatch(/role === "STUDENT"/);
    expect(bodyBlock).toMatch(/organisationName/);
  });
});
