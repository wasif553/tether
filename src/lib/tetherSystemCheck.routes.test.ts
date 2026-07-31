/**
 * Tether System Check and Exam Readiness v1 — DB-backed route tests. See
 * docs/tether-system-check-v1.md.
 *
 * Same established pattern as finalExaminationPolicy.routes.test.ts: real
 * route handlers imported directly, run against a real local test
 * Postgres. Pure aggregation/mode logic lives in
 * src/lib/systemCheck/readiness.test.ts with no DB dependency at all.
 *
 * SAFE EXECUTION ONLY: run this file exclusively via
 * `npm run release:validate` — never a direct `npx vitest run` against
 * this repository's committed DATABASE_URL (the shared Preview/
 * Production Supabase project). Enforced by src/lib/prisma.ts's
 * test-time safety guard — see docs/tether-system-check-v1.md, "Safe
 * DB-backed test execution".
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

// Corrective pass — the SYSTEM_CHECK challenge/verify flow reuses the
// real Ed25519 signing key infrastructure (getSigningPrivateKey/
// getSigningPublicKey in secureClientRunner.ts) — same convention as
// secureClientRunner.disposable.test.ts for the real exam-launch
// manifest flow: generate a fresh keypair for this test file. Set
// directly on process.env (NOT via vi.stubEnv) — several other tests in
// this file call vi.unstubAllEnvs() in their own cleanup, which would
// otherwise wipe this out the moment any of them runs, since
// unstubAllEnvs reverts every vitest-tracked stub globally, not just
// the ones a given test itself set.
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
process.env.TETHER_SECURE_CLIENT_SIGNING_PUBLIC_KEY = publicKey.export({ type: "spki", format: "pem" }).toString();
process.env.TETHER_SECURE_CLIENT_SIGNING_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

// Security hardening pass — see docs/tether-system-check-v1.md, "Genuine
// client attestation". A SEPARATE keypair, simulating the embedded
// client-attestation key that only a genuine packaged Tether build
// possesses (apps/lockdown/src/clientAttestationKey.ts). This test file
// plays the role of "genuine Tether" by signing with
// genuineClientPrivateKeyPem below; a "Chrome" scenario is simulated by
// NOT having this key at all (generating an unrelated one, or omitting
// clientAttestation entirely).
const { publicKey: genuineClientPublicKey, privateKey: genuineClientPrivateKey } = crypto.generateKeyPairSync("ed25519");
const genuineClientPrivateKeyPem = genuineClientPrivateKey.export({ type: "pkcs8", format: "pem" }).toString();
process.env.TETHER_CLIENT_ATTESTATION_PUBLIC_KEY = genuineClientPublicKey.export({ type: "spki", format: "pem" }).toString();

function buildAttestationCanonicalString(params: { nonce: string; clientVersion: string; platform: string; displayTopologyClassification: string }): string {
  return ["SYSTEM_CHECK_ATTESTATION_V1", params.nonce, params.clientVersion, params.platform, params.displayTopologyClassification].join("|");
}

/** Simulates the Electron main process signing with a given private key — genuinePrivateKeyPem for "real Tether", any other/garbage key for "Chrome pretending". */
function signAttestation(
  facts: { nonce: string; clientVersion: string; platform: string; displayTopologyClassification: string },
  privateKeyPem: string,
) {
  const canonicalString = buildAttestationCanonicalString(facts);
  const signature = crypto.sign(null, Buffer.from(canonicalString, "utf8"), privateKeyPem).toString("base64");
  return { ...facts, signature };
}

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const examRoute = await import("../app/api/exams/[id]/route");
const startRoute = await import("../app/api/exams/[id]/start/route");
const submissionRoute = await import("../app/api/submissions/[id]/route");
const configRoute = await import("../app/api/tether/system-check/config/route");
const latestRoute = await import("../app/api/tether/system-check/latest/route");
const runsRoute = await import("../app/api/tether/system-check/runs/route");
const challengeRoute = await import("../app/api/tether/system-check/secure-client/challenge/route");
const verifyRoute = await import("../app/api/tether/system-check/secure-client/verify/route");

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
  await prisma.systemCheckSecureClientVerification.deleteMany({ where: { userId: { in: cleanup.users } } });
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
  clientVersion: "1.4.0",
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

