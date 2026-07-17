import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const examRoute = await import("../app/api/exams/[id]/route");
const startRoute = await import("../app/api/exams/[id]/start/route");
const answersRoute = await import("../app/api/submissions/[id]/answers/route");
const submitRoute = await import("../app/api/submissions/[id]/submit/route");
const submissionRoute = await import("../app/api/submissions/[id]/route");
const evidenceRoute = await import("../app/api/lecturer/submissions/[id]/evidence/route");
const marksReleaseRoute = await import("../app/api/lecturer/exams/[examId]/marks-release/route");
const questionRoute = await import("../app/api/submissions/[id]/question/route");
const questionProgressRoute = await import("../app/api/submissions/[id]/question-progress/route");

let testInstitution: { id: string };

function sessionFor(userId: string, role: "LECTURER" | "STUDENT" | "PLATFORM_ADMIN") {
  return { user: { id: userId, role, email: `${userId}@test.local`, name: userId, institutionId: testInstitution.id } };
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
let platformAdmin: { id: string };
let student: { id: string };
let otherStudent: { id: string };

beforeAll(async () => {
  testInstitution = await getOrCreateTestInstitution("secure-exam-test");
  const passwordHash = await bcrypt.hash("test-password", 4);
  const stamp = Date.now();
  lecturer = await prisma.user.create({
    data: { name: "SE Lecturer", email: `se-lect-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: testInstitution.id },
  });
  otherLecturer = await prisma.user.create({
    data: { name: "SE Other Lecturer", email: `se-lect2-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: testInstitution.id },
  });
  platformAdmin = await prisma.user.create({
    data: { name: "SE Platform Admin", email: `se-admin-${stamp}@test.local`, passwordHash, role: "PLATFORM_ADMIN", institutionId: testInstitution.id },
  });
  student = await prisma.user.create({
    data: { name: "SE Student", email: `se-stud-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: testInstitution.id },
  });
  otherStudent = await prisma.user.create({
    data: { name: "SE Other Student", email: `se-stud2-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: testInstitution.id },
  });
});

afterAll(async () => {
  const userIds = [lecturer, otherLecturer, platformAdmin, student, otherStudent]
    .map((user) => user?.id)
    .filter((id): id is string => Boolean(id));
  if (userIds.length === 0) {
    await prisma.$disconnect();
    return;
  }
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
      data: { title: "Default Settings Exam", durationMins: 30, createdById: lecturer.id, institutionId: testInstitution.id },
    });

    const res = await examRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: exam.id }) });
    const body = await res.json();
    expect(body.secureSettings.secureModeEnabled).toBe(false);
  });

  it("enables Secure Exam Mode and persists settings via PATCH", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));
    const exam = await prisma.exam.create({
      data: { title: "Enable Secure Mode Exam", durationMins: 30, createdById: lecturer.id, institutionId: testInstitution.id },
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
        createdById: lecturer.id, institutionId: testInstitution.id,
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
      data: { title: "Attempts Exam", durationMins: 30, published: true, createdById: lecturer.id, institutionId: testInstitution.id },
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

  it("blocks a second attempt after a finalized single-attempt exam", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));
    const exam = await prisma.exam.create({
      data: {
        title: "Single Attempt Finalized Exam",
        durationMins: 30,
        published: true,
        createdById: lecturer.id,
        institutionId: testInstitution.id,
        secureSettings: { maxAttempts: 1 },
      },
    });

    await prisma.submission.create({
      data: {
        examId: exam.id,
        studentId: student.id,
        status: "GRADED",
        attemptNumber: 1,
        submittedAt: new Date(),
        gradedAt: new Date(),
        totalScore: 0,
      },
    });

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));
    const res = await startRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(409);
  });

  it("allows a second attempt when maxAttempts is greater than one", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));
    const exam = await prisma.exam.create({
      data: {
        title: "Multi Attempt Exam",
        durationMins: 30,
        published: true,
        createdById: lecturer.id,
        institutionId: testInstitution.id,
        secureSettings: { maxAttempts: 2 },
      },
    });

    await prisma.submission.create({
      data: {
        examId: exam.id,
        studentId: student.id,
        status: "GRADED",
        attemptNumber: 1,
        submittedAt: new Date(),
        gradedAt: new Date(),
        totalScore: 0,
      },
    });

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));
    const res = await startRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.attemptNumber).toBe(2);
  });

  it("requires the access code again for a new multi-attempt submission", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));
    const exam = await prisma.exam.create({
      data: {
        title: "Multi Attempt Code Exam",
        durationMins: 30,
        published: true,
        createdById: lecturer.id,
        institutionId: testInstitution.id,
        secureSettings: { maxAttempts: 2 },
        accessCodeHash: await bcrypt.hash("TRY-2", 4),
        accessCodeRequired: true,
      },
    });

    await prisma.submission.create({
      data: {
        examId: exam.id,
        studentId: student.id,
        status: "GRADED",
        attemptNumber: 1,
        submittedAt: new Date(),
        gradedAt: new Date(),
        totalScore: 0,
      },
    });

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));
    const blocked = await startRoute.POST(jsonRequest("POST", {}), {
      params: Promise.resolve({ id: exam.id }),
    });
    expect(blocked.status).toBe(403);

    const allowed = await startRoute.POST(jsonRequest("POST", { accessCode: "TRY-2" }), {
      params: Promise.resolve({ id: exam.id }),
    });
    expect(allowed.status).toBe(201);
  });
});

