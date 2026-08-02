/**
 * Tether Secure Exam Recovery and Resilient Autosave v1 — DB-backed route
 * tests. See docs/tether-secure-resume-recovery-v1.md and Part 18 of the
 * task spec.
 *
 * SAFE EXECUTION ONLY: run this file exclusively via
 * `npm run release:validate` (a disposable, local-only PostgreSQL
 * container) — never a direct `npx vitest run` against this
 * repository's committed DATABASE_URL. src/lib/prisma.ts's test-time
 * safety guard throws before any query can run if DATABASE_URL doesn't
 * resolve to a disposable loopback database — see
 * src/lib/prismaDbSafetyGuard.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "crypto";
import bcrypt from "bcryptjs";

// A self-contained signing keypair for THIS file only (mirrors
// secureClientRunner.disposable.test.ts's own pattern) — this is the
// first *.routes.test.ts file to exercise the launch/consume/attest
// flow, so it cannot assume a signing key is already configured in the
// ambient .env used by other route tests that never touch secure-client
// sessions at all.
const { publicKey: serverPublicKey, privateKey: serverPrivateKey } = crypto.generateKeyPairSync("ed25519");
vi.stubEnv("TETHER_SECURE_CLIENT_SIGNING_PUBLIC_KEY", serverPublicKey.export({ type: "spki", format: "pem" }).toString());
vi.stubEnv("TETHER_SECURE_CLIENT_SIGNING_PRIVATE_KEY", serverPrivateKey.export({ type: "pkcs8", format: "pem" }).toString());

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const startRoute = await import("../app/api/exams/[id]/start/route");
const answersRoute = await import("../app/api/submissions/[id]/answers/route");
const submitRoute = await import("../app/api/submissions/[id]/submit/route");
const submissionRoute = await import("../app/api/submissions/[id]/route");
const recoveryStatusRoute = await import("../app/api/submissions/[id]/recovery-status/route");
const heartbeatRoute = await import("../app/api/submissions/[id]/session-heartbeat/route");
const launchRoute = await import("../app/api/submissions/[id]/secure-client/launch/route");
const consumeRoute = await import("../app/api/secure-client/launch/[manifestId]/consume/route");
const registrationChallengeRoute = await import("../app/api/tether/installation/registration-challenge/route");
const registerRoute = await import("../app/api/tether/installation/register/route");
const examSessionChallengeRoute = await import("../app/api/tether/exam-session/attestation/challenge/route");
const examSessionVerifyRoute = await import("../app/api/tether/exam-session/attestation/verify/route");

const { signRegistrationProofOfPossession, buildExamSessionAttestationCanonicalString } = await import("./secureClient/tetherAttestation");

function sessionFor(userId: string, role: "LECTURER" | "STUDENT") {
  return { user: { id: userId, role, email: `${userId}@test.local`, name: userId, institutionId: testInstitution.id } };
}

function jsonRequest(method: string, body?: unknown) {
  return new Request("http://test.local/route", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

let testInstitution: { id: string };
let lecturer: { id: string };
let student: { id: string };
let otherStudent: { id: string };
const stamp = Date.now();
const cleanupExamIds: string[] = [];
const cleanupUserIds: string[] = [];
let passwordHashForNewUsers: string;

/** A fresh, isolated student for tests that register Tether installations — TetherClientInstallation caps active installations per user (default 2), so tests that each need 1-2 of their own must never share a student with each other. */
async function makeStudent(tag: string) {
  const user = await prisma.user.create({
    data: { name: `Recovery Student ${tag}`, email: `recovery-stud-${tag}-${stamp}@test.local`, passwordHash: passwordHashForNewUsers, role: "STUDENT", institutionId: testInstitution.id },
  });
  cleanupUserIds.push(user.id);
  return user;
}

beforeAll(async () => {
  testInstitution = await getOrCreateTestInstitution("tether-recovery-test");
  passwordHashForNewUsers = await bcrypt.hash("test-password", 4);
  lecturer = await prisma.user.create({
    data: { name: "Recovery Lecturer", email: `recovery-lect-${stamp}@test.local`, passwordHash: passwordHashForNewUsers, role: "LECTURER", institutionId: testInstitution.id },
  });
  student = await prisma.user.create({
    data: { name: "Recovery Student", email: `recovery-stud-${stamp}@test.local`, passwordHash: passwordHashForNewUsers, role: "STUDENT", institutionId: testInstitution.id },
  });
  otherStudent = await prisma.user.create({
    data: { name: "Recovery Other Student", email: `recovery-stud2-${stamp}@test.local`, passwordHash: passwordHashForNewUsers, role: "STUDENT", institutionId: testInstitution.id },
  });
});

