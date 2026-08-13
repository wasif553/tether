/**
 * PR #22 release-blocking review — secure-activation failure
 * reconciliation. See tether-launch/page.tsx's ensureSecureActivation and
 * src/lib/tetherLaunch.ts's classifyReconciliationCheck.
 *
 * DB-backed proof of the server-side half of the reconciliation design:
 * GET /api/submissions/[id]/secure-client/status's new, narrow `activated`
 * boolean field accurately reflects Submission.activatedAt at every point
 * in the activation lifecycle — the ONE signal the renderer's
 * reconcileServerActivationState relies on when POST /activate's own
 * response is ambiguous (network exception, timeout, unrecognized
 * status). Never exposes question content or the raw timestamp.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";

// Release-blocking server content-boundary audit — see
// tetherContentAccessLease.ts. A self-contained signing keypair for THIS
// file only (mirrors tetherRecovery.routes.test.ts's own pattern) — this
// file is DB-isolated from other route test files and cannot assume a
// signing key is already configured in the ambient test environment.
const { publicKey: serverPublicKey, privateKey: serverPrivateKey } = crypto.generateKeyPairSync("ed25519");
vi.stubEnv("TETHER_SECURE_CLIENT_SIGNING_PUBLIC_KEY", serverPublicKey.export({ type: "spki", format: "pem" }).toString());
vi.stubEnv("TETHER_SECURE_CLIENT_SIGNING_PRIVATE_KEY", serverPrivateKey.export({ type: "pkcs8", format: "pem" }).toString());

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const startRoute = await import("../app/api/exams/[id]/start/route");
const activateRoute = await import("../app/api/submissions/[id]/activate/route");
const statusRoute = await import("../app/api/submissions/[id]/secure-client/status/route");
const { getSigningPrivateKey, getSigningKeyId } = await import("./secureClientRunner");
const { buildContentAccessLeaseClaims, encodeContentAccessLeaseCookieValue, CONTENT_ACCESS_LEASE_COOKIE_NAME } = await import(
  "./secureClient/tetherContentAccessLease"
);

/** Release-blocking follow-up review — a lease is only ever valid when it matches the session's CURRENT clientInstallationIdHash; any SecureClientSession row this file creates directly (bypassing real v2 attestation) must set this to the SAME fixed test fingerprint. */
const TEST_INSTALLATION_FINGERPRINT = "test-installation-fingerprint";

/** Mints a real, validly-signed lease directly (no HTTP round trip needed) for a SecureClientSession created directly in the DB, exactly mirroring what a genuine v2 attestation success would have issued. */
function mintLeaseCookie(params: { submissionId: string; secureClientSessionId: string; studentId: string }): string {
  const claims = buildContentAccessLeaseClaims({
    keyId: getSigningKeyId(),
    submissionId: params.submissionId,
    secureClientSessionId: params.secureClientSessionId,
    installationKeyFingerprint: TEST_INSTALLATION_FINGERPRINT,
    studentId: params.studentId,
  });
  const token = encodeContentAccessLeaseCookieValue(claims, getSigningPrivateKey());
  return `${CONTENT_ACCESS_LEASE_COOKIE_NAME}=${token}`;
}

const stamp = Date.now();
const cleanupUserIds: string[] = [];
const cleanupExamIds: string[] = [];

function sessionFor(userId: string, institutionId: string) {
  return {
    user: { id: userId, email: "test@test.invalid", name: "Test", role: "STUDENT" as const, institutionId },
    expires: new Date(Date.now() + 86400_000).toISOString(),
  };
}