describe("save/submit blocked after final submission", () => {
  it("rejects answer saves once the submission is finalized", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));
    const exam = await prisma.exam.create({
      data: { title: "Save Block Exam", durationMins: 30, published: true, createdById: lecturer.id, institutionId: testInstitution.id },
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
      data: { title: "Idempotent Submit Exam", durationMins: 30, published: true, createdById: lecturer.id, institutionId: testInstitution.id },
    });

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));
    const submission = await prisma.submission.create({
      data: { examId: exam.id, studentId: student.id, status: "GRADED", totalScore: 5, submittedAt: new Date(), gradedAt: new Date() },
    });

    const res = await submitRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("GRADED");
    expect(body.totalScore).toBeNull();
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
        createdById: lecturer.id, institutionId: testInstitution.id,
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
        createdById: lecturer.id, institutionId: testInstitution.id,
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
      data: { title: "Plain Exam", durationMins: 30, published: true, createdById: lecturer.id, institutionId: testInstitution.id },
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
      data: { title: "Evidence Exam", durationMins: 30, published: true, createdById: lecturer.id, institutionId: testInstitution.id },
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
      data: { title: "Evidence Exam Student Block", durationMins: 30, published: true, createdById: lecturer.id, institutionId: testInstitution.id },
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
      data: { title: "Evidence Exam Other Lecturer", durationMins: 30, published: true, createdById: lecturer.id, institutionId: testInstitution.id },
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
      data: { title: "Cross Student Exam", durationMins: 30, published: true, createdById: lecturer.id, institutionId: testInstitution.id },
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
      data: { title: "No Internals Exam", durationMins: 30, published: true, createdById: lecturer.id, institutionId: testInstitution.id },
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