afterAll(async () => {
  await prisma.secureClientEvent.deleteMany({ where: { examId: { in: cleanupExamIds } } });
  await prisma.secureClientAttestation.deleteMany({ where: { session: { examId: { in: cleanupExamIds } } } });
  await prisma.secureClientSession.deleteMany({ where: { examId: { in: cleanupExamIds } } });
  await prisma.secureClientLaunchManifest.deleteMany({ where: { examId: { in: cleanupExamIds } } });
  await prisma.answer.deleteMany({ where: { submission: { examId: { in: cleanupExamIds } } } });
  await prisma.submission.deleteMany({ where: { examId: { in: cleanupExamIds } } });
  await prisma.question.deleteMany({ where: { examId: { in: cleanupExamIds } } });
  await prisma.exam.deleteMany({ where: { id: { in: cleanupExamIds } } });
  const allStudentIds = [student.id, otherStudent.id, ...cleanupUserIds];
  await prisma.platformAuditLog.deleteMany({ where: { actorId: { in: allStudentIds } } });
  await prisma.tetherClientInstallation.deleteMany({ where: { userId: { in: allStudentIds } } });
  await prisma.user.deleteMany({ where: { id: { in: [lecturer.id, ...allStudentIds] } } });
  await prisma.$disconnect();
});

async function createTetherExam(title: string, extraSettings: Record<string, unknown> = {}) {
  const exam = await prisma.exam.create({
    data: {
      title: `${title} ${stamp}-${Math.random()}`,
      durationMins: 30,
      published: true,
      createdById: lecturer.id,
      institutionId: testInstitution.id,
      secureSettings: { deliveryMode: "TETHER_CLIENT_REQUIRED", ...extraSettings },
    },
  });
  cleanupExamIds.push(exam.id);
  await prisma.question.create({ data: { examId: exam.id, type: "SHORT_ANSWER", text: "Q1", points: 1, correctAnswer: "ok" } });
  return exam;
}

async function startAsStudent(examId: string, studentUser: { id: string } = student) {
  mockAuth.mockResolvedValue(sessionFor(studentUser.id, "STUDENT"));
  const res = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: examId }) });
  expect(res.status).toBeLessThan(300);
  return res.json();
}

/** Registers a fresh Tether installation for the given student, returning the id and keypair for signing exam-session attestations. */
async function registerInstallation(studentUser: { id: string }, tag: string) {
  mockAuth.mockResolvedValue(sessionFor(studentUser.id, "STUDENT"));
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const challengeRes = await registrationChallengeRoute.POST(jsonRequest("POST", { publicKey: publicKeyPem }));
  expect(challengeRes.status).toBe(200);
  const { challenge, signature } = await challengeRes.json();

  const proofOfPossessionSignature = signRegistrationProofOfPossession(challenge.nonce, privateKeyPem);
  const registerRes = await registerRoute.POST(
    jsonRequest("POST", {
      challenge,
      challengeSignature: signature,
      publicKey: publicKeyPem,
      keyAlgorithm: "Ed25519",
      keyProtectionLevel: "SOFTWARE_PROTECTED",
      proofOfPossessionSignature,
      clientVersion: "1.6.0",
      platform: "win32",
    }),
  );
  expect(registerRes.status).toBe(200);
  const body = await registerRes.json();
  expect(body.registered).toBe(true);
  return { installationId: body.installationId as string, privateKeyPem, tag };
}

