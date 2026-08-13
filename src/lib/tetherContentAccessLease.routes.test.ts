/**
 * Release-blocking server content-boundary audit — see
 * src/lib/secureClient/tetherContentAccessLease.ts and
 * src/lib/secureClient/requireTetherContentAccess.ts.
 *
 * CONFIRMED VULNERABILITY #1 this proves closed: every existing content
 * gate for a TETHER_CLIENT_REQUIRED attempt (hasVerifiedTetherSession /
 * isSubmissionContentAccessible) was SUBMISSION-bound only — a plain
 * database read keyed by submissionId, with no way to tell whether the
 * CURRENT HTTP request actually originated from the Tether installation
 * that established that trust.
 *
 * CONFIRMED VULNERABILITY #2 (release-blocking follow-up review) this
 * ALSO proves closed: the first version of this fix issued the lease
 * from LEGACY attestation reaching VERIFIED — but legacy attestation
 * (POST /api/secure-client/sessions/[sessionId]/attestation) carries no
 * installation private-key signature at all; its body (checks/required/
 * displayCount/clientVersion) is entirely client-self-reported. An
 * ordinary authenticated browser could POST a fabricated body straight
 * to that endpoint (checks:{}, required:{} always resolves to
 * overallStatus READY) and manufacture the lease itself. These tests
 * prove that path is now closed, and that only a genuine v2
 * installation-key attestation (POST
 * /api/tether/exam-session/attestation/verify) can ever mint one.
 *
 * These tests drive the REAL routes end-to-end (exam start -> legacy
 * attestation for verificationStatus compatibility -> installation
 * registration -> v2 EXAM_SESSION attestation -> activation -> content
 * fetch) exactly the way a genuine Tether launch does, then prove an
 * ordinary, separately-authenticated request for the SAME account and
 * the SAME already-activated submission — but without the lease cookie
 * only Tether's own cookie jar would carry — is denied.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";

// A self-contained signing keypair for THIS file only (mirrors
// tetherRecovery.routes.test.ts's own pattern) — v2 attestation success
// (the sole lease-issuance point) requires
// TETHER_SECURE_CLIENT_SIGNING_PRIVATE_KEY/PUBLIC_KEY to be configured;
// this file cannot assume another test file's env stub ran first.
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
const answersRoute = await import("../app/api/submissions/[id]/answers/route");
const legacyAttestationRoute = await import("../app/api/secure-client/sessions/[sessionId]/attestation/route");
const registrationChallengeRoute = await import("../app/api/tether/installation/registration-challenge/route");
const registerRoute = await import("../app/api/tether/installation/register/route");
const examSessionChallengeRoute = await import("../app/api/tether/exam-session/attestation/challenge/route");
const examSessionVerifyRoute = await import("../app/api/tether/exam-session/attestation/verify/route");
const { signRegistrationProofOfPossession, buildExamSessionAttestationCanonicalString } = await import("./secureClient/tetherAttestation");
const { CONTENT_ACCESS_LEASE_COOKIE_NAME, buildContentAccessLeaseClaims, encodeContentAccessLeaseCookieValue } = await import("./secureClient/tetherContentAccessLease");
const { TETHER_CONTENT_ACCESS_REQUIRED_CODE } = await import("./secureClient/requireTetherContentAccess");
const { getSigningPrivateKey, getSigningKeyId } = await import("./secureClientRunner");
const questionRoute = await import("../app/api/submissions/[id]/question/route");
const submitRoute = await import("../app/api/submissions/[id]/submit/route");
const sessionHeartbeatRoute = await import("../app/api/submissions/[id]/session-heartbeat/route");

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

function extractSetCookieToken(res: Response, cookieName: string): string | null {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) return null;
  const match = setCookie.match(new RegExp(`${cookieName}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

let institutionId: string;
let lecturerId: string;

beforeAll(async () => {
  const inst = await getOrCreateTestInstitution(`tether-content-lease-${stamp}`);
  institutionId = inst.id;
  const passwordHash = await bcrypt.hash("password", 4);
  const lecturer = await prisma.user.create({
    data: { name: "Lease Lecturer", email: `lease-lecturer-${stamp}@test.invalid`, passwordHash, role: "LECTURER", institutionId },
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
    data: { name: `Lease Student ${tag}`, email: `lease-${tag}-${stamp}@test.invalid`, passwordHash, role: "STUDENT", institutionId },
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

/** Registers a fresh Tether installation for the given student, returning the id and keypair for signing exam-session attestations. */
async function registerInstallation(student: { id: string }, tag: string) {
  mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
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

/**
 * Drives a REAL v2 EXAM_SESSION attestation — the ONLY legitimate lease
 * issuance point. `installation` must already be registered (or a
 * mismatched one may be passed deliberately to prove rejection).
 */
async function attestExamSessionV2(student: { id: string }, submissionId: string, installation: { installationId: string; privateKeyPem: string }) {
  mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
  const challengeRes = await examSessionChallengeRoute.POST(jsonRequest("POST", { installationId: installation.installationId, submissionId }));
  if (challengeRes.status !== 200) return { status: challengeRes.status, body: await challengeRes.json(), res: challengeRes };
  const { challenge, signature: challengeSignature } = await challengeRes.json();

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
  return { status: verifyRes.status, body: await verifyRes.json(), res: verifyRes };
}

/**
 * Drives the exact legitimate lifecycle up through server-side
 * activation: start -> legacy attestation (verificationStatus
 * compatibility only, issues NO lease) -> installation registration ->
 * genuine v2 EXAM_SESSION attestation (the ONLY lease-issuance point) ->
 * activate, using the lease cookie the v2 verify response itself issued.
 */
async function activateViaLegitimateTetherFlow(student: { id: string }, exam: { id: string }) {
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
      status: "PREFLIGHT",
      verificationStatus: "NOT_CHECKED",
    },
  });

  // Legacy attestation still establishes verificationStatus VERIFIED
  // (backward-compatible semantics), but MUST NOT issue a lease.
  const legacyAttestRes = await legacyAttestationRoute.POST(jsonRequest("POST", { clientType: "TETHER_SECURE_CLIENT", checks: {}, required: {} }), {
    params: Promise.resolve({ sessionId: secureClientSession.id }),
  });
  expect(legacyAttestRes.status).toBe(201);
  const legacyBody = await legacyAttestRes.json();
  expect(legacyBody.overallStatus).toBe("READY");
  expect(legacyAttestRes.headers.get("set-cookie")).toBeNull();

  const installation = await registerInstallation(student, `legit-${submission.id}`);
  const v2Result = await attestExamSessionV2(student, submission.id, installation);
  expect(v2Result.status).toBe(200);
  expect(v2Result.body.verified).toBe(true);
  const leaseToken = extractSetCookieToken(v2Result.res, CONTENT_ACCESS_LEASE_COOKIE_NAME);
  expect(leaseToken).toBeTruthy();
  const leaseCookie = `${CONTENT_ACCESS_LEASE_COOKIE_NAME}=${leaseToken}`;

  const activateRes = await activateRoute.POST(jsonRequest("POST", undefined, leaseCookie), { params: Promise.resolve({ id: submission.id }) });
  expect(activateRes.status).toBe(200);
  const activateBody = await activateRes.json();
  expect(activateBody.alreadyActivated).toBe(false);

  return { submissionId: submission.id as string, leaseCookie, examId: exam.id as string, installation };
}

