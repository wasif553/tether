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

describe("18. a locked future question (one-question-at-a-time delivery) rejects assistance", () => {
  it("rejects a question ahead of the student's current position", async () => {
    const exam = await prisma.exam.create({
      data: {
        title: `AI Assistance One-Question Exam ${Date.now()}-${Math.random()}`,
        durationMins: 30,
        published: true,
        createdById: lecturerA.id,
        institutionId: instA,
        secureSettings: {
          oneQuestionAtATime: true,
          aiAssistanceMode: "BRAINSTORM_ONLY",
          aiAssistanceMaxPromptsPerQuestion: 3,
          aiAssistanceMaxPromptsPerAttempt: 10,
          aiAssistanceMaxResponseCharacters: 800,
          aiAssistanceAllowConceptExplanations: true,
          aiAssistanceAllowAnswerPlanning: true,
          aiAssistanceAllowReasoningFeedback: true,
          aiAssistanceAllowProgrammingConceptHelp: true,
        },
      },
    });
    cleanup.exams.push(exam.id);
    await prisma.question.create({ data: { examId: exam.id, type: "ESSAY", text: "Q0", points: 5, order: 0 } });
    const q1 = await prisma.question.create({ data: { examId: exam.id, type: "ESSAY", text: "Q1", points: 5, order: 1 } });
    const submission = await prisma.submission.create({
      data: {
        examId: exam.id,
        studentId: studentA.id,
        status: "IN_PROGRESS",
        currentQuestionIndex: 0, // student is still on q0
        aiAssistancePolicySnapshotJson: {
          schemaVersion: 1,
          policyVersion: "v1.0",
          mode: "BRAINSTORM_ONLY",
          maxPromptsPerQuestion: 3,
          maxPromptsPerAttempt: 10,
          maxResponseCharacters: 800,
          allowConceptExplanations: true,
          allowAnswerPlanning: true,
          allowReasoningFeedback: true,
          allowProgrammingConceptHelp: true,
        },
      },
    });

    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await assistanceRoute.POST(jsonRequest({ studentPrompt: "Help me understand this." }), {
      params: Promise.resolve({ id: submission.id, questionId: q1.id }), // q1 is ahead
    });
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
    expect(body.interactions[0]).toHaveProperty("wasRegenerated");
  });
});

describe("9/10/11. concurrency — atomic reservation prevents exceeding limits under simultaneous requests", () => {
  it("9. two simultaneous requests against a 1-prompt-per-question limit never both approve", async () => {
    const { submission, question } = await createExamAndSubmission({ maxPromptsPerQuestion: 1 });
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));

    const [resA, resB] = await Promise.all([
      assistanceRoute.POST(jsonRequest({ studentPrompt: "Help me understand this, take one." }), {
        params: Promise.resolve({ id: submission.id, questionId: question.id }),
      }),
      assistanceRoute.POST(jsonRequest({ studentPrompt: "Help me understand this, take two." }), {
        params: Promise.resolve({ id: submission.id, questionId: question.id }),
      }),
    ]);
    const [bodyA, bodyB] = await Promise.all([resA.json(), resB.json()]);
    const statuses = [bodyA.status, bodyB.status];

    // Exactly one of the two got the single available slot; the other
    // was blocked by the atomic reservation — never both APPROVED.
    expect(statuses.filter((s) => s === "APPROVED")).toHaveLength(1);
    expect(statuses.filter((s) => s === "BLOCKED")).toHaveLength(1);

    const rows = await prisma.aiAssistanceInteraction.count({
      where: { submissionId: submission.id, questionId: question.id },
    });
    expect(rows).toBe(1); // the blocked request never reserved a row at all
  });

  it("10. the same guarantee holds for the per-attempt limit across two different questions", async () => {
    const { submission, question } = await createExamAndSubmission({ maxPromptsPerAttempt: 1 });
    const question2 = await prisma.question.create({
      data: { examId: submission.examId, type: "ESSAY", text: "A second question.", points: 5, order: 1 },
    });
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));

    const [resA, resB] = await Promise.all([
      assistanceRoute.POST(jsonRequest({ studentPrompt: "Help me understand question one." }), {
        params: Promise.resolve({ id: submission.id, questionId: question.id }),
      }),
      assistanceRoute.POST(jsonRequest({ studentPrompt: "Help me understand question two." }), {
        params: Promise.resolve({ id: submission.id, questionId: question2.id }),
      }),
    ]);
    const [bodyA, bodyB] = await Promise.all([resA.json(), resB.json()]);
    const statuses = [bodyA.status, bodyB.status];
    expect(statuses.filter((s) => s === "APPROVED")).toHaveLength(1);
    expect(statuses.filter((s) => s === "BLOCKED")).toHaveLength(1);
  });
});

