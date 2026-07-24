/**
 * Answer-Development Provenance v1 — MOCKED route tests. See
 * docs/answer-development-provenance-v1.md and the operating rules for
 * this feature: no DB-backed test may run against the shared Supabase
 * database. Every Prisma call is mocked (vi.fn()) — nothing here ever
 * opens a real database connection, matching "mocked route tests" in
 * Part 13/8 of the spec.
 *
 * These tests exercise the auth/ownership/policy GATES that run before
 * any transactional write — the security-critical surface a mocked
 * Prisma client can verify without needing to fake `$transaction`'s
 * callback-style API.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAuth = vi.hoisted(() => vi.fn());
vi.mock("@/auth", () => ({ auth: mockAuth }));

const mockPrisma = vi.hoisted(() => ({
  submission: { findUnique: vi.fn() },
  answer: { findUnique: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

function studentSession(userId: string) {
  return { user: { id: userId, role: "STUDENT" } };
}
function lecturerSession(userId: string, institutionId: string) {
  return { user: { id: userId, role: "LECTURER", institutionId } };
}

const basicPolicySnapshot = {
  schemaVersion: 1,
  policyVersion: "v1.0",
  mode: "BASIC",
  versionIntervalSeconds: 60,
  versionMinimumCharacterChange: 80,
  versionMaximumPerQuestion: 40,
  capturePasteMetadata: true,
  captureDeletionRewriteMetadata: true,
  enableOutlineWorkspace: false,
  enableCalculationWorkspace: false,
  enableCodeWorkspace: false,
  captureCodeRunHistory: false,
  requireAiSourceDeclaration: false,
  allowStudentDevelopmentReview: true,
  createdAt: new Date().toISOString(),
};

function baseSubmission(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub-1",
    examId: "exam-1",
    studentId: "student-1",
    status: "IN_PROGRESS",
    currentQuestionIndex: 0,
    questionOrderJson: null,
    answerProvenancePolicySnapshotJson: basicPolicySnapshot,
    exam: {
      id: "exam-1",
      createdById: "lecturer-1",
      institutionId: "inst-1",
      secureSettings: {},
      questions: [{ id: "q-1", order: 0 }],
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/submissions/[id]/answer-development/checkpoint", () => {
  it("rejects an unauthenticated request", async () => {
    mockAuth.mockResolvedValue(null);
    const { POST } = await import("@/app/api/submissions/[id]/answer-development/checkpoint/route");
    const res = await POST(
      new Request("http://x", { method: "POST", body: JSON.stringify({ questionId: "q-1", response: "hi", source: "AUTOSAVE" }) }),
      { params: Promise.resolve({ id: "sub-1" }) },
    );
    expect(res.status).toBe(401);
  });

  it("rejects another student's submission (404, never distinguishable from not-found)", async () => {
    mockAuth.mockResolvedValue(studentSession("student-2"));
    mockPrisma.submission.findUnique.mockResolvedValue(baseSubmission());
    const { POST } = await import("@/app/api/submissions/[id]/answer-development/checkpoint/route");
    const res = await POST(
      new Request("http://x", { method: "POST", body: JSON.stringify({ questionId: "q-1", response: "hi", source: "AUTOSAVE" }) }),
      { params: Promise.resolve({ id: "sub-1" }) },
    );
    expect(res.status).toBe(404);
  });

  it("rejects when the submission is no longer IN_PROGRESS", async () => {
    mockAuth.mockResolvedValue(studentSession("student-1"));
    mockPrisma.submission.findUnique.mockResolvedValue(baseSubmission({ status: "SUBMITTED" }));
    const { POST } = await import("@/app/api/submissions/[id]/answer-development/checkpoint/route");
    const res = await POST(
      new Request("http://x", { method: "POST", body: JSON.stringify({ questionId: "q-1", response: "hi", source: "AUTOSAVE" }) }),
      { params: Promise.resolve({ id: "sub-1" }) },
    );
    expect(res.status).toBe(409);
  });

  it("rejects when provenance policy is OFF for this attempt", async () => {
    mockAuth.mockResolvedValue(studentSession("student-1"));
    mockPrisma.submission.findUnique.mockResolvedValue(baseSubmission({ answerProvenancePolicySnapshotJson: null }));
    const { POST } = await import("@/app/api/submissions/[id]/answer-development/checkpoint/route");
    const res = await POST(
      new Request("http://x", { method: "POST", body: JSON.stringify({ questionId: "q-1", response: "hi", source: "AUTOSAVE" }) }),
      { params: Promise.resolve({ id: "sub-1" }) },
    );
    expect(res.status).toBe(403);
  });

  it("rejects a question that is not part of the submission's effective question set", async () => {
    mockAuth.mockResolvedValue(studentSession("student-1"));
    mockPrisma.submission.findUnique.mockResolvedValue(baseSubmission());
    const { POST } = await import("@/app/api/submissions/[id]/answer-development/checkpoint/route");
    const res = await POST(
      new Request("http://x", { method: "POST", body: JSON.stringify({ questionId: "not-in-exam", response: "hi", source: "AUTOSAVE" }) }),
      { params: Promise.resolve({ id: "sub-1" }) },
    );
    expect(res.status).toBe(404);
  });

  it("rejects a payload over the checkpoint response text limit", async () => {
    mockAuth.mockResolvedValue(studentSession("student-1"));
    const { POST } = await import("@/app/api/submissions/[id]/answer-development/checkpoint/route");
    const res = await POST(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({ questionId: "q-1", response: "x".repeat(50_001), source: "AUTOSAVE" }),
      }),
      { params: Promise.resolve({ id: "sub-1" }) },
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/submissions/[id]/answer-development (student self-review)", () => {
  it("rejects an unauthenticated request", async () => {
    mockAuth.mockResolvedValue(null);
    const { GET } = await import("@/app/api/submissions/[id]/answer-development/route");
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: "sub-1" }) });
    expect(res.status).toBe(401);
  });

  it("rejects another student's submission", async () => {
    mockAuth.mockResolvedValue(studentSession("student-2"));
    mockPrisma.submission.findUnique.mockResolvedValue({ studentId: "student-1", answerProvenancePolicySnapshotJson: basicPolicySnapshot });
    const { GET } = await import("@/app/api/submissions/[id]/answer-development/route");
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: "sub-1" }) });
    expect(res.status).toBe(404);
  });

  it("rejects when provenance is OFF", async () => {
    mockAuth.mockResolvedValue(studentSession("student-1"));
    mockPrisma.submission.findUnique.mockResolvedValue({ studentId: "student-1", answerProvenancePolicySnapshotJson: null });
    const { GET } = await import("@/app/api/submissions/[id]/answer-development/route");
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: "sub-1" }) });
    expect(res.status).toBe(403);
  });

  it("rejects when student self-review is disabled by policy", async () => {
    mockAuth.mockResolvedValue(studentSession("student-1"));
    mockPrisma.submission.findUnique.mockResolvedValue({
      studentId: "student-1",
      answerProvenancePolicySnapshotJson: { ...basicPolicySnapshot, allowStudentDevelopmentReview: false },
    });
    const { GET } = await import("@/app/api/submissions/[id]/answer-development/route");
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: "sub-1" }) });
    expect(res.status).toBe(403);
  });
});

describe("PUT /api/submissions/[id]/answer-development/artifacts/[artifactType]", () => {
  it("rejects an invalid artifact type", async () => {
    mockAuth.mockResolvedValue(studentSession("student-1"));
    const { PUT } = await import("@/app/api/submissions/[id]/answer-development/artifacts/[artifactType]/route");
    const res = await PUT(new Request("http://x", { method: "PUT", body: JSON.stringify({ content: "hi" }) }), {
      params: Promise.resolve({ id: "sub-1", artifactType: "NOT_A_TYPE" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects when the specific workspace is not lecturer-enabled", async () => {
    mockAuth.mockResolvedValue(studentSession("student-1"));
    mockPrisma.submission.findUnique.mockResolvedValue(baseSubmission()); // enableOutlineWorkspace: false
    const { PUT } = await import("@/app/api/submissions/[id]/answer-development/artifacts/[artifactType]/route");
    const res = await PUT(
      new Request("http://x", { method: "PUT", body: JSON.stringify({ content: "hi", questionId: "q-1" }) }),
      { params: Promise.resolve({ id: "sub-1", artifactType: "OUTLINE" }) },
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /api/submissions/[id]/answer-development/code-run", () => {
  it("rejects when the code workspace is not enabled, and never claims to execute code", async () => {
    mockAuth.mockResolvedValue(studentSession("student-1"));
    mockPrisma.submission.findUnique.mockResolvedValue(baseSubmission());
    const { POST } = await import("@/app/api/submissions/[id]/answer-development/code-run/route");
    const res = await POST(
      new Request("http://x", { method: "POST", body: JSON.stringify({ questionId: "q-1", code: "print(1)" }) }),
      { params: Promise.resolve({ id: "sub-1" }) },
    );
    expect(res.status).toBe(403);
  });
});

describe("GET /api/lecturer/submissions/[id]/answer-development", () => {
  it("rejects an unauthenticated request", async () => {
    mockAuth.mockResolvedValue(null);
    const { GET } = await import("@/app/api/lecturer/submissions/[id]/answer-development/route");
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: "sub-1" }) });
    expect(res.status).toBe(401);
  });

  it("rejects a lecturer who does not own the exam (404, never confirms existence)", async () => {
    mockAuth.mockResolvedValue(lecturerSession("lecturer-2", "inst-1"));
    mockPrisma.submission.findUnique.mockResolvedValue(baseSubmission());
    const { GET } = await import("@/app/api/lecturer/submissions/[id]/answer-development/route");
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: "sub-1" }) });
    expect(res.status).toBe(404);
  });

  it("rejects a lecturer from a different institution (owner check passes but institution does not)", async () => {
    mockAuth.mockResolvedValue(lecturerSession("lecturer-1", "inst-2"));
    mockPrisma.submission.findUnique.mockResolvedValue(baseSubmission());
    const { GET } = await import("@/app/api/lecturer/submissions/[id]/answer-development/route");
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: "sub-1" }) });
    expect(res.status).toBe(403);
  });

  it("reports enabled:false without exposing internals when provenance was OFF for this attempt", async () => {
    mockAuth.mockResolvedValue(lecturerSession("lecturer-1", "inst-1"));
    mockPrisma.submission.findUnique
      .mockResolvedValueOnce(baseSubmission({ answerProvenancePolicySnapshotJson: null }))
      .mockResolvedValueOnce({ answerProvenancePolicySnapshotJson: null });
    const { GET } = await import("@/app/api/lecturer/submissions/[id]/answer-development/route");
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: "sub-1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(false);
  });
});