// ---------------------------------------------------------------------------
// Corrective pass — first-time SYSTEM_CHECK secure-client verification.
// See docs/tether-system-check-v1.md, "System-check secure-client
// verification".
// ---------------------------------------------------------------------------

type IssueAndVerifyOptions = {
  clientType?: string;
  signWith?: string;
  facts?: Partial<{ clientVersion: string; platform: string; displayTopologyClassification: string }>;
  omitClientAttestation?: boolean;
  nonceOverride?: string;
};

/**
 * Simulates the full genuine-Tether round trip by default (challenge ->
 * main-process-equivalent signing with genuineClientPrivateKeyPem ->
 * verify). Pass `signWith` a DIFFERENT/random key, or
 * `omitClientAttestation: true`, to simulate an ordinary browser that
 * has a perfectly valid SERVER challenge but no genuine client key.
 */
async function issueAndVerify(userId: string, institutionId: string, options: IssueAndVerifyOptions = {}) {
  mockAuth.mockResolvedValue(sessionFor(userId, "STUDENT", institutionId));
  const challengeRes = await challengeRoute.POST();
  expect(challengeRes.status).toBe(200);
  const { challenge, signature } = await challengeRes.json();

  const facts = {
    clientVersion: options.facts?.clientVersion ?? "1.4.0",
    platform: options.facts?.platform ?? "win32",
    displayTopologyClassification: options.facts?.displayTopologyClassification ?? "INTERNAL_ONLY",
  };
  const nonce = options.nonceOverride ?? challenge.nonce;
  const clientAttestation = options.omitClientAttestation ? undefined : signAttestation({ nonce, ...facts }, options.signWith ?? genuineClientPrivateKeyPem);

  const body: Record<string, unknown> = { challenge, signature, clientType: options.clientType ?? "TETHER_SECURE_CLIENT" };
  if (clientAttestation) body.clientAttestation = clientAttestation;

  const verifyRes = await verifyRoute.POST(jsonRequest("POST", body));
  return { challenge, signature, verifyRes };
}

async function freshStudent(label: string) {
  const user = await prisma.user.create({
    data: { name: label, email: `syscheck-${label.toLowerCase().replace(/\s+/g, "-")}-${stamp}@test.local`, passwordHash: await bcrypt.hash("x", 4), role: "STUDENT", institutionId: instId },
  });
  cleanup.users.push(user.id);
  return user;
}