/** Runs a real EXAM_SESSION v2 attestation for the CURRENT secure-client session of `submissionId`, signed by `installation`'s own key. */
async function attestExamSessionV2(studentUser: { id: string }, submissionId: string, installation: { installationId: string; privateKeyPem: string }) {
  mockAuth.mockResolvedValue(sessionFor(studentUser.id, "STUDENT"));
  const challengeRes = await examSessionChallengeRoute.POST(jsonRequest("POST", { installationId: installation.installationId, submissionId }));
  if (challengeRes.status !== 200) return { status: challengeRes.status, body: await challengeRes.json() };
  const { challenge, signature: challengeSignature } = await challengeRes.json();

  // Signed ONCE and reused verbatim in the request body below — the
  // server reconstructs the exact same canonical string from whatever
  // `timestamp` the request body claims, so signing with a DIFFERENT
  // timestamp than the one actually sent would make the installation
  // signature fail to verify (this bit the first draft of this helper).
  const timestamp = new Date().toISOString();
  const canonical = buildExamSessionAttestationCanonicalString({
    nonce: challenge.nonce,
    installationPublicKeyFingerprint: challenge.installationPublicKeyFingerprint,
    clientVersion: "1.6.0",
    platform: "win32",
    displayTopologyClassification: "INTERNAL_ONLY",
    displayCount: 1,
    examId: challenge.examId,
    submissionId: challenge.submissionId,
    policyHash: challenge.policyHash,
    secureClientSessionId: challenge.secureClientSessionId,
    capabilities: "clipboard",
    timestamp,
  });
  const installationSignature = crypto.sign(null, Buffer.from(canonical, "utf8"), installation.privateKeyPem).toString("base64");

  const verifyRes = await examSessionVerifyRoute.POST(
    jsonRequest("POST", {
      challenge,
      challengeSignature,
      installationSignature,
      clientVersion: "1.6.0",
      platform: "win32",
      displayTopologyClassification: "INTERNAL_ONLY",
      displayCount: 1,
      capabilities: "clipboard",
      timestamp,
    }),
  );
  return { status: verifyRes.status, body: await verifyRes.json() };
}

/** Real launch -> consume sequence, exactly like the tether-launch page — each call may create a fresh session (superseding any existing non-terminal one). */
async function launchAndConsume(studentUser: { id: string }, submissionId: string) {
  mockAuth.mockResolvedValue(sessionFor(studentUser.id, "STUDENT"));
  const launchRes = await launchRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submissionId }) });
  expect(launchRes.status).toBe(201);
  const { manifest, signature } = await launchRes.json();
  const consumeRes = await consumeRoute.POST(jsonRequest("POST", { manifest, signature }), { params: Promise.resolve({ manifestId: manifest.manifestId }) });
  expect(consumeRes.status).toBe(200);
  const body = await consumeRes.json();
  expect(body.ok).toBe(true);
  return body.sessionId as string;
}

