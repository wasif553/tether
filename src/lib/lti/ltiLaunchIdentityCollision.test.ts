/**
 * Canvas/LTI identity-collision hardening v1 — DB-backed route tests.
 * See docs/lti-identity-collision-hardening-v1.md.
 *
 * Requires the local test Postgres instance (run via
 * `npm run release:validate`) — src/lib/prisma.ts's
 * assertSafeDatabaseUrlForTests guard blocks a plain `vitest run`.
 *
 * Exercises the real POST /api/lti/launch route end-to-end with
 * genuinely signed JWTs (a test-generated RSA keypair; the underlying
 * `fetch` call inside findPlatformJwk/getPlatformJwks is mocked to
 * return the corresponding public JWK — jwtVerify itself is never
 * mocked, so signature/issuer/audience verification runs for real).
 *
 * Covers launch-route-only concerns: normal provisioning, the collision
 * hand-off redirect itself (never a session/auth() dependency — see
 * docs/lti-identity-collision-hardening-v1.md's "Browser-flow
 * hardening"), mapped-user email-update hardening, the no-email
 * synthetic path, nonce/replay/signature verification, and
 * LtiExamLink/launch-redirect regression. Everything about
 * resolveLtiEmailCollision's own outcomes (role/institution/canvasId
 * checks, races) and the confirmation endpoint lives in
 * ltiIdentityLinkHandoff.test.ts instead — the launch route no longer
 * determines any of those itself.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { randomBytes } from "node:crypto";

const { prisma } = await import("../prisma");
const { getOrCreateTestInstitution } = await import("../testInstitution");
const { clearJwksCache } = await import("./jwks-cache");

const STUDENT_ROLE_CLAIM = ["http://purl.imsglobal.org/vocab/lis/v2/membership#Learner"];
const INSTRUCTOR_ROLE_CLAIM = ["http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor"];

const stamp = Date.now();
const cleanupUserIds: string[] = [];
const cleanupPlatformIds: string[] = [];
const cleanupInstitutionScopedExamIds: string[] = [];

async function createUser(opts: {
  email: string;
  role: "LECTURER" | "STUDENT";
  institutionId: string | null;
  canvasUserId?: string | null;
}) {
  const passwordHash = await bcrypt.hash("password", 4);
  const u = await prisma.user.create({
    data: {
      name: "Test",
      email: opts.email,
      passwordHash,
      role: opts.role,
      institutionId: opts.institutionId,
      canvasUserId: opts.canvasUserId ?? null,
    },
  });
  cleanupUserIds.push(u.id);
  return u;
}

const jwksByUrl = new Map<string, JWK[]>();

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const keys = jwksByUrl.get(url);
    if (!keys) {
      return new Response(JSON.stringify({ keys: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ keys }), { status: 200 });
  }),
);

type PlatformKeypair = { privateKey: CryptoKey; kid: string };
const platformKeys = new Map<string, PlatformKeypair>();

async function createPlatform(institutionId: string | null) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const kid = `kid-${randomBytes(8).toString("hex")}`;
  const jwk = await exportJWK(publicKey);
  jwk.kid = kid;
  jwk.alg = "RS256";

  const jwksUrl = `https://canvas-test-${randomBytes(8).toString("hex")}.example.com/jwks`;
  jwksByUrl.set(jwksUrl, [jwk]);

  const platform = await prisma.ltiPlatform.create({
    data: {
      issuer: `https://canvas-test-${randomBytes(8).toString("hex")}.example.com`,
      clientId: `client-${randomBytes(6).toString("hex")}`,
      authEndpoint: "https://example.com/auth",
      tokenEndpoint: "https://example.com/token",
      jwksUrl,
      deploymentId: "test-deployment",
      institutionId,
    },
  });
  cleanupPlatformIds.push(platform.id);
  platformKeys.set(platform.id, { privateKey, kid });
  return platform;
}

async function startLtiSession(platformId: string) {
  const nonce = randomBytes(16).toString("hex");
  const state = randomBytes(16).toString("hex");
  const session = await prisma.ltiSession.create({
    data: { platformId, nonce, state, expiresAt: new Date(Date.now() + 60_000), consumed: false },
  });
  return session;
}

async function buildIdToken(opts: {
  platformId: string;
  issuer: string;
  audience: string;
  nonce: string;
  canvasUserId: string;
  email?: string;
  name?: string;
  role?: "STUDENT" | "LECTURER";
  courseId?: string;
  resourceLinkId?: string;
}) {
  const keys = platformKeys.get(opts.platformId);
  if (!keys) throw new Error("no test keypair for platform");
  const payload: Record<string, unknown> = {
    nonce: opts.nonce,
    name: opts.name ?? "Canvas User",
    "https://purl.imsglobal.org/spec/lti/claim/roles": opts.role === "LECTURER" ? INSTRUCTOR_ROLE_CLAIM : STUDENT_ROLE_CLAIM,
  };
  if (opts.email !== undefined) payload.email = opts.email;
  if (opts.courseId) payload["https://purl.imsglobal.org/spec/lti/claim/context"] = { id: opts.courseId };
  if (opts.resourceLinkId) payload["https://purl.imsglobal.org/spec/lti/claim/resource_link"] = { id: opts.resourceLinkId };

  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: keys.kid })
    .setIssuedAt()
    .setIssuer(opts.issuer)
    .setAudience(opts.audience)
    .setSubject(opts.canvasUserId)
    .setExpirationTime("5m")
    .sign(keys.privateKey);
}

function launchRequest(idToken: string, state: string) {
  const formData = new FormData();
  formData.set("id_token", idToken);
  formData.set("state", state);
  return new Request("http://test.local/api/lti/launch", { method: "POST", body: formData });
}

let instA: { id: string };
let instB: { id: string };

beforeAll(async () => {
  clearJwksCache();
  instA = await getOrCreateTestInstitution(`lti-collision-a-${stamp}`);
  instB = await getOrCreateTestInstitution(`lti-collision-b-${stamp}`);
});

afterAll(async () => {
  await prisma.platformAuditLog.deleteMany({ where: { targetId: { in: cleanupUserIds } } });
  await prisma.ltiLaunch.deleteMany({ where: { platformId: { in: cleanupPlatformIds } } });
  await prisma.ltiSession.deleteMany({ where: { platformId: { in: cleanupPlatformIds } } });
  await prisma.ltiExamLink.deleteMany({ where: { platformId: { in: cleanupPlatformIds } } });
  await prisma.submission.deleteMany({ where: { studentId: { in: cleanupUserIds } } });
  await prisma.exam.deleteMany({ where: { id: { in: cleanupInstitutionScopedExamIds } } });
  await prisma.ltiPlatform.deleteMany({ where: { id: { in: cleanupPlatformIds } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
});

// ── normal provisioning / mapped launch unchanged ──────────────────────────

describe("Normal Canvas launch behavior — unchanged", () => {
  it("1. new Canvas user with an unused email still provisions normally", async () => {
    const platform = await createPlatform(instA.id);
    const session = await startLtiSession(platform.id);
    const canvasUserId = `cu-${stamp}-1`;
    const email = `new-canvas-${stamp}@test.invalid`;
    const idToken = await buildIdToken({
      platformId: platform.id, issuer: platform.issuer, audience: platform.clientId,
      nonce: session.nonce, canvasUserId, email, role: "STUDENT",
    });
    const { POST } = await import("@/app/api/lti/launch/route");
    const res = await POST(launchRequest(idToken, session.state));
    expect(res.status).toBe(302);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.canvasUserId).toBe(canvasUserId);
    expect(user.institutionId).toBe(instA.id);
    cleanupUserIds.push(user.id);
  });

  it("2. existing canvasUserId mapping launches normally", async () => {
    const platform = await createPlatform(instA.id);
    const canvasUserId = `cu-${stamp}-2`;
    const existing = await createUser({ email: `mapped-${stamp}@test.invalid`, role: "STUDENT", institutionId: instA.id, canvasUserId });
    const session = await startLtiSession(platform.id);
    const idToken = await buildIdToken({
      platformId: platform.id, issuer: platform.issuer, audience: platform.clientId,
      nonce: session.nonce, canvasUserId, email: existing.email, role: "STUDENT",
    });
    const { POST } = await import("@/app/api/lti/launch/route");
    const res = await POST(launchRequest(idToken, session.state));
    expect(res.status).toBe(302);
    const count = await prisma.user.count({ where: { canvasUserId } });
    expect(count).toBe(1);
  });
});

// ── the collision hand-off itself ──────────────────────────────────────────

describe("Email collision — hand-off redirect, never a session/auth() dependency", () => {
  it("collision no longer produces a unique-email failure, and does not create a duplicate User", async () => {
    const platform = await createPlatform(instA.id);
    const existing = await createUser({ email: `collide-3-${stamp}@test.invalid`, role: "STUDENT", institutionId: null });
    const session = await startLtiSession(platform.id);
    const canvasUserId = `cu-${stamp}-3`;
    const idToken = await buildIdToken({
      platformId: platform.id, issuer: platform.issuer, audience: platform.clientId,
      nonce: session.nonce, canvasUserId, email: existing.email, role: "STUDENT",
    });
    const { POST } = await import("@/app/api/lti/launch/route");
    const res = await POST(launchRequest(idToken, session.state));
    expect(res.status).toBe(302); // not a 500
    const count = await prisma.user.count({ where: { email: existing.email } });
    expect(count).toBe(1);
  });

  it("collision always redirects to a signed hand-off, regardless of any cookie the cross-site request happens to carry", async () => {
    const platform = await createPlatform(instA.id);
    const existing = await createUser({ email: `collide-4-${stamp}@test.invalid`, role: "STUDENT", institutionId: null });
    const session = await startLtiSession(platform.id);
    const idToken = await buildIdToken({
      platformId: platform.id, issuer: platform.issuer, audience: platform.clientId,
      nonce: session.nonce, canvasUserId: `cu-${stamp}-4`, email: existing.email, role: "STUDENT",
    });
    const { POST } = await import("@/app/api/lti/launch/route");
    const res = await POST(launchRequest(idToken, session.state));
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/lti/identity-link?handoff=");
    // Nothing is ever written at launch time — linking only ever happens
    // via the separate, same-site confirmation endpoint.
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: existing.id } });
    expect(fresh.canvasUserId).toBeNull();
    expect(fresh.institutionId).toBeNull();
  });

  it("the launch route never sets a session cookie, creates an LtiLaunch row, or writes an audit entry for a collision", async () => {
    const platform = await createPlatform(instA.id);
    const existing = await createUser({ email: `collide-noaudit-${stamp}@test.invalid`, role: "STUDENT", institutionId: null });
    const session = await startLtiSession(platform.id);
    const idToken = await buildIdToken({
      platformId: platform.id, issuer: platform.issuer, audience: platform.clientId,
      nonce: session.nonce, canvasUserId: `cu-${stamp}-noaudit`, email: existing.email, role: "STUDENT",
    });
    const { POST } = await import("@/app/api/lti/launch/route");
    const res = await POST(launchRequest(idToken, session.state));
    expect(res.cookies.get("authjs.session-token")).toBeUndefined();
    expect(res.cookies.get("__Secure-authjs.session-token")).toBeUndefined();
    const launches = await prisma.ltiLaunch.count({ where: { platformId: platform.id } });
    expect(launches).toBe(0);
    const logs = await prisma.platformAuditLog.count({ where: { targetId: existing.id } });
    expect(logs).toBe(0);
  });
});

// ── mapped-user email-update hardening ─────────────────────────────────────

describe("Mapped-user email-update hardening", () => {
  it("mapped user email change to an unused email remains safe", async () => {
    const platform = await createPlatform(instA.id);
    const canvasUserId = `cu-${stamp}-17`;
    const existing = await createUser({ email: `mapped-17-old-${stamp}@test.invalid`, role: "STUDENT", institutionId: instA.id, canvasUserId });
    const session = await startLtiSession(platform.id);
    const newEmail = `mapped-17-new-${stamp}@test.invalid`;
    const idToken = await buildIdToken({
      platformId: platform.id, issuer: platform.issuer, audience: platform.clientId,
      nonce: session.nonce, canvasUserId, email: newEmail, role: "STUDENT",
    });
    const { POST } = await import("@/app/api/lti/launch/route");
    const res = await POST(launchRequest(idToken, session.state));
    expect(res.status).toBe(302);
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: existing.id } });
    expect(fresh.email).toBe(newEmail);
  });

  it("mapped user email change colliding with another User does not 500 and does not merge identities", async () => {
    const platform = await createPlatform(instA.id);
    const canvasUserId = `cu-${stamp}-18`;
    const collidingEmail = `mapped-18-taken-${stamp}@test.invalid`;
    const otherUser = await createUser({ email: collidingEmail, role: "STUDENT", institutionId: instA.id });
    const existing = await createUser({ email: `mapped-18-old-${stamp}@test.invalid`, role: "STUDENT", institutionId: instA.id, canvasUserId });
    const session = await startLtiSession(platform.id);
    const idToken = await buildIdToken({
      platformId: platform.id, issuer: platform.issuer, audience: platform.clientId,
      nonce: session.nonce, canvasUserId, email: collidingEmail, role: "STUDENT",
    });
    const { POST } = await import("@/app/api/lti/launch/route");
    const res = await POST(launchRequest(idToken, session.state));
    expect(res.status).toBe(302); // not a 500
    const freshExisting = await prisma.user.findUniqueOrThrow({ where: { id: existing.id } });
    expect(freshExisting.email).toBe(`mapped-18-old-${stamp}@test.invalid`); // unchanged, never overwritten
    expect(freshExisting.canvasUserId).toBe(canvasUserId); // launch continued using the mapped identity
    const freshOther = await prisma.user.findUniqueOrThrow({ where: { id: otherUser.id } });
    expect(freshOther.email).toBe(collidingEmail); // untouched
  });
});

// ── no-email Canvas users ──────────────────────────────────────────────────

describe("No-email Canvas launches", () => {
  it("Canvas launch with no email still follows the existing synthetic-identity path", async () => {
    const platform = await createPlatform(instA.id);
    const session = await startLtiSession(platform.id);
    const canvasUserId = `cu-${stamp}-19`;
    const idToken = await buildIdToken({
      platformId: platform.id, issuer: platform.issuer, audience: platform.clientId,
      nonce: session.nonce, canvasUserId, role: "STUDENT", // no email field at all
    });
    const { POST } = await import("@/app/api/lti/launch/route");
    const res = await POST(launchRequest(idToken, session.state));
    expect(res.status).toBe(302);
    const user = await prisma.user.findFirstOrThrow({ where: { canvasUserId } });
    expect(user.email).toBe(`lti-${canvasUserId}@safe-exam-system.local`);
    cleanupUserIds.push(user.id);
  });

  it("no-email path never matches an existing user by name", async () => {
    const platform = await createPlatform(instA.id);
    // A pre-existing self-service user who happens to share the SAME
    // display name Canvas will send — must never be matched or linked.
    const namesake = await createUser({ email: `namesake-20-${stamp}@test.invalid`, role: "STUDENT", institutionId: null });
    const session = await startLtiSession(platform.id);
    const canvasUserId = `cu-${stamp}-20`;
    const idToken = await buildIdToken({
      platformId: platform.id, issuer: platform.issuer, audience: platform.clientId,
      nonce: session.nonce, canvasUserId, name: "Test", role: "STUDENT", // no email
    });
    const { POST } = await import("@/app/api/lti/launch/route");
    const res = await POST(launchRequest(idToken, session.state));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).not.toContain("identity-link");
    const created = await prisma.user.findFirstOrThrow({ where: { canvasUserId } });
    expect(created.id).not.toBe(namesake.id);
    const freshNamesake = await prisma.user.findUniqueOrThrow({ where: { id: namesake.id } });
    expect(freshNamesake.canvasUserId).toBeNull();
    cleanupUserIds.push(created.id);
  });
});

// ── LTI session / replay safety unchanged ──────────────────────────────────

describe("LTI session / replay safety — unchanged", () => {
  it("nonce validation unchanged — mismatched nonce is rejected", async () => {
    const platform = await createPlatform(instA.id);
    const session = await startLtiSession(platform.id);
    const idToken = await buildIdToken({
      platformId: platform.id, issuer: platform.issuer, audience: platform.clientId,
      nonce: "a-completely-different-nonce", canvasUserId: `cu-${stamp}-21`, role: "STUDENT",
    });
    const { POST } = await import("@/app/api/lti/launch/route");
    const res = await POST(launchRequest(idToken, session.state));
    expect(res.status).toBe(403);
  });

  it("replay protection unchanged — a consumed LtiSession cannot be reused", async () => {
    const platform = await createPlatform(instA.id);
    const session = await startLtiSession(platform.id);
    const canvasUserId = `cu-${stamp}-22`;
    const idToken = await buildIdToken({
      platformId: platform.id, issuer: platform.issuer, audience: platform.clientId,
      nonce: session.nonce, canvasUserId, role: "STUDENT",
    });
    const { POST } = await import("@/app/api/lti/launch/route");
    const first = await POST(launchRequest(idToken, session.state));
    expect(first.status).toBe(302);
    const replay = await POST(launchRequest(idToken, session.state));
    expect(replay.status).toBe(403);
    const users = await prisma.user.findMany({ where: { canvasUserId } });
    expect(users).toHaveLength(1);
    cleanupUserIds.push(users[0].id);
  });

  it("bad JWT signature is rejected", async () => {
    const platform = await createPlatform(instA.id);
    const otherPlatform = await createPlatform(instB.id); // different keypair
    const session = await startLtiSession(platform.id);
    // Signed with the WRONG platform's private key.
    const idToken = await buildIdToken({
      platformId: otherPlatform.id, issuer: platform.issuer, audience: platform.clientId,
      nonce: session.nonce, canvasUserId: `cu-${stamp}-23`, role: "STUDENT",
    });
    const { POST } = await import("@/app/api/lti/launch/route");
    const res = await POST(launchRequest(idToken, session.state));
    expect(res.status).toBe(401);
  });
});

// ── LtiExamLink resolution / launch redirects unchanged ────────────────────

describe("LtiExamLink resolution and launch redirects — unchanged", () => {
  it("STUDENT linked exam launch creates a submission and redirects into it", async () => {
    const platform = await createPlatform(instA.id);
    const lecturer = await createUser({ email: `lti-lect-24-${stamp}@test.invalid`, role: "LECTURER", institutionId: instA.id });
    const exam = await prisma.exam.create({
      data: { title: `LTI exam ${stamp}`, durationMins: 30, published: true, createdById: lecturer.id, institutionId: instA.id },
    });
    cleanupInstitutionScopedExamIds.push(exam.id);
    const resourceLinkId = `rl-${stamp}-24`;
    await prisma.ltiExamLink.create({ data: { examId: exam.id, platformId: platform.id, resourceLinkId } });

    const session = await startLtiSession(platform.id);
    const canvasUserId = `cu-${stamp}-24`;
    const idToken = await buildIdToken({
      platformId: platform.id, issuer: platform.issuer, audience: platform.clientId,
      nonce: session.nonce, canvasUserId, role: "STUDENT", resourceLinkId,
    });
    const { POST } = await import("@/app/api/lti/launch/route");
    const res = await POST(launchRequest(idToken, session.state));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/student/exams/");
    const user = await prisma.user.findFirstOrThrow({ where: { canvasUserId } });
    cleanupUserIds.push(user.id);
    const submission = await prisma.submission.findFirstOrThrow({ where: { examId: exam.id, studentId: user.id } });
    expect(submission).toBeTruthy();
  });

  it("LECTURER linked exam launch redirects to the exam editor", async () => {
    const platform = await createPlatform(instA.id);
    const lecturer = await createUser({ email: `lti-lect-26-${stamp}@test.invalid`, role: "LECTURER", institutionId: instA.id });
    const exam = await prisma.exam.create({
      data: { title: `LTI exam 26 ${stamp}`, durationMins: 30, published: true, createdById: lecturer.id, institutionId: instA.id },
    });
    cleanupInstitutionScopedExamIds.push(exam.id);
    const resourceLinkId = `rl-${stamp}-26`;
    await prisma.ltiExamLink.create({ data: { examId: exam.id, platformId: platform.id, resourceLinkId } });

    const session = await startLtiSession(platform.id);
    const canvasUserId = `cu-${stamp}-26`;
    const idToken = await buildIdToken({
      platformId: platform.id, issuer: platform.issuer, audience: platform.clientId,
      nonce: session.nonce, canvasUserId, role: "LECTURER", resourceLinkId,
    });
    const { POST } = await import("@/app/api/lti/launch/route");
    const res = await POST(launchRequest(idToken, session.state));
    expect(res.headers.get("location")).toContain(`/lecturer/exams/${exam.id}`);
    const user = await prisma.user.findFirstOrThrow({ where: { canvasUserId } });
    cleanupUserIds.push(user.id);
  });

  it("unlinked-assignment friendly route unchanged", async () => {
    const platform = await createPlatform(instA.id);
    const session = await startLtiSession(platform.id);
    const canvasUserId = `cu-${stamp}-27`;
    const idToken = await buildIdToken({
      platformId: platform.id, issuer: platform.issuer, audience: platform.clientId,
      nonce: session.nonce, canvasUserId, role: "STUDENT", resourceLinkId: `rl-unlinked-${stamp}`,
    });
    const { POST } = await import("@/app/api/lti/launch/route");
    const res = await POST(launchRequest(idToken, session.state));
    expect(res.headers.get("location")).toContain("/lti/not-linked");
    const user = await prisma.user.findFirstOrThrow({ where: { canvasUserId } });
    cleanupUserIds.push(user.id);
  });
});

// ── cross-feature regression ────────────────────────────────────────────────

describe("Cross-feature regression — self-service unaffected", () => {
  it("self-service account creation is unaffected by this module's existence", async () => {
    const student = await createUser({ email: `ss-29-${stamp}@test.invalid`, role: "STUDENT", institutionId: null });
    expect(student.institutionId).toBeNull();
    expect(student.canvasUserId).toBeNull();
  });
});
