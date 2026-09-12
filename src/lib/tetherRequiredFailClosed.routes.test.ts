/**
 * Tether-required fail-closed security fix — DB-backed route tests.
 *
 * The defect: a lecturer could configure deliveryMode =
 * TETHER_CLIENT_REQUIRED on an ORDINARY (non-final-examination) exam —
 * e.g. a quiz, practice test, or any manually-configured Tether exam —
 * and resolveEffectiveDeliveryMode() would silently downgrade it to
 * STANDARD_WEB whenever Tether secure-client delivery was unavailable
 * (most notably via the TETHER_CLIENT_REQUIRED_DISABLED emergency kill
 * switch). POST /api/exams/[id]/start would then happily create a brand
 * new Submission with a fully-disabled secureClientPolicySnapshotJson
 * (requireVerifiedClient: false, allowedClientTypes: []), stamp
 * activatedAt immediately, and release exam content over an ordinary
 * browser — with no SecureClientEvent/session ever created. This was
 * physically confirmed against a real exam.
 *
 * finalExaminationPolicy.routes.test.ts already covers the equivalent
 * fail-closed behaviour for assessmentType === FINAL_EXAMINATION (test
 * #11) via isFinalExaminationPolicyEstablished — but that gate is a
 * no-op for every OTHER assessment type, which is exactly the gap this
 * exam class fell through. These tests cover the general case: ANY exam
 * with the RAW, lecturer-configured deliveryMode === TETHER_CLIENT_REQUIRED,
 * regardless of assessmentType, via the new
 * isTetherRequiredDeliveryUnavailable() gate in
 * POST /api/exams/[id]/start (see secureClientPolicy.ts's own doc comment
 * on that function for the full root-cause writeup).
 *
 * Same DB-backed pattern as finalExaminationPolicy.routes.test.ts — run
 * ONLY via `npm run release:validate` (a disposable, local-only Postgres
 * container). src/lib/prisma.ts's test-time safety guard refuses to run
 * against the shared Preview/Production Supabase project.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const examRoute = await import("../app/api/exams/[id]/route");
const startRoute = await import("../app/api/exams/[id]/start/route");

function sessionFor(userId: string, role: "LECTURER" | "STUDENT", institutionId: string) {
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
const cleanup = { users: [] as string[], exams: [] as string[] };

let instId: string;
let lecturer: { id: string };
let student: { id: string };

beforeAll(async () => {
  const inst = await getOrCreateTestInstitution(`tether-required-fail-closed-${stamp}`);
  instId = inst.id;
  const passwordHash = await bcrypt.hash("test-password", 4);
  lecturer = await prisma.user.create({
    data: { name: "Fail-Closed Lecturer", email: `fc-lect-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instId },
  });
  student = await prisma.user.create({
    data: { name: "Fail-Closed Student", email: `fc-stud-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instId },
  });
  cleanup.users.push(lecturer.id, student.id);
});

afterAll(async () => {
  await prisma.secureClientSession.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.submission.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.exam.deleteMany({ where: { id: { in: cleanup.exams } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanup.users } } });
});

async function createExam(title: string) {
  const exam = await prisma.exam.create({
    data: { title: `${title} ${stamp}-${Math.random()}`, durationMins: 30, createdById: lecturer.id, institutionId: instId, published: false },
  });
  cleanup.exams.push(exam.id);
  return exam;
}

/** A lecturer manually configuring TETHER_CLIENT_REQUIRED on an ORDINARY (non-final) exam — the exact class of exam the original defect affected. */
async function createTetherRequiredQuiz(title: string) {
  const exam = await createExam(title);
  mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
  await examRoute.PATCH(
    jsonRequest("PATCH", { secureSettings: { assessmentType: "QUIZ_OR_TEST", deliveryMode: "TETHER_CLIENT_REQUIRED" }, published: true }),
    { params: Promise.resolve({ id: exam.id }) },
  );
  return exam;
}

