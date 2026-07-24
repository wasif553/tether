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
import { Prisma } from "@/generated/prisma/client";

const mockAuth = vi.hoisted(() => vi.fn());
vi.mock("@/auth", () => ({ auth: mockAuth }));

const mockPrisma = vi.hoisted(() => {
  const m = {
    submission: { findUnique: vi.fn(), update: vi.fn() },
    answer: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), create: vi.fn(), upsert: vi.fn() },
    answerDevelopmentVersion: { findUnique: vi.fn(), findFirst: vi.fn(), count: vi.fn(), create: vi.fn() },
    answerDevelopmentEvent: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), findMany: vi.fn() },
    answerDevelopmentArtifact: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), findFirstOrThrow: vi.fn() },
    answerDevelopmentArtifactVersion: { create: vi.fn() },
    integrityEvent: { create: vi.fn().mockResolvedValue({ id: "evt-1" }) },
    networkEvidence: { findFirst: vi.fn().mockResolvedValue(null) },
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    // A callback-form $transaction just invokes the callback with this
    // same mock object as `tx` (every model above is available on both);
    // an array-form $transaction resolves every entry — mirrors how real
    // Prisma supports both call shapes closely enough for control-flow
    // testing (not a substitute for real Postgres atomicity, which the
    // migration's actual transaction/lock semantics provide once applied).
    $transaction: vi.fn(async (arg: unknown) => {
      if (typeof arg === "function") return (arg as (tx: unknown) => unknown)(m);
      return Promise.all(arg as Promise<unknown>[]);
    }),
  };
  return m;
});
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

