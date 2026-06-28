import { describe, expect, it } from "vitest";
import {
  getSessionInstitutionId,
  isPlatformAdmin,
  requireInstitutionId,
  institutionWhere,
  assertSameInstitution,
  MissingInstitutionError,
  InstitutionAccessError,
} from "./institutionScope";

function sessionWith(institutionId: string | null, role: string) {
  return { user: { institutionId, role } };
}

describe("getSessionInstitutionId", () => {
  it("returns the session's institutionId", () => {
    expect(getSessionInstitutionId(sessionWith("inst-1", "LECTURER"))).toBe("inst-1");
  });

  it("returns null for a session with no institutionId, without throwing", () => {
    expect(getSessionInstitutionId(sessionWith(null, "LECTURER"))).toBeNull();
    expect(getSessionInstitutionId(null)).toBeNull();
  });
});

describe("isPlatformAdmin", () => {
  it("is true only for PLATFORM_ADMIN", () => {
    expect(isPlatformAdmin(sessionWith("inst-1", "PLATFORM_ADMIN"))).toBe(true);
    expect(isPlatformAdmin(sessionWith("inst-1", "LECTURER"))).toBe(false);
    expect(isPlatformAdmin(sessionWith("inst-1", "STUDENT"))).toBe(false);
    expect(isPlatformAdmin(null)).toBe(false);
  });
});

describe("requireInstitutionId", () => {
  it("returns the institutionId when present", () => {
    expect(requireInstitutionId(sessionWith("inst-1", "LECTURER"))).toBe("inst-1");
  });

  it("throws MissingInstitutionError when absent", () => {
    expect(() => requireInstitutionId(sessionWith(null, "LECTURER"))).toThrow(MissingInstitutionError);
  });
});

describe("institutionWhere", () => {
  it("returns a scoped where fragment for a normal session", () => {
    expect(institutionWhere(sessionWith("inst-1", "LECTURER"))).toEqual({ institutionId: "inst-1" });
  });

  it("returns an empty fragment (no filter) for PLATFORM_ADMIN", () => {
    expect(institutionWhere(sessionWith("inst-1", "PLATFORM_ADMIN"))).toEqual({});
    expect(institutionWhere(sessionWith(null, "PLATFORM_ADMIN"))).toEqual({});
  });

  it("throws for a non-admin session with no institutionId", () => {
    expect(() => institutionWhere(sessionWith(null, "LECTURER"))).toThrow(MissingInstitutionError);
  });
});

describe("assertSameInstitution", () => {
  it("passes when institutionId matches", () => {
    expect(() => assertSameInstitution(sessionWith("inst-1", "LECTURER"), "inst-1")).not.toThrow();
  });

  it("throws InstitutionAccessError when institutionId differs", () => {
    expect(() => assertSameInstitution(sessionWith("inst-1", "LECTURER"), "inst-2")).toThrow(
      InstitutionAccessError,
    );
  });

  it("never silently passes a null-vs-null comparison — throws MissingInstitutionError instead", () => {
    expect(() => assertSameInstitution(sessionWith(null, "LECTURER"), null)).toThrow(MissingInstitutionError);
  });

  it("bypasses the check entirely for PLATFORM_ADMIN, even across institutions", () => {
    expect(() => assertSameInstitution(sessionWith("inst-1", "PLATFORM_ADMIN"), "inst-2")).not.toThrow();
    expect(() => assertSameInstitution(sessionWith(null, "PLATFORM_ADMIN"), "inst-2")).not.toThrow();
  });
});
