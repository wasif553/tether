import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const examRoute = await import("../app/api/exams/[id]/route");
const startRoute = await import("../app/api/exams/[id]/start/route");
const answersRoute = await import("../app/api/submissions/[id]/answers/route");
const submitRoute = await import("../app/api/submissions/[id]/submit/route");
const submissionRoute = await import("../app/api/submissions/[id]/route");
const evidenceRoute = await import("../app/api/lecturer/submissions/[id]/evidence/route");

function sessionFor(userId: string, role: "LECTURER" | "STUDENT") {
  return { user: { id: userId, role, email: `${userId}@test.local`, name: userId } };
}

function jsonRequest(method: string, body?: unknown) {
  return new Request("http://test.local/route", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

let lecturer: { id: string };
let otherLecturer: { id: string };
let student: { id: string };
let otherStudent: { id: string };

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("test-password", 4);
  const stamp = Date.now();
  lecturer = await prisma.user.create({
    data: { name: "SE Lecturer", email: `se-lect-${stamp}@test.local`, passwordHash, role: "LECTURER" },
  });
  otherLecturer = await prisma.user.create({
    data: { name: "SE Other Lecturer", email: `se-lect2-${stamp}@test.local`, passwordHash, role: "LECTURER" },
  });
  student = await prisma.user.create({
    data: { name: "SE Student", email: `se-stud-${stamp}@test.local`, passwordHash, role: "STUDENT" },
  });
  otherStudent = await prisma.user.create({
    data: { name: "SE Other Student", email: `se-stud2-${stamp}@test.local`, passwordHash, role: "STUDENT" },
  });
});

afterAll(async () => {
  const userIds = [lecturer.id, otherLecturer.id, student.id, otherStudent.id];
  await prisma.integrityEvent.deleteMany({ where: { studentId: { in: userIds } } });
  await prisma.answer.deleteMany({ where: { submission: { studentId: { in: userIds } } } });
  await prisma.submission.deleteMany({ where: { studentId: { in: userIds } } });
  await prisma.question.deleteMany({ where: { exam: { createdById: { in: [lecturer.id, otherLecturer.id] } } } });
  await prisma.exam.deleteMany({ where: { createdById: { in: [lecturer.id, otherLecturer.id] } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe("Secure Exam Mode settings", () => {
  it("defaults secureModeEnabled to false for a new exam", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));
    const exam = await prisma.exam.create({
      data: { title: "Default Settings Exam", durationMins: 30, createdById: lecturer.id },
    });

    const res = await examRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: exam.id }) });
    const body = await res.json();
    expect(body.secureSettings.secureModeEnabled).toBe(false);
  });

  it("enables Secure Exam Mode and persists settings via PATCH", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));
    const exam = await prisma.exam.create({
      data: { title: "Enable Secure Mode Exam", durationMins: 30, createdById: lecturer.id },
    });

    const res = await examRoute.PATCH(
      jsonRequest("PATCH", {
        secureSettings: { secureModeEnabled: true, requireFullscreen: true, allowLateSubmit: true },
      }),
      { params: Promise.resolve({ id: exam.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.secureSettings.secureModeEnabled).toBe(true);
    expect(body.secureSettings.requireFullscreen).toBe(true);
    expect(body.secureSettings.allowLateSubmit).toBe(true);
    // Untouched fields keep their defaults rather than being wiped out.
    expect(body.secureSettings.blockCopyPaste).toBe(true);
  });

  it("disables Secure Exam Mode again via PATCH", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));
    const exam = await prisma.exam.create({
      data: {
        title: "Disable Secure Mode Exam",
        durationMins: 30,
        createdById: lecturer.id,
        secureSettings: { secureModeEnabled: true },
      },
    });

    const res = await examRoute.PATCH(
      jsonRequest("PATCH", { secureSettings: { secureModeEnabled: false } }),
      { params: Promise.resolve({ id: exam.id }) },
    );
    const body = await res.json();
    expect(body.secureSettings.secureModeEnabled).toBe(false);
  });
});

