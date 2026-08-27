export type CourseTeachingTeamTarget = {
  role: "LECTURER" | "STUDENT" | "PLATFORM_ADMIN";
  institutionId: string | null;
};

export type CourseTeachingTeamDecision =
  | { ok: true }
  | { ok: false; code: "NOT_FOUND" | "WRONG_ACCOUNT_TYPE" | "DIFFERENT_INSTITUTION"; message: string };

export function canAddLecturerToCourse(
  target: CourseTeachingTeamTarget | null,
  courseInstitutionId: string,
): CourseTeachingTeamDecision {
  if (!target) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message: "No Tether lecturer account was found for this email.",
    };
  }

  if (target.role !== "LECTURER") {
    return {
      ok: false,
      code: "WRONG_ACCOUNT_TYPE",
      message: "This account is not a Tether lecturer account.",
    };
  }

  if (target.institutionId !== courseInstitutionId) {
    return {
      ok: false,
      code: "DIFFERENT_INSTITUTION",
      message: "This lecturer does not belong to this institution.",
    };
  }

  return { ok: true };
}

export function canRemoveCourseEnrollment(
  actorRole: "LECTURER" | "PLATFORM_ADMIN",
  targetCourseRole: "LECTURER" | "STUDENT",
): boolean {
  if (actorRole === "PLATFORM_ADMIN") return true;
  return targetCourseRole === "STUDENT";
}