describe("POST /api/tether/system-check/secure-client/challenge + verify — genuine client attestation", () => {
  it("5/14. valid genuine Tether attestation for SYSTEM_CHECK is accepted, and a first-time student (never taken any exam) reaches READY without creating Submission, Answer, or IntegrityEvent rows", async () => {
    const student = await freshStudent("First Timer");
    const [submissionsBefore, answersBefore, eventsBefore] = await Promise.all([
      prisma.submission.count({ where: { studentId: student.id } }),
      prisma.answer.count(),
      prisma.integrityEvent.count({ where: { studentId: student.id } }),
    ]);

    const { verifyRes } = await issueAndVerify(student.id, instId);
    expect(verifyRes.status).toBe(200);
    const body = await verifyRes.json();
    expect(body.verified).toBe(true);
    expect(typeof body.verificationId).toBe("string");

    const stored = await prisma.systemCheckSecureClientVerification.findUniqueOrThrow({ where: { id: body.verificationId } });
    expect(stored.userId).toBe(student.id);
    expect(stored.purpose).toBe("SYSTEM_CHECK");
    expect(stored.verificationStatus).toBe("VERIFIED");
    expect(stored.clientVersion).toBe("1.4.0");
    expect(stored.displayTopologyClassification).toBe("INTERNAL_ONLY");

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const runRes = await runsRoute.POST(
      jsonRequest("POST", { ...fullTetherResults, secureClientSessionId: null, systemCheckVerificationId: body.verificationId, clientTimeMs: Date.now() }),
    );
    expect(runRes.status).toBe(200);
    const runBody = await runRes.json();
    expect(runBody.run.results.secureClient).toEqual({ status: "PASS", reasonCode: "SYSTEM_CHECK_VERIFIED" });
    expect(runBody.run.overallStatus).toBe("READY");

    const [submissionsAfter, answersAfter, eventsAfter] = await Promise.all([
      prisma.submission.count({ where: { studentId: student.id } }),
      prisma.answer.count(),
      prisma.integrityEvent.count({ where: { studentId: student.id } }),
    ]);
    expect(submissionsAfter).toBe(submissionsBefore);
    expect(answersAfter).toBe(answersBefore);
    expect(eventsAfter).toBe(eventsBefore);
  });

  it("1. Chrome requests a valid challenge and sends it back with fabricated Tether facts (no client attestation at all) — rejected", async () => {
    const student = await freshStudent("Chrome No Attestation");
    const { verifyRes } = await issueAndVerify(student.id, instId, { omitClientAttestation: true });
    // The zod schema itself requires clientAttestation — a fabricated
    // response with none is malformed, never silently accepted.
    expect(verifyRes.status).toBe(400);
  });

  it("2. Chrome claims to be TETHER_SECURE_CLIENT (the equivalent of asserting window.sesLockdown exists) but signs with a self-generated (Chrome-side) key — rejected", async () => {
    const student = await freshStudent("Chrome Fake Bridge");
    const chromeKeys = crypto.generateKeyPairSync("ed25519");
    const chromePrivatePem = chromeKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const { verifyRes } = await issueAndVerify(student.id, instId, { clientType: "TETHER_SECURE_CLIENT", signWith: chromePrivatePem });
    expect(verifyRes.status).toBe(400);
    const body = await verifyRes.json();
    expect(body.reason).toBe("CLIENT_ATTESTATION_INVALID");
    // No verification row was ever created for this attempt.
    expect(await prisma.systemCheckSecureClientVerification.count({ where: { userId: student.id } })).toBe(0);
  });

  it("3. Chrome supplies fabricated client version and display topology, self-signed — rejected regardless of how plausible the fabricated facts look", async () => {
    const student = await freshStudent("Chrome Fabricated Facts");
    const chromeKeys = crypto.generateKeyPairSync("ed25519");
    const chromePrivatePem = chromeKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const { verifyRes } = await issueAndVerify(student.id, instId, {
      signWith: chromePrivatePem,
      facts: { clientVersion: "1.4.0", platform: "win32", displayTopologyClassification: "INTERNAL_ONLY" },
    });
    expect(verifyRes.status).toBe(400);
    const body = await verifyRes.json();
    expect(body.reason).toBe("CLIENT_ATTESTATION_INVALID");
  });

  it("4. a correctly signed server challenge, echoed back correctly, but with client attestation signed by the WRONG key — rejected (the server's own challenge signature alone is never sufficient)", async () => {
    const student = await freshStudent("Wrong Key Student");
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const challengeRes = await challengeRoute.POST();
    const { challenge, signature } = await challengeRes.json();
    // The server's own challenge signature is untouched/genuine here —
    // only the client-side attestation is forged.
    const wrongKeys = crypto.generateKeyPairSync("ed25519");
    const wrongPrivatePem = wrongKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const clientAttestation = signAttestation({ nonce: challenge.nonce, clientVersion: "1.4.0", platform: "win32", displayTopologyClassification: "INTERNAL_ONLY" }, wrongPrivatePem);
    const verifyRes = await verifyRoute.POST(jsonRequest("POST", { challenge, signature, clientType: "TETHER_SECURE_CLIENT", clientAttestation }));
    expect(verifyRes.status).toBe(400);
    const body = await verifyRes.json();
    expect(body.reason).toBe("CLIENT_ATTESTATION_INVALID");
  });

  it("rejects a signature-tampered challenge even with a genuine client attestation attached", async () => {
    const student = await freshStudent("Tamper Student");
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const challengeRes = await challengeRoute.POST();
    const { challenge, signature } = await challengeRes.json();
    const tampered = { ...challenge, userSubjectHash: "0".repeat(64) };
    const clientAttestation = signAttestation({ nonce: challenge.nonce, clientVersion: "1.4.0", platform: "win32", displayTopologyClassification: "INTERNAL_ONLY" }, genuineClientPrivateKeyPem);
    const verifyRes = await verifyRoute.POST(jsonRequest("POST", { challenge: tampered, signature, clientType: "TETHER_SECURE_CLIENT", clientAttestation }));
    expect(verifyRes.status).toBe(400);
    const body = await verifyRes.json();
    expect(body.verified).toBe(false);
  });

  it("9. a challenge issued to one student cannot be verified as another student (WRONG_SUBJECT), even with genuine client attestation", async () => {
    const owner = await freshStudent("Challenge Owner");
    const impersonator = await freshStudent("Impersonator");

    mockAuth.mockResolvedValue(sessionFor(owner.id, "STUDENT", instId));
    const challengeRes = await challengeRoute.POST();
    const { challenge, signature } = await challengeRes.json();
    const clientAttestation = signAttestation({ nonce: challenge.nonce, clientVersion: "1.4.0", platform: "win32", displayTopologyClassification: "INTERNAL_ONLY" }, genuineClientPrivateKeyPem);

    // The impersonator authenticates as themself but tries to redeem a
    // challenge that was bound (via userSubjectHash) to a different user.
    mockAuth.mockResolvedValue(sessionFor(impersonator.id, "STUDENT", instId));
    const verifyRes = await verifyRoute.POST(jsonRequest("POST", { challenge, signature, clientType: "TETHER_SECURE_CLIENT", clientAttestation }));
    expect(verifyRes.status).toBe(400);
    const body = await verifyRes.json();
    expect(body.reason).toBe("WRONG_SUBJECT");
  });

  it("8. purpose tampering is rejected (invalidates the server's own signature, since purpose is part of the signed challenge)", async () => {
    const student = await freshStudent("Purpose Tamper Student");
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const challengeRes = await challengeRoute.POST();
    const { challenge, signature } = await challengeRes.json();
    const tampered = { ...challenge, purpose: "EXAM_LAUNCH" };
    const clientAttestation = signAttestation({ nonce: challenge.nonce, clientVersion: "1.4.0", platform: "win32", displayTopologyClassification: "INTERNAL_ONLY" }, genuineClientPrivateKeyPem);
    // The zod schema itself only accepts the literal "SYSTEM_CHECK" purpose.
    const verifyRes = await verifyRoute.POST(jsonRequest("POST", { challenge: tampered, signature, clientType: "TETHER_SECURE_CLIENT", clientAttestation }));
    expect(verifyRes.status).toBe(400);
  });

  it("10. expiry tampering is rejected — extending expiresAt after issuance invalidates the server's own signature", async () => {
    const student = await freshStudent("Expiry Tamper Student");
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const challengeRes = await challengeRoute.POST();
    const { challenge, signature } = await challengeRes.json();
    const tampered = { ...challenge, expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString() };
    const clientAttestation = signAttestation({ nonce: challenge.nonce, clientVersion: "1.4.0", platform: "win32", displayTopologyClassification: "INTERNAL_ONLY" }, genuineClientPrivateKeyPem);
    const verifyRes = await verifyRoute.POST(jsonRequest("POST", { challenge: tampered, signature, clientType: "TETHER_SECURE_CLIENT", clientAttestation }));
    expect(verifyRes.status).toBe(400);
    const body = await verifyRes.json();
    expect(body.reason).toBe("INVALID_SIGNATURE");
  });

  it("11. preserves replay protection — a second verify of the same challenge is rejected", async () => {
    const student = await freshStudent("Replay Student");
    const first = await issueAndVerify(student.id, instId);
    expect(first.verifyRes.status).toBe(200);

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const clientAttestation = signAttestation({ nonce: first.challenge.nonce, clientVersion: "1.4.0", platform: "win32", displayTopologyClassification: "INTERNAL_ONLY" }, genuineClientPrivateKeyPem);
    const second = await verifyRoute.POST(jsonRequest("POST", { challenge: first.challenge, signature: first.signature, clientType: "TETHER_SECURE_CLIENT", clientAttestation }));
    expect(second.status).toBe(409);
    const secondBody = await second.json();
    expect(secondBody.reason).toBe("REPLAY");

    // Only one row was ever persisted, not two.
    const count = await prisma.systemCheckSecureClientVerification.count({ where: { userId: student.id } });
    expect(count).toBe(1);
  });

  it("concurrent replay attempts produce at most one accepted verification", async () => {
    const student = await freshStudent("Concurrent Replay Student");
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const challengeRes = await challengeRoute.POST();
    const { challenge, signature } = await challengeRes.json();
    const clientAttestation = signAttestation({ nonce: challenge.nonce, clientVersion: "1.4.0", platform: "win32", displayTopologyClassification: "INTERNAL_ONLY" }, genuineClientPrivateKeyPem);
    const body = { challenge, signature, clientType: "TETHER_SECURE_CLIENT", clientAttestation };

    const results = await Promise.all([
      verifyRoute.POST(jsonRequest("POST", body)),
      verifyRoute.POST(jsonRequest("POST", body)),
      verifyRoute.POST(jsonRequest("POST", body)),
    ]);
    const successCount = results.filter((r) => r.status === 200).length;
    expect(successCount).toBe(1);

    const count = await prisma.systemCheckSecureClientVerification.count({ where: { userId: student.id } });
    expect(count).toBe(1);
  });

  it("an expired challenge is rejected, never silently accepted", async () => {
    const student = await freshStudent("Expired Student");
    const { computeUserSubjectHash, signChallenge, generateSystemCheckNonce, SYSTEM_CHECK_CHALLENGE_PURPOSE, SYSTEM_CHECK_CHALLENGE_ISSUER, SYSTEM_CHECK_CHALLENGE_SCHEMA_VERSION } =
      await import("../lib/secureClient/systemCheckChallenge");
    const now = Date.now();
    const expiredChallenge = {
      schemaVersion: SYSTEM_CHECK_CHALLENGE_SCHEMA_VERSION,
      challengeId: "expired-challenge-1",
      keyId: "dev-key-1",
      issuer: SYSTEM_CHECK_CHALLENGE_ISSUER,
      purpose: SYSTEM_CHECK_CHALLENGE_PURPOSE,
      audience: "tether-system-check",
      userSubjectHash: computeUserSubjectHash(student.id),
      issuedAt: new Date(now - 10 * 60_000).toISOString(),
      notBefore: new Date(now - 10 * 60_000).toISOString(),
      expiresAt: new Date(now - 5 * 60_000).toISOString(),
      nonce: generateSystemCheckNonce(),
    };
    const signature = signChallenge(expiredChallenge, privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    const clientAttestation = signAttestation(
      { nonce: expiredChallenge.nonce, clientVersion: "1.4.0", platform: "win32", displayTopologyClassification: "INTERNAL_ONLY" },
      genuineClientPrivateKeyPem,
    );
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const verifyRes = await verifyRoute.POST(jsonRequest("POST", { challenge: expiredChallenge, signature, clientType: "TETHER_SECURE_CLIENT", clientAttestation }));
    expect(verifyRes.status).toBe(400);
    const body = await verifyRes.json();
    expect(body.reason).toBe("EXPIRED");
  });

  it("7. a valid real-exam SecureClientSession id cannot be relabelled/reused as a systemCheckVerificationId", async () => {
    const student = await freshStudent("Relabel Student");
    const exam = await publishFinalExam("relabel-exam-attestation");
    const submission = await prisma.submission.create({ data: { examId: exam.id, studentId: student.id, attemptNumber: 1 } });
    const examSession = await prisma.secureClientSession.create({
      data: {
        institutionId: instId,
        examId: exam.id,
        submissionId: submission.id,
        studentId: student.id,
        clientType: "TETHER_SECURE_CLIENT",
        status: "ACTIVE",
        verificationStatus: "VERIFIED",
      },
    });
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const res = await runsRoute.POST(
      jsonRequest("POST", { ...fullTetherResults, secureClientSessionId: null, systemCheckVerificationId: examSession.id, clientTimeMs: Date.now() }),
    );
    // examSession.id is a SecureClientSession id, not a
    // SystemCheckSecureClientVerification id — the two tables are
    // structurally unrelated, so this is simply "not found".
    expect(res.status).toBe(404);
  });
});

describe("POST /api/tether/system-check/runs — systemCheckVerificationId ownership", () => {
  it("9. a fabricated systemCheckVerificationId is rejected", async () => {
    const student5 = await prisma.user.create({
      data: { name: "Fab Verification Student", email: `syscheck-fabverif-${stamp}@test.local`, passwordHash: await bcrypt.hash("x", 4), role: "STUDENT", institutionId: instId },
    });
    cleanup.users.push(student5.id);
    mockAuth.mockResolvedValue(sessionFor(student5.id, "STUDENT", instId));
    const res = await runsRoute.POST(jsonRequest("POST", { ...fullTetherResults, secureClientSessionId: null, systemCheckVerificationId: "does-not-exist", clientTimeMs: Date.now() }));
    expect(res.status).toBe(404);
  });

  it("10. another student's systemCheckVerificationId is rejected, even though it genuinely exists and is VERIFIED", async () => {
    const owner2 = await prisma.user.create({
      data: { name: "Verification Owner", email: `syscheck-verifowner-${stamp}@test.local`, passwordHash: await bcrypt.hash("x", 4), role: "STUDENT", institutionId: instId },
    });
    const thief = await prisma.user.create({
      data: { name: "Verification Thief", email: `syscheck-verifthief-${stamp}@test.local`, passwordHash: await bcrypt.hash("x", 4), role: "STUDENT", institutionId: instId },
    });
    cleanup.users.push(owner2.id, thief.id);

    const { verifyRes } = await issueAndVerify(owner2.id, instId);
    const { verificationId } = await verifyRes.json();

    mockAuth.mockResolvedValue(sessionFor(thief.id, "STUDENT", instId));
    const res = await runsRoute.POST(jsonRequest("POST", { ...fullTetherResults, secureClientSessionId: null, systemCheckVerificationId: verificationId, clientTimeMs: Date.now() }));
    expect(res.status).toBe(404);
  });
});

describe("SYSTEM_CHECK verification never authorises exam content", () => {
  it("a verified SYSTEM_CHECK record does not satisfy the real exam content gate (GET /api/submissions/[id] still requires a genuine, submission-bound verified SecureClientSession)", async () => {
    const student6 = await prisma.user.create({
      data: { name: "Never Authorises Student", email: `syscheck-neverauth-${stamp}@test.local`, passwordHash: await bcrypt.hash("x", 4), role: "STUDENT", institutionId: instId },
    });
    cleanup.users.push(student6.id);

    // Establish a genuinely VERIFIED SYSTEM_CHECK record for this student.
    const { verifyRes } = await issueAndVerify(student6.id, instId);
    expect((await verifyRes.clone().json()).verified).toBe(true);

    // Start a real final exam attempt for the SAME student — this still
    // requires the REAL exam-bound Tether launch/attestation flow;
    // having a SYSTEM_CHECK verification changes nothing about it.
    const exam = await publishFinalExam("never-authorises-exam-content");
    mockAuth.mockResolvedValue(sessionFor(student6.id, "STUDENT", instId));
    const startRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(startRes.status).toBe(201);
    const submission = await startRes.json();
    expect(submission.secureClientLaunch).toMatchObject({ required: true, kind: "REDIRECT_TO_TETHER_LAUNCH" });

    // The real content-serving route still blocks — a SYSTEM_CHECK
    // verification is never read by, or substitutable for, the real
    // per-submission SecureClientSession gate.
    mockAuth.mockResolvedValue(sessionFor(student6.id, "STUDENT", instId));
    const contentRes = await submissionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    expect(contentRes.status).toBe(403);
    const contentBody = await contentRes.json();
    expect(contentBody.code).toBe("TETHER_SESSION_REQUIRED");
  });

  it("structural proof: the challenge/verify routes never create a Submission, Answer, or IntegrityEvent", async () => {
    const student7 = await prisma.user.create({
      data: { name: "Structural Proof Student", email: `syscheck-structural-${stamp}@test.local`, passwordHash: await bcrypt.hash("x", 4), role: "STUDENT", institutionId: instId },
    });
    cleanup.users.push(student7.id);

    const [submissionsBefore, answersBefore, eventsBefore] = await Promise.all([
      prisma.submission.count({ where: { studentId: student7.id } }),
      prisma.answer.count(),
      prisma.integrityEvent.count({ where: { studentId: student7.id } }),
    ]);

    await issueAndVerify(student7.id, instId);

    const [submissionsAfter, answersAfter, eventsAfter] = await Promise.all([
      prisma.submission.count({ where: { studentId: student7.id } }),
      prisma.answer.count(),
      prisma.integrityEvent.count({ where: { studentId: student7.id } }),
    ]);

    expect(submissionsAfter).toBe(submissionsBefore);
    expect(answersAfter).toBe(answersBefore);
    expect(eventsAfter).toBe(eventsBefore);
  });
});
