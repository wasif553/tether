/**
 * Self-Service Account Onboarding v1 — pure validation/slug tests. See
 * docs/self-service-account-onboarding-v1.md. No Prisma, no DB.
 */
import { describe, expect, it } from "vitest";
import {
  studentSignupSchema,
  lecturerSignupSchema,
  selfServiceSignupSchema,
  generateInstitutionSlugCandidate,
} from "./selfServiceSignup";

describe("selfServiceSignupSchema — role discrimination and strictness", () => {
  it("accepts a well-formed STUDENT payload", () => {
    const result = selfServiceSignupSchema.safeParse({
      name: "Ada Lovelace",
      email: "ADA@Example.com",
      password: "password123",
      role: "STUDENT",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe("ada@example.com"); // normalized lowercase
    }
  });

  it("accepts a well-formed LECTURER payload with organisationName", () => {
    const result = selfServiceSignupSchema.safeParse({
      name: "Grace Hopper",
      email: "grace@example.com",
      password: "password123",
      role: "LECTURER",
      organisationName: "Adelaide College",
    });
    expect(result.success).toBe(true);
  });

  it("rejects role: PLATFORM_ADMIN outright — matches neither discriminated-union branch", () => {
    const result = selfServiceSignupSchema.safeParse({
      name: "X",
      email: "x@example.com",
      password: "password123",
      role: "PLATFORM_ADMIN",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a LECTURER payload missing organisationName", () => {
    const result = selfServiceSignupSchema.safeParse({
      name: "X",
      email: "x@example.com",
      password: "password123",
      role: "LECTURER",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a STUDENT payload that includes organisationName — .strict() flags the unrecognized key", () => {
    const result = selfServiceSignupSchema.safeParse({
      name: "X",
      email: "x@example.com",
      password: "password123",
      role: "STUDENT",
      organisationName: "Should not be here",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a caller-supplied institutionId on either branch — never silently dropped", () => {
    const studentResult = selfServiceSignupSchema.safeParse({
      name: "X",
      email: "x@example.com",
      password: "password123",
      role: "STUDENT",
      institutionId: "some-other-institution",
    });
    expect(studentResult.success).toBe(false);

    const lecturerResult = selfServiceSignupSchema.safeParse({
      name: "X",
      email: "x@example.com",
      password: "password123",
      role: "LECTURER",
      organisationName: "Org",
      institutionId: "some-other-institution",
    });
    expect(lecturerResult.success).toBe(false);
  });

  it("rejects a caller-supplied slug", () => {
    const result = selfServiceSignupSchema.safeParse({
      name: "X",
      email: "x@example.com",
      password: "password123",
      role: "LECTURER",
      organisationName: "Org",
      slug: "my-chosen-slug",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed email", () => {
    expect(studentSignupSchema.safeParse({ name: "X", email: "not-an-email", password: "password123", role: "STUDENT" }).success).toBe(false);
  });

  it("rejects a password under 8 characters", () => {
    expect(studentSignupSchema.safeParse({ name: "X", email: "x@example.com", password: "short1", role: "STUDENT" }).success).toBe(false);
  });

  it("trims name and lowercases/trims email", () => {
    const result = studentSignupSchema.safeParse({
      name: "  Ada  ",
      email: "  ADA@EXAMPLE.COM  ",
      password: "password123",
      role: "STUDENT",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("Ada");
      expect(result.data.email).toBe("ada@example.com");
    }
  });

  it("lecturerSignupSchema alone also rejects a missing organisationName (defense in depth beyond the union check)", () => {
    expect(
      lecturerSignupSchema.safeParse({ name: "X", email: "x@example.com", password: "password123", role: "LECTURER" }).success,
    ).toBe(false);
  });
});

describe("generateInstitutionSlugCandidate", () => {
  it("attempt 0 is the sanitized organisation name", () => {
    expect(generateInstitutionSlugCandidate("Adelaide College", 0)).toBe("adelaide-college");
  });

  it("retries (attempt > 0) append a short server-generated suffix distinct from the base", () => {
    const base = generateInstitutionSlugCandidate("Adelaide College", 0);
    const retry1 = generateInstitutionSlugCandidate("Adelaide College", 1);
    const retry2 = generateInstitutionSlugCandidate("Adelaide College", 2);
    expect(retry1.startsWith(`${base}-`)).toBe(true);
    expect(retry2.startsWith(`${base}-`)).toBe(true);
    // Two independent retries must not produce the same suffix (random, not sequential).
    expect(retry1).not.toBe(retry2);
  });

  it("falls back to 'workspace' as the base if the organisation name sanitizes to nothing", () => {
    expect(generateInstitutionSlugCandidate("!!!", 0)).toBe("workspace");
  });
});
