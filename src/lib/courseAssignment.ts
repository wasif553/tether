/**
 * Course, Enrolment, Exam Assignment, Scheduling v1 — see
 * docs/course-enrolment-and-exam-assignment.md. Shared validation used
 * by exam create/update so a lecturer can only wire an exam to a course
 * they teach, and can only select students already enrolled in that
 * course (and institution).
 */
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { isPlatformAdmin } from "@/lib/institutionScope";

export class CourseAssignmentError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Verifies the course exists, belongs to the caller's institution, and
 * (for a LECTURER) that the caller teaches it. Returns the course row.
 * Throws CourseAssignmentError with a safe, generic message otherwise —
 * never confirms existence of a course in another institution.
 */
export async function assertCanAssignExamToCourse(session: Session, courseId: string) {
  const course = await prisma.course.findUnique({ where: { id: courseId } });
  if (!course) throw new CourseAssignmentError("Course not found");

  if (isPlatformAdmin(session)) return course;

  if (session.user.institutionId !== course.institutionId) {
    throw new CourseAssignmentError("Course not found");
  }

  const teaches = await prisma.courseEnrollment.findUnique({
    where: { courseId_userId: { courseId, userId: session.user.id } },
  });
  if (!teaches || teaches.role !== "LECTURER") {
    throw new CourseAssignmentError("You do not teach this course");
  }

  return course;
}

/**
 * Verifies every studentId in the list is enrolled as STUDENT in the
 * given course (and therefore already institution-scoped, since course
 * membership was already institution-checked). Throws
 * CourseAssignmentError listing the first invalid id found.
 */
export async function assertStudentsInCourse(courseId: string, studentIds: string[]) {
  if (studentIds.length === 0) return;

  const enrollments = await prisma.courseEnrollment.findMany({
    where: { courseId, userId: { in: studentIds }, role: "STUDENT" },
    select: { userId: true },
  });
  const enrolledIds = new Set(enrollments.map((e) => e.userId));
  const invalid = studentIds.filter((id) => !enrolledIds.has(id));
  if (invalid.length > 0) {
    throw new CourseAssignmentError(
      "One or more selected students are not enrolled in this course",
    );
  }
}