function jsonRequest(method: string, body?: unknown, cookie?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers["Cookie"] = cookie;
  return new Request("http://test.local/route", {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

let institutionId: string;
let lecturerId: string;

beforeAll(async () => {
  const inst = await getOrCreateTestInstitution(`secure-client-status-activated-${stamp}`);
  institutionId = inst.id;
  const passwordHash = await bcrypt.hash("password", 4);
  const lecturer = await prisma.user.create({
    data: { name: "Status Activated Lecturer", email: `status-activated-lecturer-${stamp}@test.invalid`, passwordHash, role: "LECTURER", institutionId },
  });
  lecturerId = lecturer.id;
  cleanupUserIds.push(lecturer.id);
});

afterAll(async () => {
  await prisma.submission.deleteMany({ where: { studentId: { in: cleanupUserIds } } });
  await prisma.exam.deleteMany({ where: { id: { in: cleanupExamIds } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
});

async function makeStudent(tag: string) {
  const passwordHash = await bcrypt.hash("password", 4);
  const user = await prisma.user.create({
    data: { name: `Status Activated Student ${tag}`, email: `status-activated-${tag}-${stamp}@test.invalid`, passwordHash, role: "STUDENT", institutionId },
  });
  cleanupUserIds.push(user.id);
  return user;
}

async function createTetherExam(title: string) {
  const exam = await prisma.exam.create({
    data: {
      title: `${title} ${stamp}-${Math.random()}`,
      durationMins: 30,
      published: true,
      createdById: lecturerId,
      institutionId,
      secureSettings: { deliveryMode: "TETHER_CLIENT_REQUIRED", maxAttempts: 1 },
    },
  });
  cleanupExamIds.push(exam.id);
  await prisma.question.create({ data: { examId: exam.id, type: "SHORT_ANSWER", text: "Q1", points: 1, correctAnswer: "ok" } });
  return exam;
}

describe("GET /api/submissions/[id]/secure-client/status — the `activated` reconciliation field", () => {
  it("REQUIRED TEST 4: a PREPARING attempt (never activated) reports activated:false — the exact signal that tells the renderer to restore native lockdown and let the student retry", async () => {
    const student = await makeStudent("preparing-false");
    const exam = await createTetherExam("Preparing False");
    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const startRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    const submission = await startRes.json();
    expect(submission.activatedAt).toBeNull();

    const statusRes = await statusRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    expect(statusRes.status).toBe(200);
    const body = await statusRes.json();
    expect(body.activated).toBe(false);
    // Release-blocking follow-up review — a bare opaque examId, needed
    // by the exam content page's pre-fetch native-lockdown gate to build
    // the tether-launch redirect URL WITHOUT ever fetching full
    // submission/question content first.
    expect(body.examId).toBe(exam.id);
    // Narrow — never exposes the raw timestamp or any question content.
    expect(body.activatedAt).toBeUndefined();
    expect(body.questions).toBeUndefined();

    // REQUIRED TEST 4 (retryability half): the same PREPARING submission
    // is still reusable — a fresh /start call resumes it, never creates a
    // second row, exactly like the existing attempt-accounting guarantees.
    const secondStart = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    const secondBody = await secondStart.json();
    expect(secondBody.id).toBe(submission.id);
    const rows = await prisma.submission.findMany({ where: { examId: exam.id, studentId: student.id } });
    expect(rows).toHaveLength(1);
  });

  it("REQUIRED TEST 3: once POST /activate has genuinely committed, activated:true is reported — the exact signal that tells the renderer NOT to restore native lockdown when its own response was lost", async () => {
    const student = await makeStudent("committed-true");
    const exam = await createTetherExam("Committed True");
    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const startRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    const submission = await startRes.json();

    const secureClientSession = await prisma.secureClientSession.create({
      data: {
        institutionId,
        examId: exam.id,
        submissionId: submission.id,
        studentId: student.id,
        clientType: "TETHER_SECURE_CLIENT",
        status: "ACTIVE",
        verificationStatus: "VERIFIED",
        clientInstallationIdHash: TEST_INSTALLATION_FINGERPRINT,
      },
    });
    const leaseCookie = mintLeaseCookie({ submissionId: submission.id, secureClientSessionId: secureClientSession.id, studentId: student.id });
    const activateRes = await activateRoute.POST(jsonRequest("POST", undefined, leaseCookie), { params: Promise.resolve({ id: submission.id }) });
    expect(activateRes.status).toBe(200);

    // Simulate the renderer's response being lost — it never sees the 200
    // above — and instead reconciling via this exact read.
    const statusRes = await statusRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    const body = await statusRes.json();
    expect(body.activated).toBe(true);
  });

  it("a non-gated (STANDARD_WEB) submission — activated immediately at /start — also reports activated:true", async () => {
    const student = await makeStudent("standard-web-true");
    const exam = await prisma.exam.create({
      data: {
        title: `Standard Web Status ${stamp}-${Math.random()}`,
        durationMins: 30,
        published: true,
        createdById: lecturerId,
        institutionId,
        secureSettings: { deliveryMode: "STANDARD_WEB" },
      },
    });
    cleanupExamIds.push(exam.id);
    await prisma.question.create({ data: { examId: exam.id, type: "SHORT_ANSWER", text: "Q1", points: 1, correctAnswer: "ok" } });

    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const startRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    const submission = await startRes.json();
    expect(submission.activatedAt).not.toBeNull();

    const statusRes = await statusRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    const body = await statusRes.json();
    expect(body.activated).toBe(true);
  });
});