describe("marks release gates student-visible scores", () => {
  async function createGradedSubmission() {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));
    const exam = await prisma.exam.create({
      data: {
        title: "Marks Release Exam",
        durationMins: 30,
        published: true,
        createdById: lecturer.id,
        institutionId: testInstitution.id,
      },
    });
    const question = await prisma.question.create({
      data: {
        examId: exam.id,
        type: "SHORT_ANSWER",
        text: "Q1",
        points: 5,
        correctAnswer: "secret",
      },
    });
    const submission = await prisma.submission.create({
      data: {
        examId: exam.id,
        studentId: student.id,
        status: "GRADED",
        submittedAt: new Date(),
        gradedAt: new Date(),
        totalScore: 4,
      },
    });
    await prisma.answer.create({
      data: {
        submissionId: submission.id,
        questionId: question.id,
        response: "answer",
        score: 4,
        feedback: "Good work",
      },
    });
    return { exam, submission };
  }

  it("hides score and per-question marks from the student before release", async () => {
    const { submission } = await createGradedSubmission();
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));

    const res = await submissionRoute.GET(jsonRequest("GET"), {
      params: Promise.resolve({ id: submission.id }),
    });
    const body = await res.json();

    expect(body.totalScore).toBeNull();
    expect(body.marksReleased).toBe(false);
    expect(body.answers[0].score).toBeUndefined();
    expect(body.answers[0].feedback).toBeUndefined();
    expect(body.exam.questions[0].correctAnswer).toBeUndefined();
  });

  it("lets the lecturer see marks before release", async () => {
    const { submission } = await createGradedSubmission();
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));

    const res = await submissionRoute.GET(jsonRequest("GET"), {
      params: Promise.resolve({ id: submission.id }),
    });
    const body = await res.json();

    expect(body.totalScore).toBe(4);
    expect(body.answers[0].score).toBe(4);
    expect(body.answers[0].feedback).toBe("Good work");
    expect(body.exam.questions[0].correctAnswer).toBe("secret");
  });

  it("releases marks to students at exam level", async () => {
    const { exam, submission } = await createGradedSubmission();
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));

    const releaseRes = await marksReleaseRoute.POST(jsonRequest("POST"), {
      params: Promise.resolve({ examId: exam.id }),
    });
    expect(releaseRes.status).toBe(200);

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));
    const studentRes = await submissionRoute.GET(jsonRequest("GET"), {
      params: Promise.resolve({ id: submission.id }),
    });
    const body = await studentRes.json();

    expect(body.marksReleased).toBe(true);
    expect(body.totalScore).toBe(4);
    expect(body.answers[0].score).toBe(4);
    expect(body.answers[0].feedback).toBe("Good work");
    expect(body.exam.questions[0].correctAnswer).toBeUndefined();
  });

  it("blocks students and non-owning lecturers from releasing marks", async () => {
    const { exam } = await createGradedSubmission();

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));
    const studentRes = await marksReleaseRoute.POST(jsonRequest("POST"), {
      params: Promise.resolve({ examId: exam.id }),
    });
    expect(studentRes.status).toBe(401);

    mockAuth.mockResolvedValue(sessionFor(otherLecturer.id, "LECTURER"));
    const lecturerRes = await marksReleaseRoute.POST(jsonRequest("POST"), {
      params: Promise.resolve({ examId: exam.id }),
    });
    expect(lecturerRes.status).toBe(404);
  });

  it("allows platform admin release within the institution", async () => {
    const { exam } = await createGradedSubmission();
    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN"));

    const res = await marksReleaseRoute.POST(jsonRequest("POST"), {
      params: Promise.resolve({ examId: exam.id }),
    });
    expect(res.status).toBe(200);
  });
});

