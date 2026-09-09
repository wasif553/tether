/**
 * Fix student completed-submission results flow — see
 * docs/student-released-results-flow-v1.md.
 *
 * Covers the actual routing/data-gap this fix closes:
 *  - GET /api/submissions/[id]/secure-client/status now reports the real
 *    submissionStatus (root-cause fix for a finished Tether-required
 *    submission being sent through the native-lockdown reactivation
 *    pipeline instead of the read-only results view).
 *  - GET /api/exams/available exposes marksReleased/totalPoints/
 *    submission.totalScore, correctly gated by Exam.marksReleasedAt.
 *  - GET /api/submissions/[id] enforces per-student ownership.
 *  - The existing repeat-attempt rejection is unaffected by this fix.
 *
 * Marks-visibility gating itself (canStudentViewMarks) already has pure
 * unit coverage in assessmentLifecycle.test.ts — not duplicated here.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import type { Prisma } from "@/generated/prisma/client";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const startRoute = await import("../app/api/exams/[id]/start/route");
const statusRoute = await import("../app/api/submissions/[id]/secure-client/status/route");
const submissionRoute = await import("../app/api/submissions/[id]/route");
const availableRoute = await import("../app/api/exams/available/route");

const stamp = Date.now();
const cleanupUserIds: string[] = [];
const cleanupExamIds: string[] = [];

function sessionFor(userId: string, institutionId: string) {
  return {
    user: { id: userId, email: "test@test.invalid", name: "Test", role: "STUDENT" as const, institutionId },
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

let institutionId: string;
let lecturerId: string;

beforeAll(async () => {
  const inst = await getOrCreateTestInstitution(`student-results-flow-${stamp}`);
  institutionId = inst.id;
  const passwordHash = await bcrypt.hash("password", 4);
  const lecturer = await prisma.user.create({
    data: { name: "Results Flow Lecturer", email: `results-flow-lecturer-${stamp}@test.invalid`, passwordHash, role: "LECTURER", institutionId },
  });
  lecturerId = lecturer.id;
  cleanupUserIds.push(lecturer.id);
});

afterAll(async () => {
  await prisma.answer.deleteMany({ where: { submission: { studentId: { in: cleanupUserIds } } } });
  await prisma.submission.deleteMany({ where: { studentId: { in: cleanupUserIds } } });
  await prisma.exam.deleteMany({ where: { id: { in: cleanupExamIds } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
});

async function makeStudent(tag: string) {
  const passwordHash = await bcrypt.hash("password", 4);
  const user = await prisma.user.create({
    data: { name: `Results Flow Student ${tag}`, email: `results-flow-${tag}-${stamp}@test.invalid`, passwordHash, role: "STUDENT", institutionId },
  });
  cleanupUserIds.push(user.id);
  return user;
}

async function makeExam(tag: string, secureSettings: Record<string, unknown>) {
  const exam = await prisma.exam.create({
    data: {
      title: `Results Flow Exam ${tag} ${stamp}-${Math.random()}`,
      durationMins: 30,
      published: true,
      createdById: lecturerId,
      institutionId,
      secureSettings: secureSettings as Prisma.InputJsonValue,
    },
  });
  cleanupExamIds.push(exam.id);
  const question = await prisma.question.create({
    data: { examId: exam.id, type: "SHORT_ANSWER", text: "Q1", points: 10, correctAnswer: "ok" },
  });
  return { exam, question };
}

describe("GET /api/submissions/[id]/secure-client/status — submissionStatus (root cause fix)", () => {
  it("reports IN_PROGRESS for a live Tether-required attempt (unchanged behavior)", async () => {
    const student = await makeStudent("tether-live");
    const { exam } = await makeExam("tether-live", { deliveryMode: "TETHER_CLIENT_REQUIRED", maxAttempts: 1 });
    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const startRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    const submission = await startRes.json();

    const statusRes = await statusRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    const body = await statusRes.json();
    expect(body.submissionStatus).toBe("IN_PROGRESS");
    expect(body.deliveryMode).toBe("TETHER_CLIENT_REQUIRED");
  });

  it("reports SUBMITTED for a finished Tether-required attempt — the exact signal the exam-taking page's pre-load gate now uses to skip native-lockdown reactivation", async () => {
    const student = await makeStudent("tether-submitted");
    const { exam } = await makeExam("tether-submitted", { deliveryMode: "TETHER_CLIENT_REQUIRED", maxAttempts: 1 });
    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const startRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    const submission = await startRes.json();
    await prisma.submission.update({ where: { id: submission.id }, data: { status: "SUBMITTED", submittedAt: new Date() } });

    const statusRes = await statusRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    const body = await statusRes.json();
    expect(body.submissionStatus).toBe("SUBMITTED");
    // deliveryMode itself is UNCHANGED — still the attempt's real frozen
    // policy, still read verbatim by tether-launch/secure-client pages
    // for a live attempt. Only submissionStatus is new.
    expect(body.deliveryMode).toBe("TETHER_CLIENT_REQUIRED");
  });

  it("reports GRADED for a graded Tether-required attempt", async () => {
    const student = await makeStudent("tether-graded");
    const { exam } = await makeExam("tether-graded", { deliveryMode: "TETHER_CLIENT_REQUIRED", maxAttempts: 1 });
    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const startRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    const submission = await startRes.json();
    await prisma.submission.update({
      where: { id: submission.id },
      data: { status: "GRADED", submittedAt: new Date(), gradedAt: new Date(), totalScore: 8 },
    });

    const statusRes = await statusRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    const body = await statusRes.json();
    expect(body.submissionStatus).toBe("GRADED");
  });
});

describe("GET /api/exams/available — marksReleased/score gating on the dashboard", () => {
  it("hides totalScore before marksReleasedAt, and reports marksReleased:false", async () => {
    const student = await makeStudent("available-hidden");
    const { exam, question } = await makeExam("available-hidden", { maxAttempts: 1 });
    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const startRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    const submission = await startRes.json();
    await prisma.answer.create({ data: { submissionId: submission.id, questionId: question.id, response: "ok", score: 8 } });
    await prisma.submission.update({
      where: { id: submission.id },
      data: { status: "GRADED", submittedAt: new Date(), gradedAt: new Date(), totalScore: 8 },
    });

    const res = await availableRoute.GET();
    expect(res.status).toBe(200);
    const exams = await res.json();
    const found = exams.find((e: { id: string }) => e.id === exam.id);
    expect(found.marksReleased).toBe(false);
    expect(found.submission.status).toBe("GRADED");
    expect(found.submission.totalScore).toBeNull();
    expect(found.totalPoints).toBe(10);
  });

  it("shows totalScore once the exam's marksReleasedAt is set", async () => {
    const student = await makeStudent("available-released");
    const { exam, question } = await makeExam("available-released", { maxAttempts: 1 });
    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const startRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    const submission = await startRes.json();
    await prisma.answer.create({ data: { submissionId: submission.id, questionId: question.id, response: "ok", score: 8 } });
    await prisma.submission.update({
      where: { id: submission.id },
      data: { status: "GRADED", submittedAt: new Date(), gradedAt: new Date(), totalScore: 8 },
    });
    await prisma.exam.update({ where: { id: exam.id }, data: { marksReleasedAt: new Date(), marksReleasedById: lecturerId } });

    const res = await availableRoute.GET();
    const exams = await res.json();
    const found = exams.find((e: { id: string }) => e.id === exam.id);
    expect(found.marksReleased).toBe(true);
    expect(found.submission.totalScore).toBe(8);
    expect(found.totalPoints).toBe(10);
  });

  it("a SUBMITTED (not yet graded) exam reports null totalScore regardless of release", async () => {
    const student = await makeStudent("available-submitted");
    const { exam } = await makeExam("available-submitted", { maxAttempts: 1 });
    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const startRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    const submission = await startRes.json();
    await prisma.submission.update({ where: { id: submission.id }, data: { status: "SUBMITTED", submittedAt: new Date() } });

    const res = await availableRoute.GET();
    const exams = await res.json();
    const found = exams.find((e: { id: string }) => e.id === exam.id);
    expect(found.submission.status).toBe("SUBMITTED");
    expect(found.submission.totalScore).toBeNull();
  });
});

describe("GET /api/submissions/[id] — ownership (Part 10)", () => {
  it("a student cannot read another student's submission (403)", async () => {
    const studentA = await makeStudent("owner-a");
    const studentB = await makeStudent("owner-b");
    const { exam } = await makeExam("ownership", { maxAttempts: 1 });
    mockAuth.mockResolvedValue(sessionFor(studentA.id, institutionId));
    const startRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    const submission = await startRes.json();

    mockAuth.mockResolvedValue(sessionFor(studentB.id, institutionId));
    const res = await submissionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(403);
  });

  it("the owning student can read their own finished submission, with marks gated by marksReleasedAt", async () => {
    const student = await makeStudent("owner-self");
    const { exam, question } = await makeExam("owner-self", { maxAttempts: 1 });
    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const startRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    const submission = await startRes.json();
    await prisma.answer.create({ data: { submissionId: submission.id, questionId: question.id, response: "ok", score: 8, feedback: "Good work" } });
    await prisma.submission.update({
      where: { id: submission.id },
      data: { status: "GRADED", submittedAt: new Date(), gradedAt: new Date(), totalScore: 8 },
    });

    const beforeRelease = await submissionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    const beforeBody = await beforeRelease.json();
    expect(beforeBody.totalScore).toBeNull();
    expect(beforeBody.answers[0].score).toBeUndefined();
    expect(beforeBody.answers[0].feedback).toBeUndefined();

    await prisma.exam.update({ where: { id: exam.id }, data: { marksReleasedAt: new Date(), marksReleasedById: lecturerId } });
    const afterRelease = await submissionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    const afterBody = await afterRelease.json();
    expect(afterBody.totalScore).toBe(8);
    expect(afterBody.answers[0].score).toBe(8);
    expect(afterBody.answers[0].feedback).toBe("Good work");
    // Never exposed to a student, released or not.
    expect(afterBody.exam.questions[0].correctAnswer).toBeUndefined();
  });
});

describe("repeat-attempt rejection is unaffected by this fix (Part 9)", () => {
  it("a finalized (SUBMITTED) attempt at maxAttempts=1 still refuses a new attempt", async () => {
    const student = await makeStudent("repeat-attempt");
    const { exam } = await makeExam("repeat-attempt", { maxAttempts: 1 });
    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const startRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    const submission = await startRes.json();
    await prisma.submission.update({ where: { id: submission.id }, data: { status: "SUBMITTED", submittedAt: new Date() } });

    const secondStart = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(secondStart.status).toBe(409);
  });
});