describe("Autosave idempotency and revision control (Part 2)", () => {
  it("1. retrying the same clientRequestId returns the previous acknowledgement without creating a duplicate row", async () => {
    const exam = await createTetherExam("Idempotent Autosave");
    const submission = await startAsStudent(exam.id);
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));

    const question = await prisma.question.findFirstOrThrow({ where: { examId: exam.id } });
    const payload = { questionId: question.id, response: "first answer", clientRequestId: "req-A", clientRevision: 1 };

    const first = await answersRoute.PATCH(jsonRequest("PATCH", payload), { params: Promise.resolve({ id: submission.id }) });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.acknowledgedRevision).toBe(1);

    const retry = await answersRoute.PATCH(jsonRequest("PATCH", payload), { params: Promise.resolve({ id: submission.id }) });
    expect(retry.status).toBe(200);
    const retryBody = await retry.json();
    expect(retryBody.response).toBe("first answer");
    expect(retryBody.acknowledgedRevision).toBe(1);

    const rows = await prisma.answer.findMany({ where: { submissionId: submission.id, questionId: question.id } });
    expect(rows).toHaveLength(1);
  });

  it("2. two concurrent duplicate autosave requests produce exactly one logical save, never two rows", async () => {
    const exam = await createTetherExam("Concurrent Autosave");
    const submission = await startAsStudent(exam.id);
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));
    const question = await prisma.question.findFirstOrThrow({ where: { examId: exam.id } });
    const payload = { questionId: question.id, response: "concurrent answer", clientRequestId: "req-concurrent", clientRevision: 1 };

    const [a, b] = await Promise.all([
      answersRoute.PATCH(jsonRequest("PATCH", payload), { params: Promise.resolve({ id: submission.id }) }),
      answersRoute.PATCH(jsonRequest("PATCH", payload), { params: Promise.resolve({ id: submission.id }) }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const rows = await prisma.answer.findMany({ where: { submissionId: submission.id, questionId: question.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].response).toBe("concurrent answer");
  });

  it("3/34. a stale (older or equal) revision cannot overwrite a newer acknowledged revision, and never creates a duplicate row", async () => {
    const exam = await createTetherExam("Stale Revision");
    const submission = await startAsStudent(exam.id);
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));
    const question = await prisma.question.findFirstOrThrow({ where: { examId: exam.id } });

    const newer = await answersRoute.PATCH(
      jsonRequest("PATCH", { questionId: question.id, response: "revision two", clientRequestId: "req-2", clientRevision: 2 }),
      { params: Promise.resolve({ id: submission.id }) },
    );
    expect(newer.status).toBe(200);

    // A stale/late arrival of an OLDER revision under a DIFFERENT request id.
    const stale = await answersRoute.PATCH(
      jsonRequest("PATCH", { questionId: question.id, response: "revision one (stale)", clientRequestId: "req-1", clientRevision: 1 }),
      { params: Promise.resolve({ id: submission.id }) },
    );
    expect(stale.status).toBe(200);
    const staleBody = await stale.json();
    // Must not regress — the current authoritative response is still the newer one.
    expect(staleBody.response).toBe("revision two");
    expect(staleBody.acknowledgedRevision).toBe(2);

    const rows = await prisma.answer.findMany({ where: { submissionId: submission.id, questionId: question.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].response).toBe("revision two");
  });

  // Post-merge correctness review — the sequential test above ("3/34")
  // only proves the app-level revision check works when the newer save
  // has already COMMITTED before the stale one is even sent. It does NOT
  // exercise genuine concurrency: two requests racing so closely that
  // BOTH read "no existing row / no conflicting revision yet" before
  // either commits. Before the fix (an advisory lock scoped to
  // (submissionId, questionId) — see answers/route.ts), Prisma's
  // upsert() compiles to an unconditional `ON CONFLICT DO UPDATE` with no
  // WHERE guard, so whichever request's write physically landed LAST at
  // the database always won — a lower revision could silently overwrite
  // a higher one. Repeated across many iterations (a single race can get
  // lucky) with genuinely concurrent Promise.all calls, each targeting a
  // FRESH question so no request ever benefits from a prior committed row
  // to read as a guard.
  it("3b/4b. concurrent PATCHes with differing revisions never let the lower one win, across many repeated races", async () => {
    const exam = await createTetherExam("Concurrent Differing Revisions");
    const submission = await startAsStudent(exam.id);
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));

    const ITERATIONS = 25;
    for (let i = 0; i < ITERATIONS; i++) {
      const question = await prisma.question.create({ data: { examId: exam.id, type: "SHORT_ANSWER", text: `Race Q${i}`, points: 1 } });

      const [low, high] = await Promise.all([
        answersRoute.PATCH(
          jsonRequest("PATCH", { questionId: question.id, response: "LOW", clientRequestId: `race-low-${i}`, clientRevision: 1 }),
          { params: Promise.resolve({ id: submission.id }) },
        ),
        answersRoute.PATCH(
          jsonRequest("PATCH", { questionId: question.id, response: "HIGH", clientRequestId: `race-high-${i}`, clientRevision: 5 }),
          { params: Promise.resolve({ id: submission.id }) },
        ),
      ]);
      expect(low.status).toBe(200);
      expect(high.status).toBe(200);

      const rows = await prisma.answer.findMany({ where: { submissionId: submission.id, questionId: question.id } });
      expect(rows).toHaveLength(1);
      // The higher revision must be the one on record, regardless of
      // which request's fetch happened to resolve/commit last.
      expect(rows[0].clientRevision).toBe(5);
      expect(rows[0].response).toBe("HIGH");
    }
  });

  it("4. a genuinely newer revision safely supersedes an earlier acknowledged one", async () => {
    const exam = await createTetherExam("Newer Revision Supersedes");
    const submission = await startAsStudent(exam.id);
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));
    const question = await prisma.question.findFirstOrThrow({ where: { examId: exam.id } });

    await answersRoute.PATCH(jsonRequest("PATCH", { questionId: question.id, response: "v1", clientRequestId: "req-1", clientRevision: 1 }), {
      params: Promise.resolve({ id: submission.id }),
    });
    const second = await answersRoute.PATCH(
      jsonRequest("PATCH", { questionId: question.id, response: "v2", clientRequestId: "req-2", clientRevision: 2 }),
      { params: Promise.resolve({ id: submission.id }) },
    );
    const body = await second.json();
    expect(body.response).toBe("v2");
    expect(body.acknowledgedRevision).toBe(2);
  });

  it("malformed/cross-submission request ids never let another student's request affect this submission's answer", async () => {
    const examA = await createTetherExam("Cross Submission A");
    const examB = await createTetherExam("Cross Submission B");
    const submissionA = await startAsStudent(examA.id, student);
    const submissionB = await startAsStudent(examB.id, otherStudent);
    const questionA = await prisma.question.findFirstOrThrow({ where: { examId: examA.id } });
    const questionB = await prisma.question.findFirstOrThrow({ where: { examId: examB.id } });

    // Both students happen to reuse the exact same clientRequestId string —
    // each Answer row is scoped to its OWN submissionId+questionId, so
    // there is no global lookup by clientRequestId that could ever let one
    // affect the other's answer.
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));
    await answersRoute.PATCH(
      jsonRequest("PATCH", { questionId: questionA.id, response: "student A's answer", clientRequestId: "shared-id", clientRevision: 1 }),
      { params: Promise.resolve({ id: submissionA.id }) },
    );
    mockAuth.mockResolvedValue(sessionFor(otherStudent.id, "STUDENT"));
    await answersRoute.PATCH(
      jsonRequest("PATCH", { questionId: questionB.id, response: "student B's answer", clientRequestId: "shared-id", clientRevision: 1 }),
      { params: Promise.resolve({ id: submissionB.id }) },
    );

    const rowA = await prisma.answer.findFirstOrThrow({ where: { submissionId: submissionA.id, questionId: questionA.id } });
    const rowB = await prisma.answer.findFirstOrThrow({ where: { submissionId: submissionB.id, questionId: questionB.id } });
    expect(rowA.response).toBe("student A's answer");
    expect(rowB.response).toBe("student B's answer");

    // 22 — a student may never even reach the other's submission at all.
    mockAuth.mockResolvedValue(sessionFor(otherStudent.id, "STUDENT"));
    const cross = await answersRoute.PATCH(
      jsonRequest("PATCH", { questionId: questionA.id, response: "attempted cross-student write" }),
      { params: Promise.resolve({ id: submissionA.id }) },
    );
    expect(cross.status).toBe(404);
  });
});