// One-Question-At-A-Time Exam Delivery v1 — see
// docs/one-question-delivery-v1.md.
describe("One-Question-At-A-Time Exam Delivery v1", () => {
  async function createExamWithQuestions(secureSettings: Record<string, unknown>) {
    const exam = await prisma.exam.create({
      data: {
        title: `One-Question Exam ${Date.now()}-${Math.random()}`,
        durationMins: 30,
        published: true,
        createdById: lecturer.id,
        institutionId: testInstitution.id,
        secureSettings: { secureModeEnabled: true, ...secureSettings },
      },
    });
    const q1 = await prisma.question.create({
      data: { examId: exam.id, type: "SHORT_ANSWER", text: "Q1", points: 1, correctAnswer: "a1", order: 0 },
    });
    const q2 = await prisma.question.create({
      data: {
        examId: exam.id,
        type: "MULTIPLE_CHOICE",
        text: "Q2",
        points: 1,
        correctAnswer: "B",
        order: 1,
        options: ["A", "B", "C"],
      },
    });
    const q3 = await prisma.question.create({
      data: { examId: exam.id, type: "ESSAY", text: "Q3", points: 1, order: 2 },
    });
    return { exam, questions: [q1, q2, q3] };
  }

  async function startAsStudent(examId: string, studentUser: { id: string } = student) {
    mockAuth.mockResolvedValue(sessionFor(studentUser.id, "STUDENT"));
    const res = await startRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: examId }) });
    return res.json();
  }

  it("6. normal exam mode (oneQuestionAtATime false) still returns the full question list unchanged", async () => {
    const { exam } = await createExamWithQuestions({ oneQuestionAtATime: false });
    const submission = await startAsStudent(exam.id);

    const res = await submissionRoute.GET(jsonRequest("GET"), {
      params: Promise.resolve({ id: submission.id }),
    });
    const body = await res.json();
    expect(body.exam.questions).toHaveLength(3);
  });

  it("7/8. one-question mode returns only the current question, never correctAnswer or other questions", async () => {
    const { exam } = await createExamWithQuestions({ oneQuestionAtATime: true });
    const submission = await startAsStudent(exam.id);

    const submissionRes = await submissionRoute.GET(jsonRequest("GET"), {
      params: Promise.resolve({ id: submission.id }),
    });
    const submissionBody = await submissionRes.json();
    expect(submissionBody.exam.questions).toEqual([]);
    expect(submissionBody.exam.totalQuestions).toBe(3);

    const res = await questionRoute.GET(jsonRequest("GET"), {
      params: Promise.resolve({ id: submission.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalQuestions).toBe(3);
    expect(body.currentIndex).toBe(0);
    expect(body.question).toBeDefined();
    expect(body.question.correctAnswer).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/correctAnswer|"a1"|"B"/);
  });

  it("returns 400 from the question routes when oneQuestionAtATime is not enabled for the exam", async () => {
    const { exam } = await createExamWithQuestions({ oneQuestionAtATime: false });
    const submission = await startAsStudent(exam.id);

    const res = await questionRoute.GET(jsonRequest("GET"), {
      params: Promise.resolve({ id: submission.id }),
    });
    expect(res.status).toBe(400);
  });

  it("9/15. stable question order persists across repeated GETs for the same submission (refresh)", async () => {
    const { exam } = await createExamWithQuestions({
      oneQuestionAtATime: true,
      randomiseQuestionOrder: true,
    });
    const submission = await startAsStudent(exam.id);

    const first = await (
      await questionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) })
    ).json();
    const second = await (
      await questionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) })
    ).json();
    expect(second.question.id).toBe(first.question.id);
    expect(second.currentIndex).toBe(first.currentIndex);
  });

  it("10. random question order can differ across different submissions", async () => {
    const { exam } = await createExamWithQuestions({
      oneQuestionAtATime: true,
      randomiseQuestionOrder: true,
    });

    // Start several attempts (different students) and collect the first
    // question each one sees — with 3 questions and enough attempts, at
    // least one should differ from the others if shuffling is real.
    const firstQuestionIds = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const extraStudent = await prisma.user.create({
        data: {
          name: `OneQ Student ${i}`,
          email: `oneq-stud-${Date.now()}-${i}@test.local`,
          passwordHash: "x",
          role: "STUDENT",
          institutionId: testInstitution.id,
        },
      });
      const submission = await startAsStudent(exam.id, extraStudent);
      const payload = await (
        await questionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) })
      ).json();
      firstQuestionIds.add(payload.question.id);
      await prisma.submission.deleteMany({ where: { studentId: extraStudent.id } });
      await prisma.user.delete({ where: { id: extraStudent.id } });
    }
    expect(firstQuestionIds.size).toBeGreaterThan(1);
  });

  it("11. non-randomised order preserves the lecturer/original Question.order", async () => {
    const { exam, questions } = await createExamWithQuestions({
      oneQuestionAtATime: true,
      randomiseQuestionOrder: false,
    });
    const submission = await startAsStudent(exam.id);

    const payload = await (
      await questionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) })
    ).json();
    expect(payload.question.id).toBe(questions[0].id);
  });

  it("12. Next navigation saves the current answer before advancing", async () => {
    const { exam, questions } = await createExamWithQuestions({ oneQuestionAtATime: true });
    const submission = await startAsStudent(exam.id);

    const first = await (
      await questionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) })
    ).json();
    await answersRoute.PATCH(jsonRequest("PATCH", { questionId: first.question.id, response: "my answer" }), {
      params: Promise.resolve({ id: submission.id }),
    });

    const next = await questionProgressRoute.POST(jsonRequest("POST", { currentIndex: 1 }), {
      params: Promise.resolve({ id: submission.id }),
    });
    expect(next.status).toBe(200);
    const nextBody = await next.json();
    expect(nextBody.currentIndex).toBe(1);

    const savedAnswer = await prisma.answer.findUnique({
      where: { submissionId_questionId: { submissionId: submission.id, questionId: questions[0].id } },
    });
    expect(savedAnswer?.response).toBe("my answer");
  });

  it("13. Previous navigation also saves the current answer first, and existingResponse is returned on return", async () => {
    const { exam } = await createExamWithQuestions({ oneQuestionAtATime: true, allowBackNavigation: true });
    const submission = await startAsStudent(exam.id);

    const first = await (
      await questionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) })
    ).json();
    await answersRoute.PATCH(jsonRequest("PATCH", { questionId: first.question.id, response: "answer 1" }), {
      params: Promise.resolve({ id: submission.id }),
    });
    await questionProgressRoute.POST(jsonRequest("POST", { currentIndex: 1 }), {
      params: Promise.resolve({ id: submission.id }),
    });

    const back = await questionProgressRoute.POST(jsonRequest("POST", { currentIndex: 0 }), {
      params: Promise.resolve({ id: submission.id }),
    });
    expect(back.status).toBe(200);
    const backBody = await back.json();
    expect(backBody.currentIndex).toBe(0);
    expect(backBody.existingResponse).toBe("answer 1");
  });

  it("14. Previous is blocked (index never moves backward) when allowBackNavigation is false, even via direct API call", async () => {
    const { exam } = await createExamWithQuestions({
      oneQuestionAtATime: true,
      allowBackNavigation: false,
    });
    const submission = await startAsStudent(exam.id);

    await questionProgressRoute.POST(jsonRequest("POST", { currentIndex: 1 }), {
      params: Promise.resolve({ id: submission.id }),
    });
    const blocked = await questionProgressRoute.POST(jsonRequest("POST", { currentIndex: 0 }), {
      params: Promise.resolve({ id: submission.id }),
    });
    expect(blocked.status).toBe(200);
    const blockedBody = await blocked.json();
    // Stays at index 1 — the requested backward move to 0 is ignored.
    expect(blockedBody.currentIndex).toBe(1);
    expect(blockedBody.canGoPrevious).toBe(false);

    const events = await prisma.integrityEvent.findMany({
      where: { submissionId: submission.id, eventType: "QUESTION_BACK_NAVIGATION_BLOCKED" },
    });
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it("14. Previous is not offered (canGoPrevious false) at question 1 even when allowBackNavigation is true", async () => {
    const { exam } = await createExamWithQuestions({ oneQuestionAtATime: true, allowBackNavigation: true });
    const submission = await startAsStudent(exam.id);

    const payload = await (
      await questionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) })
    ).json();
    expect(payload.canGoPrevious).toBe(false);
    expect(payload.canGoNext).toBe(true);
  });

  it("15. refresh (a plain GET with no navigation) restores the current question after moving forward", async () => {
    const { exam, questions } = await createExamWithQuestions({ oneQuestionAtATime: true });
    const submission = await startAsStudent(exam.id);

    await questionProgressRoute.POST(jsonRequest("POST", { currentIndex: 2 }), {
      params: Promise.resolve({ id: submission.id }),
    });

    const refreshed = await (
      await questionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) })
    ).json();
    expect(refreshed.currentIndex).toBe(2);
    expect(refreshed.question.id).toBe(questions[2].id);
  });

  it("16. submit still works normally when oneQuestionAtATime is enabled", async () => {
    const { exam, questions } = await createExamWithQuestions({ oneQuestionAtATime: true });
    const submission = await startAsStudent(exam.id);

    await answersRoute.PATCH(
      jsonRequest("PATCH", { questionId: questions[0].id, response: "a1" }),
      { params: Promise.resolve({ id: submission.id }) },
    );

    const res = await submitRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("SUBMITTED");
  });

  it("18. evidence-frame/lecturer evidence report behaviour is unaffected by one-question mode", async () => {
    const { exam } = await createExamWithQuestions({ oneQuestionAtATime: true });
    const submission = await startAsStudent(exam.id);

    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));
    const res = await evidenceRoute.GET(jsonRequest("GET"), {
      params: Promise.resolve({ id: submission.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.evidenceFrames)).toBe(true);
  });
});
