/**
 * Assessment Operations v1 — see docs/assessment-operations-v1.md.
 * Covers: student profile (institutionStudentId), bulk question entry,
 * and final marks/results exports.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const { parseBulkQuestionsText } = await import("./bulkQuestionParser");
const { buildMarksReport, toUploadReadyRows } = await import("./assessmentExport");
const { marksReportToCsv, uploadReadyToCsv, marksReportToXlsxBuffer, buildPdfReportBuffer } = await import(
  "./exportFormats"
);

const inviteStudentRoute = await import("../app/api/platform/institutions/[id]/invite-student/route");
const courseRoute = await import("../app/api/courses/[id]/route");
const bulkQuestionsRoute = await import("../app/api/lecturer/exams/[examId]/bulk-questions/route");
const submissionRoute = await import("../app/api/submissions/[id]/route");
const exportRoute = await import("../app/api/lecturer/exams/[examId]/export/[format]/route");

function sessionFor(
  userId: string,
  role: "LECTURER" | "STUDENT" | "PLATFORM_ADMIN",
  institutionId: string,
) {
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
const cleanup = {
  users: [] as string[],
  exams: [] as string[],
  courses: [] as string[],
};

let instA: string;
let instB: string;
let platformAdmin: { id: string };
let lecturerA: { id: string };
let studentA: { id: string };
let lecturerB: { id: string };

beforeAll(async () => {
  const a = await getOrCreateTestInstitution(`assess-ops-a-${stamp}`);
  const b = await getOrCreateTestInstitution(`assess-ops-b-${stamp}`);
  instA = a.id;
  instB = b.id;

  const passwordHash = await bcrypt.hash("test-password", 4);
  platformAdmin = await prisma.user.create({
    data: {
      name: "AO Platform Admin",
      email: `ao-admin-${stamp}@test.local`,
      passwordHash,
      role: "PLATFORM_ADMIN",
    },
  });
  lecturerA = await prisma.user.create({
    data: {
      name: "AO Lecturer A",
      email: `ao-lect-a-${stamp}@test.local`,
      passwordHash,
      role: "LECTURER",
      institutionId: instA,
    },
  });
  lecturerB = await prisma.user.create({
    data: {
      name: "AO Lecturer B",
      email: `ao-lect-b-${stamp}@test.local`,
      passwordHash,
      role: "LECTURER",
      institutionId: instB,
    },
  });
  studentA = await prisma.user.create({
    data: {
      name: "AO Student A",
      email: `ao-stud-a-${stamp}@test.local`,
      passwordHash,
      role: "STUDENT",
      institutionId: instA,
      institutionStudentId: "S-1001",
    },
  });
  cleanup.users.push(platformAdmin.id, lecturerA.id, lecturerB.id, studentA.id);
});

afterAll(async () => {
  await prisma.integrityEvent.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.submission.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.question.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.exam.deleteMany({ where: { id: { in: cleanup.exams } } });
  await prisma.bankQuestion.deleteMany({ where: { bank: { lecturerId: lecturerA.id } } });
  await prisma.questionBank.deleteMany({ where: { lecturerId: lecturerA.id } });
  await prisma.courseEnrollment.deleteMany({ where: { courseId: { in: cleanup.courses } } });
  await prisma.course.deleteMany({ where: { id: { in: cleanup.courses } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanup.users } } });
});

async function createExam(opts: { published?: boolean } = {}) {
  const exam = await prisma.exam.create({
    data: {
      title: `AO Exam ${Date.now()}-${Math.random()}`,
      durationMins: 30,
      createdById: lecturerA.id,
      institutionId: instA,
      published: opts.published ?? true,
    },
  });
  cleanup.exams.push(exam.id);
  return exam;
}

// ── Student profile: institutionStudentId ───────────────────────────────────

describe("student profile: institutionStudentId", () => {
  it("1. student can be invited with an optional institutionStudentId", async () => {
    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", instA));
    const res = await inviteStudentRoute.POST(
      jsonRequest("POST", {
        name: "New Student",
        email: `ao-new-stud-${stamp}@test.local`,
        password: "password123",
        institutionStudentId: "S-2002",
      }),
      { params: Promise.resolve({ id: instA }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.institutionStudentId).toBe("S-2002");
    cleanup.users.push(body.id);
  });

  it("3. missing institutionStudentId is allowed", async () => {
    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", instA));
    const res = await inviteStudentRoute.POST(
      jsonRequest("POST", {
        name: "No ID Student",
        email: `ao-noid-stud-${stamp}@test.local`,
        password: "password123",
      }),
      { params: Promise.resolve({ id: instA }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.institutionStudentId).toBeNull();
    cleanup.users.push(body.id);
  });

  it("2. institutionStudentId appears in the lecturer's course enrolment list", async () => {
    const course = await prisma.course.create({
      data: { institutionId: instA, name: "AO Course", code: `AOC-${stamp}` },
    });
    cleanup.courses.push(course.id);
    await prisma.courseEnrollment.create({
      data: { courseId: course.id, userId: lecturerA.id, role: "LECTURER" },
    });
    await prisma.courseEnrollment.create({
      data: { courseId: course.id, userId: studentA.id, role: "STUDENT" },
    });

    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await courseRoute.GET(new Request("http://test.local"), {
      params: Promise.resolve({ id: course.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const enrolment = body.enrollments.find((e: { userId: string }) => e.userId === studentA.id);
    expect(enrolment.user.institutionStudentId).toBe("S-1001");
  });

  it("4. cross-institution course access is forbidden (student data not exposed)", async () => {
    const course = await prisma.course.create({
      data: { institutionId: instA, name: "AO Course B", code: `AOC-B-${stamp}` },
    });
    cleanup.courses.push(course.id);

    mockAuth.mockResolvedValue(sessionFor(lecturerB.id, "LECTURER", instB));
    const res = await courseRoute.GET(new Request("http://test.local"), {
      params: Promise.resolve({ id: course.id }),
    });
    expect(res.status).toBe(403);
  });
});

// ── Bulk question entry ──────────────────────────────────────────────────────

describe("bulk question entry", () => {
  it("5. lecturer can bulk add valid MCQ questions", async () => {
    const exam = await createExam();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const text = `QUESTION:\nWhat is 2 + 2?\nTYPE: MCQ\nOPTIONS:\nA. 3\nB. 4\nANSWER: B\nPOINTS: 2`;
    const res = await bulkQuestionsRoute.POST(jsonRequest("POST", { text }), {
      params: Promise.resolve({ examId: exam.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(1);

    const q = await prisma.question.findFirst({ where: { examId: exam.id } });
    expect(q?.type).toBe("MULTIPLE_CHOICE");
    expect(q?.correctAnswer).toBe("4");
    expect(q?.points).toBe(2);
  });

  it("6. lecturer can bulk add short-answer questions", async () => {
    const exam = await createExam();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const text = `QUESTION:\nDefine photosynthesis.\nTYPE: SHORT_ANSWER\nPOINTS: 3`;
    const res = await bulkQuestionsRoute.POST(jsonRequest("POST", { text }), {
      params: Promise.resolve({ examId: exam.id }),
    });
    expect(res.status).toBe(200);
    const q = await prisma.question.findFirst({ where: { examId: exam.id } });
    expect(q?.type).toBe("SHORT_ANSWER");
    expect(q?.points).toBe(3);
  });

  it("7. lecturer can bulk add essay questions", async () => {
    const exam = await createExam();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const text = `QUESTION:\nDiscuss climate change impacts.\nTYPE: ESSAY\nPOINTS: 10`;
    const res = await bulkQuestionsRoute.POST(jsonRequest("POST", { text }), {
      params: Promise.resolve({ examId: exam.id }),
    });
    expect(res.status).toBe(200);
    const q = await prisma.question.findFirst({ where: { examId: exam.id } });
    expect(q?.type).toBe("ESSAY");
    expect(q?.correctAnswer).toBeNull();
  });

  it("8. invalid MCQ without a correct answer is rejected", async () => {
    const result = parseBulkQuestionsText(
      `QUESTION:\nWhat is 2 + 2?\nTYPE: MCQ\nOPTIONS:\nA. 3\nB. 4\nPOINTS: 1`,
    );
    expect(result.invalidCount).toBe(1);
    expect(result.rows[0].errors.some((e) => e.includes("ANSWER"))).toBe(true);
  });

  it("9. invalid (non-positive) points are rejected", async () => {
    const result = parseBulkQuestionsText(
      `QUESTION:\nDefine X.\nTYPE: SHORT_ANSWER\nPOINTS: 0`,
    );
    expect(result.invalidCount).toBe(1);
    expect(result.rows[0].errors.some((e) => e.includes("POINTS"))).toBe(true);
  });

  it("10. an invalid batch is not saved even partially", async () => {
    const exam = await createExam();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const text =
      `QUESTION:\nValid short answer.\nTYPE: SHORT_ANSWER\nPOINTS: 1\n\n` +
      `QUESTION:\nInvalid MCQ.\nTYPE: MCQ\nOPTIONS:\nA. 1\nB. 2\nPOINTS: 1`;
    const res = await bulkQuestionsRoute.POST(jsonRequest("POST", { text }), {
      params: Promise.resolve({ examId: exam.id }),
    });
    expect(res.status).toBe(400);

    const count = await prisma.question.count({ where: { examId: exam.id } });
    expect(count).toBe(0);
  });

  it("11. imported questions appear on the exam in order", async () => {
    const exam = await createExam();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const text =
      `QUESTION:\nFirst question.\nTYPE: SHORT_ANSWER\nPOINTS: 1\n\n` +
      `QUESTION:\nSecond question.\nTYPE: SHORT_ANSWER\nPOINTS: 1`;
    await bulkQuestionsRoute.POST(jsonRequest("POST", { text }), {
      params: Promise.resolve({ examId: exam.id }),
    });
    const questions = await prisma.question.findMany({
      where: { examId: exam.id },
      orderBy: { order: "asc" },
    });
    expect(questions.map((q) => q.text)).toEqual(["First question.", "Second question."]);
  });

  it("12. optional question-bank save creates BankQuestion rows", async () => {
    const exam = await createExam();
    const bank = await prisma.questionBank.create({
      data: { title: "AO Bank", lecturerId: lecturerA.id },
    });
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const text = `QUESTION:\nBank-saved question.\nTYPE: SHORT_ANSWER\nPOINTS: 4`;
    const res = await bulkQuestionsRoute.POST(
      jsonRequest("POST", { text, saveToBankId: bank.id }),
      { params: Promise.resolve({ examId: exam.id }) },
    );
    const body = await res.json();
    expect(body.bankSaved).toBe(1);

    const bankQuestion = await prisma.bankQuestion.findFirst({ where: { bankId: bank.id } });
    expect(bankQuestion?.text).toBe("Bank-saved question.");
  });

  it("13. students never see correctAnswer, including for bulk-imported questions", async () => {
    const exam = await createExam();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    await bulkQuestionsRoute.POST(
      jsonRequest("POST", {
        text: `QUESTION:\nWhat is 2 + 2?\nTYPE: MCQ\nOPTIONS:\nA. 3\nB. 4\nANSWER: B\nPOINTS: 1`,
      }),
      { params: Promise.resolve({ examId: exam.id }) },
    );

    const submission = await prisma.submission.create({
      data: { examId: exam.id, studentId: studentA.id },
    });

    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await submissionRoute.GET(new Request("http://test.local"), {
      params: Promise.resolve({ id: submission.id }),
    });
    const body = await res.json();
    expect(body.exam.questions[0].correctAnswer).toBeUndefined();
  });
});

// ── Manual multi-question entry (repeatable draft cards) ─────────────────────

describe("manual multi-question entry (structured draft cards)", () => {
  it("6. multiple valid manual questions (MCQ + short-answer + essay) are saved in one request", async () => {
    const exam = await createExam();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await bulkQuestionsRoute.POST(
      jsonRequest("POST", {
        questions: [
          {
            type: "MULTIPLE_CHOICE",
            text: "Capital of France?",
            options: ["Berlin", "Paris", "", ""],
            correctAnswer: "Paris",
            points: 2,
          },
          {
            type: "SHORT_ANSWER",
            text: "Define photosynthesis.",
            options: ["", "", "", ""],
            correctAnswer: "",
            points: 3,
          },
          {
            type: "ESSAY",
            text: "Discuss WWI causes.",
            options: ["", "", "", ""],
            correctAnswer: "",
            points: 8,
          },
        ],
      }),
      { params: Promise.resolve({ examId: exam.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(3);

    const questions = await prisma.question.findMany({
      where: { examId: exam.id },
      orderBy: { order: "asc" },
    });
    expect(questions.map((q) => q.type)).toEqual(["MULTIPLE_CHOICE", "SHORT_ANSWER", "ESSAY"]);
    expect(questions[0].correctAnswer).toBe("Paris");
    expect(questions[2].correctAnswer).toBeNull();
  });

  it("5. an invalid card (MCQ missing correct answer) blocks the whole manual batch", async () => {
    const exam = await createExam();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await bulkQuestionsRoute.POST(
      jsonRequest("POST", {
        questions: [
          {
            type: "SHORT_ANSWER",
            text: "Valid question.",
            options: ["", "", "", ""],
            correctAnswer: "",
            points: 1,
          },
          {
            type: "MULTIPLE_CHOICE",
            text: "Invalid MCQ.",
            options: ["A", "B", "", ""],
            correctAnswer: "",
            points: 1,
          },
        ],
      }),
      { params: Promise.resolve({ examId: exam.id }) },
    );
    expect(res.status).toBe(400);

    const count = await prisma.question.count({ where: { examId: exam.id } });
    expect(count).toBe(0);
  });
});

// ── Final marks/results exports ──────────────────────────────────────────────

describe("final marks/results exports", () => {
  async function createExamWithSubmission() {
    const exam = await createExam();
    await prisma.question.create({
      data: { examId: exam.id, type: "SHORT_ANSWER", text: "Q1", points: 10, order: 0 },
    });
    const submission = await prisma.submission.create({
      data: {
        examId: exam.id,
        studentId: studentA.id,
        status: "GRADED",
        totalScore: 7,
        submittedAt: new Date(),
        gradedAt: new Date(),
      },
    });
    return { exam, submission };
  }

  it("14. buildMarksReport produces a full marks row with score/max/percentage", async () => {
    const { exam } = await createExamWithSubmission();
    const report = await buildMarksReport(exam.id);
    expect(report.rows).toHaveLength(1);
    const row = report.rows[0];
    expect(row.totalScore).toBe(7);
    expect(row.maxScore).toBe(10);
    expect(row.percentage).toBe(70);
    expect(row.studentName).toBe("AO Student A");
  });

  it("17. exports include full name and institutional student ID", async () => {
    const { exam } = await createExamWithSubmission();
    const report = await buildMarksReport(exam.id);
    const csv = marksReportToCsv(report);
    expect(csv).toContain("AO Student A");
    expect(csv).toContain("S-1001");
  });

  it("18. exports calculate score/max/percentage correctly for CSV and upload-ready", async () => {
    const { exam } = await createExamWithSubmission();
    const report = await buildMarksReport(exam.id);
    const uploadRows = toUploadReadyRows(report);
    expect(uploadRows[0].mark).toBe(7);
    expect(uploadRows[0].markOutOf).toBe(10);
    expect(uploadRows[0].percentage).toBe(70);
  });

  it("19. exports never include passwordHash or accessCodeHash", async () => {
    const { exam } = await createExamWithSubmission();
    const report = await buildMarksReport(exam.id);
    const csv = marksReportToCsv(report);
    const upload = uploadReadyToCsv(toUploadReadyRows(report));
    expect(csv.toLowerCase()).not.toContain("passwordhash");
    expect(csv.toLowerCase()).not.toContain("accesscodehash");
    expect(upload.toLowerCase()).not.toContain("passwordhash");
    expect(upload.toLowerCase()).not.toContain("accesscodehash");
    // Structural guarantee, not just string-absence: these fields are
    // simply never selected/returned by buildMarksReport in the first place.
    expect(Object.keys(report.rows[0])).not.toContain("passwordHash");
  });

  it("20. upload-ready export excludes integrity risk/event details by default", async () => {
    const { exam, submission } = await createExamWithSubmission();
    await prisma.integrityEvent.create({
      data: {
        submissionId: submission.id,
        examId: exam.id,
        studentId: studentA.id,
        eventType: "CAMERA_STOPPED",
        severity: "HIGH",
        message: "Camera stopped",
        occurredAt: new Date(),
      },
    });
    const report = await buildMarksReport(exam.id);
    const uploadRows = toUploadReadyRows(report);
    expect(Object.keys(uploadRows[0])).not.toContain("riskLevel");
    expect(Object.keys(uploadRows[0])).not.toContain("integrityEventCount");
    const csv = uploadReadyToCsv(uploadRows);
    expect(csv).not.toContain("HIGH");
  });

  it("15/16. lecturer can export marks CSV/XLSX and PDF via the export route", async () => {
    const { exam } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));

    for (const format of ["marks-csv", "marks-xlsx", "upload-csv", "upload-xlsx", "report-pdf"]) {
      const res = await exportRoute.GET(new Request("http://test.local"), {
        params: Promise.resolve({ examId: exam.id, format }),
      });
      expect(res.status).toBe(200);
    }
  });

  it("marks-xlsx and report-pdf produce non-empty binary output", async () => {
    const { exam } = await createExamWithSubmission();
    const report = await buildMarksReport(exam.id);
    const xlsxBuffer = await marksReportToXlsxBuffer(report);
    expect(xlsxBuffer.byteLength).toBeGreaterThan(0);
    const pdfBuffer = await buildPdfReportBuffer(report);
    expect(pdfBuffer.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("21. cross-institution export is blocked", async () => {
    const { exam } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(lecturerB.id, "LECTURER", instB));
    const res = await exportRoute.GET(new Request("http://test.local"), {
      params: Promise.resolve({ examId: exam.id, format: "marks-csv" }),
    });
    expect(res.status).toBe(403);
  });

  it("22. a student cannot export class marks", async () => {
    const { exam } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await exportRoute.GET(new Request("http://test.local"), {
      params: Promise.resolve({ examId: exam.id, format: "marks-csv" }),
    });
    expect(res.status).toBe(401);
  });
});