describe("maxAttempts enforcement (v1: single attempt)", () => {
  it("returns the existing submission rather than creating a second one", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));
    const exam = await prisma.exam.create({
      data: { title: "Attempts Exam", durationMins: 30, published: true, createdById: lecturer.id },
    });

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));
    const first = await startRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: exam.id }) });
    expect(first.status).toBe(201);
    const firstBody = await first.json();

    const second = await startRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: exam.id }) });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.id).toBe(firstBody.id);

    const count = await prisma.submission.count({ where: { examId: exam.id, studentId: student.id } });
    expect(count).toBe(1);
  });
});

describe("save/submit blocked after final submission", () => {
  it("rejects answer saves once the submission is finalized", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));
    const exam = await prisma.exam.create({
      data: { title: "Save Block Exam", durationMins: 30, published: true, createdById: lecturer.id },
    });
    const question = await prisma.question.create({
      data: { examId: exam.id, type: "SHORT_ANSWER", text: "Q1", points: 1 },
    });

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));
    const submission = await prisma.submission.create({
      data: { examId: exam.id, studentId: student.id, status: "SUBMITTED", submittedAt: new Date() },
    });

    const res = await answersRoute.PATCH(
      jsonRequest("PATCH", { questionId: question.id, response: "too late" }),
      { params: Promise.resolve({ id: submission.id }) },
    );
    expect(res.status).toBe(409);
  });

  it("submit is idempotent once already finalized", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));
    const exam = await prisma.exam.create({
      data: { title: "Idempotent Submit Exam", durationMins: 30, published: true, createdById: lecturer.id },
    });

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));
    const submission = await prisma.submission.create({
      data: { examId: exam.id, studentId: student.id, status: "GRADED", totalScore: 5, submittedAt: new Date(), gradedAt: new Date() },
    });

    const res = await submitRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("GRADED");
    expect(body.totalScore).toBe(5);
  });
});

describe("late submission handling driven by allowLateSubmit", () => {
  it("blocks save and submit past the deadline when allowLateSubmit is false", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));
    const exam = await prisma.exam.create({
      data: {
        title: "No Late Submit Exam",
        durationMins: 1,
        published: true,
        createdById: lecturer.id,
        secureSettings: { secureModeEnabled: true, allowLateSubmit: false },
      },
    });
    const question = await prisma.question.create({
      data: { examId: exam.id, type: "SHORT_ANSWER", text: "Q1", points: 1 },
    });

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));
    const submission = await prisma.submission.create({
      data: {
        examId: exam.id,
        studentId: student.id,
        startedAt: new Date(Date.now() - 5 * 60_000), // started 5 minutes ago, 1 min duration
      },
    });

    const saveRes = await answersRoute.PATCH(
      jsonRequest("PATCH", { questionId: question.id, response: "late answer" }),
      { params: Promise.resolve({ id: submission.id }) },
    );
    expect(saveRes.status).toBe(409);

    const submitRes = await submitRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submission.id }) });
    expect(submitRes.status).toBe(409);

    const events = await prisma.integrityEvent.findMany({
      where: { submissionId: submission.id, eventType: "SUBMIT_AFTER_DEADLINE" },
    });
    expect(events.length).toBe(1);
    expect(events[0].severity).toBe("HIGH");
  });

  it("allows save and submit past the deadline when allowLateSubmit is true", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));
    const exam = await prisma.exam.create({
      data: {
        title: "Late Submit Allowed Exam",
        durationMins: 1,
        published: true,
        createdById: lecturer.id,
        secureSettings: { secureModeEnabled: true, allowLateSubmit: true },
      },
    });
    const question = await prisma.question.create({
      data: { examId: exam.id, type: "SHORT_ANSWER", text: "Q1", points: 1, correctAnswer: "ok" },
    });

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));
    const submission = await prisma.submission.create({
      data: {
        examId: exam.id,
        studentId: student.id,
        startedAt: new Date(Date.now() - 5 * 60_000),
      },
    });

    const saveRes = await answersRoute.PATCH(
      jsonRequest("PATCH", { questionId: question.id, response: "late but allowed" }),
      { params: Promise.resolve({ id: submission.id }) },
    );
    expect(saveRes.status).toBe(200);

    const submitRes = await submitRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submission.id }) });
    expect(submitRes.status).toBe(200);
  });
});

