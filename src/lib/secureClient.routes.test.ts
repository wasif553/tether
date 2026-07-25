/**
 * Tether Secure Client Foundation v1 — DB-backed route tests. See
 * docs/secure-client-foundation-seb-v1.md.
 *
 * Requires the seven new tables from
 * docs/secure-client-foundation-seb-v1-migration.sql, plus the new
 * Submission.secureClientPolicySnapshotJson column, to exist in the
 * connected database. That migration has NOT been applied to any
 * environment (per the operating rules for this feature) — the only
 * reachable database in this environment is the shared Preview/
 * Production Supabase instance, which correctly does not yet have this
 * schema. This file therefore covers ONLY the auth/permission layer that
 * returns before ever touching the new column or the seven new tables —
 * every case here resolves using the pre-existing User/Exam tables only.
 * This mirrors the same convention already used by
 * src/lib/cohortCollusionAnalysis.routes.test.ts and
 * src/lib/answerDevelopment.routes.test.ts alongside their own
 * not-yet-applied migrations (see docs/migration-ledger.md).
 *
 * Pure logic (policy snapshots, manifest signing, session state machine,
 * event schemas, SEB key hashing, canonical origin, SEB config
 * generation, key encryption, mock-client availability gating) is
 * covered separately and with no DB dependency at all in
 * src/lib/secureClientPolicy.test.ts and src/lib/secureClient/*.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const configurationRoute = await import("../app/api/lecturer/exams/[id]/secure-client/configuration/route");
const preflightRoute = await import("../app/api/submissions/[id]/secure-client/preflight/route");
const mockLaunchRoute = await import("../app/api/submissions/[id]/secure-client/mock-launch/route");
const lecturerSessionsRoute = await import("../app/api/lecturer/exams/[id]/secure-client/sessions/route");

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
let lecturerB: { id: string };
let studentA: { id: string };

beforeAll(async () => {
  const a = await getOrCreateTestInstitution(`secure-client-a-${stamp}`);
  const b = await getOrCreateTestInstitution(`secure-client-b-${stamp}`);
  instA = a.id;
  instB = b.id;
  const passwordHash = await bcrypt.hash("test-password", 4);
  lecturerA = await prisma.user.create({
    data: { name: "Secure Client Lecturer A", email: `sc-lect-a-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instA },
  });
  lecturerB = await prisma.user.create({
    data: { name: "Secure Client Lecturer B", email: `sc-lect-b-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instB },
  });
  studentA = await prisma.user.create({
    data: { name: "Secure Client Student A", email: `sc-stud-a-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instA },
  });
  cleanup.users.push(lecturerA.id, lecturerB.id, studentA.id);
});

afterAll(async () => {
  await prisma.question.deleteMany({ where: { examId: { in: cleanup.exams } } }).catch(() => {});
  await prisma.exam.deleteMany({ where: { id: { in: cleanup.exams } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: cleanup.users } } }).catch(() => {});
});

async function createExam(createdById: string, institutionId: string) {
  const exam = await prisma.exam.create({
    data: { title: `Secure Client Exam ${Date.now()}-${Math.random()}`, durationMins: 30, published: true, createdById, institutionId },
  });
  cleanup.exams.push(exam.id);
  return exam;
}

describe("GET/PUT /api/lecturer/exams/[id]/secure-client/configuration — permission layer (no new table touched on rejection)", () => {
  it("a student cannot read configuration (401)", async () => {
    const exam = await createExam(lecturerA.id, instA);
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await configurationRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(401);
  });

  it("a student cannot write configuration (401)", async () => {
    const exam = await createExam(lecturerA.id, instA);
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await configurationRoute.PUT(jsonRequest("PUT", { provider: "SAFE_EXAM_BROWSER" }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(401);
  });

  it("an unauthenticated request is rejected (401)", async () => {
    const exam = await createExam(lecturerA.id, instA);
    mockAuth.mockResolvedValue(null);
    const res = await configurationRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(401);
  });

  it("a lecturer from a different institution gets 404, never 403, for another institution's exam (does not confirm existence)", async () => {
    const exam = await createExam(lecturerA.id, instA);
    mockAuth.mockResolvedValue(sessionFor(lecturerB.id, "LECTURER", instB));
    const res = await configurationRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(404);
  });

  it("a lecturer who does not own the exam (same institution, different creator) gets 404", async () => {
    const otherLecturer = await prisma.user.create({
      data: { name: "Other Lecturer A", email: `sc-lect-other-${stamp}@test.local`, passwordHash: "x", role: "LECTURER", institutionId: instA },
    });
    cleanup.users.push(otherLecturer.id);
    const exam = await createExam(lecturerA.id, instA);
    mockAuth.mockResolvedValue(sessionFor(otherLecturer.id, "LECTURER", instA));
    const res = await configurationRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(404);
  });

  it("a nonexistent exam id returns 404 for the owning lecturer's own institution", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await configurationRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: "nonexistent-exam-id" }) });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/lecturer/exams/[id]/secure-client/sessions — permission layer", () => {
  it("a student cannot list sessions (401)", async () => {
    const exam = await createExam(lecturerA.id, instA);
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await lecturerSessionsRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(401);
  });

  it("a lecturer from a different institution gets 404 for another institution's exam sessions", async () => {
    const exam = await createExam(lecturerA.id, instA);
    mockAuth.mockResolvedValue(sessionFor(lecturerB.id, "LECTURER", instB));
    const res = await lecturerSessionsRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/submissions/[id]/secure-client/preflight — role check (before any Submission column read)", () => {
  it("a lecturer cannot run a student's preflight check (401)", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await preflightRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: "some-submission-id" }) });
    expect(res.status).toBe(401);
  });

  it("an unauthenticated request is rejected (401)", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await preflightRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: "some-submission-id" }) });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/submissions/[id]/secure-client/mock-launch — role check (before any Submission column read)", () => {
  it("a lecturer cannot request a mock launch (401)", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await mockLaunchRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: "some-submission-id" }) });
    expect(res.status).toBe(401);
  });

  it("an unauthenticated request is rejected (401)", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await mockLaunchRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: "some-submission-id" }) });
    expect(res.status).toBe(401);
  });
});
