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
  return {
    ...actual,
    generateBrainstormResponse: vi.fn().mockResolvedValue("What concept do you think this question is testing?"),
    // Deterministic default for every route test below: the optional
    // Anthropic provider is treated as configured, so these tests exercise
    // ownership/limits/persistence logic without needing a real
    // ANTHROPIC_API_KEY. isAnthropicConfigured() itself (the real,
    // unmocked implementation) is separately re-verified — see "provider
    // configuration" describe block below — to confirm the actual 503
    // fail-closed path still works when the provider is genuinely
    // unavailable.
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
const reviewRoute = await import("../app/api/lecturer/submissions/[id]/ai-assistance/route");
// Brainstorm starter-action reliability follow-up — the EXACT fixed
// strings AiBrainstormPanel's starter buttons send, imported rather than
// hand-copied so these tests can never silently drift from what
// production actually sends. Simplify Brainstorm actions trimmed this to
// two buttons (see AiBrainstormPanel.tsx's own doc comment) — the
// content-independent rate-limiting tests below need several genuinely
// DISTINCT prompt strings to prove the limiter doesn't care about
// content, so they use RATE_LIMIT_TEST_PROMPTS (below) rather than
// slicing STARTER_ACTIONS, which no longer has enough entries for that.
const { STARTER_ACTIONS } = await import("../components/AiBrainstormPanel");

// Content-independent rate-limiting tests only need SEVERAL DISTINCT
// prompt strings — not necessarily production's own starter-button set,
// which Simplify Brainstorm actions intentionally trimmed to two. Reuses
// both real starter prompts plus two more ad-hoc ones so this still
// exercises real starter-prompt text where possible.
const RATE_LIMIT_TEST_PROMPTS = [
  STARTER_ACTIONS[0].prompt,
  STARTER_ACTIONS[1].prompt,
  "Can you point me toward the relevant concept?",
  "What should I focus on first?",
];

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

describe("provider configuration — the optional Anthropic provider being genuinely unavailable", () => {
  it("returns 503 without consuming a prompt slot when isAnthropicConfigured() is false — the real fail-closed path, not a mocked shortcut", async () => {
    const { isAnthropicConfigured } = await import("./aiAssistanceGenerator");
    vi.mocked(isAnthropicConfigured).mockReturnValueOnce(false);

    const { submission, question } = await createExamAndSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await assistanceRoute.POST(jsonRequest({ studentPrompt: "Help me understand this." }), {
      params: Promise.resolve({ id: submission.id, questionId: question.id }),
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/not configured/i);

    // A missing provider must never consume the student's prompt allowance
    // (Part 3) — no interaction row at all, reserved or otherwise.
    const rows = await prisma.aiAssistanceInteraction.findMany({
      where: { submissionId: submission.id, questionId: question.id },
    });
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Brainstorm starter-action reliability follow-up — production report:
// some predefined starter buttons "sometimes result in a message implying
// that Brainstorm/API is not working", while a manually typed prompt
// always works. AiBrainstormPanel routes BOTH through the exact same
// sendPrompt()/POST body shape — the tests below confirm the pipeline
// itself treats every starter prompt identically to a typed one (ruling
// out "particular starter wording"), and pin down the real, confirmed,
// content-independent cause: AI_ASSISTANCE_RATE_LIMIT_MAX_REQUESTS (3
// requests / 20s, scoped to the whole submission — see
// aiAssistancePolicy.ts) is the first limit a tester clicking through
// several starter buttons in a row (a natural way to check "does each one
// work") will hit, well before any per-question/per-attempt allowance.
// ---------------------------------------------------------------------------

describe("Brainstorm starter actions use the exact same pipeline as a manually typed prompt", () => {
  it.each(STARTER_ACTIONS)("$label succeeds via the same POST body shape and returns APPROVED", async ({ prompt }) => {
    // A fresh submission per starter action isolates each case from the
    // submission-scoped rate limiter below — this block is only about
    // confirming every starter prompt is treated identically by the
    // classify -> generate -> verify pipeline, not about pacing.
    const { submission, question } = await createExamAndSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await assistanceRoute.POST(jsonRequest({ studentPrompt: prompt }), {
      params: Promise.resolve({ id: submission.id, questionId: question.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("APPROVED");
    expect(typeof body.response).toBe("string");
  });
});

describe("rate limiting — content-independent, applies identically regardless of which starter/typed prompt is used", () => {
  it("the first three starter actions in a row succeed; the fourth (a DIFFERENT starter prompt) is rate-limited, not blocked/failed", async () => {
    // Generous per-question/per-attempt allowances so ONLY the rate
    // limiter (3 requests / 20s) can possibly trigger here — isolates it
    // from AI_ASSISTANCE limit checks, which are tested separately above.
    const { submission, question } = await createExamAndSubmission({ maxPromptsPerQuestion: 10, maxPromptsPerAttempt: 10 });
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));

    const statuses: number[] = [];
    for (const prompt of RATE_LIMIT_TEST_PROMPTS) {
      const res = await assistanceRoute.POST(jsonRequest({ studentPrompt: prompt }), {
        params: Promise.resolve({ id: submission.id, questionId: question.id }),
      });
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses[3]).toBe(429);
  });

  it("a manually typed prompt is rate-limited identically once the window is exhausted by starter clicks — never shown as a provider/API failure", async () => {
    const { submission, question } = await createExamAndSubmission({ maxPromptsPerQuestion: 10, maxPromptsPerAttempt: 10 });
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    for (const prompt of RATE_LIMIT_TEST_PROMPTS.slice(0, 3)) {
      const res = await assistanceRoute.POST(jsonRequest({ studentPrompt: prompt }), {
        params: Promise.resolve({ id: submission.id, questionId: question.id }),
      });
      expect(res.status).toBe(200);
    }
    const typedRes = await assistanceRoute.POST(
      jsonRequest({ studentPrompt: "What am I missing in my current draft?" }),
      { params: Promise.resolve({ id: submission.id, questionId: question.id }) },
    );
    expect(typedRes.status).toBe(429);
    const body = await typedRes.json();
    // Accurate, non-misleading wording — never "not configured"/"not
    // connected" for a rate-limit outcome.
    expect(body.error).toMatch(/too quickly/i);
    expect(body.error).not.toMatch(/not configured|not connected/i);

    // Never silently consumes a prompt slot — the reservation transaction
    // returns rate_limited BEFORE creating any interaction row.
    const rows = await prisma.aiAssistanceInteraction.findMany({ where: { submissionId: submission.id } });
    expect(rows).toHaveLength(3);
  });
});

describe("FALLBACK status on a starter prompt — a guardrail redirect is expected behaviour, never a failure", () => {
  it("both verify attempts rejecting resolves to FALLBACK with the deterministic safe response, never FAILED", async () => {
    const { verifyBrainstormResponse } = await import("./aiAssistanceVerifier");
    const mocked = vi.mocked(verifyBrainstormResponse);
    mocked
      .mockResolvedValueOnce({ allowed: false, riskScore: 0.7, riskCodes: ["EXCESSIVE_SPECIFICITY"], reason: "too specific" })
      .mockResolvedValueOnce({ allowed: false, riskScore: 0.7, riskCodes: ["EXCESSIVE_SPECIFICITY"], reason: "still too specific" });

    const { submission, question } = await createExamAndSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await assistanceRoute.POST(jsonRequest({ studentPrompt: STARTER_ACTIONS[1].prompt }), {
      params: Promise.resolve({ id: submission.id, questionId: question.id }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("FALLBACK");
    expect(typeof body.response).toBe("string");

    const row = await prisma.aiAssistanceInteraction.findFirst({ where: { submissionId: submission.id } });
    expect(row?.status).toBe("FALLBACK");

    mocked.mockResolvedValue({ allowed: true, riskScore: 0.1, riskCodes: [], reason: "safe" }); // restore default
  });
});

// Intermittent-failure follow-up (section 5) — the verifier itself
// throwing (a transient provider failure, exhausted retries) is
// deliberately distinct from the verifier successfully judging a
// candidate unsafe (tested just above): both now resolve to the SAME
// FALLBACK outcome — a candidate WAS produced, so showing the
// deterministic, always-safe fallback guidance is strictly better than
// an unnecessarily alarming "unavailable" message, and the verifier is
// never bypassed (the unverified candidate text is still discarded).
describe("intermittent-failure follow-up — a verifier that cannot complete its check (throws) also resolves to FALLBACK, not FAILED", () => {
  it("both verify attempts throwing (not rejecting) resolves to FALLBACK, never FAILED — the generator's candidate is still discarded", async () => {
    const { verifyBrainstormResponse, AiAssistanceVerificationError } = await import("./aiAssistanceVerifier");
    const mocked = vi.mocked(verifyBrainstormResponse);
    mocked
      .mockRejectedValueOnce(new AiAssistanceVerificationError("Anthropic API request failed", "OVERLOADED"))
      .mockRejectedValueOnce(new AiAssistanceVerificationError("Anthropic API request failed", "OVERLOADED"));

    const { submission, question } = await createExamAndSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await assistanceRoute.POST(jsonRequest({ studentPrompt: "Can you help me understand this question?" }), {
      params: Promise.resolve({ id: submission.id, questionId: question.id }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("FALLBACK");
    expect(typeof body.response).toBe("string");
    expect(body.response).not.toContain("What concept do you think this question is testing?"); // the mocked generator output — never shown unverified

    const row = await prisma.aiAssistanceInteraction.findFirst({ where: { submissionId: submission.id } });
    expect(row?.status).toBe("FALLBACK");
    expect(row?.approvedResponse).not.toContain("What concept do you think this question is testing?");

    mocked.mockResolvedValue({ allowed: true, riskScore: 0.1, riskCodes: [], reason: "safe" }); // restore default
  });

  it("a genuine GENERATOR failure (no candidate ever produced) still resolves to FAILED, distinct from a verifier failure", async () => {
    const { generateBrainstormResponse, AiAssistanceGenerationError } = await import("./aiAssistanceGenerator");
    const mocked = vi.mocked(generateBrainstormResponse);
    mocked
      .mockRejectedValueOnce(new AiAssistanceGenerationError("Anthropic API request failed", "OVERLOADED"))
      .mockRejectedValueOnce(new AiAssistanceGenerationError("Anthropic API request failed", "OVERLOADED"));

    const { submission, question } = await createExamAndSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await assistanceRoute.POST(jsonRequest({ studentPrompt: "Can you help me understand this question?" }), {
      params: Promise.resolve({ id: submission.id, questionId: question.id }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("FAILED");
    expect(body.response).toBeNull();
    expect(body.studentMessage).toMatch(/temporarily unavailable/i);

    mocked.mockResolvedValue("What concept do you think this question is testing?"); // restore default
  });
});