describe("11/12. idempotency key — a duplicate client request never creates a second interaction", () => {
  it("11. resubmitting the same clientRequestId replays the original outcome instead of consuming a second slot", async () => {
    const { submission, question } = await createExamAndSubmission({ maxPromptsPerQuestion: 3 });
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const clientRequestId = "11111111-1111-4111-8111-111111111111";

    const first = await assistanceRoute.POST(
      jsonRequest({ studentPrompt: "Help me understand this.", clientRequestId }),
      { params: Promise.resolve({ id: submission.id, questionId: question.id }) },
    );
    const firstBody = await first.json();

    const second = await assistanceRoute.POST(
      jsonRequest({ studentPrompt: "Help me understand this.", clientRequestId }),
      { params: Promise.resolve({ id: submission.id, questionId: question.id }) },
    );
    const secondBody = await second.json();

    expect(secondBody.status).toBe(firstBody.status);
    expect(secondBody.response).toBe(firstBody.response);

    const rows = await prisma.aiAssistanceInteraction.count({
      where: { submissionId: submission.id, questionId: question.id },
    });
    expect(rows).toBe(1);
  });
});

describe("22/23. cumulative-leakage isolation — never mixes another student/submission/question", () => {
  it("two different students' approved interactions on the same question never share cumulative risk", async () => {
    const { submission: submissionA, question } = await createExamAndSubmission();
    const examId = submissionA.examId;
    const submissionB = await prisma.submission.create({
      data: {
        examId,
        studentId: studentB.id,
        status: "IN_PROGRESS",
        aiAssistancePolicySnapshotJson: {
          schemaVersion: 1,
          policyVersion: "v1.0",
          mode: "BRAINSTORM_ONLY",
          maxPromptsPerQuestion: 3,
          maxPromptsPerAttempt: 10,
          maxResponseCharacters: 800,
          allowConceptExplanations: true,
          allowAnswerPlanning: true,
          allowReasoningFeedback: true,
          allowProgrammingConceptHelp: true,
        },
      },
    });

    // Student A racks up cumulative risk on this question.
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    for (let i = 0; i < 3; i++) {
      await assistanceRoute.POST(jsonRequest({ studentPrompt: `Help me with this, attempt ${i}.` }), {
        params: Promise.resolve({ id: submissionA.id, questionId: question.id }),
      });
    }
    const rowsA = await prisma.aiAssistanceInteraction.findMany({
      where: { submissionId: submissionA.id, questionId: question.id, status: "APPROVED" },
      orderBy: { createdAt: "desc" },
    });
    expect(rowsA[0]?.cumulativeRiskScore).toBeGreaterThan(0);

    // Student B's first interaction on the SAME question must start from
    // zero cumulative risk — never inherit student A's.
    mockAuth.mockResolvedValue(sessionFor(studentB.id, "STUDENT", instA));
    await assistanceRoute.POST(jsonRequest({ studentPrompt: "Help me understand this question." }), {
      params: Promise.resolve({ id: submissionB.id, questionId: question.id }),
    });
    const rowB = await prisma.aiAssistanceInteraction.findFirst({
      where: { submissionId: submissionB.id, questionId: question.id, status: "APPROVED" },
    });
    expect(rowB?.cumulativeRiskScore).toBe(rowB?.riskScore ?? 0);
  });
});

describe("4/5/7/8. FAILED status — a genuine provider failure never shows generated content and consumes the reserved slot", () => {
  it("both generate attempts throwing resolves to FAILED with no response text, one interaction row", async () => {
    const { generateBrainstormResponse } = await import("./aiAssistanceGenerator");
    const mocked = vi.mocked(generateBrainstormResponse);
    mocked.mockRejectedValueOnce(new Error("boom")).mockRejectedValueOnce(new Error("boom again"));

    const { submission, question } = await createExamAndSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await assistanceRoute.POST(jsonRequest({ studentPrompt: "Help me understand this." }), {
      params: Promise.resolve({ id: submission.id, questionId: question.id }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("FAILED");
    expect(body.response).toBeNull();

    const rows = await prisma.aiAssistanceInteraction.findMany({
      where: { submissionId: submission.id, questionId: question.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("FAILED");
    expect(rows[0].approvedResponse).toBeNull();

    mocked.mockResolvedValue("What concept do you think this question is testing?"); // restore default
  });
});