describe("Final submission idempotency (Part 9)", () => {
  it("32. duplicate final submission (same submissionRequestId) is idempotent and audited distinctly on replay", async () => {
    const exam = await createTetherExam("Idempotent Submit");
    const submission = await startAsStudent(exam.id);
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));
    const question = await prisma.question.findFirstOrThrow({ where: { examId: exam.id } });
    await answersRoute.PATCH(jsonRequest("PATCH", { questionId: question.id, response: "ok" }), { params: Promise.resolve({ id: submission.id }) });

    const first = await submitRoute.POST(jsonRequest("POST", { submissionRequestId: "submit-req-1" }), { params: Promise.resolve({ id: submission.id }) });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.status).toBe("GRADED");

    const before = await prisma.platformAuditLog.count({ where: { action: "TETHER_IDEMPOTENT_FINAL_SUBMISSION_REPLAY_RESOLVED", targetId: submission.id } });
    const replay = await submitRoute.POST(jsonRequest("POST", { submissionRequestId: "submit-req-1" }), { params: Promise.resolve({ id: submission.id }) });
    expect(replay.status).toBe(200);
    const replayBody = await replay.json();
    expect(replayBody.code).toBe("ALREADY_FINALIZED");
    expect(replayBody.status).toBe("GRADED");
    const after = await prisma.platformAuditLog.count({ where: { action: "TETHER_IDEMPOTENT_FINAL_SUBMISSION_REPLAY_RESOLVED", targetId: submission.id } });
    expect(after).toBe(before + 1);

    // 21 — a submitted attempt never reopens.
    const stored = await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(stored.status).not.toBe("IN_PROGRESS");
  });

  it("33. after a lost response, querying submission status confirms prior acceptance ('Checking submission status')", async () => {
    const exam = await createTetherExam("Confirm Prior Acceptance");
    const submission = await startAsStudent(exam.id);
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));
    await submitRoute.POST(jsonRequest("POST", { submissionRequestId: "submit-req-timeout" }), { params: Promise.resolve({ id: submission.id }) });

    // The client never saw the response (simulated network loss) — GET is
    // the authoritative way to resolve the ambiguity.
    const statusRes = await submissionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    expect(statusRes.status).toBe(200);
    const statusBody = await statusRes.json();
    expect(["SUBMITTED", "GRADED"]).toContain(statusBody.status);
  });
});

