/**
 * Tether v1.7.4 pre-exam readiness — release-blocking audit, CHECK 1/4:
 * unactivated (PREPARING) attempt accounting. See
 * docs/tether-preflight-lifecycle-v1.7.4.md, "Attempt accounting for an
 * unactivated (PREPARING) attempt".
 *
 * Proves, against the REAL routes and the disposable database (mirrors
 * src/lib/courseEnrolmentExamAssignment.test.ts's established pattern):
 * a submission that reaches PREPARING (activatedAt: null) and then never
 * completes native activation — because the native check failed, or
 * because the student simply closed Tether and came back later — is
 * NEVER treated as a consumed attempt, is NEVER duplicated into a second
 * row, and NEVER causes maxAttempts to incorrectly block a retry. An
 * attempt is only ever "spent" once it reaches a FINALIZED status
 * (SUBMITTED/GRADED) — activation alone does not finalize anything, it
 * only unlocks content/timer for the SAME still-IN_PROGRESS row.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";

// Release-blocking server content-boundary audit — see
// tetherContentAccessLease.ts. A self-contained signing keypair for THIS
// file only (mirrors tetherRecovery.routes.test.ts's own pattern).
const { publicKey: serverPublicKey, privateKey: serverPrivateKey } = crypto.generateKeyPairSync("ed25519");
vi.stubEnv("TETHER_SECURE_CLIENT_SIGNING_PUBLIC_KEY", serverPublicKey.export({ type: "spki", format: "pem" }).toString());
vi.stubEnv("TETHER_SECURE_CLIENT_SIGNING_PRIVATE_KEY", serverPrivateKey.export({ type: "pkcs8", format: "pem" }).toString());

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const startRoute = await import("../app/api/exams/[id]/start/route");
const activateRoute = await import("../app/api/submissions/[id]/activate/route");
const submissionRoute = await import("../app/api/submissions/[id]/route");
const { getSigningPrivateKey, getSigningKeyId } = await import("./secureClientRunner");
const { buildContentAccessLeaseClaims, encodeContentAccessLeaseCookieValue, CONTENT_ACCESS_LEASE_COOKIE_NAME } = await import(
  "./secureClient/tetherContentAccessLease"
);

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

let institutionId: string;
let lecturerId: string;

beforeAll(async () => {
  const inst = await getOrCreateTestInstitution(`tether-attempt-accounting-${stamp}`);
  institutionId = inst.id;
  const passwordHash = await bcrypt.hash("password", 4);
  const lecturer = await prisma.user.create({
    data: { name: "Attempt Accounting Lecturer", email: `attempt-acct-lecturer-${stamp}@test.invalid`, passwordHash, role: "LECTURER", institutionId },
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
    data: { name: `Attempt Accounting Student ${tag}`, email: `attempt-acct-${tag}-${stamp}@test.invalid`, passwordHash, role: "STUDENT", institutionId },
  });
  cleanupUserIds.push(user.id);
  return user;
}

/** maxAttempts defaults to 1 in the secureSettings schema — explicit here for clarity/documentation. */
async function createTetherExam(title: string, maxAttempts = 1) {
  const exam = await prisma.exam.create({
    data: {
      title: `${title} ${stamp}-${Math.random()}`,
      durationMins: 30,
      published: true,
      createdById: lecturerId,
      institutionId,
      secureSettings: { deliveryMode: "TETHER_CLIENT_REQUIRED", maxAttempts },
    },
  });
  cleanupExamIds.push(exam.id);
  await prisma.question.create({ data: { examId: exam.id, type: "SHORT_ANSWER", text: "Q1", points: 1, correctAnswer: "ok" } });
  return exam;
}

async function startAsStudent(examId: string, student: { id: string }) {
  mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
  const res = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: examId }) });
  expect(res.status).toBeLessThan(300);
  return res.json();
}

async function establishVerifiedSession(exam: { id: string }, submissionId: string, student: { id: string }) {
  return prisma.secureClientSession.create({
    data: {
      institutionId,
      examId: exam.id,
      submissionId,
      studentId: student.id,
      clientType: "TETHER_SECURE_CLIENT",
      status: "ACTIVE",
      verificationStatus: "VERIFIED",
      clientInstallationIdHash: TEST_INSTALLATION_FINGERPRINT,
    },
  });
}

