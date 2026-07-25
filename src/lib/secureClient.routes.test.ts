/**
 * Tether Secure Client Foundation v1 — MOCKED route tests. See
 * docs/secure-client-foundation-seb-v1.md.
 *
 * Hardening pass (see docs/migration-ledger.md hardening commit): this
 * file previously created real User/Exam rows in the shared Preview/
 * Production Supabase database (the only reachable database in this
 * environment) and relied on an afterAll cleanup to remove them. That is
 * no longer acceptable practice for this repository, regardless of which
 * tables are pre-existing — see the corrected policy in
 * docs/migration-ledger.md. Every Prisma call is now mocked (vi.fn()) —
 * nothing in this file ever opens a real database connection, matching
 * the already-established pattern in
 * src/lib/answerDevelopment.routes.test.ts. This also means these tests
 * no longer depend on the still-PENDING secure-client migration at all —
 * they exercise only the auth/ownership/institution GATES that run
 * before any new table is ever touched, using canned fixture objects
 * instead of real rows.
 *
 * Pure logic (policy snapshots, manifest signing, session state machine,
 * event schemas, SEB key hashing, canonical origin, SEB config
 * generation, key encryption, mock-client/SEB-mode availability gating)
 * is covered separately and with no DB dependency at all in
 * src/lib/secureClientPolicy.test.ts, src/lib/secureClientAvailability.test.ts,
 * and src/lib/secureClient/*.test.ts. Concurrency/uniqueness guarantees
 * that genuinely require a real, migrated Postgres database are covered
 * in src/lib/secureClientRunner.disposable.test.ts, which is explicitly
 * excluded from the default test run and must only ever be pointed at a
 * disposable database — never this shared one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockAuth = vi.hoisted(() => vi.fn());
vi.mock("@/auth", () => ({ auth: mockAuth }));

const mockPrisma = vi.hoisted(() => ({
  exam: { findUnique: vi.fn() },
  submission: { findUnique: vi.fn() },
  institution: { findUnique: vi.fn() },
  secureClientConfiguration: { findMany: vi.fn(), findFirst: vi.fn() },
  secureClientSession: { findMany: vi.fn() },
  sebAllowedExamKey: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

const configurationRoute = await import("../app/api/lecturer/exams/[id]/secure-client/configuration/route");
const preflightRoute = await import("../app/api/submissions/[id]/secure-client/preflight/route");
const mockLaunchRoute = await import("../app/api/submissions/[id]/secure-client/mock-launch/route");
const lecturerSessionsRoute = await import("../app/api/lecturer/exams/[id]/secure-client/sessions/route");

const EXAM_ID = "exam-1";

function studentSession(userId: string, institutionId: string) {
  return { user: { id: userId, role: "STUDENT", institutionId } };
}
function lecturerSession(userId: string, institutionId: string) {
  return { user: { id: userId, role: "LECTURER", institutionId } };
}
function examFixture(overrides: Record<string, unknown> = {}) {
  return { id: EXAM_ID, createdById: "lecturer-a", institutionId: "inst-a", ...overrides };
}

function jsonRequest(method: string, body?: unknown) {
  return new Request("http://test.local/route", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET/PUT /api/lecturer/exams/[id]/secure-client/configuration — permission layer (no new table touched on rejection)", () => {
  it("a student cannot read configuration (401)", async () => {
    mockAuth.mockResolvedValue(studentSession("student-a", "inst-a"));
    const res = await configurationRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: EXAM_ID }) });
    expect(res.status).toBe(401);
    expect(mockPrisma.exam.findUnique).not.toHaveBeenCalled();
  });

  it("a student cannot write configuration (401)", async () => {
    mockAuth.mockResolvedValue(studentSession("student-a", "inst-a"));
    const res = await configurationRoute.PUT(jsonRequest("PUT", { provider: "SAFE_EXAM_BROWSER" }), { params: Promise.resolve({ id: EXAM_ID }) });
    expect(res.status).toBe(401);
    expect(mockPrisma.exam.findUnique).not.toHaveBeenCalled();
  });

  it("an unauthenticated request is rejected (401)", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await configurationRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: EXAM_ID }) });
    expect(res.status).toBe(401);
    expect(mockPrisma.exam.findUnique).not.toHaveBeenCalled();
  });

  it("a lecturer from a different institution gets 404, never 403, for another institution's exam (does not confirm existence)", async () => {
    mockAuth.mockResolvedValue(lecturerSession("lecturer-b", "inst-b"));
    mockPrisma.exam.findUnique.mockResolvedValue(examFixture());
    const res = await configurationRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: EXAM_ID }) });
    expect(res.status).toBe(404);
  });

  it("a lecturer who does not own the exam (same institution, different creator) gets 404", async () => {
    mockAuth.mockResolvedValue(lecturerSession("other-lecturer-a", "inst-a"));
    mockPrisma.exam.findUnique.mockResolvedValue(examFixture());
    const res = await configurationRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: EXAM_ID }) });
    expect(res.status).toBe(404);
  });

  it("a nonexistent exam id returns 404 for the owning lecturer's own institution", async () => {
    mockAuth.mockResolvedValue(lecturerSession("lecturer-a", "inst-a"));
    mockPrisma.exam.findUnique.mockResolvedValue(null);
    const res = await configurationRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: "nonexistent-exam-id" }) });
    expect(res.status).toBe(404);
  });

  it("the owning lecturer can read configuration (200, real permission-check path exercised end to end)", async () => {
    mockAuth.mockResolvedValue(lecturerSession("lecturer-a", "inst-a"));
    mockPrisma.exam.findUnique.mockResolvedValue(examFixture());
    mockPrisma.secureClientConfiguration.findMany.mockResolvedValue([]);
    const res = await configurationRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: EXAM_ID }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configurations: [] });
  });
});

describe("GET /api/lecturer/exams/[id]/secure-client/sessions — permission layer", () => {
  it("a student cannot list sessions (401)", async () => {
    mockAuth.mockResolvedValue(studentSession("student-a", "inst-a"));
    const res = await lecturerSessionsRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: EXAM_ID }) });
    expect(res.status).toBe(401);
    expect(mockPrisma.exam.findUnique).not.toHaveBeenCalled();
  });

  it("a lecturer from a different institution gets 404 for another institution's exam sessions", async () => {
    mockAuth.mockResolvedValue(lecturerSession("lecturer-b", "inst-b"));
    mockPrisma.exam.findUnique.mockResolvedValue(examFixture());
    const res = await lecturerSessionsRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: EXAM_ID }) });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/submissions/[id]/secure-client/preflight — role check (before any Submission column read)", () => {
  it("a lecturer cannot run a student's preflight check (401)", async () => {
    mockAuth.mockResolvedValue(lecturerSession("lecturer-a", "inst-a"));
    const res = await preflightRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: "some-submission-id" }) });
    expect(res.status).toBe(401);
    expect(mockPrisma.submission.findUnique).not.toHaveBeenCalled();
  });

  it("an unauthenticated request is rejected (401)", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await preflightRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: "some-submission-id" }) });
    expect(res.status).toBe(401);
    expect(mockPrisma.submission.findUnique).not.toHaveBeenCalled();
  });
});

describe("POST /api/submissions/[id]/secure-client/mock-launch — role check (before any Submission column read)", () => {
  it("a lecturer cannot request a mock launch (401)", async () => {
    mockAuth.mockResolvedValue(lecturerSession("lecturer-a", "inst-a"));
    const res = await mockLaunchRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: "some-submission-id" }) });
    expect(res.status).toBe(401);
    expect(mockPrisma.submission.findUnique).not.toHaveBeenCalled();
  });

  it("an unauthenticated request is rejected (401)", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await mockLaunchRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: "some-submission-id" }) });
    expect(res.status).toBe(401);
    expect(mockPrisma.submission.findUnique).not.toHaveBeenCalled();
  });

  it("cannot be enabled via a frontend-supplied query parameter — mock-launch availability is resolved server-side only", async () => {
    // Even a well-formed request from an authenticated STUDENT who owns
    // the submission must still fail if isMockSecureClientAllowed's
    // server-side checks (env flags + institution allowlist) deny it —
    // this route never reads a query/body parameter to decide
    // availability (see src/lib/secureClientAvailability.ts).
    mockAuth.mockResolvedValue(studentSession("student-a", "inst-a"));
    mockPrisma.submission.findUnique.mockResolvedValue({
      id: "sub-1",
      studentId: "student-a",
      status: "IN_PROGRESS",
      secureClientPolicySnapshotJson: { deliveryMode: "TETHER_CLIENT_OPTIONAL" },
      exam: { institutionId: "inst-a" },
    });
    mockPrisma.institution.findUnique.mockResolvedValue({ slug: "inst-a" });
    vi.stubEnv("TETHER_MOCK_SECURE_CLIENT_ENABLED", undefined);
    const res = await mockLaunchRoute.POST(
      new Request("http://test.local/route?mockClient=true&enableMock=1", { method: "POST" }),
      { params: Promise.resolve({ id: "sub-1" }) },
    );
    expect(res.status).toBe(403);
  });
});