describe("Crash, relaunch and Windows-restart recovery (Parts 6-8)", () => {
  it("15/16/35/36. a relaunch supersedes the old session, requires fresh (unverified) attestation on the new one, and completing it increments resumeCount exactly once with the expected audit trail", async () => {
    const testStudent = await makeStudent("full-recovery");
    const exam = await createTetherExam("Full Recovery Flow");
    const submission = await startAsStudent(exam.id, testStudent);
    const installation = await registerInstallation(testStudent, "primary");

    const session1Id = await launchAndConsume(testStudent, submission.id);
    const attest1 = await attestExamSessionV2(testStudent, submission.id, installation);
    expect(attest1.status).toBe(200);
    expect(attest1.body.verified).toBe(true);

    const session1Before = await prisma.secureClientSession.findUniqueOrThrow({ where: { id: session1Id } });
    expect(session1Before.installationAttestationVerified).toBe(true);
    expect(session1Before.status).toBe("CREATED"); // legacy status untouched by v2 — see verifyExamSessionAttestation's own doc comment

    // Simulate a Tether crash + relaunch: the client goes through the
    // launch/consume sequence again for the SAME submission.
    const session2Id = await launchAndConsume(testStudent, submission.id);
    expect(session2Id).not.toBe(session1Id);

    const session1After = await prisma.secureClientSession.findUniqueOrThrow({ where: { id: session1Id } });
    expect(session1After.status).toBe("ENDED");
    expect(session1After.closeReason).toBe("SUPERSEDED_BY_RELAUNCH");
    expect(session1After.closedAt).not.toBeNull();

    const session2 = await prisma.secureClientSession.findUniqueOrThrow({ where: { id: session2Id } });
    expect(session2.recoveryOfSessionId).toBe(session1Id);
    // 16/17 — the fresh session never inherits the old one's verified state.
    expect(session2.verificationStatus).toBe("NOT_CHECKED");
    expect(session2.installationAttestationVerified).toBe(false);

    const submissionBeforeCompletion = await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(submissionBeforeCompletion.resumeCount).toBe(0);

    const attest2 = await attestExamSessionV2(testStudent, submission.id, installation);
    expect(attest2.status).toBe(200);
    expect(attest2.body.verified).toBe(true);

    const submissionAfterCompletion = await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(submissionAfterCompletion.resumeCount).toBe(1);
    expect(submissionAfterCompletion.lastResumedAt).not.toBeNull();

    const initiatedAudit = await prisma.platformAuditLog.count({ where: { action: "TETHER_SECURE_RESUME_INITIATED", targetId: submission.id } });
    const completedAudit = await prisma.platformAuditLog.count({ where: { action: "TETHER_SECURE_RESUME_COMPLETED", targetId: submission.id } });
    expect(initiatedAudit).toBeGreaterThanOrEqual(1);
    expect(completedAudit).toBe(1);

    // 31 — no IntegrityEvent is ever created by this whole crash-recovery flow.
    const integrityEvents = await prisma.integrityEvent.count({ where: { submissionId: submission.id } });
    expect(integrityEvents).toBe(0);
  });

  it("24/36. a DIFFERENT registered installation attempting to complete the recovery is denied (device change), never silently taking over", async () => {
    const testStudent = await makeStudent("device-change");
    const exam = await createTetherExam("Device Change Denied");
    const submission = await startAsStudent(exam.id, testStudent);
    const primaryInstallation = await registerInstallation(testStudent, "device-A");
    const secondInstallation = await registerInstallation(testStudent, "device-B");

    const session1Id = await launchAndConsume(testStudent, submission.id);
    const firstAttest = await attestExamSessionV2(testStudent, submission.id, primaryInstallation);
    expect(firstAttest.body.verified).toBe(true);

    // Relaunch — session1 is superseded by session2.
    await launchAndConsume(testStudent, submission.id);

    // A DIFFERENT installation now attempts to complete the recovery.
    const deviceChangeAttempt = await attestExamSessionV2(testStudent, submission.id, secondInstallation);
    expect(deviceChangeAttempt.status).toBe(409);
    expect(deviceChangeAttempt.body.reason).toBe("DEVICE_CHANGE_DETECTED");

    const submissionAfter = await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(submissionAfter.resumeCount).toBe(0);

    const deniedAudit = await prisma.platformAuditLog.count({ where: { action: "TETHER_SECURE_RESUME_DENIED_DEVICE_CHANGE", targetId: submission.id } });
    expect(deniedAudit).toBe(1);

    // Never an IntegrityEvent — a device change is a technical/
    // administrative fact, never a misconduct signal (Part 8/13).
    const integrityEvents = await prisma.integrityEvent.count({ where: { submissionId: submission.id } });
    expect(integrityEvents).toBe(0);
    void session1Id;
  });

  it("23. a revoked installation cannot complete a recovery attestation", async () => {
    const testStudent = await makeStudent("revoked");
    const exam = await createTetherExam("Revoked Installation");
    const submission = await startAsStudent(exam.id, testStudent);
    const installation = await registerInstallation(testStudent, "to-be-revoked");
    await launchAndConsume(testStudent, submission.id);

    await prisma.tetherClientInstallation.update({ where: { id: installation.installationId }, data: { status: "REVOKED", revokedAt: new Date() } });

    // Revocation is caught as early as challenge ISSUANCE (never even
    // reaches verify) — see issueAttestationChallenge's own
    // INSTALLATION_NOT_ACTIVE check.
    const attempt = await attestExamSessionV2(testStudent, submission.id, installation);
    expect(attempt.status).toBe(409);
    expect(typeof attempt.body.error).toBe("string");
    expect(attempt.body.error.toLowerCase()).toContain("no longer active");
  });

  it("13/14. Tether relaunch never regenerates question order or pool allocation", async () => {
    const exam = await createTetherExam("Order Preserved On Relaunch", { randomiseQuestionOrder: true });
    await prisma.question.create({ data: { examId: exam.id, type: "SHORT_ANSWER", text: "Q2", points: 1, order: 1 } });
    await prisma.question.create({ data: { examId: exam.id, type: "SHORT_ANSWER", text: "Q3", points: 1, order: 2 } });
    const submission = await startAsStudent(exam.id);
    const before = await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } });

    await launchAndConsume(student, submission.id);
    await launchAndConsume(student, submission.id); // relaunch

    const after = await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(after.questionOrderJson).toEqual(before.questionOrderJson);
  });

  it("10/11/12/38. relaunching never resets startedAt, extends the deadline, or alters the frozen timing-policy snapshot", async () => {
    const exam = await createTetherExam("Timing Never Resets");
    const submission = await startAsStudent(exam.id);
    const before = await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } });

    await launchAndConsume(student, submission.id);
    const finalSessionId = await launchAndConsume(student, submission.id); // relaunch
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));
    await heartbeatRoute.POST(jsonRequest("POST", {}), { params: Promise.resolve({ id: submission.id }) });

    const after = await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(after.startedAt.getTime()).toBe(before.startedAt.getTime());
    expect(after.examPolicySnapshotJson).toEqual(before.examPolicySnapshotJson);

    // Legacy attestation on the CURRENT (post-relaunch) session, so GET's
    // content-exposure gate allows this read through — content gating
    // itself is covered by its own describe block below; here it's just
    // the means to read back the server-computed deadline.
    const attestationRoute = await import("../app/api/secure-client/sessions/[sessionId]/attestation/route");
    await attestationRoute.POST(jsonRequest("POST", { clientType: "TETHER_SECURE_CLIENT", checks: {}, required: {} }), {
      params: Promise.resolve({ sessionId: finalSessionId }),
    });

    const getRes = await submissionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    const expectedDeadline = new Date(before.startedAt.getTime() + exam.durationMins * 60_000).toISOString();
    expect(new Date(getBody.deadline).toISOString()).toBe(expectedDeadline);
  });
});

