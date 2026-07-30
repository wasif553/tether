/**
 * Tether System Check and Exam Readiness v1 — DB-backed route tests. See
 * docs/tether-system-check-v1.md.
 *
 * Same established pattern as finalExaminationPolicy.routes.test.ts: real
 * route handlers imported directly, run against a real local test
 * Postgres. Pure aggregation/mode logic lives in
 * src/lib/systemCheck/readiness.test.ts with no DB dependency at all.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const examRoute = await import("../app/api/exams/[id]/route");
const startRoute = await import("../app/api/exams/[id]/start/route");
const configRoute = await import("../app/api/tether/system-check/config/route");
const latestRoute = await import("../app/api/tether/system-check/latest/route");
const runsRoute = await import("../app/api/tether/system-check/runs/route");

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
let otherStudent: { id: string };

beforeAll(async () => {
  const inst = await getOrCreateTestInstitution(`tether-system-check-${stamp}`);
  instId = inst.id;
  const passwordHash = await bcrypt.hash("test-password", 4);
  lecturer = await prisma.user.create({
    data: { name: "System Check Lecturer", email: `syscheck-lect-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instId },
  });
  student = await prisma.user.create({
    data: { name: "System Check Student", email: `syscheck-stud-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instId },
  });
  otherStudent = await prisma.user.create({
    data: { name: "Other Student", email: `syscheck-other-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instId },
  });
  cleanup.users.push(lecturer.id, student.id, otherStudent.id);
});

afterAll(async () => {
  await prisma.tetherSystemCheckRun.deleteMany({ where: { userId: { in: cleanup.users } } });
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

async function publishFinalExam(title: string) {
  const exam = await createExam(title);
  mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
  await examRoute.PATCH(jsonRequest("PATCH", { secureSettings: { assessmentType: "FINAL_EXAMINATION" }, published: true }), {
    params: Promise.resolve({ id: exam.id }),
  });
  return exam;
}

const fullTetherResults = {
  sourceClientType: "TETHER_SECURE_CLIENT",
  clientVersion: "1.3.0",
  operatingSystem: "win32",
  operatingSystemVersion: "10.0.19045",
  secureClientSessionId: null as string | null,
  clientTimeMs: Date.now(),
  displayTopologyClassification: "INTERNAL_ONLY",
  bridgeCapabilities: { getClientVersion: true, getOperatingSystemInfo: true, getDisplayTopology: true, getSecureClientCapabilities: true },
  results: {
    network: { status: "PASS" },
    camera: { status: "PASS" },
    microphone: { status: "PASS" },
  },
};

describe("GET /api/tether/system-check/config", () => {
  it("defaults to WARN mode when TETHER_SYSTEM_CHECK_MODE is unset — missing config must never accidentally block all students", async () => {
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    vi.stubEnv("TETHER_SYSTEM_CHECK_MODE", "");
    try {
      const res = await configRoute.GET();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.mode).toBe("WARN");
      expect(typeof body.minimumSupportedVersion).toBe("string");
      expect(typeof body.serverTimeMs).toBe("number");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects an unauthenticated request", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await configRoute.GET();
    expect(res.status).toBe(401);
  });
});

describe("GET /api/tether/system-check/latest", () => {
  it("returns null when the student has never run a check", async () => {
    mockAuth.mockResolvedValue(sessionFor(otherStudent.id, "STUDENT", instId));
    const res = await latestRoute.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.run).toBe(null);
  });
});

describe("POST /api/tether/system-check/runs", () => {
  it("11. a malformed payload is rejected", async () => {
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const res = await runsRoute.POST(jsonRequest("POST", { sourceClientType: "NOT_A_REAL_TYPE" }));
    expect(res.status).toBe(400);
  });

  it("rejects a results payload with an unknown check id", async () => {
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const res = await runsRoute.POST(
      jsonRequest("POST", { ...fullTetherResults, results: { ...fullTetherResults.results, notARealCheck: { status: "PASS" } } }),
    );
    expect(res.status).toBe(400);
  });

  it("9. a fabricated secure-client session id is rejected", async () => {
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const res = await runsRoute.POST(jsonRequest("POST", { ...fullTetherResults, secureClientSessionId: "does-not-exist" }));
    expect(res.status).toBe(404);
  });

  it("10. another student's secure-client session is rejected, even though it genuinely exists", async () => {
    const exam = await publishFinalExam("foreign-session-rejected");
    const foreignSession = await prisma.secureClientSession.create({
      data: {
        institutionId: instId,
        examId: exam.id,
        submissionId: (await prisma.submission.create({
          data: { examId: exam.id, studentId: otherStudent.id, attemptNumber: 1 },
        })).id,
        studentId: otherStudent.id,
        clientType: "TETHER_SECURE_CLIENT",
        status: "ACTIVE",
        verificationStatus: "VERIFIED",
      },
    });

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const res = await runsRoute.POST(jsonRequest("POST", { ...fullTetherResults, secureClientSessionId: foreignSession.id }));
    expect(res.status).toBe(404);
  });

  it("7/8. an ordinary browser can never achieve READY, and a verified Tether session (all checks reported) achieves READY", async () => {
    // Ordinary browser — every Tether-only check is forced NOT_CHECKED
    // server-side regardless of what the payload claims.
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const browserRes = await runsRoute.POST(
      jsonRequest("POST", { ...fullTetherResults, sourceClientType: "BROWSER", secureClientSessionId: null }),
    );
    expect(browserRes.status).toBe(200);
    const browserBody = await browserRes.json();
    expect(browserBody.run.overallStatus).toBe("NOT_READY");
    expect(browserBody.run.results.secureClient.status).toBe("NOT_CHECKED");
    expect(browserBody.run.results.displayTopology.status).toBe("NOT_CHECKED");
    expect(browserBody.run.results.bridge.status).toBe("NOT_CHECKED");

    // Verified Tether session — genuine PASS on secureClient, all other
    // required checks PASS from real reported/derived data -> READY. A
    // dedicated student avoids both the rate limiter (student already
    // has a fresh run from browserRes above) and needing to re-mock
    // auth after publishFinalExam switches the session to the lecturer.
    const readyStudentForTest8 = await prisma.user.create({
      data: { name: "Ready For READY", email: `syscheck-ready8-${stamp}@test.local`, passwordHash: await bcrypt.hash("x", 4), role: "STUDENT", institutionId: instId },
    });
    cleanup.users.push(readyStudentForTest8.id);
    const exam = await publishFinalExam("verified-session-ready");
    const submission = await prisma.submission.create({ data: { examId: exam.id, studentId: readyStudentForTest8.id, attemptNumber: 1 } });
    const session = await prisma.secureClientSession.create({
      data: {
        institutionId: instId,
        examId: exam.id,
        submissionId: submission.id,
        studentId: readyStudentForTest8.id,
        clientType: "TETHER_SECURE_CLIENT",
        status: "ACTIVE",
        verificationStatus: "VERIFIED",
      },
    });
    mockAuth.mockResolvedValue(sessionFor(readyStudentForTest8.id, "STUDENT", instId));
    const readyRes = await runsRoute.POST(jsonRequest("POST", { ...fullTetherResults, secureClientSessionId: session.id, clientTimeMs: Date.now() }));
    expect(readyRes.status).toBe(200);
    const readyBody = await readyRes.json();
    expect(readyBody.run.results.secureClient).toEqual({ status: "PASS", reasonCode: "SESSION_VERIFIED" });
    expect(readyBody.run.overallStatus).toBe("READY");
  });

  it("16. running a system check never creates a Submission", async () => {
    mockAuth.mockResolvedValue(sessionFor(otherStudent.id, "STUDENT", instId));
    const before = await prisma.submission.count({ where: { studentId: otherStudent.id } });
    await runsRoute.POST(jsonRequest("POST", { ...fullTetherResults, sourceClientType: "BROWSER", secureClientSessionId: null, clientTimeMs: Date.now() }));
    const after = await prisma.submission.count({ where: { studentId: otherStudent.id } });
    expect(after).toBe(before);
  });

  it("17. running a system check never creates an IntegrityEvent", async () => {
    mockAuth.mockResolvedValue(sessionFor(otherStudent.id, "STUDENT", instId));
    const before = await prisma.integrityEvent.count({ where: { studentId: otherStudent.id } });
    await runsRoute.POST(jsonRequest("POST", { ...fullTetherResults, sourceClientType: "BROWSER", secureClientSessionId: null, clientTimeMs: Date.now() + 100 }));
    const after = await prisma.integrityEvent.count({ where: { studentId: otherStudent.id } });
    expect(after).toBe(before);
  });

  it("an out-of-support client version is BLOCKED, not READY", async () => {
    // A dedicated student — avoids the rate limiter tripping from an
    // earlier test's run for a shared user.
    const versionTestStudent = await prisma.user.create({
      data: { name: "Version Test Student", email: `syscheck-version-${stamp}@test.local`, passwordHash: await bcrypt.hash("x", 4), role: "STUDENT", institutionId: instId },
    });
    cleanup.users.push(versionTestStudent.id);
    mockAuth.mockResolvedValue(sessionFor(versionTestStudent.id, "STUDENT", instId));
    vi.stubEnv("TETHER_MINIMUM_SUPPORTED_VERSION", "9.9.9");
    try {
      const res = await runsRoute.POST(jsonRequest("POST", { ...fullTetherResults, secureClientSessionId: null, clientVersion: "1.3.0" }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.run.results.clientVersion.status).toBe("BLOCKED");
      expect(body.run.overallStatus).toBe("NOT_READY");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("18/19. final examination WARN and REQUIRE flows", () => {
  it("18. WARN mode never blocks starting a final examination, even with no stored system check", async () => {
    const exam = await publishFinalExam("warn-mode-never-blocks");
    mockAuth.mockResolvedValue(sessionFor(otherStudent.id, "STUDENT", instId));
    vi.stubEnv("TETHER_SYSTEM_CHECK_MODE", "WARN");
    try {
      const res = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
      expect(res.status).toBe(201);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("19. REQUIRE mode blocks starting a final examination with no current system check, and allows it once a READY one exists", async () => {
    const exam = await publishFinalExam("require-mode-blocks-then-allows");
    // A fresh student with no prior TetherSystemCheckRun row at all.
    const freshStudent = await prisma.user.create({
      data: { name: "Fresh Student", email: `syscheck-fresh-${stamp}@test.local`, passwordHash: await bcrypt.hash("x", 4), role: "STUDENT", institutionId: instId },
    });
    cleanup.users.push(freshStudent.id);

    mockAuth.mockResolvedValue(sessionFor(freshStudent.id, "STUDENT", instId));
    vi.stubEnv("TETHER_SYSTEM_CHECK_MODE", "REQUIRE");
    try {
      const blockedRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
      expect(blockedRes.status).toBe(409);
      const blockedBody = await blockedRes.json();
      expect(blockedBody.code).toBe("SYSTEM_CHECK_REQUIRED");
      const submissionCount = await prisma.submission.count({ where: { examId: exam.id, studentId: freshStudent.id } });
      expect(submissionCount).toBe(0);

      // A READY run for this student, established via a verified session
      // on an unrelated exam (system-check records are per-user, not
      // per-exam) — then REQUIRE mode allows starting THIS final exam.
      // publishFinalExam mocks the LECTURER session internally to author
      // the PATCH — re-mock freshStudent afterwards before any further
      // student-authenticated call.
      const otherExam = await publishFinalExam("require-mode-unrelated-exam");
      mockAuth.mockResolvedValue(sessionFor(freshStudent.id, "STUDENT", instId));
      const otherSubmission = await prisma.submission.create({ data: { examId: otherExam.id, studentId: freshStudent.id, attemptNumber: 1 } });
      const otherSession = await prisma.secureClientSession.create({
        data: {
          institutionId: instId,
          examId: otherExam.id,
          submissionId: otherSubmission.id,
          studentId: freshStudent.id,
          clientType: "TETHER_SECURE_CLIENT",
          status: "ACTIVE",
          verificationStatus: "VERIFIED",
        },
      });
      const readyRunRes = await runsRoute.POST(jsonRequest("POST", { ...fullTetherResults, secureClientSessionId: otherSession.id, clientTimeMs: Date.now() }));
      expect(readyRunRes.status).toBe(200);

      mockAuth.mockResolvedValue(sessionFor(freshStudent.id, "STUDENT", instId));
      const allowedRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
      expect(allowedRes.status).toBe(201);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("20. a stored READY system check never weakens or bypasses the existing fail-closed Tether-availability kill switch", async () => {
    const exam = await publishFinalExam("kill-switch-still-fail-closed");
    const readyStudent = await prisma.user.create({
      data: { name: "Ready Student", email: `syscheck-readystud-${stamp}@test.local`, passwordHash: await bcrypt.hash("x", 4), role: "STUDENT", institutionId: instId },
    });
    cleanup.users.push(readyStudent.id);

    // publishFinalExam mocks the LECTURER session internally to author
    // the PATCH — re-mock readyStudent afterwards before any further
    // student-authenticated call.
    const otherExam = await publishFinalExam("kill-switch-unrelated-exam-for-ready-record");
    mockAuth.mockResolvedValue(sessionFor(readyStudent.id, "STUDENT", instId));
    const otherSubmission = await prisma.submission.create({ data: { examId: otherExam.id, studentId: readyStudent.id, attemptNumber: 1 } });
    const otherSession = await prisma.secureClientSession.create({
      data: {
        institutionId: instId,
        examId: otherExam.id,
        submissionId: otherSubmission.id,
        studentId: readyStudent.id,
        clientType: "TETHER_SECURE_CLIENT",
        status: "ACTIVE",
        verificationStatus: "VERIFIED",
      },
    });
    const readyRunRes = await runsRoute.POST(jsonRequest("POST", { ...fullTetherResults, secureClientSessionId: otherSession.id, clientTimeMs: Date.now() }));
    expect(readyRunRes.status).toBe(200);

    vi.stubEnv("TETHER_SYSTEM_CHECK_MODE", "REQUIRE");
    vi.stubEnv("TETHER_CLIENT_REQUIRED_DISABLED", "true");
    try {
      mockAuth.mockResolvedValue(sessionFor(readyStudent.id, "STUDENT", instId));
      const res = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
      // The existing final-exam Tether-availability gate (checked BEFORE
      // the system-check gate in the route) still wins — a READY system
      // check record does not make the kill switch's block go away.
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe("FINAL_EXAMINATION_TETHER_UNAVAILABLE");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("non-final assessments are never unexpectedly blocked by REQUIRE mode", async () => {
    const exam = await createExam("non-final-never-blocked");
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    await examRoute.PATCH(jsonRequest("PATCH", { secureSettings: { assessmentType: "QUIZ_OR_TEST" }, published: true }), {
      params: Promise.resolve({ id: exam.id }),
    });
    const freshStudent = await prisma.user.create({
      data: { name: "Quiz Student", email: `syscheck-quiz-${stamp}@test.local`, passwordHash: await bcrypt.hash("x", 4), role: "STUDENT", institutionId: instId },
    });
    cleanup.users.push(freshStudent.id);
    mockAuth.mockResolvedValue(sessionFor(freshStudent.id, "STUDENT", instId));
    vi.stubEnv("TETHER_SYSTEM_CHECK_MODE", "REQUIRE");
    try {
      const res = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
      expect(res.status).toBe(201);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
