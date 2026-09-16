/**
 * Institution Entitlement & Access Control v1 — DB-backed route tests.
 * See docs/institution-entitlement-v1.md and src/lib/institutionEntitlement.ts.
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
const { defaultInstitutionEntitlementInput } = await import("./institutionEntitlement");
const examsRoute = await import("../app/api/exams/route");
const examRoute = await import("../app/api/exams/[id]/route");
const startRoute = await import("../app/api/exams/[id]/start/route");
const examSubmissionsRoute = await import("../app/api/exams/[id]/submissions/route");
const inviteStudentRoute = await import("../app/api/platform/institutions/[id]/invite-student/route");
const institutionsRoute = await import("../app/api/platform/institutions/route");
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
const cleanup = { users: [] as string[], exams: [] as string[], courses: [] as string[], institutions: [] as string[] };

let instId: string;
let lecturer: { id: string };
let student: { id: string };
let platformAdmin: { id: string };
let courseId: string;

async function setEntitlement(institutionId: string, overrides: Partial<ReturnType<typeof defaultInstitutionEntitlementInput>>) {
  await prisma.institutionEntitlement.update({ where: { institutionId }, data: overrides });
}

async function createExam(opts: { published: boolean; aiAssistanceMode?: "DISABLED" | "BRAINSTORM_ONLY" }) {
  const exam = await prisma.exam.create({
    data: {
      title: `Entitlement Exam ${stamp}-${Math.random()}`,
      durationMins: 30,
      published: opts.published,
      createdById: lecturer.id,
      institutionId: instId,
      // No courseId -> a legacy institution-wide exam (assignmentMode
      // default COURSE is only enforced when courseId is set); the
      // student's institution membership alone is sufficient access —
      // these tests are about entitlement, not course enrollment.
      secureSettings: opts.aiAssistanceMode ? { aiAssistanceMode: opts.aiAssistanceMode } : undefined,
    },
  });
  cleanup.exams.push(exam.id);
  await prisma.question.create({
    data: { examId: exam.id, type: "MULTIPLE_CHOICE", text: "Q", points: 1, options: ["A", "B"], correctAnswer: "A", order: 0 },
  });
  return exam;
}

beforeAll(async () => {
  const inst = await getOrCreateTestInstitution(`entitlement-${stamp}`);
  instId = inst.id;
  cleanup.institutions.push(instId);
  const passwordHash = await bcrypt.hash("test-password", 4);
  lecturer = await prisma.user.create({
    data: { name: "Entitlement Lecturer", email: `entitlement-lect-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instId },
  });
  student = await prisma.user.create({
    data: { name: "Entitlement Student", email: `entitlement-stud-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instId },
  });
  platformAdmin = await prisma.user.create({
    data: { name: "Entitlement Platform Admin", email: `entitlement-admin-${stamp}@test.local`, passwordHash, role: "PLATFORM_ADMIN", institutionId: instId },
  });
  cleanup.users.push(lecturer.id, student.id, platformAdmin.id);

  const course = await prisma.course.create({ data: { institutionId: instId, name: "Entitlement Course", code: `ENT100-${stamp}` } });
  courseId = course.id;
  cleanup.courses.push(courseId);
  await prisma.courseEnrollment.create({ data: { courseId, userId: lecturer.id, role: "LECTURER" } });
});

afterAll(async () => {
  await prisma.integrityEvent.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.answer.deleteMany({ where: { submission: { examId: { in: cleanup.exams } } } });
  await prisma.submission.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.question.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.exam.deleteMany({ where: { id: { in: cleanup.exams } } });
  await prisma.courseEnrollment.deleteMany({ where: { courseId: { in: cleanup.courses } } });
  await prisma.course.deleteMany({ where: { id: { in: cleanup.courses } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanup.users } } });
});

describe("POST /api/exams — CREATE_EXAM gate", () => {
  it("suspended institution -> new exam creation denied", async () => {
    await setEntitlement(instId, { status: "SUSPENDED" });
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    const res = await examsRoute.POST(jsonRequest("POST", { title: "Blocked exam", durationMins: 30, courseId }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("ENTITLEMENT_SUSPENDED");
    await setEntitlement(instId, { status: "ACTIVE" });
  });

  it("active institution -> new exam creation allowed", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    const res = await examsRoute.POST(jsonRequest("POST", { title: "Allowed exam", durationMins: 30, courseId }));
    expect(res.status).toBe(201);
    const body = await res.json();
    cleanup.exams.push(body.id);
  });
});

describe("PATCH /api/exams/[id] — PUBLISH_EXAM gate (draft -> published transition only)", () => {
  it("suspended institution -> publishing a draft exam is denied", async () => {
    const exam = await createExam({ published: false });
    await setEntitlement(instId, { status: "SUSPENDED" });
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    const res = await examRoute.PATCH(jsonRequest("PATCH", { published: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("ENTITLEMENT_SUSPENDED");
    await setEntitlement(instId, { status: "ACTIVE" });
  });

  it("active institution -> publishing a draft exam is allowed", async () => {
    const exam = await createExam({ published: false });
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    const res = await examRoute.PATCH(jsonRequest("PATCH", { published: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(200);
  });

  it("an ALREADY-published exam is never re-gated by a later PATCH, even while suspended", async () => {
    const exam = await createExam({ published: true });
    await setEntitlement(instId, { status: "SUSPENDED" });
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    const res = await examRoute.PATCH(jsonRequest("PATCH", { title: "Renamed while suspended" }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(200);
    await setEntitlement(instId, { status: "ACTIVE" });
  });

  it("publishing a draft exam with AI Brainstorming configured is denied when the institution isn't licensed for it (FEATURE_NOT_ENTITLED)", async () => {
    const exam = await createExam({ published: false, aiAssistanceMode: "BRAINSTORM_ONLY" });
    await setEntitlement(instId, { aiBrainstormingEnabled: false });
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    const res = await examRoute.PATCH(jsonRequest("PATCH", { published: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("FEATURE_NOT_ENTITLED");
    await setEntitlement(instId, { aiBrainstormingEnabled: true });
  });

  it("publishing a draft exam WITHOUT AI Brainstorming configured succeeds even when the feature is disabled (never touches unrelated exams)", async () => {
    const exam = await createExam({ published: false, aiAssistanceMode: "DISABLED" });
    await setEntitlement(instId, { aiBrainstormingEnabled: false });
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    const res = await examRoute.PATCH(jsonRequest("PATCH", { published: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(200);
    await setEntitlement(instId, { aiBrainstormingEnabled: true });
  });
});

describe("POST /api/exams/[id]/start — START_ATTEMPT gate, attempt limit, and in-progress-exam safety (section 8)", () => {
  it("22. new exam attempt is blocked after entitlement becomes inactive (neutral student-facing wording, no payment/contract details)", async () => {
    const exam = await createExam({ published: true });
    await setEntitlement(instId, { status: "SUSPENDED" });
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const res = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("ENTITLEMENT_SUSPENDED");
    expect(body.error).not.toMatch(/paid|payment|invoice|suspend/i);
    await setEntitlement(instId, { status: "ACTIVE" });
  });

  it("active institution -> a genuinely new attempt is allowed", async () => {
    const exam = await createExam({ published: true });
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const res = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(201);
  });

  it("21. an existing IN_PROGRESS attempt is never interrupted when the institution's entitlement later becomes inactive — resume still succeeds", async () => {
    const exam = await createExam({ published: true });
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const firstRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(firstRes.status).toBe(201);
    const firstBody = await firstRes.json();

    // Institution entitlement lapses WHILE the student is mid-exam.
    await setEntitlement(instId, { status: "SUSPENDED" });

    const resumeRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(resumeRes.status).toBe(200);
    const resumeBody = await resumeRes.json();
    expect(resumeBody.id).toBe(firstBody.id);
    expect(resumeBody.status).toBe("IN_PROGRESS");
    await setEntitlement(instId, { status: "ACTIVE" });
  });

  it("15/16/17. attemptLimit: below threshold allowed, reached denied (409 ATTEMPT_LIMIT_REACHED), unlimited (null) allowed regardless of usage", async () => {
    // Isolated institution so this test's usage counting is never
    // affected by attempts other tests in this file create.
    const limitInst = await getOrCreateTestInstitution(`entitlement-attemptlimit-${stamp}`);
    const limitLecturer = await prisma.user.create({
      data: { name: "Limit Lecturer", email: `limit-lect-${stamp}@test.local`, passwordHash: await bcrypt.hash("x", 4), role: "LECTURER", institutionId: limitInst.id },
    });
    const limitStudent = await prisma.user.create({
      data: { name: "Limit Student", email: `limit-stud-${stamp}@test.local`, passwordHash: await bcrypt.hash("x", 4), role: "STUDENT", institutionId: limitInst.id },
    });
    cleanup.users.push(limitLecturer.id, limitStudent.id);
    cleanup.institutions.push(limitInst.id);

    async function makeLimitExam() {
      // No courseId -> a legacy institution-wide exam; institution
      // membership alone is sufficient access for the student.
      const exam = await prisma.exam.create({
        data: { title: `Limit Exam ${Math.random()}`, durationMins: 30, published: true, createdById: limitLecturer.id, institutionId: limitInst.id },
      });
      cleanup.exams.push(exam.id);
      await prisma.question.create({ data: { examId: exam.id, type: "MULTIPLE_CHOICE", text: "Q", points: 1, options: ["A", "B"], correctAnswer: "A", order: 0 } });
      return exam;
    }

    // attemptLimit: 1, zero usage yet -> allowed.
    await setEntitlement(limitInst.id, { attemptLimit: 1 });
    mockAuth.mockResolvedValue(sessionFor(limitStudent.id, "STUDENT", limitInst.id));
    const examA = await makeLimitExam();
    const resA = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: examA.id }) });
    expect(resA.status).toBe(201);
    // Directly finalize as SUBMITTED (real academic-attempt usage) rather
    // than driving the whole submit flow — attempt-limit counting only
    // cares about the resulting status.
    const submissionA = await resA.json();
    await prisma.submission.update({ where: { id: submissionA.id }, data: { status: "SUBMITTED", submittedAt: new Date() } });

    // Usage now 1, limit 1 -> reached, denied.
    const examB = await makeLimitExam();
    const resB = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: examB.id }) });
    expect(resB.status).toBe(409);
    expect((await resB.json()).code).toBe("ATTEMPT_LIMIT_REACHED");

    // Unlimited (null) -> allowed regardless of usage.
    await setEntitlement(limitInst.id, { attemptLimit: null });
    const resC = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: examB.id }) });
    expect(resC.status).toBe(201);
  });
});

describe("POST /api/platform/institutions/[id]/invite-student — ADD_CANDIDATE gate and candidate limit (12/13/14)", () => {
  it("candidate limit below threshold -> allowed", async () => {
    await setEntitlement(instId, { candidateLimit: 1000 });
    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", instId));
    const res = await inviteStudentRoute.POST(
      jsonRequest("POST", { name: "New Candidate", email: `candidate-ok-${stamp}@test.local`, password: "temporary-pw" }),
      { params: Promise.resolve({ id: instId }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    cleanup.users.push(body.id);
    await setEntitlement(instId, { candidateLimit: null });
  });

  it("candidate limit reached -> denied (409 CANDIDATE_LIMIT_REACHED), never a payment-status message", async () => {
    const currentCandidates = await prisma.user.count({ where: { institutionId: instId, role: "STUDENT" } });
    await setEntitlement(instId, { candidateLimit: currentCandidates });
    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", instId));
    const res = await inviteStudentRoute.POST(
      jsonRequest("POST", { name: "Over Limit", email: `candidate-over-${stamp}@test.local`, password: "temporary-pw" }),
      { params: Promise.resolve({ id: instId }) },
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CANDIDATE_LIMIT_REACHED");
    await setEntitlement(instId, { candidateLimit: null });
  });

  it("unlimited (null) candidate limit -> allowed", async () => {
    await setEntitlement(instId, { candidateLimit: null });
    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", instId));
    const res = await inviteStudentRoute.POST(
      jsonRequest("POST", { name: "Unlimited Candidate", email: `candidate-unlimited-${stamp}@test.local`, password: "temporary-pw" }),
      { params: Promise.resolve({ id: instId }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    cleanup.users.push(body.id);
  });
});

describe("Platform Admin entitlement management (23/24/25/26)", () => {
  it("23. Platform Admin can update entitlement", async () => {
    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", instId));
    const res = await entitlementRoute.PUT(
      jsonRequest("PUT", { ...defaultInstitutionEntitlementInput(), accessType: "PAID", candidateLimit: 250 }),
      { params: Promise.resolve({ id: instId }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entitlement.accessType).toBe("PAID");
    expect(body.entitlement.candidateLimit).toBe(250);
    await setEntitlement(instId, { accessType: "TRIAL", candidateLimit: null });
  });

  it("24. non-Platform-Admin cannot update entitlement", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    const res = await entitlementRoute.PUT(jsonRequest("PUT", defaultInstitutionEntitlementInput()), { params: Promise.resolve({ id: instId }) });
    expect(res.status).toBe(403);
  });

  it("24b. an unauthenticated caller cannot update entitlement", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await entitlementRoute.PUT(jsonRequest("PUT", defaultInstitutionEntitlementInput()), { params: Promise.resolve({ id: instId }) });
    expect(res.status).toBe(401);
  });

  it("25. entitlement update creates a PlatformAuditLog entry with before/after values, and suspension/reactivation get distinct action names", async () => {
    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", instId));

    await entitlementRoute.PUT(jsonRequest("PUT", { ...defaultInstitutionEntitlementInput(), status: "SUSPENDED" }), { params: Promise.resolve({ id: instId }) });
    const suspendLog = await prisma.platformAuditLog.findFirst({
      where: { institutionId: instId, action: "INSTITUTION_ENTITLEMENT_SUSPENDED" },
      orderBy: { createdAt: "desc" },
    });
    expect(suspendLog).not.toBeNull();
    expect(suspendLog?.actorId).toBe(platformAdmin.id);
    expect((suspendLog?.metadata as { new: { status: string } }).new.status).toBe("SUSPENDED");

    await entitlementRoute.PUT(jsonRequest("PUT", { ...defaultInstitutionEntitlementInput(), status: "ACTIVE" }), { params: Promise.resolve({ id: instId }) });
    const reactivateLog = await prisma.platformAuditLog.findFirst({
      where: { institutionId: instId, action: "INSTITUTION_ENTITLEMENT_REACTIVATED" },
      orderBy: { createdAt: "desc" },
    });
    expect(reactivateLog).not.toBeNull();
  });

  it("26. internal notes never leak into the lecturer/student-facing institution list response", async () => {
    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", instId));
    await entitlementRoute.PUT(
      jsonRequest("PUT", { ...defaultInstitutionEntitlementInput(), internalNotes: "Confidential — negotiated a 40% discount, do not disclose." }),
      { params: Promise.resolve({ id: instId }) },
    );

    const listRes = await institutionsRoute.GET();
    const listBody = await listRes.json();
    expect(JSON.stringify(listBody)).not.toMatch(/discount|confidential/i);

    // The admin-only detail route DOES return internalNotes (this route
    // is unreachable by anyone but PLATFORM_ADMIN — requirePlatformAdmin
    // above already proved that), but it must still never appear for a
    // non-admin caller.
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    const deniedRes = await entitlementRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: instId }) });
    expect(deniedRes.status).toBe(403);

    await setEntitlement(instId, { internalNotes: null });
  });
});

describe("27. migrated existing institutions (no InstitutionEntitlement row) retain expected access", () => {
  it("an institution with NO entitlement row can still create/publish exams and a student can still start an attempt", async () => {
    const legacyInst = await prisma.institution.create({
      data: { name: `Legacy Institution ${stamp}`, slug: `legacy-inst-${stamp}`, plan: "pilot", active: true },
    });
    cleanup.institutions.push(legacyInst.id);
    const legacyLecturer = await prisma.user.create({
      data: { name: "Legacy Lecturer", email: `legacy-lect-${stamp}@test.local`, passwordHash: await bcrypt.hash("x", 4), role: "LECTURER", institutionId: legacyInst.id },
    });
    const legacyStudent = await prisma.user.create({
      data: { name: "Legacy Student", email: `legacy-stud-${stamp}@test.local`, passwordHash: await bcrypt.hash("x", 4), role: "STUDENT", institutionId: legacyInst.id },
    });
    const legacyCourse = await prisma.course.create({ data: { institutionId: legacyInst.id, name: "Legacy Course", code: `LEG100-${stamp}` } });
    await prisma.courseEnrollment.create({ data: { courseId: legacyCourse.id, userId: legacyLecturer.id, role: "LECTURER" } });
    await prisma.courseEnrollment.create({ data: { courseId: legacyCourse.id, userId: legacyStudent.id, role: "STUDENT" } });
    cleanup.users.push(legacyLecturer.id, legacyStudent.id);
    cleanup.courses.push(legacyCourse.id);

    // Confirm the precondition: genuinely no row.
    expect(await prisma.institutionEntitlement.findUnique({ where: { institutionId: legacyInst.id } })).toBeNull();

    mockAuth.mockResolvedValue(sessionFor(legacyLecturer.id, "LECTURER", legacyInst.id));
    const createRes = await examsRoute.POST(jsonRequest("POST", { title: "Legacy exam", durationMins: 30, courseId: legacyCourse.id }));
    expect(createRes.status).toBe(201);
    const exam = await createRes.json();
    cleanup.exams.push(exam.id);
    await prisma.question.create({ data: { examId: exam.id, type: "MULTIPLE_CHOICE", text: "Q", points: 1, options: ["A", "B"], correctAnswer: "A", order: 0 } });

    const publishRes = await examRoute.PATCH(jsonRequest("PATCH", { published: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(publishRes.status).toBe(200);

    mockAuth.mockResolvedValue(sessionFor(legacyStudent.id, "STUDENT", legacyInst.id));
    const startRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(startRes.status).toBe(201);
  });
});

describe("20. historical records remain accessible after the institution becomes EXPIRED", () => {
  it("a lecturer can still list an exam's submissions (untouched, non-entitlement-gated route)", async () => {
    const exam = await createExam({ published: true });
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const startRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(startRes.status).toBe(201);
    const submission = await startRes.json();
    await prisma.submission.update({ where: { id: submission.id }, data: { status: "SUBMITTED", submittedAt: new Date() } });

    await setEntitlement(instId, { status: "EXPIRED", endsAt: new Date("2020-01-01") });
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    const listRes = await examSubmissionsRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: exam.id }) });
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list.some((s: { id: string }) => s.id === submission.id)).toBe(true);

    await setEntitlement(instId, { status: "ACTIVE", endsAt: null });
  });
});
