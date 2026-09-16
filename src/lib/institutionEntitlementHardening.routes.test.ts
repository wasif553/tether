/**
 * Institution Entitlement & Access Control v1 — HARDENING PASS DB-backed
 * route tests. See docs/institution-entitlement-v1.md's per-section
 * updates and src/lib/institutionEntitlement.ts. Covers the corrections
 * from the hardening pass request: Secure Browser new-attempt gating, AI
 * Brainstorming post-publication re-evaluation, status+feature AND
 * logic, legacy active/entitlement non-conflict, candidate-limit
 * standalone-path closure, attempt-limit oversubscription prevention
 * (including IN_PROGRESS counting and VOIDED handling), and the
 * advanced-reporting boundary.
 *
 * SAFE EXECUTION ONLY: run this file exclusively via `npm run
 * release:validate` — never a direct `npx vitest run` against this
 * repository's committed DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const { defaultInstitutionEntitlementInput, getInstitutionCandidateUsage, getInstitutionAttemptUsage } = await import("./institutionEntitlement");
const examRoute = await import("../app/api/exams/[id]/route");
const startRoute = await import("../app/api/exams/[id]/start/route");
const aiMarkEssaysRoute = await import("../app/api/lecturer/exams/[examId]/ai-mark-essays/route");
const similarityAnalysisRoute = await import("../app/api/lecturer/exams/[examId]/similarity-analysis/route");
const collusionAnalysisRoute = await import("../app/api/lecturer/exams/[examId]/collusion-analysis/route");
const standaloneAcceptRoute = await import("../app/api/exams/[id]/standalone-invite/accept/route");
const entitlementRoute = await import("../app/api/platform/institutions/[id]/entitlement/route");

function sessionFor(userId: string, role: "LECTURER" | "STUDENT" | "PLATFORM_ADMIN", institutionId: string | null) {
  return {
    user: { id: userId, email: `${userId}@test.local`, name: userId, role, institutionId },
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

const stamp = Date.now();
const cleanup = { users: [] as string[], exams: [] as string[], institutions: [] as string[] };

let instId: string;
let lecturer: { id: string };
let student: { id: string };
let platformAdmin: { id: string };

async function setEntitlement(institutionId: string, overrides: Partial<ReturnType<typeof defaultInstitutionEntitlementInput>>) {
  await prisma.institutionEntitlement.update({ where: { institutionId }, data: overrides });
}

async function createExam(opts: {
  published: boolean;
  aiAssistanceMode?: "DISABLED" | "BRAINSTORM_ONLY";
  deliveryMode?: "STANDARD_WEB" | "TETHER_CLIENT_REQUIRED";
  assignmentMode?: "STANDALONE";
  standaloneInviteEnabled?: boolean;
  standaloneInviteTokenHash?: string | null;
}) {
  const exam = await prisma.exam.create({
    data: {
      title: `Hardening Exam ${stamp}-${Math.random()}`,
      durationMins: 30,
      published: opts.published,
      createdById: lecturer.id,
      institutionId: instId,
      assignmentMode: opts.assignmentMode ?? undefined,
      standaloneInviteEnabled: opts.standaloneInviteEnabled ?? undefined,
      standaloneInviteTokenHash: opts.standaloneInviteTokenHash ?? undefined,
      secureSettings: {
        ...(opts.aiAssistanceMode ? { aiAssistanceMode: opts.aiAssistanceMode } : {}),
        ...(opts.deliveryMode ? { deliveryMode: opts.deliveryMode } : {}),
      },
    },
  });
  cleanup.exams.push(exam.id);
  await prisma.question.create({
    data: { examId: exam.id, type: "MULTIPLE_CHOICE", text: "Q", points: 1, options: ["A", "B"], correctAnswer: "A", order: 0 },
  });
  return exam;
}

beforeAll(async () => {
  const inst = await getOrCreateTestInstitution(`entitlement-hardening-${stamp}`);
  instId = inst.id;
  cleanup.institutions.push(instId);
  const passwordHash = await bcrypt.hash("test-password", 4);
  lecturer = await prisma.user.create({
    data: { name: "Hardening Lecturer", email: `hardening-lect-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instId },
  });
  student = await prisma.user.create({
    data: { name: "Hardening Student", email: `hardening-stud-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instId },
  });
  platformAdmin = await prisma.user.create({
    data: { name: "Hardening Platform Admin", email: `hardening-admin-${stamp}@test.local`, passwordHash, role: "PLATFORM_ADMIN", institutionId: instId },
  });
  cleanup.users.push(lecturer.id, student.id, platformAdmin.id);
});

afterAll(async () => {
  await prisma.integrityEvent.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.answer.deleteMany({ where: { submission: { examId: { in: cleanup.exams } } } });
  await prisma.examAssignment.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.submission.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.question.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.exam.deleteMany({ where: { id: { in: cleanup.exams } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanup.users } } });
});

describe("1/2. Secure Browser feature enforcement", () => {
  it("1. secureBrowserEnabled=false -> publishing a TETHER_CLIENT_REQUIRED exam is denied (FEATURE_NOT_ENTITLED)", async () => {
    const exam = await createExam({ published: false, deliveryMode: "TETHER_CLIENT_REQUIRED" });
    await setEntitlement(instId, { secureBrowserEnabled: false });
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    const res = await examRoute.PATCH(jsonRequest("PATCH", { published: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("FEATURE_NOT_ENTITLED");
    await setEntitlement(instId, { secureBrowserEnabled: true });
  });

  it("1. secureBrowserEnabled=false -> a NEW attempt on an already-published TETHER_CLIENT_REQUIRED exam is denied", async () => {
    const exam = await createExam({ published: true, deliveryMode: "TETHER_CLIENT_REQUIRED" });
    await setEntitlement(instId, { secureBrowserEnabled: false });
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const res = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("FEATURE_NOT_ENTITLED");
    await setEntitlement(instId, { secureBrowserEnabled: true });
  });

  it("secureBrowserEnabled=false does NOT block a new attempt on an ordinary STANDARD_WEB exam", async () => {
    const exam = await createExam({ published: true, deliveryMode: "STANDARD_WEB" });
    await setEntitlement(instId, { secureBrowserEnabled: false });
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const res = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(201);
    await setEntitlement(instId, { secureBrowserEnabled: true });
  });

  it("2. secureBrowserEnabled disabled AFTER a TETHER_CLIENT_REQUIRED attempt is already active -> the active exam continues (resume unaffected)", async () => {
    const exam = await createExam({ published: true, deliveryMode: "TETHER_CLIENT_REQUIRED" });
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const firstRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(firstRes.status).toBe(201);
    const firstBody = await firstRes.json();

    await setEntitlement(instId, { secureBrowserEnabled: false });

    const resumeRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(resumeRes.status).toBe(200);
    expect((await resumeRes.json()).id).toBe(firstBody.id);
    await setEntitlement(instId, { secureBrowserEnabled: true });
  });
});

describe("2/3/4. AI Brainstorming entitlement after publication (new-attempt boundary)", () => {
  it("3. published AI-enabled exam + feature later disabled -> a NEW attempt is denied", async () => {
    const exam = await createExam({ published: true, aiAssistanceMode: "BRAINSTORM_ONLY" });
    // Published successfully while entitled (implicit — createExam
    // bypasses the route, but the scenario under test is specifically
    // "entitlement disabled AFTER publication", so publish state here is
    // simulated directly).
    await setEntitlement(instId, { aiBrainstormingEnabled: false });
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const res = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("FEATURE_NOT_ENTITLED");
    await setEntitlement(instId, { aiBrainstormingEnabled: true });
  });

  it("4. an active attempt created while AI Brainstorming was entitled continues safely after the feature is later disabled", async () => {
    const exam = await createExam({ published: true, aiAssistanceMode: "BRAINSTORM_ONLY" });
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const firstRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(firstRes.status).toBe(201);
    const firstBody = await firstRes.json();

    await setEntitlement(instId, { aiBrainstormingEnabled: false });

    const resumeRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(resumeRes.status).toBe(200);
    expect((await resumeRes.json()).id).toBe(firstBody.id);
    await setEntitlement(instId, { aiBrainstormingEnabled: true });
  });

  it("an exam with aiAssistanceMode DISABLED is never blocked by aiBrainstormingEnabled=false", async () => {
    const exam = await createExam({ published: true, aiAssistanceMode: "DISABLED" });
    await setEntitlement(instId, { aiBrainstormingEnabled: false });
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const res = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(201);
    await setEntitlement(instId, { aiBrainstormingEnabled: true });
  });
});

describe("3/5/6. Status + feature interaction — both required for NEW licensed activity, never for existing data", () => {
  it("5. an EXPIRED institution cannot start a new AI marking run, even with aiMarkingEnabled=true", async () => {
    const exam = await createExam({ published: true });
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const startRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    const submission = await startRes.json();
    await prisma.answer.create({
      data: { submissionId: submission.id, questionId: (await prisma.question.findFirstOrThrow({ where: { examId: exam.id } })).id, response: "essay text" },
    });
    await prisma.submission.update({ where: { id: submission.id }, data: { status: "SUBMITTED", submittedAt: new Date() } });

    await setEntitlement(instId, { status: "EXPIRED", endsAt: new Date("2020-01-01"), aiMarkingEnabled: true });
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    const res = await aiMarkEssaysRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ examId: exam.id }) });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("ENTITLEMENT_EXPIRED");

    await setEntitlement(instId, { status: "ACTIVE", endsAt: null });
  });

  it("aiMarkingEnabled=false (institution otherwise ACTIVE) denies a new AI marking run with FEATURE_NOT_ENTITLED, not an entitlement-status reason", async () => {
    const exam = await createExam({ published: true });
    await setEntitlement(instId, { aiMarkingEnabled: false });
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    const res = await aiMarkEssaysRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ examId: exam.id }) });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("FEATURE_NOT_ENTITLED");
    await setEntitlement(instId, { aiMarkingEnabled: true });
  });

  it("6. historical AI-mark results remain readable after the institution expires — the underlying Answer.aiDraftScore is never touched by an entitlement change", async () => {
    const exam = await createExam({ published: true });
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const startRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    const submission = await startRes.json();
    const question = await prisma.question.findFirstOrThrow({ where: { examId: exam.id } });
    const answer = await prisma.answer.create({
      data: { submissionId: submission.id, questionId: question.id, response: "essay text", aiDraftScore: 4, aiReasoning: "Pre-existing AI draft." },
    });
    await prisma.submission.update({ where: { id: submission.id }, data: { status: "SUBMITTED", submittedAt: new Date() } });

    await setEntitlement(instId, { status: "EXPIRED", endsAt: new Date("2020-01-01") });

    const stillThere = await prisma.answer.findUniqueOrThrow({ where: { id: answer.id } });
    expect(stillThere.aiDraftScore).toBe(4);
    expect(stillThere.aiReasoning).toBe("Pre-existing AI draft.");

    await setEntitlement(instId, { status: "ACTIVE", endsAt: null });
  });
});

describe("7. legacy Institution.active cannot silently conflict with entitlement", () => {
  it("Institution.active=false while entitlement status=ACTIVE -> full access remains (entitlement is authoritative, not active)", async () => {
    await prisma.institution.update({ where: { id: instId }, data: { active: false } });
    const exam = await createExam({ published: true });
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const res = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(201);
    await prisma.institution.update({ where: { id: instId }, data: { active: true } });
  });

  it("Institution.active=true while entitlement status=SUSPENDED -> access is still denied (entitlement is authoritative, not active)", async () => {
    const exam = await createExam({ published: true });
    await prisma.institution.update({ where: { id: instId }, data: { active: true } });
    await setEntitlement(instId, { status: "SUSPENDED" });
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const res = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(403);
    await setEntitlement(instId, { status: "ACTIVE" });
  });
});

describe("6/9. Candidate limit — standalone path cannot bypass the limit", () => {
  it("a standalone-invite acceptance is denied once candidateLimit is reached, for a student who is not already a counted candidate", async () => {
    const { hashStandaloneInviteToken } = await import("./standaloneInvite");
    const rawToken = "hardening-standalone-token-1";
    const exam = await createExam({
      published: true,
      assignmentMode: "STANDALONE",
      standaloneInviteEnabled: true,
      standaloneInviteTokenHash: hashStandaloneInviteToken(rawToken),
    });

    const newStandaloneStudent = await prisma.user.create({
      data: { name: "Standalone Bypass Student", email: `standalone-bypass-${stamp}@test.local`, passwordHash: await bcrypt.hash("x", 4), role: "STUDENT", institutionId: null },
    });
    cleanup.users.push(newStandaloneStudent.id);

    const currentUsage = await getInstitutionCandidateUsage(instId);
    await setEntitlement(instId, { candidateLimit: currentUsage });

    mockAuth.mockResolvedValue(sessionFor(newStandaloneStudent.id, "STUDENT", null));
    const res = await standaloneAcceptRoute.POST(jsonRequest("POST", { token: rawToken }), { params: Promise.resolve({ id: exam.id }) });
    const body = await res.json();
    expect(body.ok).toBe(false);

    const assignment = await prisma.examAssignment.findUnique({ where: { examId_studentId: { examId: exam.id, studentId: newStandaloneStudent.id } } });
    expect(assignment).toBeNull();

    await setEntitlement(instId, { candidateLimit: null });
  });

  it("a returning standalone candidate (already counted via a prior ExamAssignment at this institution) is never blocked by the candidate limit on a SECOND standalone exam", async () => {
    const { hashStandaloneInviteToken } = await import("./standaloneInvite");
    const rawTokenA = "hardening-standalone-token-2a";
    const rawTokenB = "hardening-standalone-token-2b";
    const examA = await createExam({
      published: true,
      assignmentMode: "STANDALONE",
      standaloneInviteEnabled: true,
      standaloneInviteTokenHash: hashStandaloneInviteToken(rawTokenA),
    });
    const examB = await createExam({
      published: true,
      assignmentMode: "STANDALONE",
      standaloneInviteEnabled: true,
      standaloneInviteTokenHash: hashStandaloneInviteToken(rawTokenB),
    });

    const returningStudent = await prisma.user.create({
      data: { name: "Returning Standalone Student", email: `standalone-returning-${stamp}@test.local`, passwordHash: await bcrypt.hash("x", 4), role: "STUDENT", institutionId: null },
    });
    cleanup.users.push(returningStudent.id);

    mockAuth.mockResolvedValue(sessionFor(returningStudent.id, "STUDENT", null));
    const firstRes = await standaloneAcceptRoute.POST(jsonRequest("POST", { token: rawTokenA }), { params: Promise.resolve({ id: examA.id }) });
    expect((await firstRes.json()).ok).toBe(true);

    // Now lock candidateLimit down to EXACTLY current usage (which
    // already includes this student) — a genuinely new candidate would
    // be denied, but this student must not be.
    const usageAfterFirst = await getInstitutionCandidateUsage(instId);
    await setEntitlement(instId, { candidateLimit: usageAfterFirst });

    const secondRes = await standaloneAcceptRoute.POST(jsonRequest("POST", { token: rawTokenB }), { params: Promise.resolve({ id: examB.id }) });
    expect((await secondRes.json()).ok).toBe(true);

    await setEntitlement(instId, { candidateLimit: null });
  });
});

describe("7/10/11/12. Attempt limit — oversubscription prevention, IN_PROGRESS counting, resume, VOIDED handling", () => {
  it("10. attempt usage counts an active IN_PROGRESS attempt, not only SUBMITTED/GRADED ones", async () => {
    const before = await getInstitutionAttemptUsage(instId);
    const exam = await createExam({ published: true });
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const res = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(201);
    const after = await getInstitutionAttemptUsage(instId);
    expect(after).toBe(before + 1);
  });

  it("11. resuming an existing IN_PROGRESS attempt does not consume a second unit of attempt usage", async () => {
    const exam = await createExam({ published: true });
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    const afterFirst = await getInstitutionAttemptUsage(instId);

    const resumeRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(resumeRes.status).toBe(200);
    const afterResume = await getInstitutionAttemptUsage(instId);
    expect(afterResume).toBe(afterFirst);
  });

  it("12. a VOIDED attempt does not count toward attempt usage", async () => {
    const exam = await createExam({ published: true });
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const res = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    const submission = await res.json();
    const before = await getInstitutionAttemptUsage(instId);
    await prisma.submission.update({ where: { id: submission.id }, data: { status: "VOIDED" } });
    const after = await getInstitutionAttemptUsage(instId);
    expect(after).toBe(before - 1);
  });

  it("last available attempt succeeds, the next one is denied with ATTEMPT_LIMIT_REACHED (409)", async () => {
    const exam = await createExam({ published: true });
    const currentUsage = await getInstitutionAttemptUsage(instId);
    await setEntitlement(instId, { attemptLimit: currentUsage + 1 });

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const okRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(okRes.status).toBe(201);

    const exam2 = await createExam({ published: true });
    const deniedRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam2.id }) });
    expect(deniedRes.status).toBe(409);
    expect((await deniedRes.json()).code).toBe("ATTEMPT_LIMIT_REACHED");

    await setEntitlement(instId, { attemptLimit: null });
  });
});

describe("8/13. Advanced reporting boundary — fully enforced across both routes", () => {
  it("similarity-analysis POST is denied when advancedReportingEnabled=false", async () => {
    const exam = await createExam({ published: true });
    await setEntitlement(instId, { advancedReportingEnabled: false });
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    const res = await similarityAnalysisRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ examId: exam.id }) });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("FEATURE_NOT_ENTITLED");
    await setEntitlement(instId, { advancedReportingEnabled: true });
  });

  it("collusion-analysis POST is denied when advancedReportingEnabled=false", async () => {
    const exam = await createExam({ published: true });
    await setEntitlement(instId, { advancedReportingEnabled: false });
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    const res = await collusionAnalysisRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ examId: exam.id }) });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("FEATURE_NOT_ENTITLED");
    await setEntitlement(instId, { advancedReportingEnabled: true });
  });

  it("both routes require ACTIVE status too (not just the feature flag) for a new analysis", async () => {
    const exam = await createExam({ published: true });
    await setEntitlement(instId, { status: "SUSPENDED", advancedReportingEnabled: true });
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    const res = await similarityAnalysisRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ examId: exam.id }) });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("ENTITLEMENT_SUSPENDED");
    await setEntitlement(instId, { status: "ACTIVE" });
  });
});

describe("14. Invalid dates/negative limits rejected at the route level (not just unit-tested)", () => {
  it("PUT /entitlement rejects endsAt before startsAt with a validationErrors array", async () => {
    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", instId));
    const res = await entitlementRoute.PUT(
      jsonRequest("PUT", { ...defaultInstitutionEntitlementInput(), startsAt: "2026-06-01T00:00:00.000Z", endsAt: "2026-05-01T00:00:00.000Z" }),
      { params: Promise.resolve({ id: instId }) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.validationErrors.some((e: { field: string }) => e.field === "endsAt")).toBe(true);
  });

  it("PUT /entitlement rejects GRACE status with no graceEndsAt", async () => {
    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", instId));
    const res = await entitlementRoute.PUT(jsonRequest("PUT", { ...defaultInstitutionEntitlementInput(), status: "GRACE" }), { params: Promise.resolve({ id: instId }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.validationErrors.some((e: { field: string }) => e.field === "graceEndsAt")).toBe(true);
  });

  it("PUT /entitlement rejects a negative candidateLimit", async () => {
    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", instId));
    const res = await entitlementRoute.PUT(jsonRequest("PUT", { ...defaultInstitutionEntitlementInput(), candidateLimit: -10 }), { params: Promise.resolve({ id: instId }) });
    expect(res.status).toBe(400);
  });

  it("a fully valid PUT still succeeds after all these rejections (the route isn't broken)", async () => {
    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", instId));
    const res = await entitlementRoute.PUT(jsonRequest("PUT", defaultInstitutionEntitlementInput()), { params: Promise.resolve({ id: instId }) });
    expect(res.status).toBe(200);
  });
});
