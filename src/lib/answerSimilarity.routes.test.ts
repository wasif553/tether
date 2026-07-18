/**
 * Answer Similarity Review + Oral Verification v1 — DB-backed route
 * tests. See docs/answer-similarity-review-v1.md and
 * docs/oral-verification-workflow-v1.md.
 *
 * Requires the local test Postgres instance. Pure logic (normalisation,
 * similarity math, MCQ pattern detection, pairing, recommendations,
 * question generation) is covered separately in answerSimilarity.test.ts
 * and oralVerificationQuestions.test.ts, with no DB dependency at all.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const similarityAnalysisRoute = await import("../app/api/lecturer/exams/[examId]/similarity-analysis/route");
const similarityReviewRoute = await import("../app/api/lecturer/similarity-matches/[matchId]/review/route");
const oralVerificationRoute = await import("../app/api/lecturer/submissions/[id]/oral-verification/route");
const submitRoute = await import("../app/api/submissions/[id]/submit/route");
const evidenceFrameRoute = await import(
  "../app/api/submissions/[id]/integrity-events/[eventId]/evidence-frame/route"
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
let lecturerA: { id: string };
let otherLecturer: { id: string };
let studentA: { id: string };
let studentB: { id: string };

beforeAll(async () => {
  const a = await getOrCreateTestInstitution(`answer-similarity-a-${stamp}`);
  instA = a.id;
  const passwordHash = await bcrypt.hash("test-password", 4);
  lecturerA = await prisma.user.create({
    data: { name: "Sim Lecturer A", email: `sim-lect-a-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instA },
  });
  otherLecturer = await prisma.user.create({
    data: { name: "Sim Other Lecturer", email: `sim-lect-other-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instA },
  });
  studentA = await prisma.user.create({
    data: { name: "Sim Student A", email: `sim-stud-a-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instA },
  });
  studentB = await prisma.user.create({
    data: { name: "Sim Student B", email: `sim-stud-b-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instA },
  });
  cleanup.users.push(lecturerA.id, otherLecturer.id, studentA.id, studentB.id);
});

afterAll(async () => {
  await prisma.submissionSimilarityMatch.deleteMany({ where: { analysis: { examId: { in: cleanup.exams } } } });
  await prisma.submissionSimilarityAnalysis.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.oralVerification.deleteMany({ where: { submission: { examId: { in: cleanup.exams } } } });
  await prisma.answer.deleteMany({ where: { submission: { examId: { in: cleanup.exams } } } });
  await prisma.submission.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.question.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.exam.deleteMany({ where: { id: { in: cleanup.exams } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanup.users } } });
});

async function createExamWithTwoSubmissions(opts: { identicalEssay?: boolean } = {}) {
  const exam = await prisma.exam.create({
    data: { title: `Similarity Exam ${Date.now()}-${Math.random()}`, durationMins: 30, published: true, createdById: lecturerA.id, institutionId: instA },
  });
  cleanup.exams.push(exam.id);
  const essayQuestion = await prisma.question.create({
    data: { examId: exam.id, type: "ESSAY", text: "Explain your reasoning.", points: 5, order: 0 },
  });
  const submissionA = await prisma.submission.create({
    data: { examId: exam.id, studentId: studentA.id, status: "SUBMITTED", submittedAt: new Date() },
  });
  const submissionB = await prisma.submission.create({
    data: { examId: exam.id, studentId: studentB.id, status: "SUBMITTED", submittedAt: new Date() },
  });
  const essayText =
    "The French Revolution began in 1789 due to widespread economic hardship, social inequality " +
    "between the estates, and the crushing weight of royal debt from foreign wars, culminating in " +
    "the storming of the Bastille as a symbol of the uprising against absolute monarchy.";
  await prisma.answer.create({
    data: { submissionId: submissionA.id, questionId: essayQuestion.id, response: essayText },
  });
  await prisma.answer.create({
    data: {
      submissionId: submissionB.id,
      questionId: essayQuestion.id,
      response: opts.identicalEssay ? essayText : "A completely different, unrelated short reply.",
    },
  });
  return { exam, essayQuestion, submissionA, submissionB };
}

describe("POST /api/lecturer/exams/[examId]/similarity-analysis — access control", () => {
  it("1. lecturer with exam access can run analysis", async () => {
    const { exam } = await createExamWithTwoSubmissions({ identicalEssay: true });
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await similarityAnalysisRoute.POST(jsonRequest("POST"), {
      params: Promise.resolve({ examId: exam.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("2. an unauthorised lecturer (does not own the exam) cannot run analysis", async () => {
    const { exam } = await createExamWithTwoSubmissions();
    mockAuth.mockResolvedValue(sessionFor(otherLecturer.id, "LECTURER", instA));
    const res = await similarityAnalysisRoute.POST(jsonRequest("POST"), {
      params: Promise.resolve({ examId: exam.id }),
    });
    expect(res.status).toBe(404);
  });

  it("3. a student cannot access similarity results", async () => {
    const { exam } = await createExamWithTwoSubmissions();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const getRes = await similarityAnalysisRoute.GET(jsonRequest("GET"), {
      params: Promise.resolve({ examId: exam.id }),
    });
    expect(getRes.status).toBe(401);
    const postRes = await similarityAnalysisRoute.POST(jsonRequest("POST"), {
      params: Promise.resolve({ examId: exam.id }),
    });
    expect(postRes.status).toBe(401);
  });
});

describe("Similarity analysis correctness", () => {
  it("4. finds an identical-essay match and never returns correct answers", async () => {
    const { exam } = await createExamWithTwoSubmissions({ identicalEssay: true });
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    await similarityAnalysisRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ examId: exam.id }) });

    const res = await similarityAnalysisRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ examId: exam.id }) });
    const body = await res.json();
    expect(body.analysis.status).toBe("COMPLETE");
    expect(body.analysis.matches.length).toBeGreaterThan(0);
    expect(JSON.stringify(body.analysis)).not.toMatch(/correctAnswer/i);
  });

  it("does not flag unrelated essays", async () => {
    const { exam } = await createExamWithTwoSubmissions({ identicalEssay: false });
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    await similarityAnalysisRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ examId: exam.id }) });
    const res = await similarityAnalysisRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ examId: exam.id }) });
    const body = await res.json();
    expect(body.analysis.matches).toHaveLength(0);
  });
});

describe("PATCH /api/lecturer/similarity-matches/[matchId]/review", () => {
  it("5. a student cannot change review status", async () => {
    const { exam } = await createExamWithTwoSubmissions({ identicalEssay: true });
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    await similarityAnalysisRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ examId: exam.id }) });
    const getRes = await similarityAnalysisRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ examId: exam.id }) });
    const { analysis } = await getRes.json();
    const matchId = analysis.matches[0].id;

    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await similarityReviewRoute.PATCH(
      jsonRequest("PATCH", { reviewStatus: "REVIEWED_NO_CONCERN" }),
      { params: Promise.resolve({ matchId }) },
    );
    expect(res.status).toBe(401);
  });

  it("6. review action is audited", async () => {
    const { exam } = await createExamWithTwoSubmissions({ identicalEssay: true });
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    await similarityAnalysisRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ examId: exam.id }) });
    const getRes = await similarityAnalysisRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ examId: exam.id }) });
    const { analysis } = await getRes.json();
    const matchId = analysis.matches[0].id;

    const res = await similarityReviewRoute.PATCH(
      jsonRequest("PATCH", { reviewStatus: "REVIEWED_NO_CONCERN", reviewNote: "Checked — coincidence" }),
      { params: Promise.resolve({ matchId }) },
    );
    expect(res.status).toBe(200);

    const log = await prisma.platformAuditLog.findFirst({
      where: { targetType: "SubmissionSimilarityMatch", targetId: matchId, action: "SIMILARITY_MATCH_REVIEW_UPDATED" },
    });
    expect(log).not.toBeNull();
    expect(JSON.stringify(log?.metadata ?? {})).not.toContain("coincidence");
  });
});

describe("POST /api/lecturer/submissions/[id]/oral-verification", () => {
  it("7. lecturer can require oral verification, and it is audited", async () => {
    const { exam, submissionA } = await createExamWithTwoSubmissions();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await oralVerificationRoute.POST(
      jsonRequest("POST", { reason: "Similarity review flagged this attempt" }),
      { params: Promise.resolve({ id: submissionA.id }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe("REQUIRED");
    expect(Array.isArray(body.generatedQuestionsJson)).toBe(true);
    expect(body.generatedQuestionsJson.length).toBeGreaterThanOrEqual(3);

    const log = await prisma.platformAuditLog.findFirst({
      where: { targetType: "OralVerification", targetId: body.id, action: "ORAL_VERIFICATION_REQUIRED" },
    });
    expect(log).not.toBeNull();
    void exam;
  });

  it("does not automatically create an OralVerification record from analysis alone", async () => {
    const { exam, submissionA } = await createExamWithTwoSubmissions({ identicalEssay: true });
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    await similarityAnalysisRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ examId: exam.id }) });

    const verifications = await prisma.oralVerification.findMany({ where: { submissionId: submissionA.id } });
    expect(verifications).toHaveLength(0);
  });
});

describe("Regression: unrelated features unaffected", () => {
  it("8. submission still succeeds normally (grading/submit unaffected by this feature)", async () => {
    const exam = await prisma.exam.create({
      data: { title: `Regression Exam ${Date.now()}`, durationMins: 30, published: true, createdById: lecturerA.id, institutionId: instA },
    });
    cleanup.exams.push(exam.id);
    const question = await prisma.question.create({
      data: { examId: exam.id, type: "SHORT_ANSWER", text: "Q1", points: 1, correctAnswer: "ok", order: 0 },
    });
    const submission = await prisma.submission.create({ data: { examId: exam.id, studentId: studentA.id } });
    await prisma.answer.create({ data: { submissionId: submission.id, questionId: question.id, response: "ok" } });

    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await submitRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("GRADED");
  });

  it("9. evidence-frame upload route is unaffected by this feature (still rejects missing file the same way)", async () => {
    const exam = await prisma.exam.create({
      data: {
        title: `Evidence Regression Exam ${Date.now()}`,
        durationMins: 30,
        published: true,
        createdById: lecturerA.id,
        institutionId: instA,
        secureSettings: { enableAiCameraIntegrityChecks: true, captureAiViolationEvidence: true },
      },
    });
    cleanup.exams.push(exam.id);
    const submission = await prisma.submission.create({ data: { examId: exam.id, studentId: studentA.id } });
    const event = await prisma.integrityEvent.create({
      data: {
        submissionId: submission.id,
        examId: exam.id,
        studentId: studentA.id,
        eventType: "POSSIBLE_PHONE_VISIBLE",
        severity: "MEDIUM",
        message: "test",
        occurredAt: new Date(),
      },
    });
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const formData = new FormData();
    const res = await evidenceFrameRoute.POST(new Request("http://test.local/route", { method: "POST", body: formData }), {
      params: Promise.resolve({ id: submission.id, eventId: event.id }),
    });
    expect(res.status).toBe(400);
  });
});