/** The current (non-terminal) SecureClientSession for a submission — same lookup every existing superseded/wrong-installation test already uses. */
async function currentSessionFor(submissionId: string) {
  return prisma.secureClientSession.findFirstOrThrow({
    where: { submissionId, status: { in: ["CREATED", "PREFLIGHT", "ACTIVE", "INTERRUPTED", "RECOVERY_REQUIRED"] } },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Builds a lease cookie that is genuinely, cryptographically valid — signed
 * with the SAME server key pair every real route verifies against — but
 * whose issuedAt/expiresAt are computed as if it had been minted `ageMs`
 * ago, rather than right now. This is what lets these tests exercise "a
 * lease minted 25/29/31 real minutes ago" deterministically, without
 * actually waiting real minutes: isContentAccessLeaseExpired only ever
 * compares the claims' own expiresAt against the real Date.now() at check
 * time, so backdating issuedAt (and therefore expiresAt = issuedAt + TTL)
 * has the exact same effect as if that much wall-clock time had genuinely
 * elapsed.
 */
async function buildLeaseCookieAtAge(params: {
  submissionId: string;
  studentId: string;
  secureClientSessionId: string;
  installationKeyFingerprint: string | null;
  ageMs: number;
  ttlSeconds?: number;
}) {
  const claims = buildContentAccessLeaseClaims({
    keyId: getSigningKeyId(),
    submissionId: params.submissionId,
    secureClientSessionId: params.secureClientSessionId,
    installationKeyFingerprint: params.installationKeyFingerprint,
    studentId: params.studentId,
    nowMs: Date.now() - params.ageMs,
    ttlSeconds: params.ttlSeconds,
  });
  const value = encodeContentAccessLeaseCookieValue(claims, getSigningPrivateKey());
  return `${CONTENT_ACCESS_LEASE_COOKIE_NAME}=${value}`;
}

describe("Tether Content Access Lease — server content-boundary request binding", () => {
  it("A/B: successful LEGACY attestation does NOT set tether_content_lease — an ordinary browser cannot manufacture it by forging the entirely client-self-reported legacy attestation body", async () => {
    const student = await makeStudent("legacy-no-lease");
    const exam = await createTetherExam("LegacyNoLease");
    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const startRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    const submission = await startRes.json();
    const secureClientSession = await prisma.secureClientSession.create({
      data: { institutionId, examId: exam.id, submissionId: submission.id, studentId: student.id, clientType: "TETHER_SECURE_CLIENT", status: "PREFLIGHT", verificationStatus: "NOT_CHECKED" },
    });

    // Exactly what a forging Chrome tab could POST directly — no
    // installation key, no native bridge, purely self-reported.
    const attestRes = await legacyAttestationRoute.POST(jsonRequest("POST", { clientType: "TETHER_SECURE_CLIENT", checks: {}, required: {} }), {
      params: Promise.resolve({ sessionId: secureClientSession.id }),
    });
    expect(attestRes.status).toBe(201);
    const body = await attestRes.json();
    expect(body.overallStatus).toBe("READY");
    expect(attestRes.headers.get("set-cookie")).toBeNull();
    expect(extractSetCookieToken(attestRes, CONTENT_ACCESS_LEASE_COOKIE_NAME)).toBeNull();

    // Confirmed: even reaching READY, activation is still denied without a lease.
    const activateRes = await activateRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submission.id }) });
    expect(activateRes.status).toBe(403);
    expect((await activateRes.json()).code).toBe(TETHER_CONTENT_ACCESS_REQUIRED_CODE);
  });

  it("C: successful native v2 installation attestation issues the lease", async () => {
    const student = await makeStudent("v2-issues");
    const exam = await createTetherExam("V2Issues");
    const { leaseCookie } = await activateViaLegitimateTetherFlow(student, exam);
    expect(leaseCookie).toContain(CONTENT_ACCESS_LEASE_COOKIE_NAME);
  });

  it("D: an invalid installation signature (wrong/unregistered key) never verifies and never issues a lease", async () => {
    const student = await makeStudent("bad-signature");
    const exam = await createTetherExam("BadSignature");
    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const startRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    const submission = await startRes.json();
    await prisma.secureClientSession.create({
      data: { institutionId, examId: exam.id, submissionId: submission.id, studentId: student.id, clientType: "TETHER_SECURE_CLIENT", status: "PREFLIGHT", verificationStatus: "NOT_CHECKED" },
    });

    const registered = await registerInstallation(student, "bad-signature-real");
    // A DIFFERENT, never-registered key pair signs the attestation —
    // simulates a forged/stolen installationId without the real private key.
    const { privateKey: forgedPrivateKey } = crypto.generateKeyPairSync("ed25519");
    const forgedPem = forgedPrivateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const result = await attestExamSessionV2(student, submission.id, { installationId: registered.installationId, privateKeyPem: forgedPem });
    expect(result.status).toBe(400);
    expect(result.body.verified).toBe(false);
    expect(extractSetCookieToken(result.res, CONTENT_ACCESS_LEASE_COOKIE_NAME)).toBeNull();
  });

  it("E: a challenge issued for one submission cannot be replayed to obtain a lease for a different submission", async () => {
    const student = await makeStudent("wrong-submission");
    const examA = await createTetherExam("WrongSubmissionA");
    const examB = await createTetherExam("WrongSubmissionB");
    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const startResA = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: examA.id }) });
    const submissionA = await startResA.json();
    await prisma.secureClientSession.create({
      data: { institutionId, examId: examA.id, submissionId: submissionA.id, studentId: student.id, clientType: "TETHER_SECURE_CLIENT", status: "PREFLIGHT", verificationStatus: "NOT_CHECKED" },
    });
    const startResB = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: examB.id }) });
    const submissionB = await startResB.json();
    await prisma.secureClientSession.create({
      data: { institutionId, examId: examB.id, submissionId: submissionB.id, studentId: student.id, clientType: "TETHER_SECURE_CLIENT", status: "PREFLIGHT", verificationStatus: "NOT_CHECKED" },
    });

    const installation = await registerInstallation(student, "wrong-submission-installation");
    // Get a genuine challenge for submissionA, but sign/submit claiming submissionB's id.
    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const challengeRes = await examSessionChallengeRoute.POST(jsonRequest("POST", { installationId: installation.installationId, submissionId: submissionA.id }));
    expect(challengeRes.status).toBe(200);
    const { challenge, signature: challengeSignature } = await challengeRes.json();
    const tampered = { ...challenge, submissionId: submissionB.id };
    const timestamp = new Date().toISOString();
    const canonical = buildExamSessionAttestationCanonicalString({
      nonce: challenge.nonce,
      installationPublicKeyFingerprint: challenge.installationPublicKeyFingerprint,
      clientVersion: "1.6.0",
      platform: "win32",
      displayTopologyClassification: "INTERNAL_ONLY",
      displayCount: 1,
      examId: challenge.examId,
      submissionId: tampered.submissionId,
      policyHash: challenge.policyHash,
      secureClientSessionId: challenge.secureClientSessionId,
      capabilities: "clipboard",
      timestamp,
    });
    const installationSignature = crypto.sign(null, Buffer.from(canonical, "utf8"), installation.privateKeyPem).toString("base64");
    const verifyRes = await examSessionVerifyRoute.POST(
      jsonRequest("POST", { challenge: tampered, challengeSignature, installationSignature, clientVersion: "1.6.0", platform: "win32", displayTopologyClassification: "INTERNAL_ONLY", displayCount: 1, capabilities: "clipboard", timestamp }),
    );
    expect(verifyRes.status).toBe(400);
    expect(extractSetCookieToken(verifyRes, CONTENT_ACCESS_LEASE_COOKIE_NAME)).toBeNull();
  });

  it("F: POST /activate with no lease is denied even when a genuinely VERIFIED secure-client session exists", async () => {
    const student = await makeStudent("activate-no-lease");
    const exam = await createTetherExam("ActivateNoLease");
    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const startRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    const submission = await startRes.json();
    await prisma.secureClientSession.create({
      data: { institutionId, examId: exam.id, submissionId: submission.id, studentId: student.id, clientType: "TETHER_SECURE_CLIENT", status: "ACTIVE", verificationStatus: "VERIFIED" },
    });

    const activateRes = await activateRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submission.id }) });
    expect(activateRes.status).toBe(403);
    const body = await activateRes.json();
    expect(body.code).toBe(TETHER_CONTENT_ACCESS_REQUIRED_CODE);
    const fresh = await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(fresh.activatedAt).toBeNull();
  });

  it("G: POST /activate with a lease minted by genuine v2 attestation is allowed once all other gates pass", async () => {
    const student = await makeStudent("activate-with-lease");
    const exam = await createTetherExam("ActivateWithLease");
    const { submissionId } = await activateViaLegitimateTetherFlow(student, exam);
    const fresh = await prisma.submission.findUniqueOrThrow({ where: { id: submissionId } });
    expect(fresh.activatedAt).not.toBeNull();
  });

  it("H: the SAME active, activated submission, same authenticated student, but the request carries NO lease cookie (the ordinary Chrome/Edge scenario) -> content denied", async () => {
    const student = await makeStudent("chrome-no-lease");
    const exam = await createTetherExam("ChromeNoLease");
    const { submissionId } = await activateViaLegitimateTetherFlow(student, exam);

    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const res = await submissionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submissionId }) });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe(TETHER_CONTENT_ACCESS_REQUIRED_CODE);
    expect(body.exam).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("Q1");
  });

  it("I: a plain spoofed/fabricated lease cookie value cannot satisfy the gate", async () => {
    const student = await makeStudent("spoofed");
    const exam = await createTetherExam("Spoofed");
    const { submissionId } = await activateViaLegitimateTetherFlow(student, exam);

    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const spoofed = `${CONTENT_ACCESS_LEASE_COOKIE_NAME}=i-am-definitely-tether`;
    const res = await submissionRoute.GET(jsonRequest("GET", undefined, spoofed), { params: Promise.resolve({ id: submissionId }) });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe(TETHER_CONTENT_ACCESS_REQUIRED_CODE);
  });

  it("J: a lease bound to a SUPERSEDED secure-client session (a new legitimate relaunch) is denied even though its signature is still valid", async () => {
    const student = await makeStudent("superseded");
    const exam = await createTetherExam("Superseded");
    const { submissionId, leaseCookie: oldLease, installation } = await activateViaLegitimateTetherFlow(student, exam);

    // A second, later v2 attestation on a NEW SecureClientSession for the
    // same submission (e.g. a genuine relaunch) supersedes the first —
    // the original must first be ended (only one CURRENT non-terminal
    // session per submission is ever allowed, enforced by a partial
    // unique index), exactly like a real relaunch would leave it.
    const priorSession = await prisma.secureClientSession.findFirstOrThrow({
      where: { submissionId, status: { in: ["CREATED", "PREFLIGHT", "ACTIVE", "INTERRUPTED", "RECOVERY_REQUIRED"] } },
      orderBy: { createdAt: "desc" },
    });
    await prisma.secureClientSession.update({ where: { id: priorSession.id }, data: { status: "ENDED" } });
    await prisma.secureClientSession.create({
      data: { institutionId, examId: exam.id, submissionId, studentId: student.id, clientType: "TETHER_SECURE_CLIENT", status: "ACTIVE", verificationStatus: "VERIFIED" },
    });
    const secondV2 = await attestExamSessionV2(student, submissionId, installation);
    expect(secondV2.status).toBe(200);

    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    // The OLD lease, from before the new session took over, must now be rejected.
    const res = await submissionRoute.GET(jsonRequest("GET", undefined, oldLease), { params: Promise.resolve({ id: submissionId }) });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe(TETHER_CONTENT_ACCESS_REQUIRED_CODE);
  });

  it("K: a lease whose installation-key fingerprint no longer matches the session's current binding (a different installation took over) is denied", async () => {
    const student = await makeStudent("wrong-installation");
    const exam = await createTetherExam("WrongInstallation");
    const { submissionId, leaseCookie } = await activateViaLegitimateTetherFlow(student, exam);

    // A DIFFERENT installation for the same student re-verifies for this
    // submission's current session, changing its clientInstallationIdHash.
    const otherInstallation = await registerInstallation(student, "different-installation");
    const otherInstallationRow = await prisma.tetherClientInstallation.findUniqueOrThrow({ where: { id: otherInstallation.installationId } });
    const currentSession = await prisma.secureClientSession.findFirstOrThrow({
      where: { submissionId, status: { in: ["CREATED", "PREFLIGHT", "ACTIVE", "INTERRUPTED", "RECOVERY_REQUIRED"] } },
      orderBy: { createdAt: "desc" },
    });
    // Simulate the takeover directly (mirrors what a genuine second v2
    // verification for the SAME session id would do to clientInstallationIdHash
    // — always the real registered publicKeyFingerprint, never a synthetic value).
    await prisma.secureClientSession.update({ where: { id: currentSession.id }, data: { clientInstallationIdHash: otherInstallationRow.publicKeyFingerprint } });

    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const res = await submissionRoute.GET(jsonRequest("GET", undefined, leaseCookie), { params: Promise.resolve({ id: submissionId }) });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe(TETHER_CONTENT_ACCESS_REQUIRED_CODE);
  });

  it("L: a legitimate Tether reload/restart can perform v2 proof again and obtain a fresh, working lease", async () => {
    const student = await makeStudent("reload");
    const exam = await createTetherExam("Reload");
    const { submissionId, installation } = await activateViaLegitimateTetherFlow(student, exam);

    // Re-attest with the SAME installation on the SAME (still-current)
    // session — a plausible "restart Tether" scenario before the session
    // itself is superseded.
    const refreshed = await attestExamSessionV2(student, submissionId, installation);
    expect(refreshed.status).toBe(200);
    const freshToken = extractSetCookieToken(refreshed.res, CONTENT_ACCESS_LEASE_COOKIE_NAME);
    expect(freshToken).toBeTruthy();
    const freshLease = `${CONTENT_ACCESS_LEASE_COOKIE_NAME}=${freshToken}`;

    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const res = await submissionRoute.GET(jsonRequest("GET", undefined, freshLease), { params: Promise.resolve({ id: submissionId }) });
    expect(res.status).toBe(200);
  });

  it("M: STANDARD_WEB submissions are completely unaffected — no lease ever required", async () => {
    const student = await makeStudent("standard-web");
    const exam = await prisma.exam.create({
      data: { title: `StandardWeb ${stamp}-${Math.random()}`, durationMins: 30, published: true, createdById: lecturerId, institutionId, secureSettings: { deliveryMode: "STANDARD_WEB" } },
    });
    cleanupExamIds.push(exam.id);
    await prisma.question.create({ data: { examId: exam.id, type: "SHORT_ANSWER", text: "Q1", points: 1, correctAnswer: "ok" } });

    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const startRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    const submission = await startRes.json();

    const res = await submissionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.exam.questions).toHaveLength(1);
  });

  it("N: full-question-mode GET /api/submissions/[id] never leaks question text/options to a lease-less request", async () => {
    const student = await makeStudent("no-leak");
    const exam = await createTetherExam("NoLeak");
    const { submissionId } = await activateViaLegitimateTetherFlow(student, exam);

    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const res = await submissionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submissionId }) });
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("Q1");
    expect(body.exam).toBeUndefined();
  });

  it("O: answer PATCH from an unauthorized (lease-less) request is denied for an active TETHER_CLIENT_REQUIRED attempt", async () => {
    const student = await makeStudent("patch-no-lease");
    const exam = await createTetherExam("PatchNoLease");
    const { submissionId } = await activateViaLegitimateTetherFlow(student, exam);
    const question = await prisma.question.findFirstOrThrow({ where: { examId: exam.id } });

    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const res = await answersRoute.PATCH(jsonRequest("PATCH", { questionId: question.id, response: "fabricated-by-chrome" }), {
      params: Promise.resolve({ id: submissionId }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe(TETHER_CONTENT_ACCESS_REQUIRED_CODE);
    const stored = await prisma.answer.findUnique({ where: { submissionId_questionId: { submissionId, questionId: question.id } } });
    expect(stored).toBeNull();
  });

  it("no timer reset / attempt duplication: activatedAt/startedAt are set exactly once and never reset by subsequent content fetches", async () => {
    const student = await makeStudent("no-reset");
    const exam = await createTetherExam("NoReset");
    const { submissionId, leaseCookie } = await activateViaLegitimateTetherFlow(student, exam);

    const afterActivate = await prisma.submission.findUniqueOrThrow({ where: { id: submissionId } });
    expect(afterActivate.activatedAt).not.toBeNull();

    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    await submissionRoute.GET(jsonRequest("GET", undefined, leaseCookie), { params: Promise.resolve({ id: submissionId }) });
    await submissionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submissionId }) }); // denied, but must not mutate state
    const repeatActivate = await activateRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submissionId }) });
    expect(repeatActivate.status).toBe(200);
    expect((await repeatActivate.json()).alreadyActivated).toBe(true);

    const finalState = await prisma.submission.findUniqueOrThrow({ where: { id: submissionId } });
    expect(finalState.activatedAt?.getTime()).toBe(afterActivate.activatedAt!.getTime());
    expect(finalState.startedAt.getTime()).toBe(afterActivate.startedAt.getTime());

    const allSubmissions = await prisma.submission.findMany({ where: { examId: exam.id, studentId: student.id } });
    expect(allSubmissions).toHaveLength(1);
  });
});