describe("CHECK 1 — unactivated (PREPARING) attempt accounting", () => {
  it("maxAttempts=1: preflight passes, /start creates PREPARING submission, native activation fails (never calls /activate), student retries — the SAME submission is reused, no second row, attemptNumber unchanged", async () => {
    const student = await makeStudent("retry-same-submission");
    const exam = await createTetherExam("Retry Same Submission", 1);

    // 1-3: preflight passes, Begin examination -> /start.
    const submission1 = await startAsStudent(exam.id, student);
    expect(submission1.attemptNumber).toBe(1);
    expect(submission1.activatedAt).toBeNull();

    // 4: native activation fails BEFORE POST /activate is ever called —
    // simulated simply by never calling it (that IS what a client-side
    // native-activation failure looks like from the server's point of
    // view: verification may or may not have completed, but /activate
    // was never invoked).
    const afterFailedAttempt = await prisma.submission.findUniqueOrThrow({ where: { id: submission1.id } });
    expect(afterFailedAttempt.status).toBe("IN_PROGRESS");
    expect(afterFailedAttempt.activatedAt).toBeNull();

    // 5: student remediates and retries — /start is called again.
    const submission2 = await startAsStudent(exam.id, student);

    // Required behaviour: the SAME row is reused.
    expect(submission2.id).toBe(submission1.id);
    expect(submission2.attemptNumber).toBe(1);
    const allRows = await prisma.submission.findMany({ where: { examId: exam.id, studentId: student.id } });
    expect(allRows).toHaveLength(1);

    // remainingAttempts/maxAttempts must not have been consumed by the
    // failed-activation attempt — a fresh /start for the SAME exam+student
    // still resolves to attemptNumber 1, never blocked by maxAttempts=1.
    const finalizedCount = allRows.filter((r) => r.status !== "IN_PROGRESS").length;
    expect(finalizedCount).toBe(0);

    // Timer has still not started; question content is still inaccessible.
    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const blockedGet = await submissionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission1.id }) });
    expect(blockedGet.status).toBe(403);
    const blockedBody = await blockedGet.json();
    // Either gate is acceptable here (no verified session yet in this
    // specific test path) — the important invariant is NEVER 200.
    expect(["TETHER_SESSION_REQUIRED", "EXAM_NOT_ACTIVATED"]).toContain(blockedBody.code);

    // 6: after a successful retry (establish verification, then
    // activate), that SAME submission activates exactly once.
    const verifiedSession = await establishVerifiedSession(exam, submission1.id, student);
    const leaseCookie = mintLeaseCookie({ submissionId: submission1.id, secureClientSessionId: verifiedSession.id, studentId: student.id });
    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const activateRes = await activateRoute.POST(jsonRequest("POST", undefined, leaseCookie), { params: Promise.resolve({ id: submission1.id }) });
    expect(activateRes.status).toBe(200);
    const activateBody = await activateRes.json();
    expect(activateBody.alreadyActivated).toBe(false);

    const activated = await prisma.submission.findUniqueOrThrow({ where: { id: submission1.id } });
    expect(activated.activatedAt).not.toBeNull();
    expect(activated.attemptNumber).toBe(1);

    // Content now accessible for the same, single submission.
    const contentGet = await submissionRoute.GET(jsonRequest("GET", undefined, leaseCookie), { params: Promise.resolve({ id: submission1.id }) });
    expect(contentGet.status).toBe(200);

    // maxAttempts=1 correctly refuses a genuinely NEW attempt while this
    // one is still IN_PROGRESS (unrelated to activation — this is the
    // pre-existing "one attempt in flight at a time" invariant, unchanged
    // by this feature) — confirms maxAttempts was never silently weakened.
    const stillBlockedThirdStart = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    const thirdBody = await stillBlockedThirdStart.json();
    expect(thirdBody.id).toBe(submission1.id); // resumes the same activated attempt, does not error or create a new one
  });

  it("student closes Tether while activatedAt is null and reopens later — the SAME submission resumes, no attempt is lost", async () => {
    const student = await makeStudent("close-reopen");
    const exam = await createTetherExam("Close Reopen", 1);

    const submission1 = await startAsStudent(exam.id, student);
    expect(submission1.activatedAt).toBeNull();

    // Simulate "closed Tether, reopened later" — nothing about the
    // submission changes on its own; a fresh /start (the real client's
    // own auto-resume/dashboard-Continue behaviour) is called again,
    // with no time-based expiry or staleness logic involved.
    const resumed = await startAsStudent(exam.id, student);
    expect(resumed.id).toBe(submission1.id);
    expect(resumed.attemptNumber).toBe(submission1.attemptNumber);
    expect(resumed.activatedAt).toBeNull();

    const rows = await prisma.submission.findMany({ where: { examId: exam.id, studentId: student.id } });
    expect(rows).toHaveLength(1);
  });

  it("maxAttempts=1 correctly refuses a genuinely new attempt once the FIRST one is finalized (SUBMITTED) — never weakened by this feature", async () => {
    const student = await makeStudent("finalized-blocks-retry");
    const exam = await createTetherExam("Finalized Blocks Retry", 1);
    const submission = await startAsStudent(exam.id, student);
    await establishVerifiedSession(exam, submission.id, student);
    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    await activateRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submission.id }) });

    // Finalize it directly (submit-route mechanics are covered
    // elsewhere; this test only needs a genuinely FINALIZED row).
    await prisma.submission.update({ where: { id: submission.id }, data: { status: "SUBMITTED", submittedAt: new Date() } });

    const secondStart = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(secondStart.status).toBe(409);
    const secondBody = await secondStart.json();
    expect(secondBody.error).toBeDefined();

    const rows = await prisma.submission.findMany({ where: { examId: exam.id, studentId: student.id } });
    expect(rows).toHaveLength(1);
  });
});

