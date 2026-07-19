/**
 * Question Navigator v1 — DB-backed route tests. See
 * docs/question-navigator-v1.md.
 *
 * Requires the local test Postgres instance. Pure navigation-rule and
 * state-derivation logic is covered separately in
 * questionNavigator.test.ts, with no DB dependency at all.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const navigatorRoute = await import("../app/api/submissions/[id]/question-navigator/route");
const progressRoute = await import("../app/api/submissions/[id]/question-progress/route");
const questionRoute = await import("../app/api/submissions/[id]/question/route");
const flagRoute = await import("../app/api/submissions/[id]/question-state/[questionId]/route");

function sessionFor(userId: string, role: "LECTURER" | "STUDENT" | "PLATFORM_ADMIN", institutionId: string) {
  return {
    user: { id: userId, email: `${userId}@test.local`, name: userId, role, institutionId },
    expires: new Date(Date.now() + 86_400_000).toISOString(),
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
const cleanup = { users: [] as string[], exams: [] as string[] };

let instA: string;
let studentA: { id: string };
let studentB: { id: string };
let lecturerA: { id: string };

beforeAll(async () => {
  const a = await getOrCreateTestInstitution(`question-navigator-a-${stamp}`);
  instA = a.id;
  const passwordHash = await bcrypt.hash("test-password", 4);
  lecturerA = await prisma.user.create({
    data: { name: "QN Lecturer A", email: `qn-lect-a-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instA },
  });
  studentA = await prisma.user.create({
    data: { name: "QN Student A", email: `qn-stud-a-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instA },
  });
  studentB = await prisma.user.create({
    data: { name: "QN Student B", email: `qn-stud-b-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instA },
  });
  cleanup.users.push(lecturerA.id, studentA.id, studentB.id);
});

afterAll(async () => {
  await prisma.submissionQuestionState.deleteMany({ where: { submission: { examId: { in: cleanup.exams } } } });
  await prisma.integrityEvent.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.answer.deleteMany({ where: { submission: { examId: { in: cleanup.exams } } } });
  await prisma.submission.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.question.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.exam.deleteMany({ where: { id: { in: cleanup.exams } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanup.users } } });
});

async function createExamAndSubmission(opts: { allowQuestionJumping?: boolean; allowBackNavigation?: boolean; allowFlagForReview?: boolean; questionCount?: number } = {}) {
  const exam = await prisma.exam.create({
    data: {
      title: `Question Navigator Exam ${Date.now()}-${Math.random()}`,
      durationMins: 30,
      published: true,
      createdById: lecturerA.id,
      institutionId: instA,
      secureSettings: {
        secureModeEnabled: true,
        oneQuestionAtATime: true,
        showQuestionNavigator: true,
        allowQuestionJumping: opts.allowQuestionJumping ?? false,
        allowBackNavigation: opts.allowBackNavigation ?? true,
        allowFlagForReview: opts.allowFlagForReview ?? true,
      },
    },
  });
  cleanup.exams.push(exam.id);
  const count = opts.questionCount ?? 3;
  const questions = [];
  for (let i = 0; i < count; i++) {
    questions.push(
      await prisma.question.create({
        data: { examId: exam.id, type: "SHORT_ANSWER", text: `Q${i}`, points: 1, order: i },
      }),
    );
  }
  const submission = await prisma.submission.create({
    data: { examId: exam.id, studentId: studentA.id, status: "IN_PROGRESS" },
  });
  return { exam, questions, submission };
}

describe("GET /api/submissions/[id]/question-navigator", () => {
  it("39. student can read their own navigator", async () => {
    const { submission } = await createExamAndSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await navigatorRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.submissionId).toBe(submission.id);
  });

  it("40. student cannot read another student's navigator", async () => {
    const { submission } = await createExamAndSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentB.id, "STUDENT", instA));
    const res = await navigatorRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(404);
  });

  it("43/44/45/46/47. navigator DTO contains no question text, answer text, correct answer, seed, or unselected questions", async () => {
    const { submission, questions } = await createExamAndSubmission();
    await prisma.answer.create({ data: { submissionId: submission.id, questionId: questions[0].id, response: "my secret answer text" } });
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await navigatorRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("my secret answer text");
    expect(text).not.toContain("Q0");
    expect(text).not.toMatch(/seed/i);
    expect(text).not.toMatch(/correctAnswer/i);
    // Only the persisted selected question ids/derived metadata appear.
    const body = JSON.parse(text);
    expect(body.questions).toHaveLength(3);
    expect(body.questions.map((q: { questionId: string }) => q.questionId).sort()).toEqual(questions.map((q) => q.id).sort());
  });

  it("1. a new reviewable question defaults to NOT_VISITED except the current one", async () => {
    const { submission } = await createExamAndSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await navigatorRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    const body = await res.json();
    expect(body.questions[0].state).toBe("CURRENT");
    expect(body.questions[1].state).toBe("NOT_VISITED");
  });
});

describe("POST /api/submissions/[id]/question-progress — GOTO", () => {
  it("12. jumping disabled rejects direct navigation", async () => {
    const { submission } = await createExamAndSubmission({ allowQuestionJumping: false });
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await progressRoute.POST(jsonRequest("POST", { action: "GOTO", targetIndex: 2 }), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Direct question navigation is not allowed for this exam");
  });

  it("13. jumping enabled allows future navigation", async () => {
    const { submission } = await createExamAndSubmission({ allowQuestionJumping: true });
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await progressRoute.POST(jsonRequest("POST", { action: "GOTO", targetIndex: 2 }), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.currentIndex).toBe(2);
  });

  it("15. back-disabled exam rejects a manipulated GOTO to an earlier index even with jumping allowed", async () => {
    const { submission } = await createExamAndSubmission({ allowQuestionJumping: true, allowBackNavigation: false });
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    await progressRoute.POST(jsonRequest("POST", { action: "GOTO", targetIndex: 2 }), { params: Promise.resolve({ id: submission.id }) });
    const res = await progressRoute.POST(jsonRequest("POST", { action: "GOTO", targetIndex: 0 }), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Back navigation is not allowed for this exam");
  });

  it("16. invalid target index is rejected with 400", async () => {
    const { submission } = await createExamAndSubmission({ allowQuestionJumping: true });
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await progressRoute.POST(jsonRequest("POST", { action: "GOTO", targetIndex: 99 }), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(400);
  });

  it("41. student cannot navigate another student's submission", async () => {
    const { submission } = await createExamAndSubmission({ allowQuestionJumping: true });
    mockAuth.mockResolvedValue(sessionFor(studentB.id, "STUDENT", instA));
    const res = await progressRoute.POST(jsonRequest("POST", { action: "GOTO", targetIndex: 1 }), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(404);
  });

  it("17. a submitted attempt rejects navigation with 409", async () => {
    const { submission } = await createExamAndSubmission({ allowQuestionJumping: true });
    await prisma.submission.update({ where: { id: submission.id }, data: { status: "SUBMITTED" } });
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await progressRoute.POST(jsonRequest("POST", { action: "GOTO", targetIndex: 1 }), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(409);
  });

  it("48/49. blocked direct navigation is logged as QUESTION_DIRECT_NAVIGATION_BLOCKED; an allowed one is logged as QUESTION_NAVIGATED_DIRECT (not a suspicious type)", async () => {
    const { submission } = await createExamAndSubmission({ allowQuestionJumping: false });
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    await progressRoute.POST(jsonRequest("POST", { action: "GOTO", targetIndex: 2 }), { params: Promise.resolve({ id: submission.id }) });
    const blockedEvents = await prisma.integrityEvent.findMany({ where: { submissionId: submission.id, eventType: "QUESTION_DIRECT_NAVIGATION_BLOCKED" } });
    expect(blockedEvents.length).toBeGreaterThan(0);
    expect(blockedEvents[0].severity).not.toBe("HIGH");

    const { submission: submission2 } = await createExamAndSubmission({ allowQuestionJumping: true });
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    await progressRoute.POST(jsonRequest("POST", { action: "GOTO", targetIndex: 2 }), { params: Promise.resolve({ id: submission2.id }) });
    const allowedEvents = await prisma.integrityEvent.findMany({ where: { submissionId: submission2.id, eventType: "QUESTION_NAVIGATED_DIRECT" } });
    expect(allowedEvents.length).toBeGreaterThan(0);
    expect(allowedEvents[0].severity).toBe("INFO");
  });

  it("existing sequential Next/Previous behaviour is unaffected by allowQuestionJumping: false", async () => {
    const { submission } = await createExamAndSubmission({ allowQuestionJumping: false });
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await progressRoute.POST(jsonRequest("POST", { currentIndex: 1 }), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.currentIndex).toBe(1);
  });
});

describe("GET /api/submissions/[id]/question — marks visited", () => {
  it("8. loading the current question marks it visited", async () => {
    const { submission, questions } = await createExamAndSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    await questionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    const state = await prisma.submissionQuestionState.findUnique({
      where: { submissionId_questionId: { submissionId: submission.id, questionId: questions[0].id } },
    });
    expect(state?.firstVisitedAt).not.toBeNull();
  });
});

describe("PATCH /api/submissions/[id]/question-state/[questionId]", () => {
  it("21. student can flag a selected question", async () => {
    const { submission, questions } = await createExamAndSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await flagRoute.PATCH(jsonRequest("PATCH", { flaggedForReview: true }), {
      params: Promise.resolve({ id: submission.id, questionId: questions[1].id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.flaggedForReview).toBe(true);
  });

  it("22/23. student can unflag, and the state persists (survives a fresh read)", async () => {
    const { submission, questions } = await createExamAndSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    await flagRoute.PATCH(jsonRequest("PATCH", { flaggedForReview: true }), { params: Promise.resolve({ id: submission.id, questionId: questions[1].id }) });
    await flagRoute.PATCH(jsonRequest("PATCH", { flaggedForReview: false }), { params: Promise.resolve({ id: submission.id, questionId: questions[1].id }) });
    const state = await prisma.submissionQuestionState.findUnique({
      where: { submissionId_questionId: { submissionId: submission.id, questionId: questions[1].id } },
    });
    expect(state?.flaggedForReview).toBe(false);
  });

  it("24. flagging disabled rejects the mutation", async () => {
    const { submission, questions } = await createExamAndSubmission({ allowFlagForReview: false });
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await flagRoute.PATCH(jsonRequest("PATCH", { flaggedForReview: true }), { params: Promise.resolve({ id: submission.id, questionId: questions[0].id }) });
    expect(res.status).toBe(403);
  });

  it("25. an unselected/foreign question cannot be flagged", async () => {
    const { submission } = await createExamAndSubmission();
    const { questions: foreignQuestions } = await createExamAndSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await flagRoute.PATCH(jsonRequest("PATCH", { flaggedForReview: true }), { params: Promise.resolve({ id: submission.id, questionId: foreignQuestions[0].id }) });
    expect(res.status).toBe(400);
  });

  it("42. student cannot flag another student's question", async () => {
    const { submission, questions } = await createExamAndSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentB.id, "STUDENT", instA));
    const res = await flagRoute.PATCH(jsonRequest("PATCH", { flaggedForReview: true }), { params: Promise.resolve({ id: submission.id, questionId: questions[0].id }) });
    expect(res.status).toBe(404);
  });

  it("26/27. flagging does not affect grade or create an integrity event", async () => {
    const { submission, questions } = await createExamAndSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const before = await prisma.submission.findUnique({ where: { id: submission.id } });
    const eventsBefore = await prisma.integrityEvent.count({ where: { submissionId: submission.id } });
    await flagRoute.PATCH(jsonRequest("PATCH", { flaggedForReview: true }), { params: Promise.resolve({ id: submission.id, questionId: questions[0].id }) });
    const after = await prisma.submission.findUnique({ where: { id: submission.id } });
    const eventsAfter = await prisma.integrityEvent.count({ where: { submissionId: submission.id } });
    expect(after?.totalScore).toBe(before?.totalScore);
    expect(eventsAfter).toBe(eventsBefore);
  });

  it("submitted attempts reject state changes", async () => {
    const { submission, questions } = await createExamAndSubmission();
    await prisma.submission.update({ where: { id: submission.id }, data: { status: "SUBMITTED" } });
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await flagRoute.PATCH(jsonRequest("PATCH", { flaggedForReview: true }), { params: Promise.resolve({ id: submission.id, questionId: questions[0].id }) });
    expect(res.status).toBe(409);
  });
});