/**
 * Release-blocking follow-up review — lease lifetime/renewal audit. Proves
 * the fixed 30-minute CONTENT_ACCESS_LEASE_TTL_SECONDS does not break a
 * legitimate 60/90/120-minute Tether exam: every content-bound route that
 * enforces the lease also performs rolling renewal
 * (renewTetherContentAccessLeaseIfValid in requireTetherContentAccess.ts)
 * on its success path, and that renewal is itself just as fail-closed as
 * the original gate — it can only ever extend a lease that independently
 * re-validates (unexpired, live-session-matching) right now, never
 * bootstrap one from nothing.
 */
describe("Tether Content Access Lease — rolling renewal keeps a long exam alive past the 30-minute TTL", () => {
  it("1: a 120-minute active exam is not broken at minute 31 — a request while the lease is still valid renews it, and the renewed lease still works past the ORIGINAL lease's own expiry", async () => {
    const student = await makeStudent("long-exam");
    const exam = await createTetherExam("LongExam");
    const { submissionId } = await activateViaLegitimateTetherFlow(student, exam);
    const session = await currentSessionFor(submissionId);

    // Simulated minute 25 — still within the original lease's 30-minute
    // TTL, close to it, exactly where a real autosave/poll would land
    // during a 120-minute exam.
    const nearExpiryCookie = await buildLeaseCookieAtAge({
      submissionId,
      studentId: student.id,
      secureClientSessionId: session.id,
      installationKeyFingerprint: session.clientInstallationIdHash,
      ageMs: 25 * 60_000,
    });

    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const res25 = await submissionRoute.GET(jsonRequest("GET", undefined, nearExpiryCookie), { params: Promise.resolve({ id: submissionId }) });
    expect(res25.status).toBe(200);
    const renewedToken = extractSetCookieToken(res25, CONTENT_ACCESS_LEASE_COOKIE_NAME);
    expect(renewedToken).toBeTruthy();
    const renewedCookie = `${CONTENT_ACCESS_LEASE_COOKIE_NAME}=${renewedToken}`;

    // Simulated minute 31 of the ORIGINAL lease (which would already be
    // expired by now had it never been renewed) — the RENEWED cookie from
    // minute 25 (only ~6 minutes old itself) must still work.
    const res31 = await submissionRoute.GET(jsonRequest("GET", undefined, renewedCookie), { params: Promise.resolve({ id: submissionId }) });
    expect(res31.status).toBe(200);
  });

  it("2: a valid lease approaching expiry + healthy current secure session -> legitimate renewal succeeds via PATCH answers", async () => {
    const student = await makeStudent("renew-answers");
    const exam = await createTetherExam("RenewAnswers");
    const { submissionId } = await activateViaLegitimateTetherFlow(student, exam);
    const question = await prisma.question.findFirstOrThrow({ where: { examId: exam.id } });
    const session = await currentSessionFor(submissionId);
    const nearExpiryCookie = await buildLeaseCookieAtAge({
      submissionId,
      studentId: student.id,
      secureClientSessionId: session.id,
      installationKeyFingerprint: session.clientInstallationIdHash,
      ageMs: 29 * 60_000,
    });

    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const res = await answersRoute.PATCH(jsonRequest("PATCH", { questionId: question.id, response: "answer" }, nearExpiryCookie), {
      params: Promise.resolve({ id: submissionId }),
    });
    expect(res.status).toBe(200);
    expect(extractSetCookieToken(res, CONTENT_ACCESS_LEASE_COOKIE_NAME)).toBeTruthy();
  });

  it("3: a MISSING lease cannot be bootstrap-renewed through any protected route", async () => {
    const student = await makeStudent("renew-missing");
    const exam = await createTetherExam("RenewMissing");
    const { submissionId } = await activateViaLegitimateTetherFlow(student, exam);

    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const res = await submissionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submissionId }) });
    expect(res.status).toBe(403);
    expect(extractSetCookieToken(res, CONTENT_ACCESS_LEASE_COOKIE_NAME)).toBeNull();
  });

  it("4: an EXPIRED lease cannot be silently renewed without fresh v2 installation proof, and fresh proof after expiry never resets the timer/attempt", async () => {
    const student = await makeStudent("renew-expired");
    const exam = await createTetherExam("RenewExpired");
    const { submissionId, installation } = await activateViaLegitimateTetherFlow(student, exam);
    const session = await currentSessionFor(submissionId);
    const expiredCookie = await buildLeaseCookieAtAge({
      submissionId,
      studentId: student.id,
      secureClientSessionId: session.id,
      installationKeyFingerprint: session.clientInstallationIdHash,
      ageMs: 31 * 60_000,
    });

    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const denied = await submissionRoute.GET(jsonRequest("GET", undefined, expiredCookie), { params: Promise.resolve({ id: submissionId }) });
    expect(denied.status).toBe(403);
    expect((await denied.json()).code).toBe(TETHER_CONTENT_ACCESS_REQUIRED_CODE);
    expect(extractSetCookieToken(denied, CONTENT_ACCESS_LEASE_COOKIE_NAME)).toBeNull();

    const beforeRestart = await prisma.submission.findUniqueOrThrow({ where: { id: submissionId } });

    // A genuine Tether restart (fresh v2 proof) CAN mint a brand new lease.
    const restart = await attestExamSessionV2(student, submissionId, installation);
    expect(restart.status).toBe(200);
    const freshToken = extractSetCookieToken(restart.res, CONTENT_ACCESS_LEASE_COOKIE_NAME);
    const freshCookie = `${CONTENT_ACCESS_LEASE_COOKIE_NAME}=${freshToken}`;

    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const allowed = await submissionRoute.GET(jsonRequest("GET", undefined, freshCookie), { params: Promise.resolve({ id: submissionId }) });
    expect(allowed.status).toBe(200);

    // Requirement 12 — no attemptNumber duplication, no startedAt/activatedAt reset.
    const afterRestart = await prisma.submission.findUniqueOrThrow({ where: { id: submissionId } });
    expect(afterRestart.startedAt.getTime()).toBe(beforeRestart.startedAt.getTime());
    expect(afterRestart.activatedAt?.getTime()).toBe(beforeRestart.activatedAt!.getTime());
    expect(afterRestart.attemptNumber).toBe(beforeRestart.attemptNumber);
    const allSubmissions = await prisma.submission.findMany({ where: { examId: exam.id, studentId: student.id } });
    expect(allSubmissions).toHaveLength(1);
  });

  it("5: ordinary Chrome with the same authenticated student but no lease is still denied, and never issued a fresh lease either", async () => {
    const student = await makeStudent("renew-chrome");
    const exam = await createTetherExam("RenewChrome");
    const { submissionId } = await activateViaLegitimateTetherFlow(student, exam);
    const question = await prisma.question.findFirstOrThrow({ where: { examId: exam.id } });

    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const res = await answersRoute.PATCH(jsonRequest("PATCH", { questionId: question.id, response: "fabricated" }), { params: Promise.resolve({ id: submissionId }) });
    expect(res.status).toBe(403);
    expect(extractSetCookieToken(res, CONTENT_ACCESS_LEASE_COOKIE_NAME)).toBeNull();
  });

  it("6: a lease bound to a SUPERSEDED SecureClientSession is denied renewal too, not just access", async () => {
    const student = await makeStudent("renew-superseded");
    const exam = await createTetherExam("RenewSuperseded");
    const { submissionId, leaseCookie: oldLease, installation } = await activateViaLegitimateTetherFlow(student, exam);

    const priorSession = await currentSessionFor(submissionId);
    await prisma.secureClientSession.update({ where: { id: priorSession.id }, data: { status: "ENDED" } });
    await prisma.secureClientSession.create({
      data: { institutionId, examId: exam.id, submissionId, studentId: student.id, clientType: "TETHER_SECURE_CLIENT", status: "ACTIVE", verificationStatus: "VERIFIED" },
    });
    await attestExamSessionV2(student, submissionId, installation);

    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const res = await submissionRoute.GET(jsonRequest("GET", undefined, oldLease), { params: Promise.resolve({ id: submissionId }) });
    expect(res.status).toBe(403);
    expect(extractSetCookieToken(res, CONTENT_ACCESS_LEASE_COOKIE_NAME)).toBeNull();
  });

  it("7: a lease whose installation fingerprint no longer matches (revoked/wrong installation) is denied renewal too", async () => {
    const student = await makeStudent("renew-wrong-install");
    const exam = await createTetherExam("RenewWrongInstall");
    const { submissionId, leaseCookie } = await activateViaLegitimateTetherFlow(student, exam);

    const otherInstallation = await registerInstallation(student, "renew-different-installation");
    const otherRow = await prisma.tetherClientInstallation.findUniqueOrThrow({ where: { id: otherInstallation.installationId } });
    const currentSession = await currentSessionFor(submissionId);
    await prisma.secureClientSession.update({ where: { id: currentSession.id }, data: { clientInstallationIdHash: otherRow.publicKeyFingerprint } });

    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const res = await submissionRoute.GET(jsonRequest("GET", undefined, leaseCookie), { params: Promise.resolve({ id: submissionId }) });
    expect(res.status).toBe(403);
    expect(extractSetCookieToken(res, CONTENT_ACCESS_LEASE_COOKIE_NAME)).toBeNull();
  });

  it("8: answer PATCH remains functional after the original 30-minute boundary for a healthy long exam", async () => {
    const student = await makeStudent("renew-patch-boundary");
    const exam = await createTetherExam("RenewPatchBoundary");
    const { submissionId } = await activateViaLegitimateTetherFlow(student, exam);
    const question = await prisma.question.findFirstOrThrow({ where: { examId: exam.id } });
    const session = await currentSessionFor(submissionId);

    const nearExpiry = await buildLeaseCookieAtAge({
      submissionId,
      studentId: student.id,
      secureClientSessionId: session.id,
      installationKeyFingerprint: session.clientInstallationIdHash,
      ageMs: 28 * 60_000,
    });
    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const firstSave = await answersRoute.PATCH(jsonRequest("PATCH", { questionId: question.id, response: "draft" }, nearExpiry), {
      params: Promise.resolve({ id: submissionId }),
    });
    expect(firstSave.status).toBe(200);
    const renewedToken = extractSetCookieToken(firstSave, CONTENT_ACCESS_LEASE_COOKIE_NAME);
    const renewedCookie = `${CONTENT_ACCESS_LEASE_COOKIE_NAME}=${renewedToken}`;

    const secondSave = await answersRoute.PATCH(jsonRequest("PATCH", { questionId: question.id, response: "final" }, renewedCookie), {
      params: Promise.resolve({ id: submissionId }),
    });
    expect(secondSave.status).toBe(200);
    const stored = await prisma.answer.findUnique({ where: { submissionId_questionId: { submissionId, questionId: question.id } } });
    expect(stored?.response).toBe("final");
  });

  it("9: question navigation remains functional after the original 30-minute boundary", async () => {
    const student = await makeStudent("renew-question-nav");
    const exam = await prisma.exam.create({
      data: {
        title: `RenewQuestionNav ${stamp}-${Math.random()}`,
        durationMins: 30,
        published: true,
        createdById: lecturerId,
        institutionId,
        secureSettings: { deliveryMode: "TETHER_CLIENT_REQUIRED", maxAttempts: 1, oneQuestionAtATime: true },
      },
    });
    cleanupExamIds.push(exam.id);
    await prisma.question.create({ data: { examId: exam.id, type: "SHORT_ANSWER", text: "Q1", points: 1, correctAnswer: "ok" } });
    const { submissionId } = await activateViaLegitimateTetherFlow(student, exam);
    const session = await currentSessionFor(submissionId);
    const nearExpiry = await buildLeaseCookieAtAge({
      submissionId,
      studentId: student.id,
      secureClientSessionId: session.id,
      installationKeyFingerprint: session.clientInstallationIdHash,
      ageMs: 29 * 60_000,
    });

    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const res = await questionRoute.GET(jsonRequest("GET", undefined, nearExpiry), { params: Promise.resolve({ id: submissionId }) });
    expect(res.status).toBe(200);
    expect(extractSetCookieToken(res, CONTENT_ACCESS_LEASE_COOKIE_NAME)).toBeTruthy();
  });

  it("10: final submit remains functional for an exam longer than 30 minutes", async () => {
    const student = await makeStudent("renew-submit-boundary");
    const exam = await createTetherExam("RenewSubmitBoundary");
    const { submissionId } = await activateViaLegitimateTetherFlow(student, exam);
    const session = await currentSessionFor(submissionId);
    const nearExpiry = await buildLeaseCookieAtAge({
      submissionId,
      studentId: student.id,
      secureClientSessionId: session.id,
      installationKeyFingerprint: session.clientInstallationIdHash,
      ageMs: 29 * 60_000,
    });

    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const res = await submitRoute.POST(jsonRequest("POST", {}, nearExpiry), { params: Promise.resolve({ id: submissionId }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code).not.toBe("ALREADY_FINALIZED");
    const fresh = await prisma.submission.findUniqueOrThrow({ where: { id: submissionId } });
    expect(["SUBMITTED", "GRADED"]).toContain(fresh.status);
  });

  it("11: STANDARD_WEB requests are never issued a tether content lease cookie by the renewal logic either", async () => {
    const student = await makeStudent("renew-standard-web");
    const exam = await prisma.exam.create({
      data: { title: `RenewStandardWeb ${stamp}-${Math.random()}`, durationMins: 30, published: true, createdById: lecturerId, institutionId, secureSettings: { deliveryMode: "STANDARD_WEB" } },
    });
    cleanupExamIds.push(exam.id);
    await prisma.question.create({ data: { examId: exam.id, type: "SHORT_ANSWER", text: "Q1", points: 1, correctAnswer: "ok" } });

    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const startRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    const submission = await startRes.json();

    const res = await submissionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(200);
    expect(extractSetCookieToken(res, CONTENT_ACCESS_LEASE_COOKIE_NAME)).toBeNull();
  });

  it("12: a 120-minute Tether exam survives 35+ minutes of pure idle reading (no answer/navigation activity at all) — only the guaranteed ~25s session-heartbeat renews the lease, and the first PATCH after the idle period still succeeds with no timer/attempt reset", async () => {
    const student = await makeStudent("renew-heartbeat-idle");
    const exam = await createTetherExam("RenewHeartbeatIdle");
    const { submissionId } = await activateViaLegitimateTetherFlow(student, exam);
    const question = await prisma.question.findFirstOrThrow({ where: { examId: exam.id } });
    const before = await prisma.submission.findUniqueOrThrow({ where: { id: submissionId } });
    const session = await currentSessionFor(submissionId);

    // Simulated minute 25 — the student has been reading an essay
    // question this whole time: no autosave, no navigation, nothing but
    // the exam page's unconditional 25-second heartbeat interval firing.
    let cookie = await buildLeaseCookieAtAge({
      submissionId,
      studentId: student.id,
      secureClientSessionId: session.id,
      installationKeyFingerprint: session.clientInstallationIdHash,
      ageMs: 25 * 60_000,
    });

    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));

    // Several simulated heartbeats, each renewing the lease again well
    // before the previous one expires — exactly what the real client-side
    // setInterval(sendHeartbeat, 25_000) does continuously, independent of
    // any student interaction, across a long exam.
    for (let i = 0; i < 3; i++) {
      const hb = await sessionHeartbeatRoute.POST(jsonRequest("POST", {}, cookie), { params: Promise.resolve({ id: submissionId }) });
      expect(hb.status).toBe(200);
      const token = extractSetCookieToken(hb, CONTENT_ACCESS_LEASE_COOKIE_NAME);
      expect(token).toBeTruthy();
      cookie = `${CONTENT_ACCESS_LEASE_COOKIE_NAME}=${token}`;
    }

    // Well past the ORIGINAL lease's own 30-minute boundary — the FIRST
    // answer save the student makes, after 35+ minutes of pure idle
    // reading, must still succeed, using only the heartbeat-renewed cookie.
    const patchRes = await answersRoute.PATCH(jsonRequest("PATCH", { questionId: question.id, response: "finally typing" }, cookie), {
      params: Promise.resolve({ id: submissionId }),
    });
    expect(patchRes.status).toBe(200);

    const after = await prisma.submission.findUniqueOrThrow({ where: { id: submissionId } });
    expect(after.startedAt.getTime()).toBe(before.startedAt.getTime());
    expect(after.activatedAt?.getTime()).toBe(before.activatedAt!.getTime());
    expect(after.attemptNumber).toBe(before.attemptNumber);
  });

  it("13: the heartbeat itself never requires a lease (works for every delivery mode), but a MISSING lease is never bootstrapped by it either", async () => {
    const student = await makeStudent("renew-hb-missing");
    const exam = await createTetherExam("RenewHbMissing");
    const { submissionId } = await activateViaLegitimateTetherFlow(student, exam);

    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const hb = await sessionHeartbeatRoute.POST(jsonRequest("POST", {}), { params: Promise.resolve({ id: submissionId }) });
    expect(hb.status).toBe(200); // heartbeat itself is not lease-gated
    expect(extractSetCookieToken(hb, CONTENT_ACCESS_LEASE_COOKIE_NAME)).toBeNull(); // but it never mints one out of nothing
  });

  it("14: the heartbeat never renews an EXPIRED lease", async () => {
    const student = await makeStudent("renew-hb-expired");
    const exam = await createTetherExam("RenewHbExpired");
    const { submissionId } = await activateViaLegitimateTetherFlow(student, exam);
    const session = await currentSessionFor(submissionId);
    const expiredCookie = await buildLeaseCookieAtAge({
      submissionId,
      studentId: student.id,
      secureClientSessionId: session.id,
      installationKeyFingerprint: session.clientInstallationIdHash,
      ageMs: 31 * 60_000,
    });

    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const hb = await sessionHeartbeatRoute.POST(jsonRequest("POST", {}, expiredCookie), { params: Promise.resolve({ id: submissionId }) });
    expect(hb.status).toBe(200);
    expect(extractSetCookieToken(hb, CONTENT_ACCESS_LEASE_COOKIE_NAME)).toBeNull();
  });

  it("15: the heartbeat never renews a lease bound to a SUPERSEDED SecureClientSession", async () => {
    const student = await makeStudent("renew-hb-superseded");
    const exam = await createTetherExam("RenewHbSuperseded");
    const { submissionId, leaseCookie: oldLease, installation } = await activateViaLegitimateTetherFlow(student, exam);

    const priorSession = await currentSessionFor(submissionId);
    await prisma.secureClientSession.update({ where: { id: priorSession.id }, data: { status: "ENDED" } });
    await prisma.secureClientSession.create({
      data: { institutionId, examId: exam.id, submissionId, studentId: student.id, clientType: "TETHER_SECURE_CLIENT", status: "ACTIVE", verificationStatus: "VERIFIED" },
    });
    await attestExamSessionV2(student, submissionId, installation);

    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const hb = await sessionHeartbeatRoute.POST(jsonRequest("POST", {}, oldLease), { params: Promise.resolve({ id: submissionId }) });
    expect(hb.status).toBe(200);
    expect(extractSetCookieToken(hb, CONTENT_ACCESS_LEASE_COOKIE_NAME)).toBeNull();
  });

  it("16: the heartbeat never renews a lease whose installation fingerprint no longer matches (revoked/wrong installation)", async () => {
    const student = await makeStudent("renew-hb-wrong-install");
    const exam = await createTetherExam("RenewHbWrongInstall");
    const { submissionId, leaseCookie } = await activateViaLegitimateTetherFlow(student, exam);

    const otherInstallation = await registerInstallation(student, "renew-hb-different-installation");
    const otherRow = await prisma.tetherClientInstallation.findUniqueOrThrow({ where: { id: otherInstallation.installationId } });
    const currentSession = await currentSessionFor(submissionId);
    await prisma.secureClientSession.update({ where: { id: currentSession.id }, data: { clientInstallationIdHash: otherRow.publicKeyFingerprint } });

    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const hb = await sessionHeartbeatRoute.POST(jsonRequest("POST", {}, leaseCookie), { params: Promise.resolve({ id: submissionId }) });
    expect(hb.status).toBe(200);
    expect(extractSetCookieToken(hb, CONTENT_ACCESS_LEASE_COOKIE_NAME)).toBeNull();
  });

  it("17: ordinary Chrome (same authenticated student, no lease) hitting the heartbeat still never obtains one", async () => {
    const student = await makeStudent("renew-hb-chrome");
    const exam = await createTetherExam("RenewHbChrome");
    const { submissionId } = await activateViaLegitimateTetherFlow(student, exam);

    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const hb = await sessionHeartbeatRoute.POST(jsonRequest("POST", {}), { params: Promise.resolve({ id: submissionId }) });
    expect(hb.status).toBe(200);
    expect(extractSetCookieToken(hb, CONTENT_ACCESS_LEASE_COOKIE_NAME)).toBeNull();

    // And still cannot use the absence of a lease to read content either.
    const res = await submissionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submissionId }) });
    expect(res.status).toBe(403);
  });
});

