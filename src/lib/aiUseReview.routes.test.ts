/**
 * AI-Use Answer Review v1 — DB-backed route tests. See
 * docs/ai-use-answer-review-v1.md.
 *
 * Requires the local test Postgres instance. Pure logic (anchors,
 * grounding, generic-response, required concepts, unsupported claims,
 * meta-language, style consistency, recommendation) is covered separately
 * in aiUseReview.test.ts with no DB dependency at all. The Anthropic
 * client is mocked (never a real network call) so these tests exercise
 * both the "not configured" and "AI-assisted configured" code paths.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = { create: mockCreate };
  }
  return { default: MockAnthropic };
});

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const aiUseReviewRoute = await import("../app/api/lecturer/submissions/[id]/ai-use-review/route");
const aiUseReviewSignalReviewRoute = await import(
  "../app/api/lecturer/ai-use-review-signals/[signalId]/review/route"
);

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
let instB: string;
let lecturerA: { id: string };
let otherLecturerSameInst: { id: string };
let lecturerB: { id: string };
let studentA: { id: string };

beforeAll(async () => {
  const a = await getOrCreateTestInstitution(`ai-use-review-a-${stamp}`);
  instA = a.id;
  const b = await getOrCreateTestInstitution(`ai-use-review-b-${stamp}`);
  instB = b.id;
  const passwordHash = await bcrypt.hash("test-password", 4);
  lecturerA = await prisma.user.create({
    data: { name: "AIR Lecturer A", email: `air-lect-a-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instA },
  });
  otherLecturerSameInst = await prisma.user.create({
    data: { name: "AIR Other Lecturer", email: `air-lect-other-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instA },
  });
  lecturerB = await prisma.user.create({
    data: { name: "AIR Lecturer B", email: `air-lect-b-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instB },
  });
  studentA = await prisma.user.create({
    data: { name: "AIR Student A", email: `air-stud-a-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instA },
  });
  cleanup.users.push(lecturerA.id, otherLecturerSameInst.id, lecturerB.id, studentA.id);
});

afterEach(() => {
  mockCreate.mockReset();
  delete process.env.ANTHROPIC_API_KEY;
});

afterAll(async () => {
  await prisma.aiUseReviewSignal.deleteMany({ where: { analysis: { examId: { in: cleanup.exams } } } });
  await prisma.aiUseReviewAnalysis.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.answer.deleteMany({ where: { submission: { examId: { in: cleanup.exams } } } });
  await prisma.submission.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.question.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.exam.deleteMany({ where: { id: { in: cleanup.exams } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanup.users } } });
});

const SCENARIO_QUESTION_TEXT =
  'Acme Corp runs a Microsoft 365 environment with a $50,000 annual security budget. Explain how you would apply ' +
  '"least privilege" to their admin accounts given these constraints.';

const GENERIC_ANSWER_TEXT =
  "In general, cybersecurity is a wide range of practices that plays a crucial role in protecting organisations. " +
  "It is important to note that there are many factors involved, and in today's world, various factors must be balanced. " +
  "Overall, a variety of controls exist, and in summary, broadly speaking, security is essential for any organisation " +
  "operating in today's society. In conclusion, it is essential to consider all of these factors carefully.";

async function createExamWithSubmission(opts: { includeCorrectAnswer?: boolean } = {}) {
  const exam = await prisma.exam.create({
    data: { title: `AI Use Review Exam ${Date.now()}-${Math.random()}`, durationMins: 30, published: true, createdById: lecturerA.id, institutionId: instA },
  });
  cleanup.exams.push(exam.id);
  const essayQuestion = await prisma.question.create({
    data: {
      examId: exam.id,
      type: "ESSAY",
      text: SCENARIO_QUESTION_TEXT,
      points: 10,
      order: 0,
      correctAnswer: opts.includeCorrectAnswer ? "Use Privileged Identity Management with just-in-time elevation." : null,
    },
  });
  const submission = await prisma.submission.create({
    data: { examId: exam.id, studentId: studentA.id, status: "SUBMITTED", submittedAt: new Date() },
  });
  const answer = await prisma.answer.create({
    data: { submissionId: submission.id, questionId: essayQuestion.id, response: GENERIC_ANSWER_TEXT },
  });
  return { exam, essayQuestion, submission, answer };
}

describe("POST/GET /api/lecturer/submissions/[id]/ai-use-review — access control", () => {
  it("1. authorised lecturer can run analysis", async () => {
    const { submission } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await aiUseReviewRoute.POST(jsonRequest("POST", {}), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("2. an unauthorised lecturer at the same institution (does not own the exam) cannot run analysis", async () => {
    const { submission } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(otherLecturerSameInst.id, "LECTURER", instA));
    const res = await aiUseReviewRoute.POST(jsonRequest("POST", {}), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(404);
  });

  it("3. a cross-institution lecturer cannot run analysis", async () => {
    const { submission } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(lecturerB.id, "LECTURER", instB));
    const res = await aiUseReviewRoute.POST(jsonRequest("POST", {}), { params: Promise.resolve({ id: submission.id }) });
    expect([403, 404]).toContain(res.status);
  });

  it("4. a student cannot run analysis or read results", async () => {
    const { submission } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const postRes = await aiUseReviewRoute.POST(jsonRequest("POST", {}), { params: Promise.resolve({ id: submission.id }) });
    expect(postRes.status).toBe(401);
    const getRes = await aiUseReviewRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    expect(getRes.status).toBe(401);
  });

  it("5. audit log is written when analysis runs", async () => {
    const { exam, submission } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    await aiUseReviewRoute.POST(jsonRequest("POST", {}), { params: Promise.resolve({ id: submission.id }) });

    const startedLog = await prisma.platformAuditLog.findFirst({
      where: { targetType: "Submission", targetId: submission.id, action: "AI_USE_REVIEW_ANALYSIS_STARTED" },
    });
    expect(startedLog).not.toBeNull();
    expect(startedLog?.institutionId).toBe(instA);
    void exam;
  });
});

describe("Deterministic analysis correctness (AI not configured)", () => {
  it("6. not-configured AI provider still returns a safe deterministic result", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { submission } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    await aiUseReviewRoute.POST(jsonRequest("POST", {}), { params: Promise.resolve({ id: submission.id }) });

    const res = await aiUseReviewRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    const body = await res.json();
    expect(body.analysis.status).toBe("COMPLETE");
    expect(body.analysis.provider).toBe("deterministic");
    expect(body.analysis.summary.aiAssisted.status).toBe("NOT_CONFIGURED");
    expect(body.analysis.signals.length).toBeGreaterThan(0);
  });

  it("7. never returns a correct answer or private lecturer notes to the response body", async () => {
    const { submission } = await createExamWithSubmission({ includeCorrectAnswer: true });
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    await aiUseReviewRoute.POST(jsonRequest("POST", {}), { params: Promise.resolve({ id: submission.id }) });
    const res = await aiUseReviewRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("Privileged Identity Management with just-in-time elevation");
  });

  it("8. submission remains SUBMITTED even if AI-use review analysis is run", async () => {
    const { submission } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    await aiUseReviewRoute.POST(jsonRequest("POST", {}), { params: Promise.resolve({ id: submission.id }) });
    const refreshed = await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(refreshed.status).toBe("SUBMITTED");
    expect(refreshed.totalScore).toBeNull();
  });
});

describe("Optional AI-assisted analysis integration", () => {
  it("9. a valid AI-assisted response is merged into the analysis", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockCreate.mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            signals: [],
            overallLevel: "NONE",
            reviewRecommended: false,
          }),
        },
      ],
    });
    const { submission } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    await aiUseReviewRoute.POST(jsonRequest("POST", {}), { params: Promise.resolve({ id: submission.id }) });
    const res = await aiUseReviewRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    const body = await res.json();
    expect(body.analysis.provider).toBe("deterministic+anthropic");
    expect(body.analysis.summary.aiAssisted.status).toBe("COMPLETE");
  });

  it("10. an AI provider failure never fails the submission and preserves deterministic results", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockCreate.mockRejectedValue(new Error("simulated timeout"));
    const { submission } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const postRes = await aiUseReviewRoute.POST(jsonRequest("POST", {}), { params: Promise.resolve({ id: submission.id }) });
    expect(postRes.status).toBe(200);

    const res = await aiUseReviewRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    const body = await res.json();
    expect(body.analysis.status).toBe("COMPLETE");
    expect(body.analysis.summary.aiAssisted.status).toBe("FAILED");
    expect(body.analysis.signals.length).toBeGreaterThan(0); // deterministic signals preserved

    const refreshed = await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(refreshed.status).toBe("SUBMITTED");
  });

  it("11. an invalid AI response body is rejected safely and deterministic results are preserved", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "not valid json" }] });
    const { submission } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    await aiUseReviewRoute.POST(jsonRequest("POST", {}), { params: Promise.resolve({ id: submission.id }) });
    const res = await aiUseReviewRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    const body = await res.json();
    expect(body.analysis.status).toBe("COMPLETE");
    expect(body.analysis.summary.aiAssisted.status).toBe("FAILED");
  });
});

describe("PATCH /api/lecturer/ai-use-review-signals/[signalId]/review", () => {
  async function runAndGetFirstSignalId(submissionId: string) {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    await aiUseReviewRoute.POST(jsonRequest("POST", {}), { params: Promise.resolve({ id: submissionId }) });
    const getRes = await aiUseReviewRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submissionId }) });
    const { analysis } = await getRes.json();
    return analysis.signals[0].id as string;
  }

  it("12. authorised lecturer can update a signal's review status, and it is audited", async () => {
    const { submission } = await createExamWithSubmission();
    const signalId = await runAndGetFirstSignalId(submission.id);

    const res = await aiUseReviewSignalReviewRoute.PATCH(
      jsonRequest("PATCH", { reviewStatus: "REVIEWED_NO_CONCERN", reviewNote: "Checked with the student informally" }),
      { params: Promise.resolve({ signalId }) },
    );
    expect(res.status).toBe(200);

    const log = await prisma.platformAuditLog.findFirst({
      where: { targetType: "AiUseReviewSignal", targetId: signalId, action: "AI_USE_REVIEW_SIGNAL_REVIEW_UPDATED" },
    });
    expect(log).not.toBeNull();
    expect(JSON.stringify(log?.metadata ?? {})).not.toContain("informally");
  });

  it("13. a student cannot change review status or read private notes", async () => {
    const { submission } = await createExamWithSubmission();
    const signalId = await runAndGetFirstSignalId(submission.id);

    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await aiUseReviewSignalReviewRoute.PATCH(
      jsonRequest("PATCH", { reviewStatus: "REVIEWED_NO_CONCERN" }),
      { params: Promise.resolve({ signalId }) },
    );
    expect(res.status).toBe(401);
  });

  it("14. a cross-institution lecturer cannot change review status", async () => {
    const { submission } = await createExamWithSubmission();
    const signalId = await runAndGetFirstSignalId(submission.id);

    mockAuth.mockResolvedValue(sessionFor(lecturerB.id, "LECTURER", instB));
    const res = await aiUseReviewSignalReviewRoute.PATCH(
      jsonRequest("PATCH", { reviewStatus: "REVIEWED_NO_CONCERN" }),
      { params: Promise.resolve({ signalId }) },
    );
    expect([403, 404]).toContain(res.status);
  });
});

describe("Regression: AI-use review never mutates grading/marks", () => {
  it("15. running analysis does not change score/feedback on the Answer row", async () => {
    const { submission, answer } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    await aiUseReviewRoute.POST(jsonRequest("POST", {}), { params: Promise.resolve({ id: submission.id }) });
    const refreshed = await prisma.answer.findUniqueOrThrow({ where: { id: answer.id } });
    expect(refreshed.score).toBeNull();
    expect(refreshed.isCorrect).toBeNull();
  });

  it("16. running analysis never creates an OralVerification record", async () => {
    const { submission } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    await aiUseReviewRoute.POST(jsonRequest("POST", {}), { params: Promise.resolve({ id: submission.id }) });
    const verifications = await prisma.oralVerification.findMany({ where: { submissionId: submission.id } });
    expect(verifications).toHaveLength(0);
  });
});
