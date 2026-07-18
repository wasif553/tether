import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const availableRoute = await import("../app/api/exams/available/route");
const examsRoute = await import("../app/api/exams/route");
const examRoute = await import("../app/api/exams/[id]/route");
const evidenceRoute = await import("../app/api/lecturer/submissions/[id]/evidence/route");
const platformInstitutionsRoute = await import("../app/api/platform/institutions/route");
const signupRoute = await import("../app/api/signup/route");

function sessionFor(
  userId: string,
  role: "LECTURER" | "STUDENT" | "PLATFORM_ADMIN",
  institutionId: string | null,
) {
  return { user: { id: userId, role, email: `${userId}@test.local`, name: userId, institutionId } };
}

function jsonRequest(method: string, body?: unknown) {
  return new Request("http://test.local/route", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

let instA: { id: string };
let instB: { id: string };
let lecturerA: { id: string };
let lecturerB: { id: string };
let studentA: { id: string };
let platformAdmin: { id: string };
let examA: { id: string };
let examB: { id: string };
let submissionForExamA: { id: string };

beforeAll(async () => {
  instA = await getOrCreateTestInstitution("mt-routes-inst-a");
  instB = await getOrCreateTestInstitution("mt-routes-inst-b");
  const passwordHash = await bcrypt.hash("test-password", 4);
  const stamp = Date.now();

  lecturerA = await prisma.user.create({
    data: { name: "MT Lecturer A", email: `mt-lect-a-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instA.id },
  });
  lecturerB = await prisma.user.create({
    data: { name: "MT Lecturer B", email: `mt-lect-b-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instB.id },
  });
  studentA = await prisma.user.create({
    data: { name: "MT Student A", email: `mt-stud-a-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instA.id },
  });
  platformAdmin = await prisma.user.create({
    data: { name: "MT Platform Admin", email: `mt-admin-${stamp}@test.local`, passwordHash, role: "PLATFORM_ADMIN", institutionId: instA.id },
  });

  examA = await prisma.exam.create({
    data: { title: "Institution A Exam", durationMins: 30, published: true, createdById: lecturerA.id, institutionId: instA.id },
  });
  examB = await prisma.exam.create({
    data: { title: "Institution B Exam", durationMins: 30, published: true, createdById: lecturerB.id, institutionId: instB.id },
  });
  submissionForExamA = await prisma.submission.create({ data: { examId: examA.id, studentId: studentA.id } });
});

afterAll(async () => {
  const userIds = [lecturerA.id, lecturerB.id, studentA.id, platformAdmin.id];
  await prisma.submission.deleteMany({ where: { studentId: { in: userIds } } });
  await prisma.exam.deleteMany({ where: { id: { in: [examA.id, examB.id] } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe("8. GET /api/exams/available — student only sees their own institution's exams", () => {
  it("returns institution A's published exam but not institution B's", async () => {
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA.id));
    const res = await availableRoute.GET();
    expect(res.status).toBe(200);
    const exams = await res.json();
    const ids = exams.map((e: { id: string }) => e.id);
    expect(ids).toContain(examA.id);
    expect(ids).not.toContain(examB.id);
  });
});

describe("9. GET /api/exams (lecturer list) — scoped to own institution and ownership", () => {
  it("lecturer A does not see lecturer B's exam", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA.id));
    const res = await examsRoute.GET();
    expect(res.status).toBe(200);
    const exams = await res.json();
    const ids = exams.map((e: { id: string }) => e.id);
    expect(ids).toContain(examA.id);
    expect(ids).not.toContain(examB.id);
  });
});

describe("10. POST /api/exams — stamps the creator's institutionId", () => {
  it("a newly created exam gets the lecturer's institutionId", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA.id));
    const res = await examsRoute.POST(jsonRequest("POST", { title: "Stamped Exam", durationMins: 20 }));
    expect(res.status).toBe(201);
    const exam = await res.json();
    expect(exam.institutionId).toBe(instA.id);
    await prisma.exam.delete({ where: { id: exam.id } });
  });
});

describe("11. GET /api/exams/[id] — cross-institution access is blocked", () => {
  it("lecturer B gets a 403/404-style response fetching institution A's exam directly by id", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerB.id, "LECTURER", instB.id));
    const res = await examRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: examA.id }) });
    expect([403, 404]).toContain(res.status);
  });

  it("the owning lecturer in the same institution can fetch it", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA.id));
    const res = await examRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: examA.id }) });
    expect(res.status).toBe(200);
  });
});

describe("12. GET /api/exams/[id] — PLATFORM_ADMIN bypasses institution scoping", () => {
  it("a PLATFORM_ADMIN can fetch an exam belonging to a different institution", async () => {
    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", instA.id));
    const res = await examRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: examB.id }) });
    expect(res.status).toBe(200);
  });
});

describe("13. A session with no institutionId fails loudly rather than silently scoping to nothing", () => {
  it("returns 401 with a re-login message for /api/exams/available", async () => {
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", null));
    const res = await availableRoute.GET();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/log in again/i);
  });

  it("returns 401 for /api/exams (lecturer list)", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", null));
    const res = await examsRoute.GET();
    expect(res.status).toBe(401);
  });
});

describe("14. Evidence report choke point (buildEvidenceReport) enforces institution scoping", () => {
  it("blocks a lecturer in a different institution from reading the evidence report", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerB.id, "LECTURER", instB.id));
    const res = await evidenceRoute.GET(jsonRequest("GET"), {
      params: Promise.resolve({ id: submissionForExamA.id }),
    });
    expect(res.status).toBe(403);
  });

  it("allows the owning lecturer in the same institution", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA.id));
    const res = await evidenceRoute.GET(jsonRequest("GET"), {
      params: Promise.resolve({ id: submissionForExamA.id }),
    });
    expect(res.status).toBe(200);
  });

  it("allows a PLATFORM_ADMIN to read it regardless of institution", async () => {
    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", instB.id));
    const res = await evidenceRoute.GET(jsonRequest("GET"), {
      params: Promise.resolve({ id: submissionForExamA.id }),
    });
    expect(res.status).toBe(200);
  });
});

// Note: the original task spec for tests #17/#18 referenced
// `POST /api/platform/institutions` and an invite-lecturer route, but
// Step 7 explicitly says not to build those routes in v1 — only the GET
// list route. These tests cover the GET route's authorization instead.
describe("15. GET /api/platform/institutions — PLATFORM_ADMIN only", () => {
  it("rejects an authenticated non-admin lecturer with 403", async () => {
    // As of Platform Admin Onboarding v2's shared requirePlatformAdmin()
    // helper, 401 is reserved for unauthenticated requests and 403 for
    // an authenticated user with the wrong role — see
    // docs/platform-admin-onboarding.md.
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA.id));
    const res = await platformInstitutionsRoute.GET();
    expect(res.status).toBe(403);
  });

  it("returns institutions with safe fields only (no passwords/secrets) for a PLATFORM_ADMIN", async () => {
    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", instA.id));
    const res = await platformInstitutionsRoute.GET();
    expect(res.status).toBe(200);
    const institutions = await res.json();
    const found = institutions.find((i: { id: string }) => i.id === instA.id);
    expect(found).toBeDefined();
    expect(found).toHaveProperty("_count");
    const serialized = JSON.stringify(institutions);
    expect(serialized).not.toContain("passwordHash");
  });
});

describe("16. POST /api/signup — assigns the default institution", () => {
  it("a new self-signup user is stamped with the default institution's id", async () => {
    const stamp = Date.now();
    const res = await signupRoute.POST(
      jsonRequest("POST", {
        name: "Signup Test User",
        email: `signup-mt-${stamp}@test.local`,
        password: "test-password-123",
        role: "STUDENT",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const user = await prisma.user.findUnique({ where: { id: body.id } });
    expect(user?.institutionId).not.toBeNull();
    await prisma.user.delete({ where: { id: body.id } });
  });
});

describe("17. GET /api/exams/[id] — assertSameInstitution never matches null institutionId against null", () => {
  it("a session missing institutionId cannot access an exam that also lacks one", async () => {
    const orphanExam = await prisma.exam.create({
      data: { title: "Orphan Exam", durationMins: 10, createdById: lecturerA.id },
    });
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", null));
    const res = await examRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: orphanExam.id }) });
    expect(res.status).toBe(401);
    await prisma.exam.delete({ where: { id: orphanExam.id } });
  });
});

// Question Pools v1 runtime regression check — see
// docs/question-pools-v1.md. GET /api/exams (the lecturer exam list) has
// no question-pool-related filtering at all; these tests exist to prove
// that directly, so a future change to that route can't silently
// reintroduce a query/relation that excludes exams based on their pools.
describe("18. GET /api/exams (lecturer list) is never affected by question pools", () => {
  it("an exam with no question pools appears in the list", async () => {
    const exam = await prisma.exam.create({
      data: { title: "No Pools Exam", durationMins: 30, createdById: lecturerA.id, institutionId: instA.id },
    });
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA.id));
    const res = await examsRoute.GET();
    expect(res.status).toBe(200);
    const ids = (await res.json()).map((e: { id: string }) => e.id);
    expect(ids).toContain(exam.id);
    await prisma.exam.delete({ where: { id: exam.id } });
  });

  it("an exam with a question pool (and questions in it) still appears in the list", async () => {
    const exam = await prisma.exam.create({
      data: {
        title: "Pool Exam",
        durationMins: 30,
        createdById: lecturerA.id,
        institutionId: instA.id,
        secureSettings: { enableQuestionPools: true, questionPoolSelectionMode: "DRAW_FROM_POOLS" },
      },
    });
    const pool = await prisma.questionPool.create({
      data: { examId: exam.id, name: "Programming basics", drawCount: 2 },
    });
    await prisma.question.create({
      data: { examId: exam.id, type: "SHORT_ANSWER", text: "Q1", points: 1, questionPoolId: pool.id },
    });

    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA.id));
    const res = await examsRoute.GET();
    expect(res.status).toBe(200);
    const ids = (await res.json()).map((e: { id: string }) => e.id);
    expect(ids).toContain(exam.id);

    await prisma.question.deleteMany({ where: { examId: exam.id } });
    await prisma.questionPool.delete({ where: { id: pool.id } });
    await prisma.exam.delete({ where: { id: exam.id } });
  });

  it("an exam with an EMPTY question pool (no questions assigned yet) still appears in the list", async () => {
    const exam = await prisma.exam.create({
      data: {
        title: "Empty Pool Exam",
        durationMins: 30,
        createdById: lecturerA.id,
        institutionId: instA.id,
        secureSettings: { enableQuestionPools: true },
      },
    });
    await prisma.questionPool.create({ data: { examId: exam.id, name: "Empty pool", drawCount: null } });

    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA.id));
    const res = await examsRoute.GET();
    expect(res.status).toBe(200);
    const ids = (await res.json()).map((e: { id: string }) => e.id);
    expect(ids).toContain(exam.id);

    await prisma.exam.delete({ where: { id: exam.id } });
  });
});
