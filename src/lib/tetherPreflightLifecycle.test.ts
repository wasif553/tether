/**
 * Tether v1.7.4 pre-exam readiness — Part 13C/D: the server-side timer
 * and content-exposure gate. See docs/tether-preflight-lifecycle-v1.7.4.md
 * and src/lib/secureClientActivation.ts.
 *
 * Exercises the REAL routes (GET /api/submissions/[id],
 * POST /api/submissions/[id]/activate) against the disposable database —
 * mirrors src/lib/courseEnrolmentExamAssignment.test.ts's established
 * pattern (mock @/auth only, everything else is a real Prisma read/write
 * against the ambient DATABASE_URL, which `npm run release:validate`
 * points at a disposable Postgres instance).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");

const stamp = Date.now();
const cleanupUserIds: string[] = [];
const cleanupExamIds: string[] = [];

function sessionFor(userId: string, institutionId: string) {
  return {
    user: { id: userId, email: "test@test.invalid", name: "Test", role: "STUDENT" as const, institutionId },
    expires: new Date(Date.now() + 86400_000).toISOString(),
  };
}

let institutionId: string;
let studentId: string;

const TETHER_REQUIRED_POLICY = {
  schemaVersion: 1,
  policyVersion: "v1.0",
  deliveryMode: "TETHER_CLIENT_REQUIRED",
  allowedClientTypes: ["TETHER_SECURE_CLIENT"],
  requireVerifiedClient: true,
  heartbeatIntervalSeconds: 30,
  heartbeatGraceSeconds: 90,
  requireDisplayCheck: false,
  maximumDisplays: 1,
  displayPolicy: "UNRESTRICTED",
  requireRemoteSessionCheck: false,
  createdAt: new Date().toISOString(),
};

const STANDARD_WEB_POLICY = { deliveryMode: "STANDARD_WEB" };

beforeAll(async () => {
  const inst = await getOrCreateTestInstitution(`tether-preflight-lifecycle-${stamp}`);
  institutionId = inst.id;
  const passwordHash = await bcrypt.hash("password", 4);
  const student = await prisma.user.create({
    data: { name: "Preflight Test Student", email: `preflight-student-${stamp}@test.invalid`, passwordHash, role: "STUDENT", institutionId },
  });
  studentId = student.id;
  cleanupUserIds.push(student.id);
});

afterAll(async () => {
  await prisma.submission.deleteMany({ where: { studentId: { in: cleanupUserIds } } });
  await prisma.exam.deleteMany({ where: { id: { in: cleanupExamIds } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
});

async function createExam() {
  const exam = await prisma.exam.create({
    data: { title: `Preflight Lifecycle Exam ${stamp}-${Math.random()}`, durationMins: 60, published: true, createdById: studentId, institutionId },
  });
  cleanupExamIds.push(exam.id);
  return exam;
}

describe("v1.7.4 pre-exam readiness — timer/content gate (Part 13C/D)", () => {
  it("[Part C/D] a VERIFIED-but-PREPARING TETHER_CLIENT_REQUIRED submission (activatedAt null) has no accessible content via GET /api/submissions/[id]", async () => {
    const exam = await createExam();
    const submission = await prisma.submission.create({
      data: { examId: exam.id, studentId, secureClientPolicySnapshotJson: TETHER_REQUIRED_POLICY, activatedAt: null },
    });
    // A VERIFIED session alone is deliberately not enough — this is
    // exactly the case the EXAM_NOT_ACTIVATED gate exists for (see
    // src/app/api/submissions/[id]/route.ts: TETHER_SESSION_REQUIRED
    // fires first for "no verified session at all"; EXAM_NOT_ACTIVATED
    // is the NEXT gate, for "verified, but never server-activated").
    await prisma.secureClientSession.create({
      data: {
        institutionId,
        examId: exam.id,
        submissionId: submission.id,
        studentId,
        clientType: "TETHER_SECURE_CLIENT",
        status: "ACTIVE",
        verificationStatus: "VERIFIED",
      },
    });

    mockAuth.mockResolvedValue(sessionFor(studentId, institutionId));
    const { GET } = await import("@/app/api/submissions/[id]/route");
    const res = await GET(new Request(`http://localhost/api/submissions/${submission.id}`), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("EXAM_NOT_ACTIVATED");
    expect(JSON.stringify(body)).not.toMatch(/question|options|text/i);
  });

  it("[Part 4] POST /activate requires a VERIFIED secure-client session — rejects when none exists", async () => {
    const exam = await createExam();
    const submission = await prisma.submission.create({
      data: { examId: exam.id, studentId, secureClientPolicySnapshotJson: TETHER_REQUIRED_POLICY, activatedAt: null },
    });

    mockAuth.mockResolvedValue(sessionFor(studentId, institutionId));
    const { POST } = await import("@/app/api/submissions/[id]/activate/route");
    const res = await POST(new Request(`http://localhost/api/submissions/${submission.id}/activate`, { method: "POST" }), {
      params: Promise.resolve({ id: submission.id }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("SECURE_SESSION_NOT_VERIFIED");

    const unchanged = await prisma.submission.findUnique({ where: { id: submission.id } });
    expect(unchanged?.activatedAt).toBeNull();
  });

  it("[Part C] activation sets activatedAt exactly once, resets startedAt to the activation instant, and unlocks content", async () => {
    const exam = await createExam();
    const submission = await prisma.submission.create({
      data: { examId: exam.id, studentId, secureClientPolicySnapshotJson: TETHER_REQUIRED_POLICY, activatedAt: null },
    });
    const originalStartedAt = submission.startedAt;
    await prisma.secureClientSession.create({
      data: {
        institutionId,
        examId: exam.id,
        submissionId: submission.id,
        studentId,
        clientType: "TETHER_SECURE_CLIENT",
        status: "ACTIVE",
        verificationStatus: "VERIFIED",
      },
    });

    mockAuth.mockResolvedValue(sessionFor(studentId, institutionId));
    const { POST } = await import("@/app/api/submissions/[id]/activate/route");
    const res = await POST(new Request(`http://localhost/api/submissions/${submission.id}/activate`, { method: "POST" }), {
      params: Promise.resolve({ id: submission.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.alreadyActivated).toBe(false);

    const activated = await prisma.submission.findUnique({ where: { id: submission.id } });
    expect(activated?.activatedAt).not.toBeNull();
    // startedAt reset to the activation instant — must no longer equal the
    // original submission-creation timestamp (Part 2: "reset startedAt to
    // the true activation instant so timing analytics remain semantically
    // useful").
    expect(activated?.startedAt.getTime()).not.toBe(originalStartedAt.getTime());
    expect(activated?.startedAt.getTime()).toBe(activated?.activatedAt?.getTime());

    // [Part C] second activation is idempotent — activatedAt never moves.
    const firstActivatedAt = activated!.activatedAt!.getTime();
    await new Promise((r) => setTimeout(r, 5));
    const res2 = await POST(new Request(`http://localhost/api/submissions/${submission.id}/activate`, { method: "POST" }), {
      params: Promise.resolve({ id: submission.id }),
    });
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.alreadyActivated).toBe(true);
    const afterSecondCall = await prisma.submission.findUnique({ where: { id: submission.id } });
    expect(afterSecondCall?.activatedAt?.getTime()).toBe(firstActivatedAt);

    // [Part D] content is now accessible via the real GET route.
    const { GET } = await import("@/app/api/submissions/[id]/route");
    const getRes = await GET(new Request(`http://localhost/api/submissions/${submission.id}`), { params: Promise.resolve({ id: submission.id }) });
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.id).toBe(submission.id);
  });

  it("[Part C legacy] a STANDARD_WEB submission has activatedAt set immediately and content is accessible with no activation call needed", async () => {
    const exam = await createExam();
    const submission = await prisma.submission.create({
      data: { examId: exam.id, studentId, secureClientPolicySnapshotJson: STANDARD_WEB_POLICY, activatedAt: new Date() },
    });
    expect(submission.activatedAt).not.toBeNull();

    mockAuth.mockResolvedValue(sessionFor(studentId, institutionId));
    const { GET } = await import("@/app/api/submissions/[id]/route");
    const res = await GET(new Request(`http://localhost/api/submissions/${submission.id}`), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(200);
  });

  it("[Part D] a gated submission cannot save an answer before activation", async () => {
    const exam = await createExam();
    const question = await prisma.question.create({
      data: { examId: exam.id, type: "SHORT_ANSWER", text: "Q1", points: 1, order: 0 },
    });
    const submission = await prisma.submission.create({
      data: { examId: exam.id, studentId, secureClientPolicySnapshotJson: TETHER_REQUIRED_POLICY, activatedAt: null },
    });

    mockAuth.mockResolvedValue(sessionFor(studentId, institutionId));
    const { PATCH } = await import("@/app/api/submissions/[id]/answers/route");
    const res = await PATCH(
      new Request(`http://localhost/api/submissions/${submission.id}/answers`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId: question.id, response: "an answer" }),
      }),
      { params: Promise.resolve({ id: submission.id }) },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("EXAM_NOT_ACTIVATED");

    const answer = await prisma.answer.findUnique({ where: { submissionId_questionId: { submissionId: submission.id, questionId: question.id } } });
    expect(answer).toBeNull();
  });
});
