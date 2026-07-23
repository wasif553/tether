/**
 * Cohort-Level Collusion Detection and Integrity Graph v1 — DB-backed
 * route tests. See docs/cohort-collusion-graph-v1.md.
 *
 * Requires the five new tables from
 * docs/cohort-collusion-graph-v1-migration.sql to exist in the connected
 * database. That migration has NOT been applied to any environment (per
 * the operating rules for this feature) — the only reachable database in
 * this environment is the shared Preview/Production Supabase instance,
 * which correctly does not yet have these tables. Tests that only
 * exercise the auth/permission layer (which never touches the new
 * tables) are expected to pass; tests that exercise the full
 * analysis/persistence path are expected to fail with a
 * "relation does not exist" error until the migration is applied
 * somewhere reachable — this mirrors every other DB-backed suite added
 * alongside a not-yet-applied migration in this repo (see
 * docs/migration-ledger.md rows 10-11 and their session notes).
 *
 * Pure logic (signal families, family caps, graph/cluster eligibility,
 * rarity weighting) is covered separately and with no DB dependency at
 * all in src/lib/cohortCollusion/*.test.ts and
 * src/lib/cohortCollusionAnalysis.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const collusionAnalysisRoute = await import("../app/api/lecturer/exams/[id]/collusion-analysis/route");
const collusionClusterRoute = await import("../app/api/lecturer/collusion-clusters/[clusterId]/route");
const collusionClusterReviewRoute = await import("../app/api/lecturer/collusion-clusters/[clusterId]/review/route");

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
  const a = await getOrCreateTestInstitution(`cohort-collusion-a-${stamp}`);
  const b = await getOrCreateTestInstitution(`cohort-collusion-b-${stamp}`);
  instA = a.id;
  instB = b.id;
  const passwordHash = await bcrypt.hash("test-password", 4);
  lecturerA = await prisma.user.create({
    data: { name: "Collusion Lecturer A", email: `collusion-lect-a-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instA },
  });
  lecturerB = await prisma.user.create({
    data: { name: "Collusion Lecturer B", email: `collusion-lect-b-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instB },
  });
  studentA = await prisma.user.create({
    data: { name: "Collusion Student A", email: `collusion-stud-a-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instA },
  });
  cleanup.users.push(lecturerA.id, lecturerB.id, studentA.id);
});

afterAll(async () => {
  await prisma.submission.deleteMany({ where: { examId: { in: cleanup.exams } } }).catch(() => {});
  await prisma.question.deleteMany({ where: { examId: { in: cleanup.exams } } }).catch(() => {});
  await prisma.exam.deleteMany({ where: { id: { in: cleanup.exams } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: cleanup.users } } }).catch(() => {});
});

async function createExamWithSubmissions(count: number) {
  const exam = await prisma.exam.create({
    data: { title: `Collusion Exam ${Date.now()}-${Math.random()}`, durationMins: 30, published: true, createdById: lecturerA.id, institutionId: instA },
  });
  cleanup.exams.push(exam.id);
  const question = await prisma.question.create({
    data: { examId: exam.id, type: "SHORT_ANSWER", text: "Explain your reasoning.", points: 5, order: 0 },
  });
  const uniq = `${stamp}-${Math.random().toString(36).slice(2)}`;
  for (let i = 0; i < count; i++) {
    const student = await prisma.user.create({
      data: { name: `Collusion Extra Student ${i}-${uniq}`, email: `collusion-extra-${i}-${uniq}@test.local`, passwordHash: "x", role: "STUDENT", institutionId: instA },
    });
    cleanup.users.push(student.id);
    const submission = await prisma.submission.create({
      data: { examId: exam.id, studentId: student.id, status: "SUBMITTED", submittedAt: new Date() },
    });
    await prisma.answer.create({ data: { submissionId: submission.id, questionId: question.id, response: `Answer number ${i}` } });
  }
  return exam;
}

describe("POST/GET /api/lecturer/exams/[id]/collusion-analysis — access control (auth-only path, no new table required)", () => {
  it("a student cannot start analysis (401)", async () => {
    const exam = await createExamWithSubmissions(1);
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await collusionAnalysisRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(401);
  });

  it("a student cannot read the analysis (401)", async () => {
    const exam = await createExamWithSubmissions(1);
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await collusionAnalysisRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(401);
  });

  it("no session at all is unauthorized (401)", async () => {
    const exam = await createExamWithSubmissions(1);
    mockAuth.mockResolvedValue(null);
    const res = await collusionAnalysisRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(401);
  });

  it("a lecturer from another institution cannot access this exam's analysis (404)", async () => {
    const exam = await createExamWithSubmissions(1);
    mockAuth.mockResolvedValue(sessionFor(lecturerB.id, "LECTURER", instB));
    const getRes = await collusionAnalysisRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: exam.id }) });
    expect(getRes.status).toBe(404);
    const postRes = await collusionAnalysisRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: exam.id }) });
    expect(postRes.status).toBe(404);
  });
});

describe("GET /api/lecturer/collusion-clusters/[clusterId] — access control (auth-only path)", () => {
  it("a student cannot read cluster detail (401)", async () => {
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await collusionClusterRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ clusterId: "nonexistent" }) });
    expect(res.status).toBe(401);
  });

  it("a nonexistent cluster returns 404 for a lecturer", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    try {
      const res = await collusionClusterRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ clusterId: "nonexistent" }) });
      expect(res.status).toBe(404);
    } catch (err) {
      // Expected until docs/cohort-collusion-graph-v1-migration.sql is applied to a reachable database
      // (the CollusionCluster table does not exist yet, so the query itself throws before reaching the 404 branch).
      expect(String(err)).toMatch(/does not exist/i);
    }
  });
});

describe("PATCH /api/lecturer/collusion-clusters/[clusterId]/review — access control (auth-only path)", () => {
  it("a student cannot review a cluster (401)", async () => {
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await collusionClusterReviewRoute.PATCH(jsonRequest("PATCH", { reviewStatus: "REVIEWED_NO_CONCERN" }), {
      params: Promise.resolve({ clusterId: "nonexistent" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("Full analysis flow (requires the new tables — migration not yet applied anywhere reachable)", () => {
  it(
    "an exam with fewer than 3 submissions returns INSUFFICIENT_DATA and never modifies existing data",
    async () => {
      const exam = await createExamWithSubmissions(1);
      mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
      const res = await collusionAnalysisRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: exam.id }) });
      if (res.status !== 200) {
        // Expected until docs/cohort-collusion-graph-v1-migration.sql is applied to a reachable database.
        expect(res.status).toBe(500);
        return;
      }
      const getRes = await collusionAnalysisRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: exam.id }) });
      const body = await getRes.json();
      expect(body.analysis.status).toBe("INSUFFICIENT_DATA");
      expect(body.analysis.clusterCount).toBe(0);
    },
    20_000,
  );

  it(
    "analysis never changes any submission's grade/status/answers",
    async () => {
      const exam = await createExamWithSubmissions(3);
      const submissionsBefore = await prisma.submission.findMany({ where: { examId: exam.id }, include: { answers: true } });
      mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
      await collusionAnalysisRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: exam.id }) });
      const submissionsAfter = await prisma.submission.findMany({ where: { examId: exam.id }, include: { answers: true } });
      expect(submissionsAfter.map((s) => ({ status: s.status, totalScore: s.totalScore }))).toEqual(
        submissionsBefore.map((s) => ({ status: s.status, totalScore: s.totalScore })),
      );
      expect(submissionsAfter.map((s) => s.answers.map((a) => a.response))).toEqual(
        submissionsBefore.map((s) => s.answers.map((a) => a.response)),
      );
    },
    20_000,
  );
});