describe("Freshness-gated verification (Part 6) — 'a previously verified session alone cannot restore content'", () => {
  it("17/19. once a verified session's contact has gone stale beyond the offline-continue window, content is blocked again — an ordinary browser gains nothing from the old VERIFIED row", async () => {
    vi.stubEnv("TETHER_OFFLINE_CONTINUE_MINUTES", "2");
    try {
      const exam = await createTetherExam("Staleness Blocks Content");
      const submission = await startAsStudent(exam.id);
      const sessionId = await launchAndConsume(student, submission.id);

      // Legacy attestation — simplest path to a genuinely VERIFIED session.
      mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));
      const attestationRoute = await import("../app/api/secure-client/sessions/[sessionId]/attestation/route");
      const attestRes = await attestationRoute.POST(jsonRequest("POST", { clientType: "TETHER_SECURE_CLIENT", checks: {}, required: {} }), {
        params: Promise.resolve({ sessionId }),
      });
      expect(attestRes.status).toBe(201);

      const verified = await prisma.secureClientSession.findUniqueOrThrow({ where: { id: sessionId } });
      expect(verified.verificationStatus).toBe("VERIFIED");

      // Content is accessible immediately after verification.
      const freshGet = await submissionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
      expect(freshGet.status).toBe(200);

      // Simulate a long-dead process: backdate contact far beyond the
      // (stubbed, 2-minute) offline-continue window — nothing else about
      // the row changes; verificationStatus is STILL "VERIFIED".
      const longAgo = new Date(Date.now() - 60 * 60_000);
      await prisma.secureClientSession.update({ where: { id: sessionId }, data: { startedAt: longAgo, lastHeartbeatAt: longAgo } });

      const staleGet = await submissionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
      expect(staleGet.status).toBe(403);
      const staleBody = await staleGet.json();
      expect(staleBody.code).toBe("TETHER_SESSION_REQUIRED");
    } finally {
      vi.unstubAllEnvs();
      vi.stubEnv("TETHER_SECURE_CLIENT_SIGNING_PUBLIC_KEY", serverPublicKey.export({ type: "spki", format: "pem" }).toString());
      vi.stubEnv("TETHER_SECURE_CLIENT_SIGNING_PRIVATE_KEY", serverPrivateKey.export({ type: "pkcs8", format: "pem" }).toString());
    }
  });
});

