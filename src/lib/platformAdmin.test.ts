import { describe, expect, it } from "vitest";
import {
  requirePlatformAdmin,
  sanitizeInstitutionSlug,
  validateInstitutionPayload,
  validateInviteLecturerPayload,
} from "./platformAdmin";

describe("sanitizeInstitutionSlug", () => {
  it("lowercases and joins words with single hyphens", () => {
    expect(sanitizeInstitutionSlug("Example University")).toBe("example-university");
  });

  it("strips non-alphanumeric characters", () => {
    expect(sanitizeInstitutionSlug("Foo & Bar, Inc.")).toBe("foo-bar-inc");
  });

  it("collapses repeated separators and trims leading/trailing hyphens", () => {
    expect(sanitizeInstitutionSlug("  --Foo---Bar--  ")).toBe("foo-bar");
  });

  it("is idempotent on an already-clean slug", () => {
    expect(sanitizeInstitutionSlug("already-clean")).toBe("already-clean");
  });
});

describe("requirePlatformAdmin", () => {
  it("returns a 401 response for no session", () => {
    const res = requirePlatformAdmin(null);
    expect(res?.status).toBe(401);
  });

  it("returns a 403 response for an authenticated non-admin", () => {
    const res = requirePlatformAdmin({ user: { id: "u1", role: "LECTURER" } });
    expect(res?.status).toBe(403);
  });

  it("returns null for a PLATFORM_ADMIN", () => {
    const res = requirePlatformAdmin({ user: { id: "u1", role: "PLATFORM_ADMIN" } });
    expect(res).toBeNull();
  });
});

describe("validateInstitutionPayload", () => {
  it("accepts a valid minimal payload and defaults plan to pilot", () => {
    const result = validateInstitutionPayload({ name: "Example University", slug: "Example University" });
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.name).toBe("Example University");
      expect(result.slug).toBe("example-university");
      expect(result.plan).toBe("pilot");
      expect(result.domain).toBeNull();
    }
  });

  it("rejects a missing name", () => {
    const result = validateInstitutionPayload({ slug: "example" });
    expect("error" in result).toBe(true);
  });

  it("rejects a slug that sanitizes to empty", () => {
    const result = validateInstitutionPayload({ name: "Foo", slug: "!!!" });
    expect("error" in result).toBe(true);
  });

  it("rejects a non-object body", () => {
    const result = validateInstitutionPayload(null);
    expect("error" in result).toBe(true);
  });
});

describe("validateInviteLecturerPayload", () => {
  it("accepts a valid payload and normalizes email to lowercase", () => {
    const result = validateInviteLecturerPayload({
      name: "Jane Doe",
      email: "Jane.Doe@Example.EDU",
      password: "temporary-password",
    });
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.email).toBe("jane.doe@example.edu");
    }
  });

  it("rejects an invalid email", () => {
    const result = validateInviteLecturerPayload({ name: "Jane", email: "not-an-email", password: "longenough" });
    expect("error" in result).toBe(true);
  });

  it("rejects a password shorter than 8 characters", () => {
    const result = validateInviteLecturerPayload({ name: "Jane", email: "jane@example.edu", password: "short" });
    expect("error" in result).toBe(true);
  });

  it("rejects a missing name", () => {
    const result = validateInviteLecturerPayload({ email: "jane@example.edu", password: "longenough" });
    expect("error" in result).toBe(true);
  });
});
