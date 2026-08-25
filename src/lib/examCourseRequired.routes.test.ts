/**
 * Course, Exam-per-Course v1 — see docs/exam-course-required-v1.md.
 * Covers: courseId now required on POST /api/exams, authorization
 * (own/other-lecturer/other-institution course), course-scoped listing
 * via GET /api/courses, one course holding multiple exams, legacy
 * courseId=null exams remaining fully supported (load, archive, marks
 * export), and archive/restore preserving courseId.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const { buildLecturerMarksExport } = await import("./lecturerMarksExport");

const examsRoute = await import("../app/api/exams/route");
const examRoute = await import("../app/api/exams/[id]/route");
const coursesRoute = await import("../app/api/courses/route");

function sessionFor(userId: string, role: "LECTURER" | "STUDENT" | "PLATFORM_ADMIN", institutionId: string) {
  return {
    user: { id: userId, email: `${userId}@test.local`, name: userId, role, institutionId },
    expires: new Date(Date.now() + 86400_000).toISOString(),
  };
}

function jsonRequest(method: string, body?: unknown) {
  return new Request("http://test.local/route", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const stamp = Date.now();
const cleanup = { users: [] as string[], exams: [] as string[], courses: [] as string[] };

let instA: string;
let instB: string;
let lecturerA: { id: string };
let lecturerA2: { id: string };
let lecturerB: { id: string };
let studentA: { id: string };
let courseA1: { id: string; name: string; code: string };
let courseA2: { id: string; name: string; code: string };
let courseA3: { id: string; name: string; code: string };
let courseB1: { id: string; name: string; code: string };

beforeAll(async () => {
  const a = await getOrCreateTestInstitution(`exam-course-required-a-${stamp}`);
  const b = await getOrCreateTestInstitution(`exam-course-required-b-${stamp}`);
  instA = a.id;
  instB = b.id;

  const passwordHash = await bcrypt.hash("test-password", 4);
  lecturerA = await prisma.user.create({
    data: { name: "Course Req Lecturer A", email: `course-req-lect-a-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instA },
  });
  lecturerA2 = await prisma.user.create({
    data: { name: "Course Req Lecturer A2", email: `course-req-lect-a2-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instA },
  });
  lecturerB = await prisma.user.create({
    data: { name: "Course Req Lecturer B", email: `course-req-lect-b-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instB },
  });
  studentA = await prisma.user.create({
    data: { name: "Course Req Student A", email: `course-req-stud-a-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instA },
  });
  cleanup.users.push(lecturerA.id, lecturerA2.id, lecturerB.id, studentA.id);

  courseA1 = await prisma.course.create({ data: { institutionId: instA, name: "Programming Fundamentals", code: `ICT112-${stamp}` } });
  courseA2 = await prisma.course.create({ data: { institutionId: instA, name: "Data Structures", code: `ICT113-${stamp}` } });
  courseA3 = await prisma.course.create({ data: { institutionId: instA, name: "Not Taught By A", code: `ICT114-${stamp}` } });
  courseB1 = await prisma.course.create({ data: { institutionId: instB, name: "Other Institution Course", code: `OTH100-${stamp}` } });
  cleanup.courses.push(courseA1.id, courseA2.id, courseA3.id, courseB1.id);

  await prisma.courseEnrollment.create({ data: { courseId: courseA1.id, userId: lecturerA.id, role: "LECTURER" } });
  await prisma.courseEnrollment.create({ data: { courseId: courseA2.id, userId: lecturerA.id, role: "LECTURER" } });
  await prisma.courseEnrollment.create({ data: { courseId: courseA3.id, userId: lecturerA2.id, role: "LECTURER" } });
  await prisma.courseEnrollment.create({ data: { courseId: courseB1.id, userId: lecturerB.id, role: "LECTURER" } });
});

afterAll(async () => {
  await prisma.integrityEvent.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.answer.deleteMany({ where: { submission: { examId: { in: cleanup.exams } } } });
  await prisma.submission.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.question.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.exam.deleteMany({ where: { id: { in: cleanup.exams } } });
  await prisma.courseEnrollment.deleteMany({ where: { courseId: { in: cleanup.courses } } });
  await prisma.course.deleteMany({ where: { id: { in: cleanup.courses } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanup.users } } });
});

async function createLegacyExam(opts: { published?: boolean } = {}) {
  const exam = await prisma.exam.create({
    data: {
      title: `Legacy No-Course Exam ${Date.now()}-${Math.random()}`,
      durationMins: 30,
      createdById: lecturerA.id,
      institutionId: instA,
      published: opts.published ?? true,
      // courseId intentionally omitted — legacy exams predate this requirement.
    },
  });
  cleanup.exams.push(exam.id);
  return exam;
}

describe("exam creation requires a course", () => {
  it("1. lecturer can create an exam in a course they teach", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await examsRoute.POST(jsonRequest("POST", { title: "Mid-Semester Exam", durationMins: 60, courseId: courseA1.id }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.courseId).toBe(courseA1.id);
    cleanup.exams.push(body.id);
  });

  it("2. the course relation is persisted and the exam appears in GET /api/exams?all=true with course metadata", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const createRes = await examsRoute.POST(jsonRequest("POST", { title: "Quiz 1", durationMins: 20, courseId: courseA1.id }));
    const created = await createRes.json();
    cleanup.exams.push(created.id);

    const listRes = await examsRoute.GET(new Request("http://test.local/api/exams?all=true"));
    const list = (await listRes.json()) as Array<{ id: string; course: { id: string; code: string; name: string } | null }>;
    const found = list.find((e) => e.id === created.id);
    expect(found?.course?.id).toBe(courseA1.id);
    expect(found?.course?.code).toBe(courseA1.code);
  });

  it("3. missing courseId is rejected with 'Select a course.'", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await examsRoute.POST(jsonRequest("POST", { title: "No Course Exam", durationMins: 60 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.fieldErrors.courseId[0]).toBe("Select a course.");
  });

  it("4. a non-existent courseId is rejected with the safe generic message", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await examsRoute.POST(jsonRequest("POST", { title: "Bad Course Exam", durationMins: 60, courseId: "does-not-exist" }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("You do not have access to this course.");
  });

  it("5. another institution's course is rejected — never exposes that the course exists", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await examsRoute.POST(jsonRequest("POST", { title: "Cross-Inst Exam", durationMins: 60, courseId: courseB1.id }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("You do not have access to this course.");
  });

  it("6. a course in the same institution taught by a DIFFERENT lecturer is rejected", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await examsRoute.POST(jsonRequest("POST", { title: "Not My Course Exam", durationMins: 60, courseId: courseA3.id }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("You do not have access to this course.");
  });

  it("7. an invalid duration is rejected with 'Enter a valid exam duration.'", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await examsRoute.POST(jsonRequest("POST", { title: "Bad Duration Exam", durationMins: -5, courseId: courseA1.id }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.fieldErrors.durationMins[0]).toBe("Enter a valid exam duration.");
  });
});

describe("course-scoped listing and multiple exams per course", () => {
  it("8. GET /api/courses returns only courses the lecturer teaches", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await coursesRoute.GET(new Request("http://test.local/api/courses"));
    const body = (await res.json()) as Array<{ id: string }>;
    const ids = body.map((c) => c.id);
    expect(ids).toContain(courseA1.id);
    expect(ids).toContain(courseA2.id);
    expect(ids).not.toContain(courseA3.id);
    expect(ids).not.toContain(courseB1.id);
  });

  it("9. one course can contain multiple exams — all appear in that course's exam list", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const r1 = await examsRoute.POST(jsonRequest("POST", { title: "Practical Exam", durationMins: 90, courseId: courseA2.id }));
    const r2 = await examsRoute.POST(jsonRequest("POST", { title: "Final Exam", durationMins: 120, courseId: courseA2.id }));
    const e1 = await r1.json();
    const e2 = await r2.json();
    cleanup.exams.push(e1.id, e2.id);

    const listRes = await examsRoute.GET(new Request("http://test.local/api/exams?all=true"));
    const list = (await listRes.json()) as Array<{ id: string; course: { id: string } | null }>;
    const courseA2ExamIds = list.filter((e) => e.course?.id === courseA2.id).map((e) => e.id);
    expect(courseA2ExamIds).toEqual(expect.arrayContaining([e1.id, e2.id]));
  });
});

describe("legacy courseId=null exams remain fully supported", () => {
  it("10. a legacy exam with no course still loads via GET /api/exams/[id]", async () => {
    const exam = await createLegacyExam();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await examRoute.GET(new Request("http://test.local"), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.courseId).toBeNull();
  });

  it("11. a legacy exam does not crash marks export and exports blank course fields", async () => {
    const exam = await createLegacyExam();
    await prisma.submission.create({ data: { examId: exam.id, studentId: studentA.id, status: "SUBMITTED", submittedAt: new Date() } });
    const data = await buildLecturerMarksExport(exam.id);
    expect(data.courseCode).toBeNull();
    expect(data.rows[0].courseCode).toBeNull();
    expect(data.rows[0].courseName).toBeNull();
  });

  it("12. a legacy exam does not crash archive/restore", async () => {
    const exam = await createLegacyExam();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const archiveRes = await examRoute.PATCH(jsonRequest("PATCH", { archived: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(archiveRes.status).toBe(200);
    const restoreRes = await examRoute.PATCH(jsonRequest("PATCH", { archived: false }), { params: Promise.resolve({ id: exam.id }) });
    expect(restoreRes.status).toBe(200);
    const updated = await prisma.exam.findUnique({ where: { id: exam.id } });
    expect(updated?.archivedAt).toBeNull();
    expect(updated?.courseId).toBeNull();
  });
});

describe("archive/restore preserves course association", () => {
  it("13. archiving a course-linked exam preserves its courseId", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const createRes = await examsRoute.POST(jsonRequest("POST", { title: "Archivable Exam", durationMins: 45, courseId: courseA1.id }));
    const exam = await createRes.json();
    cleanup.exams.push(exam.id);

    await examRoute.PATCH(jsonRequest("PATCH", { archived: true }), { params: Promise.resolve({ id: exam.id }) });
    const archived = await prisma.exam.findUnique({ where: { id: exam.id } });
    expect(archived?.courseId).toBe(courseA1.id);
  });

  it("14. restoring a course-linked exam preserves its courseId", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const createRes = await examsRoute.POST(jsonRequest("POST", { title: "Restorable Exam", durationMins: 45, courseId: courseA1.id }));
    const exam = await createRes.json();
    cleanup.exams.push(exam.id);

    await examRoute.PATCH(jsonRequest("PATCH", { archived: true }), { params: Promise.resolve({ id: exam.id }) });
    await examRoute.PATCH(jsonRequest("PATCH", { archived: false }), { params: Promise.resolve({ id: exam.id }) });
    const restored = await prisma.exam.findUnique({ where: { id: exam.id } });
    expect(restored?.courseId).toBe(courseA1.id);
    expect(restored?.archivedAt).toBeNull();
  });
});

describe("marks export uses the linked course", () => {
  it("15. a newly linked exam exports the correct course code and name", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const createRes = await examsRoute.POST(jsonRequest("POST", { title: "Export Exam", durationMins: 45, courseId: courseA1.id }));
    const exam = await createRes.json();
    cleanup.exams.push(exam.id);
    await prisma.submission.create({ data: { examId: exam.id, studentId: studentA.id, status: "SUBMITTED", submittedAt: new Date() } });

    const data = await buildLecturerMarksExport(exam.id);
    expect(data.courseCode).toBe(courseA1.code);
    expect(data.rows[0].courseCode).toBe(courseA1.code);
    expect(data.rows[0].courseName).toBe(courseA1.name);
  });
});