describe("Heartbeat (Part 5)", () => {
  it("28/29. a heartbeat updates the secure-client session's lastHeartbeatAt and creates no IntegrityEvent", async () => {
    const exam = await createTetherExam("Heartbeat Updates Contact");
    const submission = await startAsStudent(exam.id);
    const sessionId = await launchAndConsume(student, submission.id);
    const before = await prisma.secureClientSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(before.lastHeartbeatAt).toBeNull();

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));
    const res = await heartbeatRoute.POST(jsonRequest("POST", { pendingSaveCount: 2 }), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(200);

    const after = await prisma.secureClientSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(after.lastHeartbeatAt).not.toBeNull();

    const integrityEvents = await prisma.integrityEvent.count({ where: { submissionId: submission.id } });
    expect(integrityEvents).toBe(0);
  });
});

describe("Recovery-status endpoint authorization and non-final-assessment regression", () => {
  it("22. another student cannot read this submission's recovery status", async () => {
    const exam = await createTetherExam("Recovery Status Ownership");
    const submission = await startAsStudent(exam.id, student);
    mockAuth.mockResolvedValue(sessionFor(otherStudent.id, "STUDENT"));
    const res = await recoveryStatusRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(404);
  });

  it("24. MANUAL_REVIEW_REQUIRED when the requesting installation differs from the one bound to the current session", async () => {
    const testStudent = await makeStudent("status-hint");
    const exam = await createTetherExam("Recovery Status Device Change Hint");
    const submission = await startAsStudent(exam.id, testStudent);
    const installationA = await registerInstallation(testStudent, "status-A");
    const installationB = await registerInstallation(testStudent, "status-B");
    await launchAndConsume(testStudent, submission.id);
    const attest = await attestExamSessionV2(testStudent, submission.id, installationA);
    expect(attest.body.verified).toBe(true);

    mockAuth.mockResolvedValue(sessionFor(testStudent.id, "STUDENT"));
    const req = new Request(`http://test.local/route?installationId=${installationB.installationId}`, { method: "GET" });
    const res = await recoveryStatusRoute.GET(req, { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe("MANUAL_REVIEW_REQUIRED");
  });

  it("SUBMITTED state once finalized; 21 — never reopens", async () => {
    const exam = await createTetherExam("Recovery Status Submitted");
    const submission = await startAsStudent(exam.id);
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));
    await submitRoute.POST(jsonRequest("POST", {}), { params: Promise.resolve({ id: submission.id }) });
    const res = await recoveryStatusRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    const body = await res.json();
    expect(body.state).toBe("SUBMITTED");
  });

  it("37. a non-Tether (STANDARD_WEB) assessment's autosave/submit behaviour is completely unaffected", async () => {
    const exam = await prisma.exam.create({
      data: { title: `Non-Final Regression ${stamp}`, durationMins: 30, published: true, createdById: lecturer.id, institutionId: testInstitution.id },
    });
    cleanupExamIds.push(exam.id);
    const question = await prisma.question.create({ data: { examId: exam.id, type: "SHORT_ANSWER", text: "Q1", points: 1, correctAnswer: "ok" } });
    const submission = await startAsStudent(exam.id);
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));
    const saveRes = await answersRoute.PATCH(jsonRequest("PATCH", { questionId: question.id, response: "ok" }), { params: Promise.resolve({ id: submission.id }) });
    expect(saveRes.status).toBe(200);
    const submitRes = await submitRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submission.id }) });
    expect(submitRes.status).toBe(200);
    const submitBody = await submitRes.json();
    expect(submitBody.status).toBe("GRADED");
  });
});
