/**
 * Question-scoped brainstorm sidebar v1 — DB-backed route tests for
 * GET /api/submissions/[id]/questions/[questionId]/ai-assistance
 * (src/lib/aiAssistanceRunner.ts's loadInteractionHistory). See
 * docs/question-scoped-brainstorm-sidebar-v1.md.
 *
 * Covers: a question's transcript is scoped to submissionId+questionId
 * only (never another question's interactions, even within the same
 * submission), restoring the same transcript on repeat visits without
 * duplication, max/remaining counters, and RESERVED-row normalization.
 * The generator/verifier Anthropic calls are mocked — never a live model.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/aiAssistanceGenerator", async () => {
  const actual = await vi.importActual<typeof import("./aiAssistanceGenerator")>("./aiAssistanceGenerator");
  return {
    ...actual,
    generateBrainstormResponse: vi.fn().mockResolvedValue("Focus on the core concept this question is testing. What specific idea does it require you to apply?"),
    isAnthropicConfigured: vi.fn().mockReturnValue(true),
  };
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

function sessionFor(userId: string, role: "LECTURER" | "STUDENT" | "PLATFORM_ADMIN", institutionId: string) {
  return {
    user: { id: userId, email: `${userId}@test.local`, name: userId, role, institutionId },
    expires: new Date(Date.now() + 86_400_000).toISOString(),
  };
}

function postRequest(body?: unknown) {
  return new Request("http://test.local/route", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function getRequest() {
  return new Request("http://test.local/route", { method: "GET" });
}

const stamp = Date.now();
const cleanup = { users: [] as string[], exams: [] as string[] };

let instA: string;
let lecturerA: { id: string };
let studentA: { id: string };
let studentB: { id: string };

beforeAll(async () => {
  const a = await getOrCreateTestInstitution(`ai-history-a-${stamp}`);
  instA = a.id;
  const passwordHash = await bcrypt.hash("test-password", 4);
  lecturerA = await prisma.user.create({
    data: { name: "AIH Lecturer A", email: `aih-lect-a-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instA },
  });
  studentA = await prisma.user.create({
    data: { name: "AIH Student A", email: `aih-stud-a-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instA },
  });
  studentB = await prisma.user.create({
    data: { name: "AIH Student B", email: `aih-stud-b-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instA },
  });
  cleanup.users.push(lecturerA.id, studentA.id, studentB.id);
});

afterAll(async () => {
  await prisma.aiAssistanceInteraction.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.integrityEvent.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.submission.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.question.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.exam.deleteMany({ where: { id: { in: cleanup.exams } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanup.users } } });
});

async function createTwoQuestionExam(opts: { maxPromptsPerQuestion?: number; maxPromptsPerAttempt?: number } = {}) {
  const maxPromptsPerQuestion = opts.maxPromptsPerQuestion ?? 3;
  const maxPromptsPerAttempt = opts.maxPromptsPerAttempt ?? 10;
  const exam = await prisma.exam.create({
    data: {
      title: `AI History Exam ${Date.now()}-${Math.random()}`,
      durationMins: 30,
      published: true,
      createdById: lecturerA.id,
      institutionId: instA,
      secureSettings: {
        aiAssistanceMode: "BRAINSTORM_ONLY",
        aiAssistanceMaxPromptsPerQuestion: maxPromptsPerQuestion,
        aiAssistanceMaxPromptsPerAttempt: maxPromptsPerAttempt,
        aiAssistanceMaxResponseCharacters: 800,
        aiAssistanceAllowConceptExplanations: true,
        aiAssistanceAllowAnswerPlanning: true,
        aiAssistanceAllowReasoningFeedback: true,
        aiAssistanceAllowProgrammingConceptHelp: true,
      },
    },
  });
  cleanup.exams.push(exam.id);
  const q1 = await prisma.question.create({ data: { examId: exam.id, type: "ESSAY", text: "Explain photosynthesis.", points: 5, order: 0 } });
  const q2 = await prisma.question.create({ data: { examId: exam.id, type: "ESSAY", text: "Explain cellular respiration.", points: 5, order: 1 } });
  const submission = await prisma.submission.create({
    data: {
      examId: exam.id,
      studentId: studentA.id,
      status: "IN_PROGRESS",
      aiAssistancePolicySnapshotJson: {
        schemaVersion: 1,
        policyVersion: "v1.0",
        mode: "BRAINSTORM_ONLY",
        maxPromptsPerQuestion,
        maxPromptsPerAttempt,
        maxResponseCharacters: 800,
        allowConceptExplanations: true,
        allowAnswerPlanning: true,
        allowReasoningFeedback: true,
        allowProgrammingConceptHelp: true,
      },
    },
  });
  return { exam, q1, q2, submission };
}

async function postPrompt(submissionId: string, questionId: string, studentPrompt: string) {
  mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
  const res = await assistanceRoute.POST(postRequest({ studentPrompt }), {
    params: Promise.resolve({ id: submissionId, questionId }),
  });
  expect(res.status).toBe(200);
  return res.json();
}

async function getHistory(submissionId: string, questionId: string, asStudent: { id: string } = studentA) {
  mockAuth.mockResolvedValue(sessionFor(asStudent.id, "STUDENT", instA));
  return assistanceRoute.GET(getRequest(), { params: Promise.resolve({ id: submissionId, questionId }) });
}

describe("question-scoped history", () => {
  it("1. a question with no interactions returns an empty list", async () => {
    const { q1, submission } = await createTwoQuestionExam();
    const res = await getHistory(submission.id, q1.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.interactions).toEqual([]);
  });

  it("2. Question 1's history shows only Question 1's interactions", async () => {
    const { q1, q2, submission } = await createTwoQuestionExam();
    await postPrompt(submission.id, q1.id, "Help me understand Q1 part A");
    await postPrompt(submission.id, q1.id, "Help me understand Q1 part B");
    await postPrompt(submission.id, q2.id, "Help me understand Q2");

    const res = await getHistory(submission.id, q1.id);
    const body = await res.json();
    expect(body.interactions).toHaveLength(2);
    expect(body.interactions.every((i: { studentPrompt: string }) => i.studentPrompt.startsWith("Help me understand Q1"))).toBe(true);
  });

  it("3. Question 2's history shows only Question 2's interactions — never Question 1's", async () => {
    const { q1, q2, submission } = await createTwoQuestionExam();
    await postPrompt(submission.id, q1.id, "Help me understand Q1 part A");
    await postPrompt(submission.id, q2.id, "Help me understand Q2");

    const res = await getHistory(submission.id, q2.id);
    const body = await res.json();
    expect(body.interactions).toHaveLength(1);
    expect(body.interactions[0].studentPrompt).toBe("Help me understand Q2");
  });

  it("4. returning to Question 1 restores the same interactions — no reset, no duplication", async () => {
    const { q1, submission } = await createTwoQuestionExam();
    await postPrompt(submission.id, q1.id, "First question about Q1");
    await postPrompt(submission.id, q1.id, "Second question about Q1");

    const firstVisit = await (await getHistory(submission.id, q1.id)).json();
    const secondVisit = await (await getHistory(submission.id, q1.id)).json();

    expect(firstVisit.interactions).toHaveLength(2);
    expect(secondVisit.interactions).toHaveLength(2);
    expect(secondVisit.interactions.map((i: { id: string }) => i.id)).toEqual(firstVisit.interactions.map((i: { id: string }) => i.id));
  });

  it("5. interactions are returned in chronological order", async () => {
    const { q1, submission } = await createTwoQuestionExam();
    await postPrompt(submission.id, q1.id, "First");
    await postPrompt(submission.id, q1.id, "Second");
    await postPrompt(submission.id, q1.id, "Third");

    const body = await (await getHistory(submission.id, q1.id)).json();
    expect(body.interactions.map((i: { studentPrompt: string }) => i.studentPrompt)).toEqual(["First", "Second", "Third"]);
  });

  it("6. another student cannot read a submission's history that isn't theirs", async () => {
    const { q1, submission } = await createTwoQuestionExam();
    await postPrompt(submission.id, q1.id, "Private prompt");

    const res = await getHistory(submission.id, q1.id, studentB);
    expect(res.status).toBe(404);
  });

  it("7. AI-disabled exam rejects history the same way it rejects a POST", async () => {
    const exam = await prisma.exam.create({
      data: {
        title: `AI Disabled Exam ${Date.now()}`,
        durationMins: 30,
        published: true,
        createdById: lecturerA.id,
        institutionId: instA,
        secureSettings: { aiAssistanceMode: "DISABLED" },
      },
    });
    cleanup.exams.push(exam.id);
    const question = await prisma.question.create({ data: { examId: exam.id, type: "ESSAY", text: "Q", points: 5, order: 0 } });
    const submission = await prisma.submission.create({
      data: { examId: exam.id, studentId: studentA.id, status: "IN_PROGRESS" },
    });
    const res = await getHistory(submission.id, question.id);
    expect(res.status).toBe(403);
  });
});

describe("counters", () => {
  it("8. response includes both remaining and max values for question and exam scope", async () => {
    const { q1, submission } = await createTwoQuestionExam({ maxPromptsPerQuestion: 3, maxPromptsPerAttempt: 10 });
    await postPrompt(submission.id, q1.id, "One prompt");

    const body = await (await getHistory(submission.id, q1.id)).json();
    expect(body.maxPromptsPerQuestion).toBe(3);
    expect(body.maxPromptsPerAttempt).toBe(10);
    expect(body.promptsRemainingForQuestion).toBe(2);
    expect(body.promptsRemainingForAttempt).toBe(9);
  });

  it("9. POST responses also include max values alongside remaining counts", async () => {
    const { q1, submission } = await createTwoQuestionExam({ maxPromptsPerQuestion: 3, maxPromptsPerAttempt: 10 });
    const body = await postPrompt(submission.id, q1.id, "One prompt");
    expect(body.maxPromptsPerQuestion).toBe(3);
    expect(body.maxPromptsPerAttempt).toBe(10);
  });
});

describe("exhaustion", () => {
  it("10. per-question exhaustion is reflected as promptsRemainingForQuestion 0 without affecting the exam-wide count", async () => {
    const { q1, q2, submission } = await createTwoQuestionExam({ maxPromptsPerQuestion: 1, maxPromptsPerAttempt: 10 });
    await postPrompt(submission.id, q1.id, "Only allowed prompt for Q1");

    const q1History = await (await getHistory(submission.id, q1.id)).json();
    expect(q1History.promptsRemainingForQuestion).toBe(0);
    expect(q1History.promptsRemainingForAttempt).toBe(9);

    // Q2 is a DIFFERENT question — its own per-question allowance is untouched.
    const q2History = await (await getHistory(submission.id, q2.id)).json();
    expect(q2History.promptsRemainingForQuestion).toBe(1);
  });

  it("11. exam-wide exhaustion is reflected as promptsRemainingForAttempt 0", async () => {
    const { q1, q2, submission } = await createTwoQuestionExam({ maxPromptsPerQuestion: 5, maxPromptsPerAttempt: 2 });
    await postPrompt(submission.id, q1.id, "First of two exam-wide prompts");
    await postPrompt(submission.id, q2.id, "Second of two exam-wide prompts");

    const body = await (await getHistory(submission.id, q1.id)).json();
    expect(body.promptsRemainingForAttempt).toBe(0);
  });
});

describe("RESERVED-row display normalization (read-only)", () => {
  it("12. a fresh (non-stale) RESERVED row is excluded from history — the requesting tab already has it via its own POST response", async () => {
    const { q1, submission } = await createTwoQuestionExam();
    await prisma.aiAssistanceInteraction.create({
      data: {
        submissionId: submission.id,
        questionId: q1.id,
        examId: submission.examId,
        studentId: studentA.id,
        studentPrompt: "In-flight prompt",
        status: "RESERVED",
        promptNumberForQuestion: 1,
        promptNumberForAttempt: 1,
        policyVersion: "v1.0",
      },
    });

    const body = await (await getHistory(submission.id, q1.id)).json();
    expect(body.interactions).toEqual([]);
  });

  it("13. a stale RESERVED row (crashed/timed-out original request) is displayed as FAILED, without mutating the stored row", async () => {
    const { q1, submission } = await createTwoQuestionExam();
    const stale = await prisma.aiAssistanceInteraction.create({
      data: {
        submissionId: submission.id,
        questionId: q1.id,
        examId: submission.examId,
        studentId: studentA.id,
        studentPrompt: "Crashed prompt",
        status: "RESERVED",
        promptNumberForQuestion: 1,
        promptNumberForAttempt: 1,
        policyVersion: "v1.0",
        createdAt: new Date(Date.now() - 100_000),
      },
    });

    const body = await (await getHistory(submission.id, q1.id)).json();
    expect(body.interactions).toHaveLength(1);
    expect(body.interactions[0].status).toBe("FAILED");

    // Read-only — the underlying row is untouched; the next real POST is
    // what actually self-heals it (see reserveInteractionSlot).
    const stillStored = await prisma.aiAssistanceInteraction.findUnique({ where: { id: stale.id } });
    expect(stillStored?.status).toBe("RESERVED");
  });
});