describe("CHECK 4 — idempotent /activate does not change activatedAt on repeat", () => {
  it("calling /activate a second time after success returns the SAME activatedAt, unchanged", async () => {
    const student = await makeStudent("idempotent-activate");
    const exam = await createTetherExam("Idempotent Activate", 1);
    const submission = await startAsStudent(exam.id, student);
    const verifiedSession = await establishVerifiedSession(exam, submission.id, student);
    const leaseCookie = mintLeaseCookie({ submissionId: submission.id, secureClientSessionId: verifiedSession.id, studentId: student.id });

    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const first = await activateRoute.POST(jsonRequest("POST", undefined, leaseCookie), { params: Promise.resolve({ id: submission.id }) });
    expect(first.status).toBe(200);
    const firstBody = await first.json();

    await new Promise((r) => setTimeout(r, 5));

    const second = await activateRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submission.id }) });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.alreadyActivated).toBe(true);
    expect(secondBody.activatedAt).toBe(firstBody.activatedAt);
  });
});

describe("CHECK 4 — migration backfill semantics", () => {
  it("a legacy row (simulated: activatedAt explicitly NULL, as if created before the column existed) is backfilled to activatedAt = startedAt by the EXACT SQL statement in the production migration file", async () => {
    const student = await makeStudent("migration-backfill");
    const exam = await createTetherExam("Migration Backfill Simulation", 1);
    const legacyStartedAt = new Date(Date.now() - 7 * 24 * 60 * 60_000); // a week ago, pre-dating v1.7.4
    const legacyRow = await prisma.submission.create({
      data: {
        examId: exam.id,
        studentId: student.id,
        secureClientPolicySnapshotJson: { deliveryMode: "TETHER_CLIENT_REQUIRED" },
        activatedAt: null,
        startedAt: legacyStartedAt,
      },
    });
    expect(legacyRow.activatedAt).toBeNull();

    // The EXACT statement from docs/tether-preflight-lifecycle-v1.7.4-migration.sql,
    // Block 2 — run directly here to prove its logic against a real row,
    // without needing to execute the .sql file itself (which is applied
    // manually, outside this test suite — see docs/migration-ledger.md).
    await prisma.$executeRawUnsafe(`UPDATE "Submission" SET "activatedAt" = "startedAt" WHERE "activatedAt" IS NULL AND "id" = $1`, legacyRow.id);

    const backfilled = await prisma.submission.findUniqueOrThrow({ where: { id: legacyRow.id } });
    expect(backfilled.activatedAt).not.toBeNull();
    expect(backfilled.activatedAt!.getTime()).toBe(legacyStartedAt.getTime());
    expect(backfilled.startedAt.getTime()).toBe(legacyStartedAt.getTime()); // startedAt itself is never touched by the backfill

    // Idempotency: re-running the same statement is a no-op (WHERE
    // activatedAt IS NULL now matches nothing for this row).
    await prisma.$executeRawUnsafe(`UPDATE "Submission" SET "activatedAt" = "startedAt" WHERE "activatedAt" IS NULL AND "id" = $1`, legacyRow.id);
    const afterSecondRun = await prisma.submission.findUniqueOrThrow({ where: { id: legacyRow.id } });
    expect(afterSecondRun.activatedAt!.getTime()).toBe(backfilled.activatedAt!.getTime());
  });

  it("a legacy SUBMITTED/GRADED row was NEVER actually at risk, regardless of activatedAt — GET /api/submissions/[id]'s activation gate only ever applies to status IN_PROGRESS (see route.ts's own `submission.status === \"IN_PROGRESS\"` guard); a finalized historical record remains readable with or without the backfill", async () => {
    const student = await makeStudent("finalized-never-at-risk");
    const exam = await createTetherExam("Finalized Never At Risk", 1);
    const legacyStartedAt = new Date(Date.now() - 30 * 24 * 60 * 60_000);
    const legacyRow = await prisma.submission.create({
      data: {
        examId: exam.id,
        studentId: student.id,
        secureClientPolicySnapshotJson: { deliveryMode: "TETHER_CLIENT_REQUIRED" },
        activatedAt: null, // deliberately NOT backfilled — proves this alone never blocks a finalized row
        startedAt: legacyStartedAt,
        status: "SUBMITTED",
        submittedAt: new Date(Date.now() - 29 * 24 * 60 * 60_000),
        totalScore: 8,
      },
    });

    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const res = await submissionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: legacyRow.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("SUBMITTED");
  });

  it("pre-migration historical semantics are preserved after backfill: the GENUINE risk case — a legacy IN_PROGRESS row with a verified secure-client session that predates v1.7.4 (e.g. a real attempt still open exactly when the new code deploys) remains fully readable once backfilled, exactly as it was before v1.7.4", async () => {
    const student = await makeStudent("in-progress-historical-semantics");
    const exam = await createTetherExam("In Progress Historical Semantics Preserved", 1);
    const legacyStartedAt = new Date(Date.now() - 20 * 60_000);
    const legacyRow = await prisma.submission.create({
      data: {
        examId: exam.id,
        studentId: student.id,
        secureClientPolicySnapshotJson: { deliveryMode: "TETHER_CLIENT_REQUIRED" },
        activatedAt: null, // pre-migration state — this IS the row the migration's backfill exists to protect
        startedAt: legacyStartedAt,
        status: "IN_PROGRESS",
      },
    });
    const verifiedSession = await prisma.secureClientSession.create({
      data: {
        institutionId,
        examId: exam.id,
        submissionId: legacyRow.id,
        studentId: student.id,
        clientType: "TETHER_SECURE_CLIENT",
        status: "ACTIVE",
        verificationStatus: "VERIFIED",
        clientInstallationIdHash: TEST_INSTALLATION_FINGERPRINT,
      },
    });
    const leaseCookie = mintLeaseCookie({ submissionId: legacyRow.id, secureClientSessionId: verifiedSession.id, studentId: student.id });

    // Before backfill: the v1.7.4 content gate WOULD incorrectly block
    // this genuinely-in-progress historical attempt — exactly the
    // regression the migration's backfill (applied before the v1.7.4
    // code deploy) prevents in production.
    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const beforeBackfill = await submissionRoute.GET(jsonRequest("GET", undefined, leaseCookie), { params: Promise.resolve({ id: legacyRow.id }) });
    expect(beforeBackfill.status).toBe(403);
    const beforeBody = await beforeBackfill.json();
    expect(beforeBody.code).toBe("EXAM_NOT_ACTIVATED");

    // Apply the migration's exact backfill statement.
    await prisma.$executeRawUnsafe(`UPDATE "Submission" SET "activatedAt" = "startedAt" WHERE "activatedAt" IS NULL AND "id" = $1`, legacyRow.id);

    // After backfill: fully readable again, exactly like this attempt
    // always was before v1.7.4 — same startedAt, same status, same
    // content-access outcome, no student ever notices the schema change.
    const afterBackfill = await submissionRoute.GET(jsonRequest("GET", undefined, leaseCookie), { params: Promise.resolve({ id: legacyRow.id }) });
    expect(afterBackfill.status).toBe(200);
    const body = await afterBackfill.json();
    expect(body.status).toBe("IN_PROGRESS");
    expect(body.startedAt).toBe(legacyStartedAt.toISOString());
  });
});