/**
 * Physical acceptance follow-up — question-navigation latency audit.
 * PATCH /api/submissions/[id]/answers, GET /api/submissions/[id], and the
 * one-question-mode routes were refactored to renew the lease straight
 * from the SAME ContentAccessDecision their own access gate already
 * computed (renewContentAccessLeaseFromValidatedDecision), instead of
 * checkTetherContentAccessLease running a SECOND time per request. These
 * tests prove that optimization changed nothing about WHEN a lease can be
 * renewed — only removed the redundant re-verification work — by
 * exercising the answers PATCH route (the route this optimization matters
 * most for) against every failure mode a renewal must still reject.
 */
describe("Tether Content Access Lease — the single-check renewal optimization is exactly as fail-closed as the original two-check version", () => {
  it("a valid, near-expiry lease is both ACCEPTED and RENEWED by the optimized PATCH /answers path, and the renewed cookie is itself genuinely usable afterward", async () => {
    const student = await makeStudent("opt-answers-valid");
    const exam = await createTetherExam("OptAnswersValid");
    const { submissionId } = await activateViaLegitimateTetherFlow(student, exam);
    const question = await prisma.question.findFirstOrThrow({ where: { examId: exam.id } });
    const session = await currentSessionFor(submissionId);
    const nearExpiry = await buildLeaseCookieAtAge({
      submissionId,
      studentId: student.id,
      secureClientSessionId: session.id,
      installationKeyFingerprint: session.clientInstallationIdHash,
      ageMs: 29 * 60_000,
    });

    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const res = await answersRoute.PATCH(jsonRequest("PATCH", { questionId: question.id, response: "answer" }, nearExpiry), {
      params: Promise.resolve({ id: submissionId }),
    });
    expect(res.status).toBe(200);
    const renewedToken = extractSetCookieToken(res, CONTENT_ACCESS_LEASE_COOKIE_NAME);
    expect(renewedToken).toBeTruthy();

    // The renewed cookie must be a genuinely fresh, independently valid
    // lease — not a copy of the (still near-expiry) presented one.
    const renewedCookie = `${CONTENT_ACCESS_LEASE_COOKIE_NAME}=${renewedToken}`;
    const followUp = await submissionRoute.GET(jsonRequest("GET", undefined, renewedCookie), { params: Promise.resolve({ id: submissionId }) });
    expect(followUp.status).toBe(200);
  });

  it("an EXPIRED lease is REJECTED and NOT renewed by the optimized PATCH /answers path", async () => {
    const student = await makeStudent("opt-answers-expired");
    const exam = await createTetherExam("OptAnswersExpired");
    const { submissionId } = await activateViaLegitimateTetherFlow(student, exam);
    const question = await prisma.question.findFirstOrThrow({ where: { examId: exam.id } });
    const session = await currentSessionFor(submissionId);
    const expiredCookie = await buildLeaseCookieAtAge({
      submissionId,
      studentId: student.id,
      secureClientSessionId: session.id,
      installationKeyFingerprint: session.clientInstallationIdHash,
      ageMs: 31 * 60_000,
    });

    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const res = await answersRoute.PATCH(jsonRequest("PATCH", { questionId: question.id, response: "fabricated" }, expiredCookie), {
      params: Promise.resolve({ id: submissionId }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe(TETHER_CONTENT_ACCESS_REQUIRED_CODE);
    expect(extractSetCookieToken(res, CONTENT_ACCESS_LEASE_COOKIE_NAME)).toBeNull();
    const stored = await prisma.answer.findUnique({ where: { submissionId_questionId: { submissionId, questionId: question.id } } });
    expect(stored).toBeNull();
  });

  it("a lease bound to a SUPERSEDED SecureClientSession is REJECTED and NOT renewed by the optimized PATCH /answers path", async () => {
    const student = await makeStudent("opt-answers-superseded");
    const exam = await createTetherExam("OptAnswersSuperseded");
    const { submissionId, leaseCookie: oldLease, installation } = await activateViaLegitimateTetherFlow(student, exam);
    const question = await prisma.question.findFirstOrThrow({ where: { examId: exam.id } });

    const priorSession = await currentSessionFor(submissionId);
    await prisma.secureClientSession.update({ where: { id: priorSession.id }, data: { status: "ENDED" } });
    await prisma.secureClientSession.create({
      data: { institutionId, examId: exam.id, submissionId, studentId: student.id, clientType: "TETHER_SECURE_CLIENT", status: "ACTIVE", verificationStatus: "VERIFIED" },
    });
    await attestExamSessionV2(student, submissionId, installation);

    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const res = await answersRoute.PATCH(jsonRequest("PATCH", { questionId: question.id, response: "fabricated" }, oldLease), {
      params: Promise.resolve({ id: submissionId }),
    });
    expect(res.status).toBe(403);
    expect(extractSetCookieToken(res, CONTENT_ACCESS_LEASE_COOKIE_NAME)).toBeNull();
  });

  it("a lease with a REVOKED/WRONG installation fingerprint is REJECTED and NOT renewed by the optimized PATCH /answers path", async () => {
    const student = await makeStudent("opt-answers-wrong-install");
    const exam = await createTetherExam("OptAnswersWrongInstall");
    const { submissionId, leaseCookie } = await activateViaLegitimateTetherFlow(student, exam);
    const question = await prisma.question.findFirstOrThrow({ where: { examId: exam.id } });

    const otherInstallation = await registerInstallation(student, "opt-answers-different-installation");
    const otherRow = await prisma.tetherClientInstallation.findUniqueOrThrow({ where: { id: otherInstallation.installationId } });
    const currentSession = await currentSessionFor(submissionId);
    await prisma.secureClientSession.update({ where: { id: currentSession.id }, data: { clientInstallationIdHash: otherRow.publicKeyFingerprint } });

    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const res = await answersRoute.PATCH(jsonRequest("PATCH", { questionId: question.id, response: "fabricated" }, leaseCookie), {
      params: Promise.resolve({ id: submissionId }),
    });
    expect(res.status).toBe(403);
    expect(extractSetCookieToken(res, CONTENT_ACCESS_LEASE_COOKIE_NAME)).toBeNull();
  });
});