// ---------------------------------------------------------------------------
// POST /api/submissions/[id]/submit — hardening (Part 1): final provenance
// is now AWAITED and runs inside the SAME transaction as grading and the
// submission-status update. These tests verify the CONTROL-FLOW guarantee
// a mocked Prisma client can meaningfully prove: the route never returns a
// success response while provenance writes are pending or failed, and a
// failure surfaces as an error rather than a silently-incomplete success.
// The actual ATOMIC ROLLBACK guarantee (that a real Postgres transaction
// undoes the grading/status writes too) is provided by Postgres itself
// once the migration is applied — a mock can't simulate real transaction
// rollback, only that the application never treats a failed attempt as
// successful and that a subsequent attempt is not blocked by it.
// ---------------------------------------------------------------------------
describe("POST /api/submissions/[id]/submit (Answer-Development Provenance hardening)", () => {
  function submitSubmission(overrides: Record<string, unknown> = {}) {
    return {
      id: "sub-1",
      examId: "exam-1",
      studentId: "student-1",
      status: "IN_PROGRESS",
      startedAt: new Date(),
      attemptNumber: 1,
      questionOrderJson: null,
      answerProvenancePolicySnapshotJson: basicPolicySnapshot,
      exam: {
        id: "exam-1",
        institutionId: "inst-1",
        durationMins: 60,
        marksReleasedAt: null,
        secureSettings: {},
        questions: [{ id: "q-1", type: "SHORT_ANSWER", correctAnswer: null, points: 1, order: 0 }],
      },
      ...overrides,
    };
  }

  function wireHappyPathMocks(finalAnswerText: string) {
    // Both the outer read and the fresh in-transaction status re-check
    // resolve to the same IN_PROGRESS submission.
    mockPrisma.submission.findUnique.mockResolvedValue(submitSubmission());
    mockPrisma.answer.findMany.mockResolvedValue([{ id: "ans-1", questionId: "q-1", response: finalAnswerText }]);
    mockPrisma.answer.update.mockResolvedValue({ id: "ans-1", questionId: "q-1", response: finalAnswerText });
    mockPrisma.submission.update.mockResolvedValue({
      id: "sub-1",
      status: "GRADED",
      submittedAt: new Date(),
      attemptNumber: 1,
      totalScore: 0,
    });
    mockPrisma.answerDevelopmentVersion.findUnique.mockResolvedValue(null);
    mockPrisma.answerDevelopmentVersion.findFirst.mockResolvedValue(null);
    mockPrisma.answer.upsert.mockResolvedValue({ id: "ans-1" });
    mockPrisma.answerDevelopmentVersion.create.mockResolvedValue({ id: "ver-1" });
    mockPrisma.answerDevelopmentEvent.findUnique.mockResolvedValue(null);
    mockPrisma.answerDevelopmentEvent.create.mockResolvedValue({ id: "evt-1" });
  }

  it("duplicate submit is idempotent — an already-finalized submission never enters the transaction", async () => {
    mockAuth.mockResolvedValue(studentSession("student-1"));
    mockPrisma.submission.findUnique.mockResolvedValue(
      submitSubmission({ status: "GRADED", submittedAt: new Date(), totalScore: 5 }),
    );
    const { POST } = await import("@/app/api/submissions/[id]/submit/route");
    const res = await POST(new Request("http://x", { method: "POST", body: "{}" }), { params: Promise.resolve({ id: "sub-1" }) });
    const body = await res.json();
    expect(body.code).toBe("ALREADY_FINALIZED");
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("final provenance is awaited before success, and the final checkpoint matches the authoritative final answer", async () => {
    wireHappyPathMocks("this is the student's final authoritative answer");
    mockAuth.mockResolvedValue(studentSession("student-1"));
    const { POST } = await import("@/app/api/submissions/[id]/submit/route");
    const res = await POST(new Request("http://x", { method: "POST", body: "{}" }), { params: Promise.resolve({ id: "sub-1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("GRADED");

    // The final checkpoint and final event were both created — awaited,
    // not fire-and-forget — before the success response was returned.
    expect(mockPrisma.answerDevelopmentVersion.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.answerDevelopmentEvent.create).toHaveBeenCalledTimes(1);
    const createCall = mockPrisma.answerDevelopmentVersion.create.mock.calls[0][0];
    expect(createCall.data.changeType).toBe("FINAL_SUBMISSION");
    // Matches the FRESH in-transaction answer read, not a stale outer read.
    expect(createCall.data.responseText).toBe("this is the student's final authoritative answer");
  });

  it("a provenance failure never leaves a successful response and grading/status are not treated as finalized", async () => {
    wireHappyPathMocks("draft answer text");
    mockAuth.mockResolvedValue(studentSession("student-1"));
    mockPrisma.answerDevelopmentVersion.create.mockRejectedValueOnce(new Error("simulated provenance failure"));
    const { POST } = await import("@/app/api/submissions/[id]/submit/route");
    const res = await POST(new Request("http://x", { method: "POST", body: "{}" }), { params: Promise.resolve({ id: "sub-1" }) });
    const body = await res.json();
    // Never the success shape — no GRADED/SUBMITTED status is ever returned
    // for a failed transaction.
    expect(body.status).not.toBe("GRADED");
    expect(body.status).not.toBe("SUBMITTED");
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  it("a safe retry after a provenance failure succeeds normally (the prior failed attempt never blocks a fresh one)", async () => {
    wireHappyPathMocks("retry answer text");
    mockAuth.mockResolvedValue(studentSession("student-1"));
    // First attempt fails...
    mockPrisma.answerDevelopmentVersion.create.mockRejectedValueOnce(new Error("simulated provenance failure"));
    const { POST } = await import("@/app/api/submissions/[id]/submit/route");
    const first = await POST(new Request("http://x", { method: "POST", body: "{}" }), { params: Promise.resolve({ id: "sub-1" }) });
    expect((await first.json()).status).not.toBe("GRADED");

    // ...a retry (submission still reports IN_PROGRESS, exactly as a real
    // rolled-back transaction would leave it) succeeds cleanly.
    const second = await POST(new Request("http://x", { method: "POST", body: "{}" }), { params: Promise.resolve({ id: "sub-1" }) });
    expect(second.status).toBe(200);
    expect((await second.json()).status).toBe("GRADED");
  });

  it("FINAL_SUBMISSION checkpoints and FINAL_ANSWER_SUBMITTED events are not duplicated across the one successful call", async () => {
    wireHappyPathMocks("single answer");
    mockAuth.mockResolvedValue(studentSession("student-1"));
    const { POST } = await import("@/app/api/submissions/[id]/submit/route");
    await POST(new Request("http://x", { method: "POST", body: "{}" }), { params: Promise.resolve({ id: "sub-1" }) });
    expect(mockPrisma.answerDevelopmentVersion.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.answerDevelopmentEvent.create).toHaveBeenCalledTimes(1);
  });

  it("provenance OFF behaves exactly as before — no checkpoint/event writes at all", async () => {
    mockAuth.mockResolvedValue(studentSession("student-1"));
    mockPrisma.submission.findUnique.mockResolvedValue(submitSubmission({ answerProvenancePolicySnapshotJson: null }));
    mockPrisma.answer.findMany.mockResolvedValue([{ id: "ans-1", questionId: "q-1", response: "legacy answer" }]);
    mockPrisma.answer.update.mockResolvedValue({ id: "ans-1" });
    mockPrisma.submission.update.mockResolvedValue({
      id: "sub-1",
      status: "GRADED",
      submittedAt: new Date(),
      attemptNumber: 1,
      totalScore: 0,
    });
    const { POST } = await import("@/app/api/submissions/[id]/submit/route");
    const res = await POST(new Request("http://x", { method: "POST", body: "{}" }), { params: Promise.resolve({ id: "sub-1" }) });
    expect(res.status).toBe(200);
    expect(mockPrisma.answerDevelopmentVersion.create).not.toHaveBeenCalled();
    expect(mockPrisma.answerDevelopmentEvent.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// upsertAnswerDevelopmentArtifact — Part 3 hardening: race-safe uniqueness.
// The real guarantee is the database's own partial unique indexes (see
// docs/answer-development-provenance-v1-migration.sql); this simulates the
// race a concurrent duplicate write would hit (a P2002 unique-constraint
// violation on the CREATE branch) and confirms the runner recovers by
// updating the winner's row instead of surfacing a 500 — never relying on
// the application-level `findFirst` pre-check alone.
// ---------------------------------------------------------------------------
describe("upsertAnswerDevelopmentArtifact (Part 3 concurrency hardening)", () => {
  it("recovers from a concurrent duplicate-create race (P2002) by updating the winner's row instead of failing", async () => {
    mockPrisma.answer.upsert.mockResolvedValue({ id: "ans-1" });
    // No existing row visible to the pre-check...
    mockPrisma.answerDevelopmentArtifact.findFirst.mockResolvedValueOnce(null);
    // ...but another concurrent request wins the actual insert.
    mockPrisma.answerDevelopmentArtifact.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`answerId`,`artifactType`)", {
        code: "P2002",
        clientVersion: "7.8.0",
      }),
    );
    // Re-read after the race recognises the winner's row.
    mockPrisma.answerDevelopmentArtifact.findFirstOrThrow.mockResolvedValue({
      id: "artifact-winner",
      version: 1,
      contentHash: "different-hash-than-ours",
    });
    mockPrisma.answerDevelopmentArtifact.update.mockResolvedValue({ id: "artifact-winner", version: 2 });
    mockPrisma.answerDevelopmentArtifactVersion.create.mockResolvedValue({ id: "artifact-version-1" });

    const { upsertAnswerDevelopmentArtifact } = await import("@/lib/answerDevelopmentRunner");
    const outcome = await upsertAnswerDevelopmentArtifact({
      submissionId: "sub-1",
      questionId: "q-1",
      answerId: null,
      artifactType: "OUTLINE",
      content: "my outline",
      clientRequestId: null,
    });

    // Recovered into an update of the winner's row — never a duplicate,
    // never a 500 surfaced to the student.
    expect(outcome.kind).toBe("updated");
    expect(outcome.artifactId).toBe("artifact-winner");
    expect(mockPrisma.answerDevelopmentArtifact.update).toHaveBeenCalledTimes(1);
  });

  it("guarantees a real (non-null) answerId for a per-question artifact before it is ever written — the actual uniqueness discriminator", async () => {
    mockPrisma.answer.upsert.mockResolvedValue({ id: "ans-42" });
    mockPrisma.answerDevelopmentArtifact.findFirst.mockResolvedValueOnce(null);
    mockPrisma.answerDevelopmentArtifact.create.mockResolvedValue({ id: "artifact-1" });
    mockPrisma.answerDevelopmentArtifactVersion.create.mockResolvedValue({ id: "artifact-version-1" });

    const { upsertAnswerDevelopmentArtifact } = await import("@/lib/answerDevelopmentRunner");
    await upsertAnswerDevelopmentArtifact({
      submissionId: "sub-1",
      questionId: "q-1",
      answerId: null,
      artifactType: "CALCULATION_WORKING",
      content: "working",
      clientRequestId: null,
    });

    const createArgs = mockPrisma.answerDevelopmentArtifact.create.mock.calls[0][0];
    expect(createArgs.data.answerId).toBe("ans-42");
    const findFirstWhere = mockPrisma.answerDevelopmentArtifact.findFirst.mock.calls[0][0].where;
    expect(findFirstWhere.answerId).toBe("ans-42");
  });
});