describe("POST /api/exams/[id]/start — Tether-required fail-closed (any assessment type)", () => {
  it("A. TETHER_CLIENT_REQUIRED + available: remains TETHER_CLIENT_REQUIRED and the secure flow proceeds normally", async () => {
    const exam = await createTetherRequiredQuiz("available-proceeds");
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const res = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.secureClientLaunch).toMatchObject({ required: true, kind: "REDIRECT_TO_TETHER_LAUNCH" });

    const stored = await prisma.submission.findUniqueOrThrow({ where: { id: body.id } });
    const snapshot = stored.secureClientPolicySnapshotJson as { deliveryMode: string; requireVerifiedClient: boolean; allowedClientTypes: string[] };
    expect(snapshot.deliveryMode).toBe("TETHER_CLIENT_REQUIRED");
    expect(snapshot.requireVerifiedClient).toBe(true);
    expect(snapshot.allowedClientTypes).toEqual(["TETHER_SECURE_CLIENT"]);
    expect(stored.activatedAt).toBeNull(); // PREPARING — requires native activation, exactly as intended.
  });

  it("B. TETHER_CLIENT_REQUIRED + unavailable: start is rejected, no STANDARD_WEB fallback, no content, no insecure activation", async () => {
    const exam = await createTetherRequiredQuiz("unavailable-rejected");
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    vi.stubEnv("TETHER_CLIENT_REQUIRED_DISABLED", "true");
    try {
      const res = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe("TETHER_REQUIRED_UNAVAILABLE");
      expect(body.error).toBe(
        "This examination requires Tether Secure Browser, but secure delivery is temporarily unavailable. Your examination has not started.",
      );

      // No submission was created at all — never mind one with a
      // downgraded STANDARD_WEB snapshot. No content, no activatedAt, no
      // insecure attempt of any kind exists for this student/exam.
      const count = await prisma.submission.count({ where: { examId: exam.id, studentId: student.id } });
      expect(count).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("C. STANDARD_WEB exam continues to work normally even while Tether is unavailable (kill switch never affects unrelated exams)", async () => {
    const exam = await createExam("standard-web-unaffected");
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    await examRoute.PATCH(
      jsonRequest("PATCH", { secureSettings: { assessmentType: "QUIZ_OR_TEST", deliveryMode: "STANDARD_WEB" }, published: true }),
      { params: Promise.resolve({ id: exam.id }) },
    );
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    vi.stubEnv("TETHER_CLIENT_REQUIRED_DISABLED", "true");
    try {
      const res = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.secureClientLaunch).toEqual({ required: false });
      const stored = await prisma.submission.findUniqueOrThrow({ where: { id: body.id } });
      expect(stored.activatedAt).not.toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("D. a rejected start attempt never mutates the exam's own configured secure settings", async () => {
    const exam = await createTetherRequiredQuiz("settings-not-mutated");
    const before = await prisma.exam.findUniqueOrThrow({ where: { id: exam.id } });
    const beforeSettings = before.secureSettings;

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    vi.stubEnv("TETHER_CLIENT_REQUIRED_DISABLED", "true");
    try {
      const res = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
      expect(res.status).toBe(409);
    } finally {
      vi.unstubAllEnvs();
    }

    const after = await prisma.exam.findUniqueOrThrow({ where: { id: exam.id } });
    expect(after.secureSettings).toEqual(beforeSettings);
    expect((after.secureSettings as { deliveryMode?: string } | null)?.deliveryMode).toBe("TETHER_CLIENT_REQUIRED");
  });

  it("E. repeated start attempts while unavailable remain safe — every retry fails closed identically, never creating or resuming an insecure attempt", async () => {
    const exam = await createTetherRequiredQuiz("repeated-attempts-safe");
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    vi.stubEnv("TETHER_CLIENT_REQUIRED_DISABLED", "true");
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.code).toBe("TETHER_REQUIRED_UNAVAILABLE");
      }
      const count = await prisma.submission.count({ where: { examId: exam.id, studentId: student.id } });
      expect(count).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }

    // Once availability is restored, the very next attempt succeeds
    // normally — proves the fail-closed gate has no lingering state of
    // its own that could either wrongly persist or wrongly reset.
    const res = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(201);
    const count = await prisma.submission.count({ where: { examId: exam.id, studentId: student.id } });
    expect(count).toBe(1);
  });

  it("an already-in-progress Tether-required attempt (created while available) may still be resumed normally even if availability later flips off mid-exam", async () => {
    const exam = await createTetherRequiredQuiz("in-progress-resume-unaffected");
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const firstRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(firstRes.status).toBe(201);
    const submissionId = (await firstRes.json()).id as string;

    vi.stubEnv("TETHER_CLIENT_REQUIRED_DISABLED", "true");
    try {
      const resumeRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
      expect(resumeRes.status).toBe(200);
      const resumeBody = await resumeRes.json();
      expect(resumeBody.id).toBe(submissionId);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("the student-facing error surfaced by /start is exactly the required copy, ready for the existing generic body.error display on both the join and Tether-launch pages", async () => {
    const exam = await createTetherRequiredQuiz("student-facing-copy");
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    vi.stubEnv("TETHER_CLIENT_REQUIRED_DISABLED", "true");
    try {
      const res = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
      const body = await res.json();
      // Both src/app/student/exams/join/[examId]/page.tsx and
      // src/app/student/exams/[id]/tether-launch/page.tsx already do
      // `typeof body?.error === "string" ? body.error : "Failed to start exam."`
      // generically for any non-ok /start response — asserting the exact
      // string here is what guarantees that existing display shows the
      // required copy with zero client-side changes.
      expect(typeof body.error).toBe("string");
      expect(body.error).toBe(
        "This examination requires Tether Secure Browser, but secure delivery is temporarily unavailable. Your examination has not started.",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
