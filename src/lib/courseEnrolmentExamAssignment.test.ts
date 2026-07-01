/**
 * Course, Enrolment, Exam Assignment, Scheduling v1 — see
 * docs/course-enrolment-and-exam-assignment.md. Covers visibility rules
 * in GET /api/exams/available and access rules in
 * POST /api/exams/[id]/start, plus course-assignment validation in the
 * exam create/update routes.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");

const stamp = Date.now();
const cleanupUserIds: string[] = [];
const cleanupExamIds: string[] = [];
const cleanupCourseIds: string[] = [];

function sessionFor(
  userId: string,
  role: "LECTURER" | "STUDENT" | "PLATFORM_ADMIN",
  institutionId: string,
) {
  return {
    user: { id: userId, email: "test@test.invalid", name: "Test", role, institutionId },
    expires: new Date(Date.now() + 86400_000).toISOString(),
  };
}

async function createUser(email: string, role: "LECTURER" | "STUDENT", institutionId: string) {
  const passwordHash = await bcrypt.hash("password", 4);
  const u = await prisma.user.create({ data: { name: "Test", email, passwordHash, role, institutionId } });
  cleanupUserIds.push(u.id);
  return u;
}

async function createCourse(institutionId: string, code: string) {
  const c = await prisma.course.create({
    data: { institutionId, name: `Course ${code}`, code },
  });
  cleanupCourseIds.push(c.id);
  return c;
}

async function createExam(opts: {
  institutionId: string;
  createdById: string;
  courseId?: string | null;
  assignmentMode?: "COURSE" | "SELECTED_STUDENTS";
  availableFrom?: Date | null;
  availableUntil?: Date | null;
  accessCodeHash?: string | null;
  accessCodeRequired?: boolean;
}) {
  const exam = await prisma.exam.create({
    data: {
      title: `Exam ${stamp}-${Math.random()}`,
      durationMins: 60,
      published: true,
      createdById: opts.createdById,
      institutionId: opts.institutionId,
      courseId: opts.courseId ?? null,
      assignmentMode: opts.assignmentMode ?? "COURSE",
      availableFrom: opts.availableFrom ?? null,
      availableUntil: opts.availableUntil ?? null,
      accessCodeHash: opts.accessCodeHash ?? null,
      accessCodeRequired: opts.accessCodeRequired ?? false,
    },
  });
  cleanupExamIds.push(exam.id);
  return exam;
}

let instA: string;
let instB: string;
let lecturerA: string;
let lecturerAOther: string;
let studentInCourse: string;
let studentNotInCourse: string;
let studentInstB: string;

beforeAll(async () => {
  const a = await getOrCreateTestInstitution(`course-assign-a-${stamp}`);
  const b = await getOrCreateTestInstitution(`course-assign-b-${stamp}`);
  instA = a.id;
  instB = b.id;

  const lect = await createUser(`lect-${stamp}@test.invalid`, "LECTURER", instA);
  lecturerA = lect.id;
  const lectOther = await createUser(`lect-other-${stamp}@test.invalid`, "LECTURER", instA);
  lecturerAOther = lectOther.id;
  const s1 = await createUser(`stud-in-${stamp}@test.invalid`, "STUDENT", instA);
  studentInCourse = s1.id;
  const s2 = await createUser(`stud-out-${stamp}@test.invalid`, "STUDENT", instA);
  studentNotInCourse = s2.id;
  const s3 = await createUser(`stud-instb-${stamp}@test.invalid`, "STUDENT", instB);
  studentInstB = s3.id;
});

afterAll(async () => {
  await prisma.examAssignment.deleteMany({ where: { examId: { in: cleanupExamIds } } });
  await prisma.exam.deleteMany({ where: { id: { in: cleanupExamIds } } });
  await prisma.courseEnrollment.deleteMany({ where: { courseId: { in: cleanupCourseIds } } });
  await prisma.course.deleteMany({ where: { id: { in: cleanupCourseIds } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
});

describe("GET /api/exams/available — course/assignment visibility", () => {
  it("1. student sees same-course published exam (whole-course assignment)", async () => {
    const course = await createCourse(instA, `C1-${stamp}`);
    await prisma.courseEnrollment.create({ data: { courseId: course.id, userId: studentInCourse, role: "STUDENT" } });
    await createExam({ institutionId: instA, createdById: lecturerA, courseId: course.id, assignmentMode: "COURSE" });

    mockAuth.mockResolvedValue(sessionFor(studentInCourse, "STUDENT", instA));
    const { GET } = await import("@/app/api/exams/available/route");
    const res = await GET();
    const exams = await res.json();
    expect(exams.some((e: { title: string }) => e.title.includes(course.code) === false)).toBeDefined();
    expect(exams.length).toBeGreaterThan(0);
  });

  it("2. student does not see another course's exam in the same institution", async () => {
    const courseX = await createCourse(instA, `CX-${stamp}`);
    const courseY = await createCourse(instA, `CY-${stamp}`);
    await prisma.courseEnrollment.create({ data: { courseId: courseX.id, userId: studentInCourse, role: "STUDENT" } });
    const examY = await createExam({ institutionId: instA, createdById: lecturerA, courseId: courseY.id, assignmentMode: "COURSE" });

    mockAuth.mockResolvedValue(sessionFor(studentInCourse, "STUDENT", instA));
    const { GET } = await import("@/app/api/exams/available/route");
    const res = await GET();
    const exams = await res.json();
    expect(exams.find((e: { id: string }) => e.id === examY.id)).toBeUndefined();
  });

  it("3. student does not see another institution's exam", async () => {
    const exam = await createExam({ institutionId: instB, createdById: lecturerA, courseId: null });
    mockAuth.mockResolvedValue(sessionFor(studentInCourse, "STUDENT", instA));
    const { GET } = await import("@/app/api/exams/available/route");
    const res = await GET();
    const exams = await res.json();
    expect(exams.find((e: { id: string }) => e.id === exam.id)).toBeUndefined();
  });

  it("12. legacy institution-wide exam (courseId: null) remains visible to same-institution students", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, courseId: null });
    mockAuth.mockResolvedValue(sessionFor(studentNotInCourse, "STUDENT", instA));
    const { GET } = await import("@/app/api/exams/available/route");
    const res = await GET();
    const exams = await res.json();
    expect(exams.find((e: { id: string }) => e.id === exam.id)).toBeDefined();
  });

  it("legacy exam is invisible to a student in a different institution", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, courseId: null });
    mockAuth.mockResolvedValue(sessionFor(studentInstB, "STUDENT", instB));
    const { GET } = await import("@/app/api/exams/available/route");
    const res = await GET();
    const exams = await res.json();
    expect(exams.find((e: { id: string }) => e.id === exam.id)).toBeUndefined();
  });
});

describe("POST /api/exams/[id]/start — assignment and scheduling enforcement", () => {
  it("4. whole-course assignment: enrolled student can start", async () => {
    const course = await createCourse(instA, `WC-${stamp}`);
    await prisma.courseEnrollment.create({ data: { courseId: course.id, userId: studentInCourse, role: "STUDENT" } });
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, courseId: course.id, assignmentMode: "COURSE" });

    mockAuth.mockResolvedValue(sessionFor(studentInCourse, "STUDENT", instA));
    const { POST } = await import("@/app/api/exams/[id]/start/route");
    const req = new Request(`http://localhost/api/exams/${exam.id}/start`, { method: "POST" });
    const res = await POST(req, { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(201);
  });

  it("6. non-selected course student cannot start a selected-students exam", async () => {
    const course = await createCourse(instA, `SS-${stamp}`);
    await prisma.courseEnrollment.create({ data: { courseId: course.id, userId: studentInCourse, role: "STUDENT" } });
    await prisma.courseEnrollment.create({ data: { courseId: course.id, userId: studentNotInCourse, role: "STUDENT" } });
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, courseId: course.id, assignmentMode: "SELECTED_STUDENTS" });
    await prisma.examAssignment.create({ data: { examId: exam.id, studentId: studentInCourse } });

    mockAuth.mockResolvedValue(sessionFor(studentNotInCourse, "STUDENT", instA));
    const { POST } = await import("@/app/api/exams/[id]/start/route");
    const req = new Request(`http://localhost/api/exams/${exam.id}/start`, { method: "POST" });
    const res = await POST(req, { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(404);

    const submission = await prisma.submission.findUnique({ where: { examId_studentId: { examId: exam.id, studentId: studentNotInCourse } } });
    expect(submission).toBeNull();
  });

  it("7. selected student can start a selected-students exam", async () => {
    const course = await createCourse(instA, `SS2-${stamp}`);
    await prisma.courseEnrollment.create({ data: { courseId: course.id, userId: studentInCourse, role: "STUDENT" } });
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, courseId: course.id, assignmentMode: "SELECTED_STUDENTS" });
    await prisma.examAssignment.create({ data: { examId: exam.id, studentId: studentInCourse } });

    mockAuth.mockResolvedValue(sessionFor(studentInCourse, "STUDENT", instA));
    const { POST } = await import("@/app/api/exams/[id]/start/route");
    const req = new Request(`http://localhost/api/exams/${exam.id}/start`, { method: "POST" });
    const res = await POST(req, { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(201);
  });

  it("8. availableFrom in future blocks start", async () => {
    const exam = await createExam({
      institutionId: instA,
      createdById: lecturerA,
      courseId: null,
      availableFrom: new Date(Date.now() + 3600_000),
    });
    mockAuth.mockResolvedValue(sessionFor(studentNotInCourse, "STUDENT", instA));
    const { POST } = await import("@/app/api/exams/[id]/start/route");
    const req = new Request(`http://localhost/api/exams/${exam.id}/start`, { method: "POST" });
    const res = await POST(req, { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(403);
    const submission = await prisma.submission.findUnique({ where: { examId_studentId: { examId: exam.id, studentId: studentNotInCourse } } });
    expect(submission).toBeNull();
  });

  it("9. availableUntil in past blocks start", async () => {
    const exam = await createExam({
      institutionId: instA,
      createdById: lecturerA,
      courseId: null,
      availableUntil: new Date(Date.now() - 3600_000),
    });
    mockAuth.mockResolvedValue(sessionFor(studentNotInCourse, "STUDENT", instA));
    const { POST } = await import("@/app/api/exams/[id]/start/route");
    const req = new Request(`http://localhost/api/exams/${exam.id}/start`, { method: "POST" });
    const res = await POST(req, { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(403);
  });

  it("10 & 11. access code still required after assignment/time checks pass; wrong code does not create submission", async () => {
    const codeHash = await bcrypt.hash("secret123", 4);
    const exam = await createExam({
      institutionId: instA,
      createdById: lecturerA,
      courseId: null,
      accessCodeHash: codeHash,
      accessCodeRequired: true,
    });
    mockAuth.mockResolvedValue(sessionFor(studentNotInCourse, "STUDENT", instA));
    const { POST } = await import("@/app/api/exams/[id]/start/route");

    const wrongReq = new Request(`http://localhost/api/exams/${exam.id}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessCode: "wrong" }),
    });
    const wrongRes = await POST(wrongReq, { params: Promise.resolve({ id: exam.id }) });
    expect(wrongRes.status).toBe(403);
    const noSubmission = await prisma.submission.findUnique({ where: { examId_studentId: { examId: exam.id, studentId: studentNotInCourse } } });
    expect(noSubmission).toBeNull();

    const rightReq = new Request(`http://localhost/api/exams/${exam.id}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessCode: "secret123" }),
    });
    const rightRes = await POST(rightReq, { params: Promise.resolve({ id: exam.id }) });
    expect(rightRes.status).toBe(201);
  });

  it("12b. legacy institution-wide exam with no schedule starts at any time (access code behaviour unchanged)", async () => {
    const codeHash = await bcrypt.hash("legacycode", 4);
    const exam = await createExam({
      institutionId: instA,
      createdById: lecturerA,
      courseId: null,
      accessCodeHash: codeHash,
      accessCodeRequired: true,
    });
    mockAuth.mockResolvedValue(sessionFor(studentNotInCourse, "STUDENT", instA));
    const { POST } = await import("@/app/api/exams/[id]/start/route");
    const req = new Request(`http://localhost/api/exams/${exam.id}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessCode: "legacycode" }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(201);
  });
});

describe("Course assignment validation (lecturer exam create/update)", () => {
  it("13. lecturer cannot assign exam to a course they do not teach", async () => {
    const course = await createCourse(instA, `NOTTAUGHT-${stamp}`);
    // lecturerAOther teaches nothing; not enrolled as LECTURER on `course`.
    mockAuth.mockResolvedValue(sessionFor(lecturerAOther, "LECTURER", instA));
    const { POST } = await import("@/app/api/exams/route");
    const req = new Request("http://localhost/api/exams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Should fail", durationMins: 30, courseId: course.id }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("14. selected students must belong to the same course", async () => {
    const course = await createCourse(instA, `MEMBERCHECK-${stamp}`);
    await prisma.courseEnrollment.create({ data: { courseId: course.id, userId: lecturerA, role: "LECTURER" } });
    // studentNotInCourse is NOT enrolled in this course.
    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { POST } = await import("@/app/api/exams/route");
    const req = new Request("http://localhost/api/exams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Should fail 2",
        durationMins: 30,
        courseId: course.id,
        assignmentMode: "SELECTED_STUDENTS",
        selectedStudentIds: [studentNotInCourse],
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("lecturer can create an exam for a course they teach, assigned to enrolled students", async () => {
    const course = await createCourse(instA, `OK-${stamp}`);
    await prisma.courseEnrollment.create({ data: { courseId: course.id, userId: lecturerA, role: "LECTURER" } });
    await prisma.courseEnrollment.create({ data: { courseId: course.id, userId: studentInCourse, role: "STUDENT" } });

    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { POST } = await import("@/app/api/exams/route");
    const req = new Request("http://localhost/api/exams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Should succeed",
        durationMins: 30,
        courseId: course.id,
        assignmentMode: "SELECTED_STUDENTS",
        selectedStudentIds: [studentInCourse],
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const created = await res.json();
    cleanupExamIds.push(created.id);

    const assignment = await prisma.examAssignment.findUnique({
      where: { examId_studentId: { examId: created.id, studentId: studentInCourse } },
    });
    expect(assignment).not.toBeNull();
  });
});