describe("non-secure exam flow is unaffected", () => {
  it("allows normal save/submit when Secure Exam Mode is disabled", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));
    const exam = await prisma.exam.create({
      data: { title: "Plain Exam", durationMins: 30, published: true, createdById: lecturer.id },
    });
    const question = await prisma.question.create({
      data: { examId: exam.id, type: "SHORT_ANSWER", text: "Q1", points: 1, correctAnswer: "ok" },
    });

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));
    const startRes = await startRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: exam.id }) });
    const submission = await startRes.json();

    const saveRes = await answersRoute.PATCH(
      jsonRequest("PATCH", { questionId: question.id, response: "ok" }),
      { params: Promise.resolve({ id: submission.id }) },
    );
    expect(saveRes.status).toBe(200);

    const submitRes = await submitRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submission.id }) });
    expect(submitRes.status).toBe(200);
    const body = await submitRes.json();
    expect(body.status).toBe("GRADED");
    expect(body.totalScore).toBe(1);
  });
});

describe("evidence report access control", () => {
  it("allows the owning lecturer to access the evidence report", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));
    const exam = await prisma.exam.create({
      data: { title: "Evidence Exam", durationMins: 30, published: true, createdById: lecturer.id },
    });

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));
    const submission = await prisma.submission.create({
      data: { examId: exam.id, studentId: student.id },
    });

    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));
    const res = await evidenceRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.student.email).toBe("string");
    expect(body.disclaimer).toContain("not automatic misconduct determinations");
  });

  it("blocks a student from accessing the evidence report", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));
    const exam = await prisma.exam.create({
      data: { title: "Evidence Exam Student Block", durationMins: 30, published: true, createdById: lecturer.id },
    });

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));
    const submission = await prisma.submission.create({
      data: { examId: exam.id, studentId: student.id },
    });

    const res = await evidenceRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(401);
  });

  it("blocks a non-owning lecturer from accessing the evidence report", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));
    const exam = await prisma.exam.create({
      data: { title: "Evidence Exam Other Lecturer", durationMins: 30, published: true, createdById: lecturer.id },
    });

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));
    const submission = await prisma.submission.create({
      data: { examId: exam.id, studentId: student.id },
    });

    mockAuth.mockResolvedValue(sessionFor(otherLecturer.id, "LECTURER"));
    const res = await evidenceRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(403);
  });
});

describe("student cannot access another student's submission or lecturer-only internals", () => {
  it("blocks cross-student submission access", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));
    const exam = await prisma.exam.create({
      data: { title: "Cross Student Exam", durationMins: 30, published: true, createdById: lecturer.id },
    });

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));
    const submission = await prisma.submission.create({
      data: { examId: exam.id, studentId: student.id },
    });

    mockAuth.mockResolvedValue(sessionFor(otherStudent.id, "STUDENT"));
    const res = await submissionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(403);
  });

  it("never returns AI draft internals or Canvas passback internals to the owning student", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));
    const exam = await prisma.exam.create({
      data: { title: "No Internals Exam", durationMins: 30, published: true, createdById: lecturer.id },
    });
    const question = await prisma.question.create({
      data: { examId: exam.id, type: "ESSAY", text: "Essay Q", points: 5 },
    });

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));
    const submission = await prisma.submission.create({
      data: { examId: exam.id, studentId: student.id, status: "SUBMITTED", submittedAt: new Date() },
    });
    await prisma.answer.create({
      data: {
        submissionId: submission.id,
        questionId: question.id,
        response: "my essay",
        aiDraftScore: 4,
        aiReasoning: "looks good",
      },
    });

    const res = await submissionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    const body = await res.json();
    expect(body.answers[0].aiDraftScore).toBeUndefined();
    expect(body.answers[0].aiReasoning).toBeUndefined();
    expect(body.canvasPassback).toBeNull();
  });
});
