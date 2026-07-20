/**
 * Controlled AI Brainstorming Assistance v1 — DB-backed route tests. See
 * docs/controlled-ai-brainstorming-assistance-v1.md.
 *
 * Requires the local test Postgres instance. Pure classifier/policy/
 * verifier-composition logic is covered separately (no DB dependency) in
 * aiAssistancePolicy.test.ts, aiAssistanceClassifier.test.ts,
 * aiAssistanceGenerator.test.ts, aiAssistanceVerifier.test.ts and
 * aiAssistanceRunner.test.ts. The generator/verifier Anthropic calls are
 * mocked here too — these tests exercise ownership/limits/persistence
 * against a real database, never a live model.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/aiAssistanceGenerator", async () => {
  const actual = await vi.importActual<typeof import("./aiAssistanceGenerator")>("./aiAssistanceGenerator");
  return { ...actual, generateBrainstormResponse: vi.fn().mockResolvedValue("What concept do you think this question is testing?") };
});
vi.mock("@/lib/aiAssistanceVerifier", async () => {
  const actual = await vi.importActual<typeof import("./aiAssistanceVerifier")>("./aiAssistanceVerifier");
  return {
    ...actual,
    verifyBrainstormResponse: vi.fn().mockResolvedValue({ allowed: true, riskScore: 0.1, riskCodes: [], reason: "safe" }),
  };
});

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const assistanceRoute = await import("../app/api/submissions/[id]/questions/[questionId]/ai-assistance/route");
const reviewRoute = await import("../app/api/lecturer/submissions/[id]/ai-assistance/route");

function sessionFor(userId: string, role: "LECTURER" | "STUDENT" | "PLATFORM_ADMIN", institutionId: string) {
  return {
    user: { id: userId, email: `${userId}@test.local`, name: userId, role, institutionId },
    expires: new Date(Date.now() + 86_400_000).toISOString(),
  };
}

function jsonRequest(body?: unknown) {
  return new Request("http://test.local/route", {
    method: "POST",
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
  const a = await getOrCreateTestInstitution(`ai-assistance-a-${stamp}`);
  instA = a.id;
  const passwordHash = await bcrypt.hash("test-password", 4);
  lecturerA = await prisma.user.create({
    data: { name: "AIA Lecturer A", email: `aia-lect-a-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instA },
  });
  studentA = await prisma.user.create({
    data: { name: "AIA Student A", email: `aia-stud-a-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instA },
  });
  studentB = await prisma.user.create({
    data: { name: "AIA Student B", email: `aia-stud-b-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instA },
  });
  cleanup.users.push(lecturerA.id, studentA.id, studentB.id);
});

afterAll(async () => {
  await prisma.aiAssistanceInteraction.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.integrityEvent.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.answer.deleteMany({ where: { submission: { examId: { in: cleanup.exams } } } });
  await prisma.submission.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.question.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.exam.deleteMany({ where: { id: { in: cleanup.exams } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanup.users } } });
});

async function createExamAndSubmission(
  opts: {
    aiAssistanceMode?: "DISABLED" | "BRAINSTORM_ONLY";
    maxPromptsPerQuestion?: number;
    maxPromptsPerAttempt?: number;
    submissionStatus?: "IN_PROGRESS" | "SUBMITTED" | "GRADED";
    takeSnapshot?: boolean;
  } = {},
) {
  const mode = opts.aiAssistanceMode ?? "BRAINSTORM_ONLY";
  const exam = await prisma.exam.create({
    data: {
      title: `AI Assistance Exam ${Date.now()}-${Math.random()}`,
      durationMins: 30,
      published: true,
      createdById: lecturerA.id,
      institutionId: instA,
      secureSettings: {
        aiAssistanceMode: mode,
        aiAssistanceMaxPromptsPerQuestion: opts.maxPromptsPerQuestion ?? 3,
        aiAssistanceMaxPromptsPerAttempt: opts.maxPromptsPerAttempt ?? 10,
        aiAssistanceMaxResponseCharacters: 800,
        aiAssistanceAllowConceptExplanations: true,
        aiAssistanceAllowAnswerPlanning: true,
        aiAssistanceAllowReasoningFeedback: true,
        aiAssistanceAllowProgrammingConceptHelp: true,
      },
    },
  });
  cleanup.exams.push(exam.id);
  const question = await prisma.question.create({
    data: { examId: exam.id, type: "ESSAY", text: "Explain photosynthesis.", points: 5, order: 0 },
  });
  const outsideExam = await prisma.exam.create({
    data: { title: `Other Exam ${Date.now()}-${Math.random()}`, durationMins: 30, published: true, createdById: lecturerA.id, institutionId: instA },
  });
  cleanup.exams.push(outsideExam.id);
  const outsideQuestion = await prisma.question.create({
    data: { examId: outsideExam.id, type: "ESSAY", text: "Unrelated question.", points: 5, order: 0 },
  });
  const submission = await prisma.submission.create({
    data: {
      examId: exam.id,
      studentId: studentA.id,
      status: opts.submissionStatus ?? "IN_PROGRESS",
      aiAssistancePolicySnapshotJson:
        opts.takeSnapshot === false
          ? undefined
          : {
              schemaVersion: 1,
              policyVersion: "v1.0",
              mode,
              maxPromptsPerQuestion: opts.maxPromptsPerQuestion ?? 3,
              maxPromptsPerAttempt: opts.maxPromptsPerAttempt ?? 10,
              maxResponseCharacters: 800,
              allowConceptExplanations: true,
              allowAnswerPlanning: true,
              allowReasoningFeedback: true,
              allowProgrammingConceptHelp: true,
            },
    },
  });
  return { exam, question, outsideQuestion, submission };
}

describe("1/3. assistance disabled / inactive submission rejects request", () => {
  it("mode DISABLED rejects", async () => {
    const { submission, question } = await createExamAndSubmission({ aiAssistanceMode: "DISABLED" });
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await assistanceRoute.POST(jsonRequest({ studentPrompt: "help me understand this" }), {
      params: Promise.resolve({ id: submission.id, questionId: question.id }),
    });
    expect(res.status).toBe(403);
  });

  it("3. a SUBMITTED attempt rejects assistance", async () => {
    const { submission, question } = await createExamAndSubmission({ submissionStatus: "SUBMITTED" });
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await assistanceRoute.POST(jsonRequest({ studentPrompt: "help me understand this" }), {
      params: Promise.resolve({ id: submission.id, questionId: question.id }),
    });
    expect(res.status).toBe(409);
  });
});

describe("2/27. another student cannot access or review", () => {
  it("2. another student cannot POST assistance for a submission that isn't theirs", async () => {
    const { submission, question } = await createExamAndSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentB.id, "STUDENT", instA));
    const res = await assistanceRoute.POST(jsonRequest({ studentPrompt: "help me understand this" }), {
      params: Promise.resolve({ id: submission.id, questionId: question.id }),
    });
    expect(res.status).toBe(404);
  });

  it("27. another lecturer (not the exam owner) cannot review interactions", async () => {
    const { submission } = await createExamAndSubmission();
    const otherLecturer = await prisma.user.create({
      data: { name: "AIA Other Lecturer", email: `aia-other-lect-${stamp}@test.local`, passwordHash: await bcrypt.hash("x", 4), role: "LECTURER", institutionId: instA },
    });
    cleanup.users.push(otherLecturer.id);
    mockAuth.mockResolvedValue(sessionFor(otherLecturer.id, "LECTURER", instA));
    const res = await reviewRoute.GET(jsonRequest(), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(403);
  });
});

describe("4. question outside the stable attempt set rejects", () => {
  it("rejects a questionId from a different exam", async () => {
    const { submission, outsideQuestion } = await createExamAndSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await assistanceRoute.POST(jsonRequest({ studentPrompt: "help me understand this" }), {
      params: Promise.resolve({ id: submission.id, questionId: outsideQuestion.id }),
    });
    expect(res.status).toBe(404);
  });
});

describe("8/9. classification gate at the route level", () => {
  it("8. a direct-answer request is blocked before any generation", async () => {
    const { submission, question } = await createExamAndSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await assistanceRoute.POST(jsonRequest({ studentPrompt: "Just give me the answer" }), {
      params: Promise.resolve({ id: submission.id, questionId: question.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("BLOCKED");
    expect(body.response).toBeNull();
  });

  it("9/19. a safe request is approved and the interaction is persisted without leaking anything unexpected", async () => {
    const { submission, question } = await createExamAndSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await assistanceRoute.POST(
      jsonRequest({ studentPrompt: "Can you help me understand this question?" }),
      { params: Promise.resolve({ id: submission.id, questionId: question.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("APPROVED");
    expect(typeof body.response).toBe("string");

    const row = await prisma.aiAssistanceInteraction.findFirst({ where: { submissionId: submission.id } });
    expect(row?.status).toBe("APPROVED");
    expect(row?.approvedResponse).toContain("concept");
  });
});

describe("19. a BLOCKED interaction never has stored response text", () => {
  it("approvedResponse is null for a blocked request", async () => {
    const { submission, question } = await createExamAndSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    await assistanceRoute.POST(jsonRequest({ studentPrompt: "Write the code for me" }), {
      params: Promise.resolve({ id: submission.id, questionId: question.id }),
    });
    const row = await prisma.aiAssistanceInteraction.findFirst({
      where: { submissionId: submission.id, status: "BLOCKED" },
      orderBy: { createdAt: "desc" },
    });
    expect(row?.approvedResponse).toBeNull();
  });
});

describe("5/6. prompt/attempt limits are enforced", () => {
  it("5. question limit blocks once reached", async () => {
    const { submission, question } = await createExamAndSubmission({ maxPromptsPerQuestion: 1 });
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const first = await assistanceRoute.POST(jsonRequest({ studentPrompt: "Help me understand this." }), {
      params: Promise.resolve({ id: submission.id, questionId: question.id }),
    });
    expect(first.status).toBe(200);
    const second = await assistanceRoute.POST(jsonRequest({ studentPrompt: "Another question please." }), {
      params: Promise.resolve({ id: submission.id, questionId: question.id }),
    });
    const secondBody = await second.json();
    expect(secondBody.status).toBe("BLOCKED");
    expect(secondBody.promptsRemainingForQuestion).toBe(0);
  });
});

describe("26. lecturer can review approved interactions", () => {
  it("returns the transcript for the exam owner", async () => {
    const { submission, question } = await createExamAndSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    await assistanceRoute.POST(jsonRequest({ studentPrompt: "Can you help me understand this question?" }), {
      params: Promise.resolve({ id: submission.id, questionId: question.id }),
    });

    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await reviewRoute.GET(jsonRequest(), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.interactions.length).toBeGreaterThan(0);
    expect(body.interactions[0].status).toBe("APPROVED");
  });
});
