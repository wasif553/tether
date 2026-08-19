/**
 * Canonical email normalization — see src/lib/identityEmail.ts and
 * docs/lti-identity-collision-hardening-v1.md. Pure unit tests, no DB.
 */
import { describe, expect, it } from "vitest";
import { normalizeIdentityEmail } from "./identityEmail";

describe("normalizeIdentityEmail", () => {
  it("2. lowercases a mixed-case email", () => {
    expect(normalizeIdentityEmail("Student@Example.org")).toBe("student@example.org");
  });

  it("3. trims leading/trailing whitespace", () => {
    expect(normalizeIdentityEmail("  stanley.wisoky@example.org  ")).toBe("stanley.wisoky@example.org");
  });

  it("combines trim and lowercase, matching the exact motivating example", () => {
    expect(normalizeIdentityEmail(" Stanley.Wisoky@Example.org ")).toBe("stanley.wisoky@example.org");
  });

  it("1. matches the self-service onboarding convention (trim().toLowerCase()) for representative inputs", () => {
    const selfServiceConvention = (value: string) => value.trim().toLowerCase();
    const samples = [" Student@Example.ORG ", "a.b+tag@Sub.Example.com", "already-lower@example.org"];
    for (const sample of samples) {
      expect(normalizeIdentityEmail(sample)).toBe(selfServiceConvention(sample));
    }
  });

  it("is idempotent", () => {
    const once = normalizeIdentityEmail(" Mixed.Case@Example.ORG ");
    expect(normalizeIdentityEmail(once)).toBe(once);
  });
});
