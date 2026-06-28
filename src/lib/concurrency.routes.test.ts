import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const startRoute = await import("../app/api/exams/[id]/start/route");
const submitRoute = await import("../app/api/submissions/[id]/submit/route");
const integrityEventsRoute = await import("../app/api/submissions/[id]/integrity-events/route");
const analyticsModule = await import("./analytics");

let testInstitution: { id: string };

function sessionFor(userId: string, role: "LECTURER" | "STUDENT") {
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
let studentA: { id: string };
let studentB: { id: string };

beforeAll(async () => {
  testInstitution = await getOrCreateTestInstitution("concurrency-test");
  const passwordHash = await bcrypt.hash("test-password", 4);
  const stamp = Date.now();
  lecturer = await prisma.user.create({
    data: { name: "Concurrency Lecturer", email: `conc-lect-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: testInstitution.id },
  });
  studentA = await prisma.user.create({
    data: { name: "Concurrency Student A", email: `conc-stud-a-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: testInstitution.id },
  });
  studentB = await prisma.user.create({
    data: { name: "Concurrency Student B", email: `conc-stud-b-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: testInstitution.id },
  });
});

afterAll(async () => {
  const userIds = [lecturer.id, studentA.id, studentB.id];
  await prisma.integrityEvent.deleteMany({ where: { studentId: { in: userIds } } });
  await prisma.answer.deleteMany({ where: { submission: { studentId: { in: userIds } } } });
  await prisma.submission.deleteMany({ where: { studentId: { in: userIds } } });
  await prisma.question.deleteMany({ where: { exam: { createdById: lecturer.id, institutionId: testInstitution.id } } });
  await prisma.exam.deleteMany({ where: { createdById: lecturer.id, institutionId: testInstitution.id } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe("two students submitting the same exam independently", () => {
  it("both succeed without interfering with each other", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));
    const exam = await prisma.exam.create({
      data: { title: "Concurrent Submitters Exam", durationMins: 30, published: true, createdById: lecturer.id, institutionId: testInstitution.id },
    });

    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT"));
    const subA = await prisma.submission.create({ data: { examId: exam.id, studentId: studentA.id } });
    const resA = await submitRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: subA.id }) });

    mockAuth.mockResolvedValue(sessionFor(studentB.id, "STUDENT"));
    const subB = await prisma.submission.create({ data: { examId: exam.id, studentId: studentB.id } });
    const resB = await submitRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: subB.id }) });

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    const bodyA = await resA.json();
    const bodyB = await resB.json();
    expect(bodyA.id).toBe(subA.id);
    expect(bodyB.id).toBe(subB.id);
    expect(bodyA.id).not.toBe(bodyB.id);
  });
});

describe("concurrent exam-start requests cannot create duplicate submissions", () => {
  it("returns the same submission for two simultaneous start calls", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));
    const exam = await prisma.exam.create({
      data: { title: "Race Start Exam", durationMins: 30, published: true, createdById: lecturer.id, institutionId: testInstitution.id },
    });

    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT"));
    const [res1, res2] = await Promise.all([
      startRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: exam.id }) }),
      startRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: exam.id }) }),
    ]);

    expect([res1.status, res2.status].sort()).toEqual([200, 201]);
    const body1 = await res1.json();
    const body2 = await res2.json();
    expect(body1.id).toBe(body2.id);

    const count = await prisma.submission.count({ where: { examId: exam.id, studentId: studentA.id } });
    expect(count).toBe(1);
  });
});

describe("integrity event debounce under rapid repeated events", () => {
  it("returns the existing event instead of creating a new one within the debounce window", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));
    const exam = await prisma.exam.create({
      data: { title: "Debounce Exam", durationMins: 30, published: true, createdById: lecturer.id, institutionId: testInstitution.id },
    });

    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT"));
    const submission = await prisma.submission.create({ data: { examId: exam.id, studentId: studentA.id } });

    const fireBlur = () =>
      integrityEventsRoute.POST(
        jsonRequest("POST", {
          eventType: "WINDOW_BLUR",
          severity: "MEDIUM",
          message: "You switched away from the exam window.",
          occurredAt: new Date().toISOString(),
        }),
        { params: Promise.resolve({ id: submission.id }) },
      );

    const first = await fireBlur();
    expect(first.status).toBe(201);
    const firstBody = await first.json();

    // Rapid repeats within the 10s WINDOW_BLUR debounce window should not
    // create additional rows.
    const second = await fireBlur();
    const third = await fireBlur();
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);
    const secondBody = await second.json();
    const thirdBody = await third.json();
    expect(secondBody.id).toBe(firstBody.id);
    expect(thirdBody.id).toBe(firstBody.id);

    const count = await prisma.integrityEvent.count({
      where: { submissionId: submission.id, eventType: "WINDOW_BLUR" },
    });
    expect(count).toBe(1);
  });
});

describe("analytics with mixed IN_PROGRESS/SUBMITTED/GRADED submissions", () => {
  it("only counts finalized submissions in score-based stats, but counts all in totals", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));
    const exam = await prisma.exam.create({
      data: { title: "Mixed State Analytics Exam", durationMins: 30, published: true, createdById: lecturer.id, institutionId: testInstitution.id },
    });
    await prisma.question.create({
      data: { examId: exam.id, type: "SHORT_ANSWER", text: "Q1", points: 2, correctAnswer: "ok" },
    });

    const stamp = Date.now();
    const passwordHash = await bcrypt.hash("test-password", 4);
    const inProgressStudent = await prisma.user.create({
      data: { name: "Mixed IP", email: `mixed-ip-${stamp}@test.local`, passwordHash, role: "STUDENT" },
    });
    const submittedStudent = await prisma.user.create({
      data: { name: "Mixed SUB", email: `mixed-sub-${stamp}@test.local`, passwordHash, role: "STUDENT" },
    });
    const gradedStudent = await prisma.user.create({
      data: { name: "Mixed GR", email: `mixed-gr-${stamp}@test.local`, passwordHash, role: "STUDENT" },
    });

    await prisma.submission.create({ data: { examId: exam.id, studentId: inProgressStudent.id } });
    await prisma.submission.create({
      data: { examId: exam.id, studentId: submittedStudent.id, status: "SUBMITTED", submittedAt: new Date() },
    });
    await prisma.submission.create({
      data: {
        examId: exam.id,
        studentId: gradedStudent.id,
        status: "GRADED",
        submittedAt: new Date(),
        gradedAt: new Date(),
        totalScore: 2,
      },
    });

    const analytics = await analyticsModule.calculateExamAnalytics(exam.id);
    expect(analytics.summary.totalStudentsStarted).toBe(3);
    expect(analytics.summary.totalSubmitted).toBe(2);
    expect(analytics.summary.totalGraded).toBe(1);
    expect(analytics.summary.averageScorePct).toBe(100);
    expect(analytics.studentResults).toHaveLength(3);

    await prisma.submission.deleteMany({ where: { examId: exam.id } });
    await prisma.user.deleteMany({
      where: { id: { in: [inProgressStudent.id, submittedStudent.id, gradedStudent.id] } },
    });
  });
});
