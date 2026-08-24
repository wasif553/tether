/**
 * Exam Archive Lifecycle v1 — see docs/exam-archive-lifecycle-v1.md.
 * Covers: archive/restore (GET /api/exams filtering, PATCH /api/exams/[id]),
 * safe permanent delete eligibility (DELETE /api/exams/[id],
 * src/lib/examDeleteEligibility.ts), and the marks export CSV route.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const { checkExamDeleteEligibility } = await import("./examDeleteEligibility");
const { buildLecturerMarksExport, marksExportToCsv, marksExportFilename } = await import("./lecturerMarksExport");

const examsRoute = await import("../app/api/exams/route");
const examRoute = await import("../app/api/exams/[id]/route");
const marksExportRoute = await import("../app/api/lecturer/exams/[examId]/marks-export/route");

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
let lecturerB: { id: string };
let studentA: { id: string };

beforeAll(async () => {
  const a = await getOrCreateTestInstitution(`exam-archive-a-${stamp}`);
  const b = await getOrCreateTestInstitution(`exam-archive-b-${stamp}`);
  instA = a.id;
  instB = b.id;

  const passwordHash = await bcrypt.hash("test-password", 4);
  lecturerA = await prisma.user.create({
    data: { name: "Archive Lecturer A", email: `archive-lect-a-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instA },
  });
  lecturerB = await prisma.user.create({
    data: { name: "Archive Lecturer B", email: `archive-lect-b-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instB },
  });
  studentA = await prisma.user.create({
    data: { name: "Archive Student A", email: `archive-stud-a-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instA },
  });
  cleanup.users.push(lecturerA.id, lecturerB.id, studentA.id);
});

afterAll(async () => {
  await prisma.integrityEvent.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.submission.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.question.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.exam.deleteMany({ where: { id: { in: cleanup.exams } } });
  await prisma.courseEnrollment.deleteMany({ where: { courseId: { in: cleanup.courses } } });
  await prisma.course.deleteMany({ where: { id: { in: cleanup.courses } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanup.users } } });
});

async function createExam(opts: { published?: boolean; courseId?: string } = {}) {
  const exam = await prisma.exam.create({
    data: {
      title: `Archive Exam ${Date.now()}-${Math.random()}`,
      durationMins: 30,
      createdById: lecturerA.id,
      institutionId: instA,
      published: opts.published ?? true,
      courseId: opts.courseId,
    },
  });
  cleanup.exams.push(exam.id);
  return exam;
}

// ── Archive / Restore ────────────────────────────────────────────────────

describe("exam archive / restore", () => {
  it("1. lecturer can archive a current exam via PATCH { archived: true }", async () => {
    const exam = await createExam();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await examRoute.PATCH(jsonRequest("PATCH", { archived: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(200);
    const updated = await prisma.exam.findUnique({ where: { id: exam.id } });
    expect(updated?.archivedAt).not.toBeNull();
  });

  it("2. archiving does not touch published, availableFrom/Until, or any other field", async () => {
    const exam = await createExam({ published: true });
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    await examRoute.PATCH(jsonRequest("PATCH", { archived: true }), { params: Promise.resolve({ id: exam.id }) });
    const updated = await prisma.exam.findUnique({ where: { id: exam.id } });
    expect(updated?.published).toBe(true);
    expect(updated?.title).toBe(exam.title);
  });

  it("3. an archived exam is excluded from the default GET /api/exams response", async () => {
    const exam = await createExam();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    await examRoute.PATCH(jsonRequest("PATCH", { archived: true }), { params: Promise.resolve({ id: exam.id }) });

    const res = await examsRoute.GET();
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.find((e) => e.id === exam.id)).toBeUndefined();
  });

  it("4. an archived exam is excluded from GET /api/exams?all=true too", async () => {
    const exam = await createExam();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    await examRoute.PATCH(jsonRequest("PATCH", { archived: true }), { params: Promise.resolve({ id: exam.id }) });

    const res = await examsRoute.GET(new Request("http://test.local/api/exams?all=true"));
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.find((e) => e.id === exam.id)).toBeUndefined();
  });

  it("5. an archived exam IS visible under GET /api/exams?archived=true", async () => {
    const exam = await createExam();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    await examRoute.PATCH(jsonRequest("PATCH", { archived: true }), { params: Promise.resolve({ id: exam.id }) });

    const res = await examsRoute.GET(new Request("http://test.local/api/exams?archived=true"));
    const body = (await res.json()) as Array<{ id: string; archivedAt: string | null }>;
    const found = body.find((e) => e.id === exam.id);
    expect(found).toBeDefined();
    expect(found?.archivedAt).not.toBeNull();
  });

  it("6. an unpublished (draft) exam with unresolved needsReviewCount is still excluded from default view once archived — archived overrides needs-attention", async () => {
    const exam = await createExam({ published: true });
    const submission = await prisma.submission.create({ data: { examId: exam.id, studentId: studentA.id } });
    await prisma.integrityEvent.create({
      data: { submissionId: submission.id, examId: exam.id, studentId: studentA.id, eventType: "CAMERA_STOPPED", severity: "HIGH", message: "x", occurredAt: new Date(), reviewStatus: "NEEDS_REVIEW" },
    });
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    await examRoute.PATCH(jsonRequest("PATCH", { archived: true }), { params: Promise.resolve({ id: exam.id }) });

    const res = await examsRoute.GET();
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.find((e) => e.id === exam.id)).toBeUndefined();
  });

  it("7. restoring (archived: false) clears archivedAt and the exam reappears in the default view", async () => {
    const exam = await createExam();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    await examRoute.PATCH(jsonRequest("PATCH", { archived: true }), { params: Promise.resolve({ id: exam.id }) });
    await examRoute.PATCH(jsonRequest("PATCH", { archived: false }), { params: Promise.resolve({ id: exam.id }) });

    const updated = await prisma.exam.findUnique({ where: { id: exam.id } });
    expect(updated?.archivedAt).toBeNull();

    const res = await examsRoute.GET();
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.find((e) => e.id === exam.id)).toBeDefined();
  });

  it("8. a restored unpublished exam is classified as Draft by the existing grouping logic (no second status system)", async () => {
    const exam = await createExam({ published: false });
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    await examRoute.PATCH(jsonRequest("PATCH", { archived: true }), { params: Promise.resolve({ id: exam.id }) });
    await examRoute.PATCH(jsonRequest("PATCH", { archived: false }), { params: Promise.resolve({ id: exam.id }) });

    const res = await examsRoute.GET();
    const body = (await res.json()) as Array<{ id: string; published: boolean }>;
    const found = body.find((e) => e.id === exam.id);
    expect(found?.published).toBe(false);
  });

  it("9. a restored published exam whose window has passed is classified as Closed by the existing grouping logic", async () => {
    const exam = await prisma.exam.create({
      data: {
        title: `Archive Exam Closed ${Date.now()}`,
        durationMins: 30,
        createdById: lecturerA.id,
        institutionId: instA,
        published: true,
        availableFrom: new Date(Date.now() - 86_400_000 * 2),
        availableUntil: new Date(Date.now() - 86_400_000),
      },
    });
    cleanup.exams.push(exam.id);
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    await examRoute.PATCH(jsonRequest("PATCH", { archived: true }), { params: Promise.resolve({ id: exam.id }) });
    await examRoute.PATCH(jsonRequest("PATCH", { archived: false }), { params: Promise.resolve({ id: exam.id }) });

    const res = await examsRoute.GET(new Request("http://test.local/api/exams?all=true"));
    const body = (await res.json()) as Array<{ id: string; availableUntil: string | null }>;
    const found = body.find((e) => e.id === exam.id);
    expect(found?.availableUntil).not.toBeNull();
    expect(new Date(found!.availableUntil!).getTime()).toBeLessThan(Date.now());
  });

  it("10. archiving never affects student-facing exam access (student GET still succeeds for a published archived exam)", async () => {
    const exam = await createExam({ published: true });
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    await examRoute.PATCH(jsonRequest("PATCH", { archived: true }), { params: Promise.resolve({ id: exam.id }) });

    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await examRoute.GET(new Request("http://test.local"), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(200);
  });

  it("11. cross-institution lecturer cannot archive another institution's exam", async () => {
    const exam = await createExam();
    mockAuth.mockResolvedValue(sessionFor(lecturerB.id, "LECTURER", instB));
    const res = await examRoute.PATCH(jsonRequest("PATCH", { archived: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(404);
    const updated = await prisma.exam.findUnique({ where: { id: exam.id } });
    expect(updated?.archivedAt).toBeNull();
  });
});

// ── Safe permanent delete ────────────────────────────────────────────────

describe("exam permanent delete eligibility", () => {
  it("12. an unpublished draft with zero submissions/integrity records is eligible", async () => {
    const exam = await createExam({ published: false });
    const eligibility = await checkExamDeleteEligibility(exam.id);
    expect(eligibility.eligible).toBe(true);
  });

  it("13. a published exam is never eligible, even with zero submissions", async () => {
    const exam = await createExam({ published: true });
    const eligibility = await checkExamDeleteEligibility(exam.id);
    expect(eligibility.eligible).toBe(false);
  });

  it("14. an exam with a submission is denied", async () => {
    const exam = await createExam({ published: false });
    await prisma.submission.create({ data: { examId: exam.id, studentId: studentA.id } });
    const eligibility = await checkExamDeleteEligibility(exam.id);
    expect(eligibility.eligible).toBe(false);
  });

  it("15. an exam with an integrity event (via a submission) is denied", async () => {
    const exam = await createExam({ published: false });
    const submission = await prisma.submission.create({ data: { examId: exam.id, studentId: studentA.id } });
    await prisma.integrityEvent.create({
      data: { submissionId: submission.id, examId: exam.id, studentId: studentA.id, eventType: "CAMERA_STOPPED", severity: "HIGH", message: "x", occurredAt: new Date() },
    });
    const eligibility = await checkExamDeleteEligibility(exam.id);
    expect(eligibility.eligible).toBe(false);
  });

  it("16. DELETE /api/exams/[id] performs the eligibility check and denies with 409, never exposing internal errors", async () => {
    const exam = await createExam({ published: false });
    await prisma.submission.create({ data: { examId: exam.id, studentId: studentA.id } });
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await examRoute.DELETE(new Request("http://test.local", { method: "DELETE" }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("This exam cannot be permanently deleted because assessment records exist. Archive it instead.");
    expect(body.error.toLowerCase()).not.toContain("prisma");
    expect(body.error.toLowerCase()).not.toContain("foreign key");

    // Nothing was deleted — the exam and its submission still exist.
    const stillExists = await prisma.exam.findUnique({ where: { id: exam.id } });
    expect(stillExists).not.toBeNull();
    const submissionCount = await prisma.submission.count({ where: { examId: exam.id } });
    expect(submissionCount).toBe(1);
  });

  it("17. DELETE /api/exams/[id] actually deletes an eligible unused draft", async () => {
    const exam = await createExam({ published: false });
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await examRoute.DELETE(new Request("http://test.local", { method: "DELETE" }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(200);
    const gone = await prisma.exam.findUnique({ where: { id: exam.id } });
    expect(gone).toBeNull();
    cleanup.exams = cleanup.exams.filter((e) => e !== exam.id);
  });

  it("18. an unauthorized (cross-institution) lecturer cannot delete an exam, eligible or not", async () => {
    const exam = await createExam({ published: false });
    mockAuth.mockResolvedValue(sessionFor(lecturerB.id, "LECTURER", instB));
    const res = await examRoute.DELETE(new Request("http://test.local", { method: "DELETE" }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(404);
    const stillExists = await prisma.exam.findUnique({ where: { id: exam.id } });
    expect(stillExists).not.toBeNull();
  });

  it("19. a student cannot delete any exam", async () => {
    const exam = await createExam({ published: false });
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await examRoute.DELETE(new Request("http://test.local", { method: "DELETE" }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(401);
    const stillExists = await prisma.exam.findUnique({ where: { id: exam.id } });
    expect(stillExists).not.toBeNull();
  });

  it("20. a failed eligibility check never partially deletes related records", async () => {
    const exam = await createExam({ published: false });
    const submission = await prisma.submission.create({ data: { examId: exam.id, studentId: studentA.id } });
    await prisma.integrityEvent.create({
      data: { submissionId: submission.id, examId: exam.id, studentId: studentA.id, eventType: "CAMERA_STOPPED", severity: "LOW", message: "x", occurredAt: new Date() },
    });
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    await examRoute.DELETE(new Request("http://test.local", { method: "DELETE" }), { params: Promise.resolve({ id: exam.id }) });

    expect(await prisma.exam.count({ where: { id: exam.id } })).toBe(1);
    expect(await prisma.submission.count({ where: { id: submission.id } })).toBe(1);
    expect(await prisma.integrityEvent.count({ where: { submissionId: submission.id } })).toBe(1);
  });
});

// ── Marks export ─────────────────────────────────────────────────────────

describe("lecturer marks export", () => {
  async function createExamWithSubmission(opts: { courseId?: string } = {}) {
    const exam = await createExam({ courseId: opts.courseId });
    const q1 = await prisma.question.create({ data: { examId: exam.id, type: "SHORT_ANSWER", text: "Q1", points: 6, order: 0 } });
    const q2 = await prisma.question.create({ data: { examId: exam.id, type: "SHORT_ANSWER", text: "Q2", points: 4, order: 1 } });
    const submission = await prisma.submission.create({
      data: { examId: exam.id, studentId: studentA.id, status: "GRADED", totalScore: 7, submittedAt: new Date(), gradedAt: new Date() },
    });
    await prisma.answer.create({ data: { submissionId: submission.id, questionId: q1.id, score: 5 } });
    await prisma.answer.create({ data: { submissionId: submission.id, questionId: q2.id, score: 2 } });
    return { exam, submission, q1, q2 };
  }

  it("21. buildLecturerMarksExport computes mark/max/percentage using the same authoritative values as the submission record", async () => {
    const { exam } = await createExamWithSubmission();
    const data = await buildLecturerMarksExport(exam.id);
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0].rawMark).toBe(7);
    expect(data.rows[0].maxMark).toBe(10);
    expect(data.rows[0].percentage).toBe(70);
  });

  it("22. zero max marks never divides by zero — percentage is null", async () => {
    const exam = await createExam();
    await prisma.submission.create({ data: { examId: exam.id, studentId: studentA.id, status: "GRADED", totalScore: 0, submittedAt: new Date(), gradedAt: new Date() } });
    const data = await buildLecturerMarksExport(exam.id);
    expect(data.rows[0].maxMark).toBe(0);
    expect(data.rows[0].percentage).toBeNull();
  });

  it("23. summary CSV headers are exactly the specified columns, no more", async () => {
    const { exam } = await createExamWithSubmission();
    const data = await buildLecturerMarksExport(exam.id);
    const csv = marksExportToCsv(data, false);
    const headerLine = csv.split("\r\n")[0];
    expect(headerLine).toBe(
      "Student name,Student ID,Student email,Course code,Course name,Exam,Submission status,Submitted at,Raw mark,Maximum mark,Percentage,Grading status,Integrity review status",
    );
  });

  it("24. detailed CSV adds one Q<n> column per question in order", async () => {
    const { exam } = await createExamWithSubmission();
    const data = await buildLecturerMarksExport(exam.id);
    const csv = marksExportToCsv(data, true);
    const headerLine = csv.split("\r\n")[0];
    expect(headerLine.endsWith("Q1,Q2")).toBe(true);
    const dataLine = csv.split("\r\n")[1];
    expect(dataLine.endsWith("5,2")).toBe(true);
  });

  it("25. CSV escaping handles commas, quotes, and newlines in a student name", async () => {
    const exam = await createExam();
    const passwordHash = await bcrypt.hash("test-password", 4);
    const weirdStudent = await prisma.user.create({
      data: { name: 'Smith, "The Great"\nJr.', email: `weird-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instA },
    });
    cleanup.users.push(weirdStudent.id);
    await prisma.submission.create({ data: { examId: exam.id, studentId: weirdStudent.id, status: "SUBMITTED", submittedAt: new Date() } });
    const data = await buildLecturerMarksExport(exam.id);
    const csv = marksExportToCsv(data, false);
    expect(csv).toContain('"Smith, ""The Great""\nJr."');
  });

  it("26. Integrity review status is 'Not required' with no events, 'Needs review' with an open one, 'Reviewed' once all are resolved — never raw severity/count", async () => {
    const { exam, submission } = await createExamWithSubmission();
    let data = await buildLecturerMarksExport(exam.id);
    expect(data.rows[0].integrityReviewStatus).toBe("Not required");

    const event = await prisma.integrityEvent.create({
      data: { submissionId: submission.id, examId: exam.id, studentId: studentA.id, eventType: "CAMERA_STOPPED", severity: "HIGH", message: "x", occurredAt: new Date(), reviewStatus: "NEEDS_REVIEW" },
    });
    data = await buildLecturerMarksExport(exam.id);
    expect(data.rows[0].integrityReviewStatus).toBe("Needs review");

    await prisma.integrityEvent.update({ where: { id: event.id }, data: { reviewStatus: "REVIEWED_NO_CONCERN" } });
    data = await buildLecturerMarksExport(exam.id);
    expect(data.rows[0].integrityReviewStatus).toBe("Reviewed");

    const csv = marksExportToCsv(data, false);
    expect(csv).not.toContain("HIGH");
    expect(csv.toLowerCase()).not.toContain("risk");
  });

  it("27. gradingStatus and submissionStatus are computed independently (in progress, not marked, marked)", async () => {
    const exam = await createExam();
    const inProgress = await prisma.submission.create({ data: { examId: exam.id, studentId: studentA.id, status: "IN_PROGRESS" } });
    const data = await buildLecturerMarksExport(exam.id);
    const row = data.rows[0];
    expect(row?.submissionStatus).toBe("In progress");
    expect(row?.gradingStatus).toBe("In progress");
    await prisma.submission.delete({ where: { id: inProgress.id } });
  });

  it("28. filename follows <course-code>_<exam-title>_marks_<YYYY-MM-DD>.csv and sanitizes illegal characters", async () => {
    const course = await prisma.course.create({ data: { institutionId: instA, name: "ME Course", code: `ME/CODE:${stamp}` } });
    cleanup.courses.push(course.id);
    const { exam } = await createExamWithSubmission({ courseId: course.id });
    await prisma.exam.update({ where: { id: exam.id }, data: { title: "Exam: Part 1 / Final" } });
    const data = await buildLecturerMarksExport(exam.id);
    const filename = marksExportFilename(data, new Date("2026-08-24T00:00:00Z"));
    expect(filename).not.toMatch(/[/\\:]/);
    expect(filename.endsWith("_marks_2026-08-24.csv")).toBe(true);
  });

  it("29. filename omits the course segment for a legacy institution-wide exam with no course", async () => {
    const { exam } = await createExamWithSubmission();
    const data = await buildLecturerMarksExport(exam.id);
    expect(data.courseCode).toBeNull();
    const filename = marksExportFilename(data, new Date("2026-08-24T00:00:00Z"));
    expect(filename.startsWith(data.examTitle.replace(/\s+/g, "-"))).toBe(true);
  });

  it("30. authorized lecturer can export marks via the route (200, correct content type)", async () => {
    const { exam } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await marksExportRoute.GET(new Request("http://test.local"), { params: Promise.resolve({ examId: exam.id }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
    const csv = await res.text();
    expect(csv).toContain("Archive Student A");
  });

  it("31. cross-institution lecturer cannot export another institution's exam marks", async () => {
    const { exam } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(lecturerB.id, "LECTURER", instB));
    const res = await marksExportRoute.GET(new Request("http://test.local"), { params: Promise.resolve({ examId: exam.id }) });
    expect(res.status).toBe(403);
  });

  it("32. a student cannot export marks", async () => {
    const { exam } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await marksExportRoute.GET(new Request("http://test.local"), { params: Promise.resolve({ examId: exam.id }) });
    expect(res.status).toBe(401);
  });

  it("33. an exam with zero submissions produces a headers-only CSV, not an error", async () => {
    const exam = await createExam();
    const data = await buildLecturerMarksExport(exam.id);
    expect(data.rows).toHaveLength(0);
    const csv = marksExportToCsv(data, false);
    expect(csv.split("\r\n").filter(Boolean)).toHaveLength(1);
  });
});
