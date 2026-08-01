/**
 * Tether System Check and Exam Readiness — DB-backed route tests. See
 * docs/tether-system-check-v1.md, "Secure Client Attestation v2".
 *
 * Same established pattern as finalExaminationPolicy.routes.test.ts: real
 * route handlers imported directly, run against a real local test
 * Postgres. Pure aggregation/mode logic lives in
 * src/lib/systemCheck/readiness.test.ts; pure attestation crypto lives in
 * src/lib/secureClient/tetherAttestation.test.ts and
 * apps/lockdown/src/installationKey.test.ts — none of those need a DB.
 *
 * IMPORTANT — v2 architecture note, read before extending this file:
 * there is no longer a single globally-shared attestation key. Every
 * test that needs a "genuine Tether installation" must actually drive
 * the real registration flow (registerFreshInstallation below) to
 * obtain a per-installation keypair the server has genuinely recorded —
 * exactly what a real packaged client does. A "Chrome" scenario is
 * simulated by signing with a key that was NEVER registered (or was
 * registered by a DIFFERENT installation) — the server looks up the
 * REGISTERED public key for the claimed installationId and verifies
 * against THAT, so an unregistered/mismatched key never verifies. See
 * "Known limitations" in docs/tether-system-check-v1.md for the honest
 * boundary this does NOT defend: a sufficiently sophisticated attacker
 * who can script the registration+attestation HTTP flow directly (not
 * merely open DevTools in a real browser tab) CAN self-register a
 * SOFTWARE_PROTECTED installation and attest with it — v2's guarantee is
 * that this is never mistaken for TPM-backed/hardware-attested (see the
 * protection-level tests below), and that any single installation's
 * compromise is contained and revocable, not that pure software crypto
 * makes this impossible — no purely software scheme can, without real
 * TPM/CNG remote attestation infrastructure this pass does not add.
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
import { buildSystemCheckAttestationCanonicalString, buildExamSessionAttestationCanonicalString } from "@/lib/secureClient/tetherAttestation";
import { resolveExamAttestationMode } from "@/lib/tetherAttestationConfig";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

// The SERVER's own challenge-signing key (unchanged role from before —
// see getSigningPrivateKey/getSigningPublicKey in secureClientRunner.ts,
// reused as-is by the v2 attestation challenge flow too). Set directly
// on process.env (NOT via vi.stubEnv) — several tests below call
// vi.unstubAllEnvs() in their own cleanup, which would otherwise wipe
// this out the moment any of them runs.
const { publicKey: serverPublicKey, privateKey: serverPrivateKey } = crypto.generateKeyPairSync("ed25519");
process.env.TETHER_SECURE_CLIENT_SIGNING_PUBLIC_KEY = serverPublicKey.export({ type: "spki", format: "pem" }).toString();
process.env.TETHER_SECURE_CLIENT_SIGNING_PRIVATE_KEY = serverPrivateKey.export({ type: "pkcs8", format: "pem" }).toString();

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
const installationRegistrationChallengeRoute = await import("../app/api/tether/installation/registration-challenge/route");
const installationRegisterRoute = await import("../app/api/tether/installation/register/route");
const installationRevokeRoute = await import("../app/api/tether/installation/[id]/revoke/route");
const installationCurrentRoute = await import("../app/api/tether/installation/current/route");
const examSessionChallengeRoute = await import("../app/api/tether/exam-session/attestation/challenge/route");
const examSessionVerifyRoute = await import("../app/api/tether/exam-session/attestation/verify/route");
const installationListRoute = await import("../app/api/tether/installation/list/route");
const legacyAttestationRoute = await import("../app/api/secure-client/sessions/[sessionId]/attestation/route");

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
  await prisma.platformAuditLog.deleteMany({ where: { actorId: { in: cleanup.users } } });
  await prisma.tetherSystemCheckRun.deleteMany({ where: { userId: { in: cleanup.users } } });
  await prisma.systemCheckSecureClientVerification.deleteMany({ where: { userId: { in: cleanup.users } } });
  await prisma.tetherClientInstallation.deleteMany({ where: { userId: { in: cleanup.users } } });
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

async function freshStudent(label: string) {
  const user = await prisma.user.create({
    data: { name: label, email: `syscheck-${label.toLowerCase().replace(/\s+/g, "-")}-${stamp}-${Math.random().toString(36).slice(2)}@test.local`, passwordHash: await bcrypt.hash("x", 4), role: "STUDENT", institutionId: instId },
  });
  cleanup.users.push(user.id);
  return user;
}

const fullTetherResults = {
  sourceClientType: "TETHER_SECURE_CLIENT",
  clientVersion: "1.5.0",
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

// ---------------------------------------------------------------------------
// Secure Client Attestation v2 helpers — installation registration and
// purpose-bound attestation, driving the REAL routes exactly like a
// genuine packaged client (minus the actual Electron IPC — signing
// happens in-process here with a real keypair, playing main.ts's role).
// ---------------------------------------------------------------------------

type RegisterOptions = { keyPair?: crypto.KeyPairSyncResult<string, string>; keyProtectionLevel?: string; keyAlgorithm?: string };

async function registerFreshInstallation(userId: string, institutionId: string, options: RegisterOptions = {}) {
  const keyPair = options.keyPair ?? crypto.generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const publicKeyPem = keyPair.publicKey;
  const privateKeyPem = keyPair.privateKey;

  mockAuth.mockResolvedValue(sessionFor(userId, "STUDENT", institutionId));
  const challengeRes = await installationRegistrationChallengeRoute.POST(jsonRequest("POST", { publicKey: publicKeyPem }));
  const { challenge, signature: challengeSignature } = await challengeRes.json();
  const proofOfPossessionSignature = crypto.sign(null, Buffer.from(challenge.nonce, "utf8"), privateKeyPem).toString("base64");

  const registerRes = await installationRegisterRoute.POST(
    jsonRequest("POST", {
      challenge,
      challengeSignature,
      publicKey: publicKeyPem,
      keyAlgorithm: options.keyAlgorithm ?? "Ed25519",
      keyProtectionLevel: options.keyProtectionLevel ?? "SOFTWARE_PROTECTED",
      proofOfPossessionSignature,
      clientVersion: "1.5.0",
      platform: "win32",
    }),
  );
  return { registerRes, privateKeyPem, publicKeyPem };
}

type IssueAndVerifyOptions = {
  installationId?: string;
  signWith?: string;
  facts?: Partial<{ clientVersion: string; platform: string; displayTopologyClassification: string }>;
  omitAttestation?: boolean;
  nonceOverride?: string;
  clientType?: string;
};

/** Registers a fresh, genuine installation (unless one is supplied) and drives the real SYSTEM_CHECK challenge/verify round trip. Pass `signWith` a key that was NEVER registered to simulate "Chrome" (or any actor without the genuine installation's key). */
async function issueAndVerify(userId: string, institutionId: string, options: IssueAndVerifyOptions = {}) {
  let installationId = options.installationId;
  let signingKey = options.signWith;
  if (!installationId) {
    const reg = await registerFreshInstallation(userId, institutionId);
    const body = await reg.registerRes.clone().json();
    installationId = body.installationId;
    signingKey = signingKey ?? reg.privateKeyPem;
  }

  mockAuth.mockResolvedValue(sessionFor(userId, "STUDENT", institutionId));
  const challengeRes = await challengeRoute.POST(jsonRequest("POST", { installationId }));
  if (!challengeRes.ok) return { challengeRes, verifyRes: null as unknown as Response, challenge: null, challengeSignature: null, installationId };
  const { challenge, signature: challengeSignature } = await challengeRes.json();

  const facts = {
    clientVersion: options.facts?.clientVersion ?? "1.5.0",
    platform: options.facts?.platform ?? "win32",
    displayTopologyClassification: options.facts?.displayTopologyClassification ?? "INTERNAL_ONLY",
  };
  const nonce = options.nonceOverride ?? challenge.nonce;
  const canonicalString = buildSystemCheckAttestationCanonicalString({ nonce, installationPublicKeyFingerprint: challenge.installationPublicKeyFingerprint, ...facts });
  const installationSignature = options.omitAttestation || !signingKey ? undefined : crypto.sign(null, Buffer.from(canonicalString, "utf8"), signingKey).toString("base64");

  const body: Record<string, unknown> = { challenge, challengeSignature, clientType: options.clientType ?? "TETHER_SECURE_CLIENT", ...facts };
  if (installationSignature) body.installationSignature = installationSignature;

  const verifyRes = await verifyRoute.POST(jsonRequest("POST", body));
  return { challengeRes, verifyRes, challenge, challengeSignature, installationId, requestBody: body };
}

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
  it("21a. a malformed payload is rejected", async () => {
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

  it("a fabricated secure-client session id is rejected", async () => {
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const res = await runsRoute.POST(jsonRequest("POST", { ...fullTetherResults, secureClientSessionId: "does-not-exist" }));
    expect(res.status).toBe(404);
  });

  it("another student's secure-client session is rejected, even though it genuinely exists", async () => {
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

  it("13. an ordinary browser can never create a READY persisted system-check run", async () => {
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
  });

  it("a verified real-exam secure-client session (legacy path, unaffected by v2) still achieves READY", async () => {
    const readyStudentForTest8 = await freshStudent("Ready For READY");
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

  it("22a. running a system check never creates a Submission", async () => {
    mockAuth.mockResolvedValue(sessionFor(otherStudent.id, "STUDENT", instId));
    const before = await prisma.submission.count({ where: { studentId: otherStudent.id } });
    await runsRoute.POST(jsonRequest("POST", { ...fullTetherResults, sourceClientType: "BROWSER", secureClientSessionId: null, clientTimeMs: Date.now() }));
    const after = await prisma.submission.count({ where: { studentId: otherStudent.id } });
    expect(after).toBe(before);
  });

  it("22b. running a system check never creates an IntegrityEvent", async () => {
    mockAuth.mockResolvedValue(sessionFor(otherStudent.id, "STUDENT", instId));
    const before = await prisma.integrityEvent.count({ where: { studentId: otherStudent.id } });
    await runsRoute.POST(jsonRequest("POST", { ...fullTetherResults, sourceClientType: "BROWSER", secureClientSessionId: null, clientTimeMs: Date.now() + 100 }));
    const after = await prisma.integrityEvent.count({ where: { studentId: otherStudent.id } });
    expect(after).toBe(before);
  });

  it("an out-of-support client version is BLOCKED, not READY", async () => {
    const versionTestStudent = await freshStudent("Version Test Student");
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

describe("18/19/21. final examination WARN and REQUIRE flows", () => {
  it("WARN mode never blocks starting a final examination, even with no stored system check", async () => {
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

  it("REQUIRE mode blocks starting a final examination with no current system check, and allows it once a READY one exists", async () => {
    const exam = await publishFinalExam("require-mode-blocks-then-allows");
    const freshStudentUser = await freshStudent("Fresh Student");

    mockAuth.mockResolvedValue(sessionFor(freshStudentUser.id, "STUDENT", instId));
    vi.stubEnv("TETHER_SYSTEM_CHECK_MODE", "REQUIRE");
    try {
      const blockedRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
      expect(blockedRes.status).toBe(409);
      const blockedBody = await blockedRes.json();
      expect(blockedBody.code).toBe("SYSTEM_CHECK_REQUIRED");
      const submissionCount = await prisma.submission.count({ where: { examId: exam.id, studentId: freshStudentUser.id } });
      expect(submissionCount).toBe(0);

      const otherExam = await publishFinalExam("require-mode-unrelated-exam");
      mockAuth.mockResolvedValue(sessionFor(freshStudentUser.id, "STUDENT", instId));
      const otherSubmission = await prisma.submission.create({ data: { examId: otherExam.id, studentId: freshStudentUser.id, attemptNumber: 1 } });
      const otherSession = await prisma.secureClientSession.create({
        data: {
          institutionId: instId,
          examId: otherExam.id,
          submissionId: otherSubmission.id,
          studentId: freshStudentUser.id,
          clientType: "TETHER_SECURE_CLIENT",
          status: "ACTIVE",
          verificationStatus: "VERIFIED",
        },
      });
      const readyRunRes = await runsRoute.POST(jsonRequest("POST", { ...fullTetherResults, secureClientSessionId: otherSession.id, clientTimeMs: Date.now() }));
      expect(readyRunRes.status).toBe(200);

      mockAuth.mockResolvedValue(sessionFor(freshStudentUser.id, "STUDENT", instId));
      const allowedRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
      expect(allowedRes.status).toBe(201);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a stored READY system check never weakens or bypasses the existing fail-closed Tether-availability kill switch", async () => {
    const exam = await publishFinalExam("kill-switch-still-fail-closed");
    const readyStudent = await freshStudent("Ready Student");

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
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe("FINAL_EXAMINATION_TETHER_UNAVAILABLE");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("23. non-final assessments are never unexpectedly blocked by REQUIRE mode", async () => {
    const exam = await createExam("non-final-never-blocked");
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    await examRoute.PATCH(jsonRequest("PATCH", { secureSettings: { assessmentType: "QUIZ_OR_TEST" }, published: true }), {
      params: Promise.resolve({ id: exam.id }),
    });
    const freshStudentUser = await freshStudent("Quiz Student");
    mockAuth.mockResolvedValue(sessionFor(freshStudentUser.id, "STUDENT", instId));
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
// Installation registration and lifecycle (Secure Client Attestation v2)
// ---------------------------------------------------------------------------

describe("POST /api/tether/installation/register", () => {
  it("6. a valid installation signature (genuine registration + attestation) is accepted", async () => {
    const s = await freshStudent("Genuine Installation");
    const { registerRes } = await registerFreshInstallation(s.id, instId);
    expect(registerRes.status).toBe(200);
    const body = await registerRes.json();
    expect(body.registered).toBe(true);
    expect(typeof body.installationId).toBe("string");

    const stored = await prisma.tetherClientInstallation.findUniqueOrThrow({ where: { id: body.installationId } });
    expect(stored.userId).toBe(s.id);
    expect(stored.status).toBe("ACTIVE");
  });

  it("2. two separate installations (real registrations) end up with different, independently-stored public keys", async () => {
    const s1 = await freshStudent("Install A");
    const s2 = await freshStudent("Install B");
    const { registerRes: r1 } = await registerFreshInstallation(s1.id, instId);
    const { registerRes: r2 } = await registerFreshInstallation(s2.id, instId);
    const b1 = await r1.json();
    const b2 = await r2.json();
    expect(b1.publicKeyFingerprint).not.toBe(b2.publicKeyFingerprint);
  });

  it("4. ordinary Chrome cannot register as TPM-attested — the server rejects the claim outright, it is not silently downgraded", async () => {
    const s = await freshStudent("TPM Claim Student");
    const { registerRes } = await registerFreshInstallation(s.id, instId, { keyProtectionLevel: "TPM_ATTESTED" });
    expect(registerRes.status).toBe(400);
    expect(await prisma.tetherClientInstallation.count({ where: { userId: s.id } })).toBe(0);
  });

  it("5. a self-generated (Chrome/WebCrypto-equivalent) key can only ever be classified as SOFTWARE_PROTECTED — never silently treated as genuine hardware-backed Tether", async () => {
    const s = await freshStudent("Software Protected Student");
    const { registerRes } = await registerFreshInstallation(s.id, instId, { keyProtectionLevel: "SOFTWARE_PROTECTED" });
    expect(registerRes.status).toBe(200);
    const body = await registerRes.json();
    const stored = await prisma.tetherClientInstallation.findUniqueOrThrow({ where: { id: body.installationId } });
    expect(stored.keyProtectionLevel).toBe("SOFTWARE_PROTECTED");
    expect(stored.keyProtectionLevel).not.toBe("TPM_ATTESTED");
  });

  it("rejects registration with a proof-of-possession signature that does not match the submitted public key", async () => {
    const s = await freshStudent("Bad Proof Student");
    const realKeys = crypto.generateKeyPairSync("ed25519");
    const realPublicKeyPem = realKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
    mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
    const challengeRes = await installationRegistrationChallengeRoute.POST(jsonRequest("POST", { publicKey: realPublicKeyPem }));
    const { challenge, signature: challengeSignature } = await challengeRes.json();
    const attackerKeys = crypto.generateKeyPairSync("ed25519");
    const wrongProof = crypto.sign(null, Buffer.from(challenge.nonce, "utf8"), attackerKeys.privateKey).toString("base64");
    const registerRes = await installationRegisterRoute.POST(
      jsonRequest("POST", {
        challenge,
        challengeSignature,
        publicKey: realPublicKeyPem,
        keyAlgorithm: "Ed25519",
        keyProtectionLevel: "SOFTWARE_PROTECTED",
        proofOfPossessionSignature: wrongProof,
        clientVersion: "1.5.0",
        platform: "win32",
      }),
    );
    expect(registerRes.status).toBe(400);
    const body = await registerRes.json();
    expect(body.reason).toBe("PROOF_OF_POSSESSION_INVALID");
  });

  // Multi-device support superseded the old "registering always REPLACES
  // the prior installation" behaviour — see the dedicated "Multi-device
  // (TETHER_MAX_ACTIVE_INSTALLATIONS_PER_USER)" describe block below for
  // full coverage of the current up-to-the-limit ACTIVE / LIMIT_REACHED
  // behaviour.
});

describe("Single-use registration challenges (pre-Preview safety pass)", () => {
  it("1. a valid registration challenge succeeds — once", async () => {
    const s = await freshStudent("Single Use Success Student");
    const { registerRes } = await registerFreshInstallation(s.id, instId);
    expect(registerRes.status).toBe(200);
    const body = await registerRes.json();
    expect(body.registered).toBe(true);
    const consumedRows = await prisma.tetherInstallationRegistrationChallenge.count({ where: { userId: s.id } });
    expect(consumedRows).toBe(1);
  });

  it("2. a second use of the SAME challenge (identical challenge/signature/proof, replayed) is rejected", async () => {
    const s = await freshStudent("Single Use Replay Student");
    const keyPair = crypto.generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
    const challengeRes = await installationRegistrationChallengeRoute.POST(jsonRequest("POST", { publicKey: keyPair.publicKey }));
    const { challenge, signature: challengeSignature } = await challengeRes.json();
    const proofOfPossessionSignature = crypto.sign(null, Buffer.from(challenge.nonce, "utf8"), keyPair.privateKey).toString("base64");
    const body = { challenge, challengeSignature, publicKey: keyPair.publicKey, keyAlgorithm: "Ed25519", keyProtectionLevel: "SOFTWARE_PROTECTED", proofOfPossessionSignature, clientVersion: "1.6.0", platform: "win32" };

    const first = await installationRegisterRoute.POST(jsonRequest("POST", body));
    expect(first.status).toBe(200);

    const second = await installationRegisterRoute.POST(jsonRequest("POST", body));
    expect(second.status).toBe(409);
    const secondBody = await second.json();
    expect(secondBody.reason).toBe("CHALLENGE_ALREADY_CONSUMED");

    // Only ONE installation was ever created for this student.
    expect(await prisma.tetherClientInstallation.count({ where: { userId: s.id } })).toBe(1);
  });

  it("3. three concurrent registration attempts with the SAME challenge accept at most one", async () => {
    const s = await freshStudent("Single Use Concurrent Student");
    const keyPair = crypto.generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
    const challengeRes = await installationRegistrationChallengeRoute.POST(jsonRequest("POST", { publicKey: keyPair.publicKey }));
    const { challenge, signature: challengeSignature } = await challengeRes.json();
    const proofOfPossessionSignature = crypto.sign(null, Buffer.from(challenge.nonce, "utf8"), keyPair.privateKey).toString("base64");
    const body = { challenge, challengeSignature, publicKey: keyPair.publicKey, keyAlgorithm: "Ed25519", keyProtectionLevel: "SOFTWARE_PROTECTED", proofOfPossessionSignature, clientVersion: "1.6.0", platform: "win32" };

    const results = await Promise.all([
      installationRegisterRoute.POST(jsonRequest("POST", body)),
      installationRegisterRoute.POST(jsonRequest("POST", body)),
      installationRegisterRoute.POST(jsonRequest("POST", body)),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409]);
    expect(await prisma.tetherClientInstallation.count({ where: { userId: s.id } })).toBe(1);
  });

  it("4. an expired registration challenge is rejected, never silently accepted", async () => {
    const s = await freshStudent("Expired Registration Student");
    const { computeUserSubjectHash: subjHash, signRegistrationChallenge: signReg, generateAttestationNonce: genNonce, ATTESTATION_ISSUER: issuer, ATTESTATION_PROTOCOL_VERSION: protoVersion, REGISTRATION_PURPOSE: purpose, computePublicKeyFingerprint: fingerprint } = await import(
      "../lib/secureClient/tetherAttestation"
    );
    const keyPair = crypto.generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    const now = Date.now();
    const expiredChallenge = {
      schemaVersion: protoVersion,
      challengeId: "expired-reg-challenge-1",
      keyId: "dev-key-1",
      issuer,
      purpose,
      audience: "tether-installation-registration",
      userSubjectHash: subjHash(s.id),
      issuedAt: new Date(now - 10 * 60_000).toISOString(),
      notBefore: new Date(now - 10 * 60_000).toISOString(),
      expiresAt: new Date(now - 5 * 60_000).toISOString(),
      nonce: genNonce(),
      publicKeyFingerprint: fingerprint(keyPair.publicKey),
    };
    const challengeSignature = signReg(expiredChallenge, serverPrivateKey.export({ type: "pkcs8", format: "pem" }).toString());
    const proofOfPossessionSignature = crypto.sign(null, Buffer.from(expiredChallenge.nonce, "utf8"), keyPair.privateKey).toString("base64");
    mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
    const registerRes = await installationRegisterRoute.POST(
      jsonRequest("POST", {
        challenge: expiredChallenge,
        challengeSignature,
        publicKey: keyPair.publicKey,
        keyAlgorithm: "Ed25519",
        keyProtectionLevel: "SOFTWARE_PROTECTED",
        proofOfPossessionSignature,
        clientVersion: "1.6.0",
        platform: "win32",
      }),
    );
    expect(registerRes.status).toBe(400);
    const body = await registerRes.json();
    expect(body.reason).toBe("EXPIRED");
    expect(await prisma.tetherClientInstallation.count({ where: { userId: s.id } })).toBe(0);
  });

  it("5. a challenge issued to one user cannot be consumed by another user", async () => {
    const owner = await freshStudent("Registration Challenge Owner");
    const attacker = await freshStudent("Registration Challenge Attacker");
    const keyPair = crypto.generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    mockAuth.mockResolvedValue(sessionFor(owner.id, "STUDENT", instId));
    const challengeRes = await installationRegistrationChallengeRoute.POST(jsonRequest("POST", { publicKey: keyPair.publicKey }));
    const { challenge, signature: challengeSignature } = await challengeRes.json();
    const proofOfPossessionSignature = crypto.sign(null, Buffer.from(challenge.nonce, "utf8"), keyPair.privateKey).toString("base64");

    mockAuth.mockResolvedValue(sessionFor(attacker.id, "STUDENT", instId));
    const registerRes = await installationRegisterRoute.POST(
      jsonRequest("POST", { challenge, challengeSignature, publicKey: keyPair.publicKey, keyAlgorithm: "Ed25519", keyProtectionLevel: "SOFTWARE_PROTECTED", proofOfPossessionSignature, clientVersion: "1.6.0", platform: "win32" }),
    );
    expect(registerRes.status).toBe(400);
    const body = await registerRes.json();
    expect(body.reason).toBe("WRONG_SUBJECT");
    expect(await prisma.tetherClientInstallation.count({ where: { userId: attacker.id } })).toBe(0);
  });

  it("6. a challenge bound to one public key cannot be consumed by registering a DIFFERENT public key", async () => {
    const s = await freshStudent("Registration Wrong Key Student");
    const boundKeyPair = crypto.generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    const differentKeyPair = crypto.generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
    const challengeRes = await installationRegistrationChallengeRoute.POST(jsonRequest("POST", { publicKey: boundKeyPair.publicKey }));
    const { challenge, signature: challengeSignature } = await challengeRes.json();
    // Genuine proof of possession for the DIFFERENT key — proves the
    // student really holds it, but that is not the key this challenge
    // was issued for.
    const proofOfPossessionSignature = crypto.sign(null, Buffer.from(challenge.nonce, "utf8"), differentKeyPair.privateKey).toString("base64");
    const registerRes = await installationRegisterRoute.POST(
      jsonRequest("POST", { challenge, challengeSignature, publicKey: differentKeyPair.publicKey, keyAlgorithm: "Ed25519", keyProtectionLevel: "SOFTWARE_PROTECTED", proofOfPossessionSignature, clientVersion: "1.6.0", platform: "win32" }),
    );
    expect(registerRes.status).toBe(400);
    const body = await registerRes.json();
    expect(body.reason).toBe("WRONG_PUBLIC_KEY");
    expect(await prisma.tetherClientInstallation.count({ where: { userId: s.id } })).toBe(0);
  });

  it("7. purpose mutation (claiming a non-registration purpose) is rejected", async () => {
    const s = await freshStudent("Registration Purpose Mutation Student");
    const keyPair = crypto.generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
    const challengeRes = await installationRegistrationChallengeRoute.POST(jsonRequest("POST", { publicKey: keyPair.publicKey }));
    const { challenge, signature: challengeSignature } = await challengeRes.json();
    const proofOfPossessionSignature = crypto.sign(null, Buffer.from(challenge.nonce, "utf8"), keyPair.privateKey).toString("base64");
    const tampered = { ...challenge, purpose: "SYSTEM_CHECK" };
    const registerRes = await installationRegisterRoute.POST(
      jsonRequest("POST", { challenge: tampered, challengeSignature, publicKey: keyPair.publicKey, keyAlgorithm: "Ed25519", keyProtectionLevel: "SOFTWARE_PROTECTED", proofOfPossessionSignature, clientVersion: "1.6.0", platform: "win32" }),
    );
    // Rejected at the schema layer (purpose is a fixed literal) — still a
    // genuine rejection, never a registered installation.
    expect(registerRes.status).toBe(400);
    expect(await prisma.tetherClientInstallation.count({ where: { userId: s.id } })).toBe(0);
  });

  it("8. signature mutation (tampered challengeSignature) is rejected", async () => {
    const s = await freshStudent("Registration Signature Mutation Student");
    const keyPair = crypto.generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
    const challengeRes = await installationRegistrationChallengeRoute.POST(jsonRequest("POST", { publicKey: keyPair.publicKey }));
    const { challenge, signature: challengeSignature } = await challengeRes.json();
    const proofOfPossessionSignature = crypto.sign(null, Buffer.from(challenge.nonce, "utf8"), keyPair.privateKey).toString("base64");
    const tamperedSignature = challengeSignature.slice(0, -4) + (challengeSignature.slice(-4) === "AAAA" ? "BBBB" : "AAAA");
    const registerRes = await installationRegisterRoute.POST(
      jsonRequest("POST", { challenge, challengeSignature: tamperedSignature, publicKey: keyPair.publicKey, keyAlgorithm: "Ed25519", keyProtectionLevel: "SOFTWARE_PROTECTED", proofOfPossessionSignature, clientVersion: "1.6.0", platform: "win32" }),
    );
    expect(registerRes.status).toBe(400);
    const body = await registerRes.json();
    expect(body.reason).toBe("INVALID_SIGNATURE");
    expect(await prisma.tetherClientInstallation.count({ where: { userId: s.id } })).toBe(0);
  });

  it("9. duplicate fingerprint (re-registering the exact same public key with a FRESH challenge) remains rejected", async () => {
    const s = await freshStudent("Registration Duplicate Fingerprint Student");
    const keyPair = crypto.generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    const first = await registerFreshInstallation(s.id, instId, { keyPair });
    expect(first.registerRes.status).toBe(200);

    // A genuinely fresh challenge, correctly bound to the SAME key —
    // single-use no longer applies (this is a different nonce), but the
    // key itself is already registered.
    const second = await registerFreshInstallation(s.id, instId, { keyPair });
    expect(second.registerRes.status).toBe(409);
    const body = await second.registerRes.json();
    expect(body.reason).toBe("DUPLICATE_KEY");
  });

  it("10. rate limiting still works after the single-use change", async () => {
    const s = await freshStudent("Registration Rate Limit Still Works Student");
    for (let i = 0; i < 10; i++) {
      const reg = await registerFreshInstallation(s.id, instId);
      expect(reg.registerRes.status).toBe(200);
      const body = await reg.registerRes.json();
      mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
      await installationRevokeRoute.POST(jsonRequest("POST", { reason: "cycling" }), { params: Promise.resolve({ id: body.installationId }) });
    }
    const eleventh = await registerFreshInstallation(s.id, instId);
    expect(eleventh.registerRes.status).toBe(429);
  });

  it("11. the shared Supabase database remains protected by the Vitest DB safety guard", () => {
    expect(process.env.VITEST).toBe("true");
    expect(process.env.DATABASE_URL ?? "").toMatch(/localhost|127\.0\.0\.1|::1/);
  });
});

describe("POST /api/tether/installation/[id]/revoke", () => {
  it("the owning student can revoke their own installation", async () => {
    const s = await freshStudent("Self Revoke Student");
    const { registerRes } = await registerFreshInstallation(s.id, instId);
    const { installationId } = await registerRes.json();

    mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
    const revokeRes = await installationRevokeRoute.POST(jsonRequest("POST", { reason: "Lost device" }), { params: Promise.resolve({ id: installationId }) });
    expect(revokeRes.status).toBe(200);

    const record = await prisma.tetherClientInstallation.findUniqueOrThrow({ where: { id: installationId } });
    expect(record.status).toBe("REVOKED");
    expect(record.revocationReason).toBe("Lost device");
  });

  it("another student cannot revoke someone else's installation", async () => {
    const owner = await freshStudent("Installation Owner");
    const attacker = await freshStudent("Revoke Attacker");
    const { registerRes } = await registerFreshInstallation(owner.id, instId);
    const { installationId } = await registerRes.json();

    mockAuth.mockResolvedValue(sessionFor(attacker.id, "STUDENT", instId));
    const revokeRes = await installationRevokeRoute.POST(jsonRequest("POST", {}), { params: Promise.resolve({ id: installationId }) });
    expect(revokeRes.status).toBe(404);

    const record = await prisma.tetherClientInstallation.findUniqueOrThrow({ where: { id: installationId } });
    expect(record.status).toBe("ACTIVE");
  });

  it("8. a revoked installation cannot attest", async () => {
    const s = await freshStudent("Revoked Attest Student");
    const reg = await registerFreshInstallation(s.id, instId);
    const { installationId } = await reg.registerRes.json();

    mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
    await installationRevokeRoute.POST(jsonRequest("POST", { reason: "test revoke" }), { params: Promise.resolve({ id: installationId }) });

    const { verifyRes, challengeRes } = await issueAndVerify(s.id, instId, { installationId, signWith: reg.privateKeyPem });
    // The challenge issuance itself already refuses a non-ACTIVE installation.
    expect(challengeRes.status).toBe(409);
    expect(verifyRes).toBeNull();
  });

  it("9. an installation whose status is anything other than ACTIVE (e.g. REPLACED — a status this pass's multi-device support no longer writes via any live code path, but the type/enum and the ACTIVE-only check both still exist defensively) cannot attest, even though it was genuinely registered", async () => {
    const s = await freshStudent("Replaced Attest Student");
    const reg = await registerFreshInstallation(s.id, instId);
    const { installationId } = await reg.registerRes.json();
    await prisma.tetherClientInstallation.update({ where: { id: installationId }, data: { status: "REPLACED" } });

    const { verifyRes, challengeRes } = await issueAndVerify(s.id, instId, { installationId, signWith: reg.privateKeyPem });
    // The challenge issuance itself already refuses a non-ACTIVE installation.
    expect(challengeRes.status).toBe(409);
    expect(verifyRes).toBeNull();
  });
});

describe("POST /api/tether/installation/current", () => {
  it("returns null for a student with no registered installation", async () => {
    const s = await freshStudent("No Installation Student");
    const neverRegistered = crypto.generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
    const res = await installationCurrentRoute.POST(jsonRequest("POST", { publicKey: neverRegistered.publicKey }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.installation).toBeNull();
  });

  it("returns the ACTIVE installation matching the exact public key asking, never a different device's", async () => {
    const s = await freshStudent("Current Installation Student");
    const first = await registerFreshInstallation(s.id, instId);
    const firstBody = await first.registerRes.json();
    const second = await registerFreshInstallation(s.id, instId);
    const secondBody = await second.registerRes.json();

    mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
    const firstRes = await installationCurrentRoute.POST(jsonRequest("POST", { publicKey: first.publicKeyPem }));
    expect((await firstRes.json()).installation.id).toBe(firstBody.installationId);

    const secondRes = await installationCurrentRoute.POST(jsonRequest("POST", { publicKey: second.publicKeyPem }));
    expect((await secondRes.json()).installation.id).toBe(secondBody.installationId);
  });
});

// ---------------------------------------------------------------------------
// SYSTEM_CHECK purpose-bound attestation — genuine-client proof.
// ---------------------------------------------------------------------------

describe("POST /api/tether/system-check/secure-client/challenge + verify", () => {
  it("5/14. valid genuine Tether attestation for SYSTEM_CHECK is accepted, and a first-time student (never taken any exam) reaches READY without creating Submission, Answer, or IntegrityEvent rows", async () => {
    const s = await freshStudent("First Timer");
    const [submissionsBefore, answersBefore, eventsBefore] = await Promise.all([
      prisma.submission.count({ where: { studentId: s.id } }),
      prisma.answer.count(),
      prisma.integrityEvent.count({ where: { studentId: s.id } }),
    ]);

    const { verifyRes } = await issueAndVerify(s.id, instId);
    expect(verifyRes.status).toBe(200);
    const body = await verifyRes.json();
    expect(body.verified).toBe(true);
    expect(typeof body.verificationId).toBe("string");

    const stored = await prisma.systemCheckSecureClientVerification.findUniqueOrThrow({ where: { id: body.verificationId } });
    expect(stored.userId).toBe(s.id);
    expect(stored.purpose).toBe("SYSTEM_CHECK");
    expect(stored.verificationStatus).toBe("VERIFIED");
    expect(stored.clientVersion).toBe("1.5.0");
    expect(stored.displayTopologyClassification).toBe("INTERNAL_ONLY");
    expect(typeof stored.installationId).toBe("string");

    mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
    const runRes = await runsRoute.POST(
      jsonRequest("POST", { ...fullTetherResults, secureClientSessionId: null, systemCheckVerificationId: body.verificationId, clientTimeMs: Date.now() }),
    );
    expect(runRes.status).toBe(200);
    const runBody = await runRes.json();
    expect(runBody.run.results.secureClient).toEqual({ status: "PASS", reasonCode: "SYSTEM_CHECK_VERIFIED" });
    expect(runBody.run.overallStatus).toBe("READY");

    const [submissionsAfter, answersAfter, eventsAfter] = await Promise.all([
      prisma.submission.count({ where: { studentId: s.id } }),
      prisma.answer.count(),
      prisma.integrityEvent.count({ where: { studentId: s.id } }),
    ]);
    expect(submissionsAfter).toBe(submissionsBefore);
    expect(answersAfter).toBe(answersBefore);
    expect(eventsAfter).toBe(eventsBefore);
  });

  it("1. Chrome with no genuinely registered installation key sends a request with no installation signature at all — rejected", async () => {
    const s = await freshStudent("Chrome No Attestation");
    const { verifyRes } = await issueAndVerify(s.id, instId, { omitAttestation: true });
    expect(verifyRes.status).toBe(400);
  });

  it("1/2/3. Chrome signs with a key that was NEVER registered with the server (the WebCrypto/self-generated-but-unregistered case) — rejected regardless of how plausible the claimed facts are", async () => {
    const s = await freshStudent("Chrome Unregistered Key");
    const unregisteredKeys = crypto.generateKeyPairSync("ed25519");
    const unregisteredPrivatePem = unregisteredKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const { verifyRes } = await issueAndVerify(s.id, instId, { signWith: unregisteredPrivatePem, facts: { clientVersion: "1.5.0", platform: "win32", displayTopologyClassification: "INTERNAL_ONLY" } });
    expect(verifyRes.status).toBe(400);
    const body = await verifyRes.json();
    expect(body.reason).toBe("INSTALLATION_SIGNATURE_INVALID");
    expect(await prisma.systemCheckSecureClientVerification.count({ where: { userId: s.id } })).toBe(0);
  });

  it("7. wrong installation key is rejected — a signature from a DIFFERENT student's genuinely-registered installation never verifies against this installation's pinned fingerprint", async () => {
    const s = await freshStudent("Right Installation Student");
    const otherReg = await registerFreshInstallation((await freshStudent("Someone Elses Installation")).id, instId);
    const { verifyRes } = await issueAndVerify(s.id, instId, { signWith: otherReg.privateKeyPem });
    expect(verifyRes.status).toBe(400);
    const body = await verifyRes.json();
    expect(body.reason).toBe("INSTALLATION_SIGNATURE_INVALID");
  });

  it("rejects a signature-tampered challenge even with a genuine installation signature attached", async () => {
    const s = await freshStudent("Tamper Student");
    const reg = await registerFreshInstallation(s.id, instId);
    const { installationId } = await reg.registerRes.json();
    mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
    const challengeRes = await challengeRoute.POST(jsonRequest("POST", { installationId }));
    const { challenge, signature: challengeSignature } = await challengeRes.json();
    const tampered = { ...challenge, userSubjectHash: "0".repeat(64) };
    const facts = { clientVersion: "1.5.0", platform: "win32", displayTopologyClassification: "INTERNAL_ONLY" };
    const canonicalString = buildSystemCheckAttestationCanonicalString({ nonce: challenge.nonce, installationPublicKeyFingerprint: challenge.installationPublicKeyFingerprint, ...facts });
    const installationSignature = crypto.sign(null, Buffer.from(canonicalString, "utf8"), reg.privateKeyPem).toString("base64");
    const verifyRes = await verifyRoute.POST(jsonRequest("POST", { challenge: tampered, challengeSignature, clientType: "TETHER_SECURE_CLIENT", installationSignature, ...facts }));
    expect(verifyRes.status).toBe(400);
    const body = await verifyRes.json();
    expect(body.verified).toBe(false);
  });

  it("12. a challenge issued to one student cannot be verified as another student", async () => {
    const owner = await freshStudent("Challenge Owner");
    const impersonator = await freshStudent("Impersonator");
    const reg = await registerFreshInstallation(owner.id, instId);
    const { installationId } = await reg.registerRes.json();

    mockAuth.mockResolvedValue(sessionFor(owner.id, "STUDENT", instId));
    const challengeRes = await challengeRoute.POST(jsonRequest("POST", { installationId }));
    const { challenge, signature: challengeSignature } = await challengeRes.json();
    const facts = { clientVersion: "1.5.0", platform: "win32", displayTopologyClassification: "INTERNAL_ONLY" };
    const canonicalString = buildSystemCheckAttestationCanonicalString({ nonce: challenge.nonce, installationPublicKeyFingerprint: challenge.installationPublicKeyFingerprint, ...facts });
    const installationSignature = crypto.sign(null, Buffer.from(canonicalString, "utf8"), reg.privateKeyPem).toString("base64");

    mockAuth.mockResolvedValue(sessionFor(impersonator.id, "STUDENT", instId));
    const verifyRes = await verifyRoute.POST(jsonRequest("POST", { challenge, challengeSignature, clientType: "TETHER_SECURE_CLIENT", installationSignature, ...facts }));
    expect(verifyRes.status).toBe(400);
    const body = await verifyRes.json();
    // The installation lookup itself is owner-scoped (loadOwnedInstallation),
    // exactly like every other ownership check in this codebase (see
    // loadOwnedSystemCheckVerification's own "404-equivalent semantics
    // for both not-found and belongs-to-someone-else" doc comment) — the
    // impersonator's own query for `challenge.installationId` simply
    // never finds a match scoped to their own userId, so this is
    // reported the same way as "installation not found", never
    // literally distinguishing "exists but isn't yours" (which would
    // leak installationId existence to a non-owner). Either way, the
    // request is unconditionally rejected.
    expect(body.reason).toBe("INVALID_SIGNATURE");
  });

  it("16. purpose tampering is rejected (invalidates the server's own signature, since purpose is part of the signed challenge)", async () => {
    const s = await freshStudent("Purpose Tamper Student");
    const reg = await registerFreshInstallation(s.id, instId);
    const { installationId } = await reg.registerRes.json();
    mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
    const challengeRes = await challengeRoute.POST(jsonRequest("POST", { installationId }));
    const { challenge, signature: challengeSignature } = await challengeRes.json();
    const tampered = { ...challenge, purpose: "EXAM_SESSION" };
    const facts = { clientVersion: "1.5.0", platform: "win32", displayTopologyClassification: "INTERNAL_ONLY" };
    const canonicalString = buildSystemCheckAttestationCanonicalString({ nonce: challenge.nonce, installationPublicKeyFingerprint: challenge.installationPublicKeyFingerprint, ...facts });
    const installationSignature = crypto.sign(null, Buffer.from(canonicalString, "utf8"), reg.privateKeyPem).toString("base64");
    const verifyRes = await verifyRoute.POST(jsonRequest("POST", { challenge: tampered, challengeSignature, clientType: "TETHER_SECURE_CLIENT", installationSignature, ...facts }));
    expect(verifyRes.status).toBe(400);
  });

  it("17. expiry tampering is rejected — extending expiresAt after issuance invalidates the server's own signature", async () => {
    const s = await freshStudent("Expiry Tamper Student");
    const reg = await registerFreshInstallation(s.id, instId);
    const { installationId } = await reg.registerRes.json();
    mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
    const challengeRes = await challengeRoute.POST(jsonRequest("POST", { installationId }));
    const { challenge, signature: challengeSignature } = await challengeRes.json();
    const tampered = { ...challenge, expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString() };
    const facts = { clientVersion: "1.5.0", platform: "win32", displayTopologyClassification: "INTERNAL_ONLY" };
    const canonicalString = buildSystemCheckAttestationCanonicalString({ nonce: challenge.nonce, installationPublicKeyFingerprint: challenge.installationPublicKeyFingerprint, ...facts });
    const installationSignature = crypto.sign(null, Buffer.from(canonicalString, "utf8"), reg.privateKeyPem).toString("base64");
    const verifyRes = await verifyRoute.POST(jsonRequest("POST", { challenge: tampered, challengeSignature, clientType: "TETHER_SECURE_CLIENT", installationSignature, ...facts }));
    expect(verifyRes.status).toBe(400);
    const body = await verifyRes.json();
    expect(body.reason).toBe("INVALID_SIGNATURE");
  });

  it("18. replay is rejected — resubmitting the EXACT same verify request a second time fails", async () => {
    const s = await freshStudent("Replay Student");
    const first = await issueAndVerify(s.id, instId);
    expect(first.verifyRes.status).toBe(200);

    mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
    const secondRes = await verifyRoute.POST(jsonRequest("POST", first.requestBody));
    expect(secondRes.status).toBe(409);
    const secondBody = await secondRes.json();
    expect(secondBody.reason).toBe("REPLAY");

    const count = await prisma.systemCheckSecureClientVerification.count({ where: { userId: s.id } });
    expect(count).toBe(1);
  });

  it("19. concurrent replay attempts produce at most one accepted verification", async () => {
    const s = await freshStudent("Concurrent Replay Student");
    const reg = await registerFreshInstallation(s.id, instId);
    const { installationId } = await reg.registerRes.json();
    mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
    const challengeRes = await challengeRoute.POST(jsonRequest("POST", { installationId }));
    const { challenge, signature: challengeSignature } = await challengeRes.json();
    const facts = { clientVersion: "1.5.0", platform: "win32", displayTopologyClassification: "INTERNAL_ONLY" };
    const canonicalString = buildSystemCheckAttestationCanonicalString({ nonce: challenge.nonce, installationPublicKeyFingerprint: challenge.installationPublicKeyFingerprint, ...facts });
    const installationSignature = crypto.sign(null, Buffer.from(canonicalString, "utf8"), reg.privateKeyPem).toString("base64");
    const body = { challenge, challengeSignature, clientType: "TETHER_SECURE_CLIENT", installationSignature, ...facts };

    const results = await Promise.all([
      verifyRoute.POST(jsonRequest("POST", body)),
      verifyRoute.POST(jsonRequest("POST", body)),
      verifyRoute.POST(jsonRequest("POST", body)),
    ]);
    const successCount = results.filter((r) => r.status === 200).length;
    expect(successCount).toBe(1);

    const count = await prisma.systemCheckSecureClientVerification.count({ where: { userId: s.id } });
    expect(count).toBe(1);
  });

  it("20. fabricated native facts (genuinely signed by the RIGHT key, but altered afterward) invalidate the signature", async () => {
    const s = await freshStudent("Fabricated Facts Student");
    const reg = await registerFreshInstallation(s.id, instId);
    const { installationId } = await reg.registerRes.json();
    mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
    const challengeRes = await challengeRoute.POST(jsonRequest("POST", { installationId }));
    const { challenge, signature: challengeSignature } = await challengeRes.json();
    const facts = { clientVersion: "1.5.0", platform: "win32", displayTopologyClassification: "INTERNAL_ONLY" };
    const canonicalString = buildSystemCheckAttestationCanonicalString({ nonce: challenge.nonce, installationPublicKeyFingerprint: challenge.installationPublicKeyFingerprint, ...facts });
    const installationSignature = crypto.sign(null, Buffer.from(canonicalString, "utf8"), reg.privateKeyPem).toString("base64");
    // Genuinely signed for INTERNAL_ONLY — resubmitted claiming a duplicated display instead.
    const verifyRes = await verifyRoute.POST(
      jsonRequest("POST", { challenge, challengeSignature, clientType: "TETHER_SECURE_CLIENT", installationSignature, ...facts, displayTopologyClassification: "CLONE_OR_DUPLICATE" }),
    );
    expect(verifyRes.status).toBe(400);
    const body = await verifyRes.json();
    expect(body.reason).toBe("INSTALLATION_SIGNATURE_INVALID");
  });

  it("an expired challenge is rejected, never silently accepted", async () => {
    const s = await freshStudent("Expired Student");
    const reg = await registerFreshInstallation(s.id, instId);
    const { installationId } = await reg.registerRes.json();
    const {
      computeUserSubjectHash,
      signAttestationChallenge,
      generateAttestationNonce,
      ATTESTATION_ISSUER,
      ATTESTATION_PROTOCOL_VERSION,
    } = await import("../lib/secureClient/tetherAttestation");
    const now = Date.now();
    const installation = await prisma.tetherClientInstallation.findUniqueOrThrow({ where: { id: installationId } });
    const expiredChallenge = {
      schemaVersion: ATTESTATION_PROTOCOL_VERSION,
      challengeId: "expired-challenge-1",
      keyId: "dev-key-1",
      issuer: ATTESTATION_ISSUER,
      purpose: "SYSTEM_CHECK" as const,
      audience: "tether-attestation",
      userSubjectHash: computeUserSubjectHash(s.id),
      installationId,
      installationPublicKeyFingerprint: installation.publicKeyFingerprint,
      issuedAt: new Date(now - 10 * 60_000).toISOString(),
      notBefore: new Date(now - 10 * 60_000).toISOString(),
      expiresAt: new Date(now - 5 * 60_000).toISOString(),
      nonce: generateAttestationNonce(),
      examId: null,
      submissionId: null,
      policyHash: null,
      secureClientSessionId: null,
      institutionId: null,
      allowedClientType: null,
      displayPolicy: null,
      requiredMinimumClientVersion: null,
    };
    const challengeSignature = signAttestationChallenge(expiredChallenge, serverPrivateKey.export({ type: "pkcs8", format: "pem" }).toString());
    const facts = { clientVersion: "1.5.0", platform: "win32", displayTopologyClassification: "INTERNAL_ONLY" };
    const canonicalString = buildSystemCheckAttestationCanonicalString({ nonce: expiredChallenge.nonce, installationPublicKeyFingerprint: installation.publicKeyFingerprint, ...facts });
    const installationSignature = crypto.sign(null, Buffer.from(canonicalString, "utf8"), reg.privateKeyPem).toString("base64");
    mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
    const verifyRes = await verifyRoute.POST(jsonRequest("POST", { challenge: expiredChallenge, challengeSignature, clientType: "TETHER_SECURE_CLIENT", installationSignature, ...facts }));
    expect(verifyRes.status).toBe(400);
    const body = await verifyRes.json();
    expect(body.reason).toBe("EXPIRED");
  });
});

describe("POST /api/tether/system-check/runs — systemCheckVerificationId ownership", () => {
  it("a fabricated systemCheckVerificationId is rejected", async () => {
    const s = await freshStudent("Fab Verification Student");
    mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
    const res = await runsRoute.POST(jsonRequest("POST", { ...fullTetherResults, secureClientSessionId: null, systemCheckVerificationId: "does-not-exist", clientTimeMs: Date.now() }));
    expect(res.status).toBe(404);
  });

  it("15. a stolen verification ID cannot be used by another user, even though it genuinely exists and is VERIFIED", async () => {
    const owner2 = await freshStudent("Verification Owner");
    const thief = await freshStudent("Verification Thief");

    const { verifyRes } = await issueAndVerify(owner2.id, instId);
    const { verificationId } = await verifyRes.json();

    mockAuth.mockResolvedValue(sessionFor(thief.id, "STUDENT", instId));
    const res = await runsRoute.POST(jsonRequest("POST", { ...fullTetherResults, secureClientSessionId: null, systemCheckVerificationId: verificationId, clientTimeMs: Date.now() }));
    expect(res.status).toBe(404);
  });

  it("a valid real-exam SecureClientSession id cannot be relabelled/reused as a systemCheckVerificationId", async () => {
    const s = await freshStudent("Relabel Student");
    const exam = await publishFinalExam("relabel-exam-attestation");
    const submission = await prisma.submission.create({ data: { examId: exam.id, studentId: s.id, attemptNumber: 1 } });
    const examSession = await prisma.secureClientSession.create({
      data: {
        institutionId: instId,
        examId: exam.id,
        submissionId: submission.id,
        studentId: s.id,
        clientType: "TETHER_SECURE_CLIENT",
        status: "ACTIVE",
        verificationStatus: "VERIFIED",
      },
    });
    mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
    const res = await runsRoute.POST(
      jsonRequest("POST", { ...fullTetherResults, secureClientSessionId: null, systemCheckVerificationId: examSession.id, clientTimeMs: Date.now() }),
    );
    expect(res.status).toBe(404);
  });
});

describe("10. SYSTEM_CHECK verification never authorises exam content", () => {
  it("a verified SYSTEM_CHECK record does not satisfy the real exam content gate (GET /api/submissions/[id] still requires a genuine, submission-bound verified SecureClientSession)", async () => {
    const s = await freshStudent("Never Authorises Student");

    const { verifyRes } = await issueAndVerify(s.id, instId);
    expect((await verifyRes.clone().json()).verified).toBe(true);

    const exam = await publishFinalExam("never-authorises-exam-content");
    mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
    const startRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(startRes.status).toBe(201);
    const submission = await startRes.json();
    expect(submission.secureClientLaunch).toMatchObject({ required: true, kind: "REDIRECT_TO_TETHER_LAUNCH" });

    mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
    const contentRes = await submissionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    expect(contentRes.status).toBe(403);
    const contentBody = await contentRes.json();
    expect(contentBody.code).toBe("TETHER_SESSION_REQUIRED");
  });

  it("structural proof: the challenge/verify routes never create a Submission, Answer, or IntegrityEvent", async () => {
    const s = await freshStudent("Structural Proof Student");

    const [submissionsBefore, answersBefore, eventsBefore] = await Promise.all([
      prisma.submission.count({ where: { studentId: s.id } }),
      prisma.answer.count(),
      prisma.integrityEvent.count({ where: { studentId: s.id } }),
    ]);

    await issueAndVerify(s.id, instId);

    const [submissionsAfter, answersAfter, eventsAfter] = await Promise.all([
      prisma.submission.count({ where: { studentId: s.id } }),
      prisma.answer.count(),
      prisma.integrityEvent.count({ where: { studentId: s.id } }),
    ]);

    expect(submissionsAfter).toBe(submissionsBefore);
    expect(answersAfter).toBe(answersBefore);
    expect(eventsAfter).toBe(eventsBefore);
  });
});

// ---------------------------------------------------------------------------
// EXAM_SESSION purpose-bound attestation — additive groundwork.
// ---------------------------------------------------------------------------

describe("EXAM_SESSION attestation — purpose isolation and additive-only behaviour", () => {
  async function setUpInProgressSession(s: { id: string }) {
    const exam = await publishFinalExam("exam-session-attestation");
    mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
    const submission = await prisma.submission.create({ data: { examId: exam.id, studentId: s.id, attemptNumber: 1, status: "IN_PROGRESS" } });
    const session = await prisma.secureClientSession.create({
      data: {
        institutionId: instId,
        examId: exam.id,
        submissionId: submission.id,
        studentId: s.id,
        clientType: "TETHER_SECURE_CLIENT",
        status: "ACTIVE",
        verificationStatus: "NOT_CHECKED",
      },
    });
    return { exam, submission, session };
  }

  it("11. a valid EXAM_SESSION attestation is accepted and populates clientInstallationIdHash, but is never usable as a SYSTEM_CHECK proof", async () => {
    const s = await freshStudent("Exam Session Student");
    const reg = await registerFreshInstallation(s.id, instId);
    const { installationId } = await reg.registerRes.json();
    const { submission, session } = await setUpInProgressSession(s);

    mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
    const challengeRes = await examSessionChallengeRoute.POST(jsonRequest("POST", { installationId, submissionId: submission.id }));
    expect(challengeRes.status).toBe(200);
    const { challenge, signature: challengeSignature } = await challengeRes.json();
    expect(challenge.purpose).toBe("EXAM_SESSION");
    expect(challenge.examId).toBe(submission.examId);
    expect(challenge.submissionId).toBe(submission.id);

    const facts = { clientVersion: "1.5.0", platform: "win32", displayTopologyClassification: "INTERNAL_ONLY", displayCount: 1, capabilities: "1,1,1,1", timestamp: new Date().toISOString() };
    const canonicalString = buildExamSessionAttestationCanonicalString({
      nonce: challenge.nonce,
      installationPublicKeyFingerprint: challenge.installationPublicKeyFingerprint,
      examId: challenge.examId,
      submissionId: challenge.submissionId,
      policyHash: challenge.policyHash,
      secureClientSessionId: challenge.secureClientSessionId,
      ...facts,
    });
    const installationSignature = crypto.sign(null, Buffer.from(canonicalString, "utf8"), reg.privateKeyPem).toString("base64");

    const verifyRes = await examSessionVerifyRoute.POST(jsonRequest("POST", { challenge, challengeSignature, installationSignature, ...facts }));
    expect(verifyRes.status).toBe(200);
    const body = await verifyRes.json();
    expect(body.verified).toBe(true);
    expect(body.sessionId).toBe(session.id);

    const updatedSession = await prisma.secureClientSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(updatedSession.clientInstallationIdHash).toBeTruthy();
    // ADDITIVE ONLY — verificationStatus/status untouched by this pass.
    expect(updatedSession.verificationStatus).toBe("NOT_CHECKED");

    // Using this SAME challenge shape/response against the SYSTEM_CHECK
    // verify route is rejected outright — different purpose, different
    // canonical signed payload entirely.
    const relabelRes = await verifyRoute.POST(
      jsonRequest("POST", { challenge, challengeSignature, clientType: "TETHER_SECURE_CLIENT", installationSignature, clientVersion: facts.clientVersion, platform: facts.platform, displayTopologyClassification: facts.displayTopologyClassification }),
    );
    expect(relabelRes.status).toBe(400);
  });

  it("a valid SYSTEM_CHECK attestation cannot be used as EXAM_SESSION proof", async () => {
    const s = await freshStudent("Cross Purpose Student");
    const { verifyRes: systemCheckVerifyRes, challenge: systemCheckChallenge, challengeSignature } = await issueAndVerify(s.id, instId);
    expect(systemCheckVerifyRes.status).toBe(200);

    const facts = { clientVersion: "1.5.0", platform: "win32", displayTopologyClassification: "INTERNAL_ONLY", displayCount: 1, capabilities: "1,1,1,1", timestamp: new Date().toISOString() };
    const relabelRes = await examSessionVerifyRoute.POST(
      jsonRequest("POST", { challenge: systemCheckChallenge, challengeSignature, installationSignature: "irrelevant", ...facts }),
    );
    expect(relabelRes.status).toBe(400);
  });

  it("13. exam tampering (a challenge for exam A resubmitted claiming exam B) is rejected", async () => {
    const s = await freshStudent("Exam Tamper Student");
    const reg = await registerFreshInstallation(s.id, instId);
    const { installationId } = await reg.registerRes.json();
    const { submission } = await setUpInProgressSession(s);

    mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
    const challengeRes = await examSessionChallengeRoute.POST(jsonRequest("POST", { installationId, submissionId: submission.id }));
    const { challenge, signature: challengeSignature } = await challengeRes.json();
    const tampered = { ...challenge, examId: "a-different-exam-id" };
    const facts = { clientVersion: "1.5.0", platform: "win32", displayTopologyClassification: "INTERNAL_ONLY", displayCount: 1, capabilities: "1,1,1,1", timestamp: new Date().toISOString() };
    const canonicalString = buildExamSessionAttestationCanonicalString({ nonce: challenge.nonce, installationPublicKeyFingerprint: challenge.installationPublicKeyFingerprint, examId: challenge.examId, submissionId: challenge.submissionId, policyHash: challenge.policyHash, secureClientSessionId: challenge.secureClientSessionId, ...facts });
    const installationSignature = crypto.sign(null, Buffer.from(canonicalString, "utf8"), reg.privateKeyPem).toString("base64");
    const verifyRes = await examSessionVerifyRoute.POST(jsonRequest("POST", { challenge: tampered, challengeSignature, installationSignature, ...facts }));
    expect(verifyRes.status).toBe(400);
  });

  it("14. submission tampering (a signature for one submission cannot be reused for another) is rejected", async () => {
    const s = await freshStudent("Submission Tamper Student");
    const reg = await registerFreshInstallation(s.id, instId);
    const { installationId } = await reg.registerRes.json();
    const { submission: submissionA } = await setUpInProgressSession(s);
    const { submission: submissionB } = await setUpInProgressSession(s);

    mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
    const challengeRes = await examSessionChallengeRoute.POST(jsonRequest("POST", { installationId, submissionId: submissionA.id }));
    const { challenge, signature: challengeSignature } = await challengeRes.json();
    const facts = { clientVersion: "1.5.0", platform: "win32", displayTopologyClassification: "INTERNAL_ONLY", displayCount: 1, capabilities: "1,1,1,1", timestamp: new Date().toISOString() };
    const canonicalString = buildExamSessionAttestationCanonicalString({ nonce: challenge.nonce, installationPublicKeyFingerprint: challenge.installationPublicKeyFingerprint, examId: challenge.examId, submissionId: challenge.submissionId, policyHash: challenge.policyHash, secureClientSessionId: challenge.secureClientSessionId, ...facts });
    const installationSignature = crypto.sign(null, Buffer.from(canonicalString, "utf8"), reg.privateKeyPem).toString("base64");
    // Genuinely signed for submissionA's challenge — resubmit CLAIMING submissionB.
    const tampered = { ...challenge, submissionId: submissionB.id };
    const verifyRes = await examSessionVerifyRoute.POST(jsonRequest("POST", { challenge: tampered, challengeSignature, installationSignature, ...facts }));
    expect(verifyRes.status).toBe(400);
  });

  it("15. policy-hash tampering is rejected", async () => {
    const s = await freshStudent("Policy Hash Tamper Student");
    const reg = await registerFreshInstallation(s.id, instId);
    const { installationId } = await reg.registerRes.json();
    const { submission } = await setUpInProgressSession(s);

    mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
    const challengeRes = await examSessionChallengeRoute.POST(jsonRequest("POST", { installationId, submissionId: submission.id }));
    const { challenge, signature: challengeSignature } = await challengeRes.json();
    const tampered = { ...challenge, policyHash: "a-different-policy-hash" };
    const facts = { clientVersion: "1.5.0", platform: "win32", displayTopologyClassification: "INTERNAL_ONLY", displayCount: 1, capabilities: "1,1,1,1", timestamp: new Date().toISOString() };
    const canonicalString = buildExamSessionAttestationCanonicalString({ nonce: challenge.nonce, installationPublicKeyFingerprint: challenge.installationPublicKeyFingerprint, examId: challenge.examId, submissionId: challenge.submissionId, policyHash: challenge.policyHash, secureClientSessionId: challenge.secureClientSessionId, ...facts });
    const installationSignature = crypto.sign(null, Buffer.from(canonicalString, "utf8"), reg.privateKeyPem).toString("base64");
    const verifyRes = await examSessionVerifyRoute.POST(jsonRequest("POST", { challenge: tampered, challengeSignature, installationSignature, ...facts }));
    expect(verifyRes.status).toBe(400);
  });
});

describe("21. final-exam content remains fail-closed regardless of any v2 attestation activity", () => {
  it("a student with a genuine SYSTEM_CHECK verification AND a genuine EXAM_SESSION attestation still cannot access exam content without the real, unmodified secure-client session verification", async () => {
    const s = await freshStudent("Fail Closed Student");
    const reg = await registerFreshInstallation(s.id, instId);
    const { installationId } = await reg.registerRes.json();

    await issueAndVerify(s.id, instId, { installationId, signWith: reg.privateKeyPem });

    // Started via the REAL start route (not a direct Prisma insert) so
    // the submission carries a genuine, frozen
    // secureClientPolicySnapshotJson (deliveryMode: TETHER_CLIENT_REQUIRED)
    // — without this, GET /api/submissions/[id]'s Tether gate has
    // nothing to key off and the test would prove nothing.
    const exam = await publishFinalExam("fail-closed-exam-session");
    mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
    const startRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(startRes.status).toBe(201);
    const submission = await startRes.json();
    // The real start flow only creates the Submission — a
    // SecureClientSession only exists once a launch manifest is
    // consumed, which examSessionVerifyRoute requires to already exist
    // (it looks one up, never creates one — see its own doc comment).
    await prisma.secureClientSession.create({
      data: {
        institutionId: instId,
        examId: exam.id,
        submissionId: submission.id,
        studentId: s.id,
        clientType: "TETHER_SECURE_CLIENT",
        status: "ACTIVE",
        verificationStatus: "NOT_CHECKED",
      },
    });

    const challengeRes = await examSessionChallengeRoute.POST(jsonRequest("POST", { installationId, submissionId: submission.id }));
    const { challenge, signature: challengeSignature } = await challengeRes.json();
    const facts = { clientVersion: "1.5.0", platform: "win32", displayTopologyClassification: "INTERNAL_ONLY", displayCount: 1, capabilities: "1,1,1,1", timestamp: new Date().toISOString() };
    const canonicalString = buildExamSessionAttestationCanonicalString({ nonce: challenge.nonce, installationPublicKeyFingerprint: challenge.installationPublicKeyFingerprint, examId: challenge.examId, submissionId: challenge.submissionId, policyHash: challenge.policyHash, secureClientSessionId: challenge.secureClientSessionId, ...facts });
    const installationSignature = crypto.sign(null, Buffer.from(canonicalString, "utf8"), reg.privateKeyPem).toString("base64");
    const examSessionVerifyRes = await examSessionVerifyRoute.POST(jsonRequest("POST", { challenge, challengeSignature, installationSignature, ...facts }));
    expect(examSessionVerifyRes.status).toBe(200);

    // Content is STILL blocked — verificationStatus is still NOT_CHECKED
    // (the legacy recordAttestation flow, which this pass never calls,
    // is the only thing that can change it).
    mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
    const contentRes = await submissionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    expect(contentRes.status).toBe(403);
  });
});

describe("25. DB-backed tests run only through disposable release validation", () => {
  it("this file's own module-level guard is the src/lib/prisma.ts safety guard, proven directly in prismaDbSafetyGuard.test.ts — this test only re-confirms this process is running under a disposable/local DATABASE_URL right now", () => {
    expect(process.env.VITEST).toBe("true");
    expect(process.env.DATABASE_URL ?? "").toMatch(/localhost|127\.0\.0\.1|::1/);
  });
});

// ---------------------------------------------------------------------------
// Wiring installation attestation into real exam sessions — see
// docs/tether-system-check-v1.md, "Wiring installation attestation into
// real exam sessions". Everything below drives the ACTUAL enforcement
// points (POST /api/exams/[id]/start, GET /api/submissions/[id]) rather
// than calling tetherAttestationRunner.ts directly, so these tests prove
// the real student-facing behaviour, not just the pure logic.
// ---------------------------------------------------------------------------

/** Drives the REAL legacy attestation route to a genuine VERIFIED session — checks: {} / required: {} always resolves to overallStatus READY (see overallStatusFromChecks). */
async function establishLegacyVerifiedSession(sessionId: string, clientVersion = "1.5.0") {
  return legacyAttestationRoute.POST(
    jsonRequest("POST", { platform: "win32", clientVersion, checks: {}, required: {} }),
    { params: Promise.resolve({ sessionId }) },
  );
}

/**
 * Full real flow: publish a TETHER_CLIENT_REQUIRED final exam, start it,
 * and create the SecureClientSession a genuine launch-manifest consume
 * would have produced — mirrors setUpInProgressSession's pattern but
 * started via the real route so the policy snapshot is genuine.
 *
 * Snapshots `attestationRequirement` from the CURRENT
 * `resolveExamAttestationMode()` by default — exactly what the real
 * getOrCreateSessionCore does — so a test that stubs
 * TETHER_EXAM_ATTESTATION_MODE before calling this helper gets a
 * realistic snapshot. `requirementOverride` exists ONLY for the
 * snapshot-immutability tests (Part 1, scenarios 5/6), which must prove
 * a session keeps a DIFFERENT requirement than whatever the environment
 * says at verification time.
 */
async function startFinalExamWithSession(s: { id: string }, label: string, requirementOverride?: string) {
  const exam = await publishFinalExam(label);
  mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
  const startRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
  expect(startRes.status).toBe(201);
  const submission = await startRes.json();
  const session = await prisma.secureClientSession.create({
    data: {
      institutionId: instId,
      examId: exam.id,
      submissionId: submission.id,
      studentId: s.id,
      clientType: "TETHER_SECURE_CLIENT",
      status: "ACTIVE",
      verificationStatus: "NOT_CHECKED",
      attestationRequirement: requirementOverride ?? resolveExamAttestationMode(),
    },
  });
  return { exam, submission, session };
}

async function attestExamSessionV2(s: { id: string }, reg: { installationId: string; privateKeyPem: string }, submissionId: string, factOverrides: Record<string, unknown> = {}) {
  mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
  const challengeRes = await examSessionChallengeRoute.POST(jsonRequest("POST", { installationId: reg.installationId, submissionId }));
  const { challenge, signature: challengeSignature } = await challengeRes.json();
  const facts = { clientVersion: "1.5.0", platform: "win32", displayTopologyClassification: "INTERNAL_ONLY", displayCount: 1, capabilities: "1,1,1,1", timestamp: new Date().toISOString(), ...factOverrides };
  const canonicalString = buildExamSessionAttestationCanonicalString({
    nonce: challenge.nonce,
    installationPublicKeyFingerprint: challenge.installationPublicKeyFingerprint,
    examId: challenge.examId,
    submissionId: challenge.submissionId,
    policyHash: challenge.policyHash,
    secureClientSessionId: challenge.secureClientSessionId,
    ...facts,
  });
  const installationSignature = crypto.sign(null, Buffer.from(canonicalString, "utf8"), reg.privateKeyPem).toString("base64");
  return examSessionVerifyRoute.POST(jsonRequest("POST", { challenge, challengeSignature, installationSignature, ...facts }));
}

describe("EXAM_SESSION v2 — additional 20-point checklist mutation coverage", () => {
  it("session-ID mutation (claiming a different SecureClientSession) is rejected", async () => {
    const s = await freshStudent("Session Id Tamper Student");
    const reg = await registerFreshInstallation(s.id, instId);
    const { installationId } = await reg.registerRes.json();
    const { submission: submissionA, session: sessionA } = await startFinalExamWithSession(s, "session-tamper-a");
    const { session: sessionB } = await startFinalExamWithSession(s, "session-tamper-b");
    expect(sessionA.id).not.toBe(sessionB.id);

    mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
    const challengeRes = await examSessionChallengeRoute.POST(jsonRequest("POST", { installationId, submissionId: submissionA.id }));
    const { challenge, signature: challengeSignature } = await challengeRes.json();
    const tampered = { ...challenge, secureClientSessionId: sessionB.id };
    const facts = { clientVersion: "1.5.0", platform: "win32", displayTopologyClassification: "INTERNAL_ONLY", displayCount: 1, capabilities: "1,1,1,1", timestamp: new Date().toISOString() };
    // Genuinely signed for sessionA's challenge (canonical string still binds sessionA.id) — resubmitting the challenge object claiming sessionB fails BOTH the challenge signature check and, even if that were somehow bypassed, the installation signature.
    const canonicalString = buildExamSessionAttestationCanonicalString({
      nonce: challenge.nonce,
      installationPublicKeyFingerprint: challenge.installationPublicKeyFingerprint,
      examId: challenge.examId,
      submissionId: challenge.submissionId,
      policyHash: challenge.policyHash,
      secureClientSessionId: challenge.secureClientSessionId,
      ...facts,
    });
    const installationSignature = crypto.sign(null, Buffer.from(canonicalString, "utf8"), reg.privateKeyPem).toString("base64");
    const verifyRes = await examSessionVerifyRoute.POST(jsonRequest("POST", { challenge: tampered, challengeSignature, installationSignature, ...facts }));
    expect(verifyRes.status).toBe(400);
  });

  it("client-version mutation (below the required minimum) is rejected", async () => {
    const s = await freshStudent("Version Mutation Student");
    const reg = await registerFreshInstallation(s.id, instId);
    const { submission } = await startFinalExamWithSession(s, "version-mutation");
    const verifyRes = await attestExamSessionV2(s, { installationId: (await reg.registerRes.json()).installationId, privateKeyPem: reg.privateKeyPem }, submission.id, { clientVersion: "1.0.0" });
    expect(verifyRes.status).toBe(400);
    const body = await verifyRes.json();
    expect(body.reason).toBe("CLIENT_VERSION_UNSUPPORTED");
  });

  it("display-fact mutation (extra display) is rejected when the immutable attempt policy requires a single display", async () => {
    const s = await freshStudent("Display Mutation Student");
    const reg = await registerFreshInstallation(s.id, instId);
    const { installationId } = await reg.registerRes.json();
    // Mandatory Tether Delivery for Final Examinations — a FINAL_EXAMINATION's
    // frozen policy snapshot always carries displayPolicy: SINGLE_DISPLAY_REQUIRED
    // (see src/lib/assessmentType.ts), so publishFinalExam alone already
    // exercises this check — no extra settings needed.
    const { submission } = await startFinalExamWithSession(s, "display-mutation-exam");

    const verifyRes = await attestExamSessionV2(s, { installationId, privateKeyPem: reg.privateKeyPem }, submission.id, { displayCount: 2 });
    expect(verifyRes.status).toBe(400);
    const body = await verifyRes.json();
    expect(body.reason).toBe("DISPLAY_POLICY_VIOLATION");
  });

  it("concurrent replay: two simultaneous verify attempts with the same nonce accept at most one", async () => {
    const s = await freshStudent("Concurrent Replay Student");
    const reg = await registerFreshInstallation(s.id, instId);
    const { installationId } = await reg.registerRes.json();
    const { submission } = await startFinalExamWithSession(s, "concurrent-replay");

    mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
    const challengeRes = await examSessionChallengeRoute.POST(jsonRequest("POST", { installationId, submissionId: submission.id }));
    const { challenge, signature: challengeSignature } = await challengeRes.json();
    const facts = { clientVersion: "1.5.0", platform: "win32", displayTopologyClassification: "INTERNAL_ONLY", displayCount: 1, capabilities: "1,1,1,1", timestamp: new Date().toISOString() };
    const canonicalString = buildExamSessionAttestationCanonicalString({
      nonce: challenge.nonce,
      installationPublicKeyFingerprint: challenge.installationPublicKeyFingerprint,
      examId: challenge.examId,
      submissionId: challenge.submissionId,
      policyHash: challenge.policyHash,
      secureClientSessionId: challenge.secureClientSessionId,
      ...facts,
    });
    const installationSignature = crypto.sign(null, Buffer.from(canonicalString, "utf8"), reg.privateKeyPem).toString("base64");
    const body = { challenge, challengeSignature, installationSignature, ...facts };

    const [res1, res2] = await Promise.all([
      examSessionVerifyRoute.POST(jsonRequest("POST", body)),
      examSessionVerifyRoute.POST(jsonRequest("POST", body)),
    ]);
    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([200, 409]);
  });
});

describe("TETHER_EXAM_ATTESTATION_MODE — real enforcement wiring (POST /start, GET /submissions/[id])", () => {
  it("LEGACY (default, unset): a genuine legacy VERIFIED session grants content access with no v2 evidence at all", async () => {
    const s = await freshStudent("Legacy Mode Student");
    const { submission, session } = await startFinalExamWithSession(s, "legacy-mode-exam");
    await establishLegacyVerifiedSession(session.id);

    mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
    const contentRes = await submissionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    expect(contentRes.status).toBe(200);
  });

  it("4. a DUAL-snapshotted session requires BOTH legacy and v2 — legacy alone is not enough", async () => {
    vi.stubEnv("TETHER_EXAM_ATTESTATION_MODE", "DUAL");
    try {
      const s = await freshStudent("Dual Mode Legacy Only Student");
      const { submission, session } = await startFinalExamWithSession(s, "dual-mode-legacy-only");
      await establishLegacyVerifiedSession(session.id, "1.6.0");

      mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
      const contentRes = await submissionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
      expect(contentRes.status).toBe(403);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("4. a DUAL-snapshotted session grants access once BOTH legacy VERIFIED and genuine v2 EXAM_SESSION evidence are present", async () => {
    vi.stubEnv("TETHER_EXAM_ATTESTATION_MODE", "DUAL");
    try {
      const s = await freshStudent("Dual Mode Both Student");
      const reg = await registerFreshInstallation(s.id, instId);
      const { installationId } = await reg.registerRes.json();
      const { submission, session } = await startFinalExamWithSession(s, "dual-mode-both");
      await establishLegacyVerifiedSession(session.id, "1.6.0");
      const v2Res = await attestExamSessionV2(s, { installationId, privateKeyPem: reg.privateKeyPem }, submission.id);
      expect(v2Res.status).toBe(200);

      mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
      const contentRes = await submissionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
      expect(contentRes.status).toBe(200);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("1. a DUAL session cannot downgrade to legacy-only by claiming clientVersion 1.4.9 in the (unsigned) legacy attestation body", async () => {
    vi.stubEnv("TETHER_EXAM_ATTESTATION_MODE", "DUAL");
    try {
      const s = await freshStudent("Dual Downgrade 1.4.9 Student");
      const { submission, session } = await startFinalExamWithSession(s, "dual-downgrade-149");
      await establishLegacyVerifiedSession(session.id, "1.4.9");

      mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
      const contentRes = await submissionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
      // No grandfathering by any reported version — v2 is still required.
      expect(contentRes.status).toBe(403);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("2. a DUAL session cannot downgrade by omitting clientVersion entirely from the legacy attestation body", async () => {
    vi.stubEnv("TETHER_EXAM_ATTESTATION_MODE", "DUAL");
    try {
      const s = await freshStudent("Dual Downgrade Omit Version Student");
      const { submission, session } = await startFinalExamWithSession(s, "dual-downgrade-omit");
      mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
      const attestRes = await legacyAttestationRoute.POST(
        jsonRequest("POST", { platform: "win32", checks: {}, required: {} }),
        { params: Promise.resolve({ sessionId: session.id }) },
      );
      expect(attestRes.status).toBe(201);
      const stored = await prisma.secureClientSession.findUniqueOrThrow({ where: { id: session.id } });
      expect(stored.clientVersion).toBeNull();
      expect(stored.verificationStatus).toBe("VERIFIED");

      const contentRes = await submissionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
      expect(contentRes.status).toBe(403);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("3. a DUAL session cannot downgrade even via direct manipulation of the unsigned SecureClientSession.clientVersion column itself", async () => {
    vi.stubEnv("TETHER_EXAM_ATTESTATION_MODE", "DUAL");
    try {
      const s = await freshStudent("Dual Downgrade Direct Column Student");
      const { submission, session } = await startFinalExamWithSession(s, "dual-downgrade-direct-column");
      await establishLegacyVerifiedSession(session.id, "1.6.0");
      // Maximally adversarial: even if an attacker could somehow force
      // this unsigned column to any value at all (e.g. "999.0.0", trying
      // to look maximally "new"), it must still have zero bearing on the
      // decision — resolveEffectiveTetherVerification takes no
      // clientVersion input whatsoever any more.
      await prisma.secureClientSession.update({ where: { id: session.id }, data: { clientVersion: "999.0.0" } });

      mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
      const contentRes = await submissionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
      expect(contentRes.status).toBe(403);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("5. a LEGACY-snapshotted session remains LEGACY (grants access on legacy alone) even after the environment later changes to DUAL", async () => {
    const s = await freshStudent("Snapshot Stays Legacy Student");
    // Session created while the environment is (implicitly) LEGACY.
    const { submission, session } = await startFinalExamWithSession(s, "snapshot-stays-legacy");
    await establishLegacyVerifiedSession(session.id);
    const stored = await prisma.secureClientSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(stored.attestationRequirement).toBe("LEGACY");

    vi.stubEnv("TETHER_EXAM_ATTESTATION_MODE", "DUAL");
    try {
      mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
      const contentRes = await submissionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
      // Still 200 — the environment changing to DUAL AFTER this session
      // was created must never retroactively demand v2 evidence it was
      // never told to collect.
      expect(contentRes.status).toBe(200);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("6. a DUAL-snapshotted session remains DUAL (still requires v2) even after the environment later changes back to LEGACY", async () => {
    const s = await freshStudent("Snapshot Stays Dual Student");
    let submissionId: string;
    let sessionId: string;
    vi.stubEnv("TETHER_EXAM_ATTESTATION_MODE", "DUAL");
    try {
      const { submission, session } = await startFinalExamWithSession(s, "snapshot-stays-dual");
      submissionId = submission.id;
      sessionId = session.id;
      await establishLegacyVerifiedSession(sessionId, "1.6.0");
      const stored = await prisma.secureClientSession.findUniqueOrThrow({ where: { id: sessionId } });
      expect(stored.attestationRequirement).toBe("DUAL");
    } finally {
      vi.unstubAllEnvs();
    }
    // Environment is back to (unset/)LEGACY now — but this session's OWN
    // snapshot is still DUAL, and it only ever completed legacy, not v2.
    mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
    const contentRes = await submissionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submissionId }) });
    expect(contentRes.status).toBe(403);
  });

  it("7. V2_REQUIRED rejects legacy-only evidence outright", async () => {
    vi.stubEnv("TETHER_EXAM_ATTESTATION_MODE", "V2_REQUIRED");
    try {
      const s = await freshStudent("V2 Required Legacy Only Student");
      const { submission, session } = await startFinalExamWithSession(s, "v2-required-legacy-only");
      await establishLegacyVerifiedSession(session.id);

      mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
      const contentRes = await submissionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
      expect(contentRes.status).toBe(403);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("7. V2_REQUIRED grants access on genuine v2 EXAM_SESSION evidence alone, even with no legacy attestation at all", async () => {
    vi.stubEnv("TETHER_EXAM_ATTESTATION_MODE", "V2_REQUIRED");
    try {
      const s = await freshStudent("V2 Required V2 Only Student");
      const reg = await registerFreshInstallation(s.id, instId);
      const { installationId } = await reg.registerRes.json();
      const { submission } = await startFinalExamWithSession(s, "v2-required-v2-only");
      const v2Res = await attestExamSessionV2(s, { installationId, privateKeyPem: reg.privateKeyPem }, submission.id);
      expect(v2Res.status).toBe(200);

      mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
      const contentRes = await submissionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
      expect(contentRes.status).toBe(200);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("8. client-version mutation between what was signed and what is submitted invalidates the v2 installation signature", async () => {
    const s = await freshStudent("Signed Version Mutation Student");
    const reg = await registerFreshInstallation(s.id, instId);
    const { installationId } = await reg.registerRes.json();
    const { submission } = await startFinalExamWithSession(s, "signed-version-mutation");

    mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
    const challengeRes = await examSessionChallengeRoute.POST(jsonRequest("POST", { installationId, submissionId: submission.id }));
    const { challenge, signature: challengeSignature } = await challengeRes.json();
    const signedFacts = { clientVersion: "1.6.0", platform: "win32", displayTopologyClassification: "INTERNAL_ONLY", displayCount: 1, capabilities: "1,1,1,1", timestamp: new Date().toISOString() };
    const canonicalString = buildExamSessionAttestationCanonicalString({
      nonce: challenge.nonce,
      installationPublicKeyFingerprint: challenge.installationPublicKeyFingerprint,
      examId: challenge.examId,
      submissionId: challenge.submissionId,
      policyHash: challenge.policyHash,
      secureClientSessionId: challenge.secureClientSessionId,
      ...signedFacts,
    });
    const installationSignature = crypto.sign(null, Buffer.from(canonicalString, "utf8"), reg.privateKeyPem).toString("base64");
    // Genuinely signed for "1.6.0" — submit claiming "1.0.0" instead.
    const submittedFacts = { ...signedFacts, clientVersion: "1.0.0" };
    const verifyRes = await examSessionVerifyRoute.POST(jsonRequest("POST", { challenge, challengeSignature, installationSignature, ...submittedFacts }));
    expect(verifyRes.status).toBe(400);
    const body = await verifyRes.json();
    expect(body.reason).toBe("INSTALLATION_SIGNATURE_INVALID");
  });

  it("9. an incompatible client (genuinely signed version below the required minimum) receives a deterministic, distinguishable upgrade-required result", async () => {
    const s = await freshStudent("Incompatible Client Student");
    const reg = await registerFreshInstallation(s.id, instId);
    const { installationId } = await reg.registerRes.json();
    const { submission } = await startFinalExamWithSession(s, "incompatible-client");
    const verifyRes = await attestExamSessionV2(s, { installationId, privateKeyPem: reg.privateKeyPem }, submission.id, { clientVersion: "1.0.0" });
    expect(verifyRes.status).toBe(400);
    const body = await verifyRes.json();
    // Deterministic and distinguishable from every other rejection reason
    // (INVALID_SIGNATURE, BINDING_MISMATCH, etc.) — a client/UI can show
    // "please update Tether Secure Browser" specifically for this code.
    expect(body.reason).toBe("CLIENT_VERSION_UNSUPPORTED");
  });

  it("10. an ordinary browser (no secure-client session at all) remains blocked regardless of mode", async () => {
    vi.stubEnv("TETHER_EXAM_ATTESTATION_MODE", "V2_REQUIRED");
    try {
      const s = await freshStudent("No Session At All Student");
      const exam = await publishFinalExam("no-session-at-all");
      mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
      const startRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
      const submission = await startRes.json();
      // No SecureClientSession ever created for this submission.
      const contentRes = await submissionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
      expect(contentRes.status).toBe(403);
      const body = await contentRes.json();
      expect(body.code).toBe("TETHER_SESSION_REQUIRED");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("11. final-exam content remains fail-closed under DUAL when neither factor is present", async () => {
    vi.stubEnv("TETHER_EXAM_ATTESTATION_MODE", "DUAL");
    try {
      const s = await freshStudent("Fail Closed Dual Student");
      const { submission } = await startFinalExamWithSession(s, "fail-closed-dual");
      mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
      const contentRes = await submissionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
      expect(contentRes.status).toBe(403);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("12. non-final assessments (STANDARD_WEB) remain completely unaffected by any mode", async () => {
    vi.stubEnv("TETHER_EXAM_ATTESTATION_MODE", "V2_REQUIRED");
    try {
      const s = await freshStudent("Standard Web Unaffected Student");
      const exam = await createExam("standard-web-unaffected");
      mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
      await examRoute.PATCH(jsonRequest("PATCH", { published: true }), { params: Promise.resolve({ id: exam.id }) });

      mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
      const startRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
      expect(startRes.status).toBe(201);
      const submission = await startRes.json();
      expect(submission.secureClientLaunch?.required ?? false).toBe(false);

      const contentRes = await submissionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
      expect(contentRes.status).toBe(200);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("Multi-device (TETHER_MAX_ACTIVE_INSTALLATIONS_PER_USER)", () => {
  it("a student may register up to the default limit (2) of simultaneously ACTIVE installations — the second does not silently revoke the first", async () => {
    const s = await freshStudent("Multi Device Student");
    const first = await registerFreshInstallation(s.id, instId);
    const firstBody = await first.registerRes.json();
    expect(firstBody.registered).toBe(true);
    const second = await registerFreshInstallation(s.id, instId);
    const secondBody = await second.registerRes.json();
    expect(secondBody.registered).toBe(true);

    const firstRow = await prisma.tetherClientInstallation.findUniqueOrThrow({ where: { id: firstBody.installationId } });
    const secondRow = await prisma.tetherClientInstallation.findUniqueOrThrow({ where: { id: secondBody.installationId } });
    expect(firstRow.status).toBe("ACTIVE");
    expect(secondRow.status).toBe("ACTIVE");
  });

  it("a third registration beyond the limit is rejected with LIMIT_REACHED — never silently revokes an existing device", async () => {
    const s = await freshStudent("Multi Device Limit Student");
    const first = await registerFreshInstallation(s.id, instId);
    const firstBody = await first.registerRes.json();
    await registerFreshInstallation(s.id, instId);
    const third = await registerFreshInstallation(s.id, instId);
    expect(third.registerRes.status).toBe(409);
    const thirdBody = await third.registerRes.json();
    expect(thirdBody.reason).toBe("LIMIT_REACHED");

    // The first device is still ACTIVE — never silently revoked to make room.
    const firstRow = await prisma.tetherClientInstallation.findUniqueOrThrow({ where: { id: firstBody.installationId } });
    expect(firstRow.status).toBe("ACTIVE");
  });

  it("revoking an old installation frees a slot for a new registration", async () => {
    const s = await freshStudent("Multi Device Revoke Student");
    const first = await registerFreshInstallation(s.id, instId);
    const firstBody = await first.registerRes.json();
    await registerFreshInstallation(s.id, instId);

    mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
    const revokeRes = await installationRevokeRoute.POST(jsonRequest("POST", { reason: "Replacing lost device" }), { params: Promise.resolve({ id: firstBody.installationId }) });
    expect(revokeRes.status).toBe(200);

    const third = await registerFreshInstallation(s.id, instId);
    expect(third.registerRes.status).toBe(200);
  });

  it("GET /api/tether/installation/list shows creation date, last-attested date, and status, but never a public key or fingerprint", async () => {
    const s = await freshStudent("Multi Device List Student");
    await registerFreshInstallation(s.id, instId);

    mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
    const res = await installationListRoute.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.installations.length).toBeGreaterThanOrEqual(1);
    expect(body.maxActiveInstallations).toBe(2);
    for (const installation of body.installations) {
      expect(installation).not.toHaveProperty("publicKey");
      expect(installation).not.toHaveProperty("publicKeyFingerprint");
      expect(installation.installedAt).toBeTruthy();
      expect(["ACTIVE", "REVOKED", "REPLACED"]).toContain(installation.status);
    }
  });

  it("one student's device list never includes another student's installations", async () => {
    const s = await freshStudent("Multi Device Isolation Student A");
    const other = await freshStudent("Multi Device Isolation Student B");
    await registerFreshInstallation(other.id, instId);

    mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
    const res = await installationListRoute.GET();
    const body = await res.json();
    expect(body.installations.length).toBe(0);
  });
});

describe("Registration rate limiting", () => {
  it("exceeding REGISTRATION_RATE_LIMIT_MAX_ATTEMPTS successful registrations within the window is rejected with RATE_LIMITED", async () => {
    const s = await freshStudent("Rate Limit Student");
    // Register-then-revoke in a loop so each attempt stays under the
    // multi-device active-count limit but still counts toward the
    // rolling registration-rate window (countRecentRegistrationAttempts
    // counts every row created, active or not).
    for (let i = 0; i < 10; i++) {
      const reg = await registerFreshInstallation(s.id, instId);
      expect(reg.registerRes.status).toBe(200);
      const body = await reg.registerRes.json();
      mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
      await installationRevokeRoute.POST(jsonRequest("POST", { reason: "cycling for rate-limit test" }), { params: Promise.resolve({ id: body.installationId }) });
    }
    const eleventh = await registerFreshInstallation(s.id, instId);
    expect(eleventh.registerRes.status).toBe(429);
    const body = await eleventh.registerRes.json();
    expect(body.reason).toBe("RATE_LIMITED");
  });
});

describe("Registration and revocation are audited (not via IntegrityEvent)", () => {
  it("a successful registration writes a PlatformAuditLog row, never an IntegrityEvent", async () => {
    const s = await freshStudent("Audit Register Student");
    const [integrityEventsBefore] = await Promise.all([prisma.integrityEvent.count({ where: { studentId: s.id } })]);
    const reg = await registerFreshInstallation(s.id, instId);
    const body = await reg.registerRes.json();

    const auditRows = await prisma.platformAuditLog.findMany({ where: { actorId: s.id, action: "TETHER_INSTALLATION_REGISTERED" } });
    expect(auditRows.length).toBe(1);
    expect(auditRows[0].targetId).toBe(body.installationId);
    expect(auditRows[0].targetType).toBe("TetherClientInstallation");

    const integrityEventsAfter = await prisma.integrityEvent.count({ where: { studentId: s.id } });
    expect(integrityEventsAfter).toBe(integrityEventsBefore);
  });

  it("a revocation writes a PlatformAuditLog row with the reason, never an IntegrityEvent", async () => {
    const s = await freshStudent("Audit Revoke Student");
    const reg = await registerFreshInstallation(s.id, instId);
    const { installationId } = await reg.registerRes.json();

    mockAuth.mockResolvedValue(sessionFor(s.id, "STUDENT", instId));
    await installationRevokeRoute.POST(jsonRequest("POST", { reason: "Lost device" }), { params: Promise.resolve({ id: installationId }) });

    const auditRows = await prisma.platformAuditLog.findMany({ where: { actorId: s.id, action: "TETHER_INSTALLATION_REVOKED" } });
    expect(auditRows.length).toBe(1);
    expect(auditRows[0].targetId).toBe(installationId);
    expect((auditRows[0].metadata as { reason?: string } | null)?.reason).toBe("Lost device");

    const integrityEvents = await prisma.integrityEvent.count({ where: { studentId: s.id } });
    expect(integrityEvents).toBe(0);
  });
});
