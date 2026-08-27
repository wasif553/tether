import { describe, expect, it } from "vitest";
import { canAddLecturerToCourse, canRemoveCourseEnrollment } from "./courseTeachingTeam";

describe("canAddLecturerToCourse", () => {
  it("allows a lecturer from the same institution", () => {
    expect(
      canAddLecturerToCourse(
        { role: "LECTURER", institutionId: "inst-1" },
        "inst-1",
      ),
    ).toEqual({ ok: true });
  });

  it("rejects a student account being promoted through course enrolment", () => {
    expect(
      canAddLecturerToCourse(
        { role: "STUDENT", institutionId: "inst-1" },
        "inst-1",
      ),
    ).toMatchObject({ ok: false, code: "WRONG_ACCOUNT_TYPE" });
  });

  it("rejects a lecturer from another institution", () => {
    expect(
      canAddLecturerToCourse(
        { role: "LECTURER", institutionId: "inst-2" },
        "inst-1",
      ),
    ).toMatchObject({ ok: false, code: "DIFFERENT_INSTITUTION" });
  });

  it("rejects an unknown account", () => {
    expect(canAddLecturerToCourse(null, "inst-1")).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
  });
});

describe("canRemoveCourseEnrollment", () => {
  it("allows lecturers to remove students", () => {
    expect(canRemoveCourseEnrollment("LECTURER", "STUDENT")).toBe(true);
  });

  it("prevents lecturers from removing lecturers", () => {
    expect(canRemoveCourseEnrollment("LECTURER", "LECTURER")).toBe(false);
  });

  it("allows platform administrators to remove lecturers", () => {
    expect(canRemoveCourseEnrollment("PLATFORM_ADMIN", "LECTURER")).toBe(true);
  });
});