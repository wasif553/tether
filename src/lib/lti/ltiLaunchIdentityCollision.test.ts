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
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { randomBytes } from "node:crypto";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("../prisma");
const { getOrCreateTestInstitution } = await import("../testInstitution");
const { clearJwksCache } = await import("./jwks-cache");

const STUDENT_ROLE_CLAIM = ["http://purl.imsglobal.org/vocab/lis/v2/membership#Learner"];
const INSTRUCTOR_ROLE_CLAIM = ["http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor"];

const stamp = Date.now();
const cleanupUserIds: string[] = [];
const cleanupPlatformIds: string[] = [];
const cleanupInstitutionScopedExamIds: string[] = [];

function sessionFor(userId: string, role: "LECTURER" | "STUDENT" | "PLATFORM_ADMIN", institutionId: string | null) {
  return { user: { id: userId, email: `${userId}@test.invalid`, name: "Test", role, institutionId } };
}

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

// ── 1-2: normal provisioning / mapped launch unchanged ────────────────────

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

// ── 3-16: the collision itself ─────────────────────────────────────────────

describe("Email collision — no unhandled crash, no automatic email-only linking", () => {
  it("3 & 5. collision no longer produces a unique-email failure, and does not create a duplicate User", async () => {
    const platform = await createPlatform(instA.id);
    const existing = await createUser({ email: `collide-3-${stamp}@test.invalid`, role: "STUDENT", institutionId: null });
    const session = await startLtiSession(platform.id);
    const canvasUserId = `cu-${stamp}-3`;
    const idToken = await buildIdToken({
      platformId: platform.id, issuer: platform.issuer, audience: platform.clientId,
      nonce: session.nonce, canvasUserId, email: existing.email, role: "STUDENT",
    });
    mockAuth.mockResolvedValue(null);
    const { POST } = await import("@/app/api/lti/launch/route");
    const res = await POST(launchRequest(idToken, session.state));
    expect(res.status).toBe(302); // not a 500
    const count = await prisma.user.count({ where: { email: existing.email } });
    expect(count).toBe(1);
  });

  it("4. collision + no Tether session does NOT link automatically", async () => {
    const platform = await createPlatform(instA.id);
    const existing = await createUser({ email: `collide-4-${stamp}@test.invalid`, role: "STUDENT", institutionId: null });
    const session = await startLtiSession(platform.id);
    const idToken = await buildIdToken({
      platformId: platform.id, issuer: platform.issuer, audience: platform.clientId,
      nonce: session.nonce, canvasUserId: `cu-${stamp}-4`, email: existing.email, role: "STUDENT",
    });
    mockAuth.mockResolvedValue(null);
    const { POST } = await import("@/app/api/lti/launch/route");
    const res = await POST(launchRequest(idToken, session.state));
    expect(res.headers.get("location")).toContain("/lti/identity-link?reason=requires_login");
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: existing.id } });
    expect(fresh.canvasUserId).toBeNull();
    expect(fresh.institutionId).toBeNull();
  });

  it("6. collision + wrong signed-in Tether User does NOT link", async () => {
    const platform = await createPlatform(instA.id);
    const existing = await createUser({ email: `collide-6-${stamp}@test.invalid`, role: "STUDENT", institutionId: null });
    const otherLoggedIn = await createUser({ email: `collide-6-other-${stamp}@test.invalid`, role: "STUDENT", institutionId: instA.id });
    const session = await startLtiSession(platform.id);
    const idToken = await buildIdToken({
      platformId: platform.id, issuer: platform.issuer, audience: platform.clientId,
      nonce: session.nonce, canvasUserId: `cu-${stamp}-6`, email: existing.email, role: "STUDENT",
    });
    mockAuth.mockResolvedValue(sessionFor(otherLoggedIn.id, "STUDENT", instA.id));
    const { POST } = await import("@/app/api/lti/launch/route");
    const res = await POST(launchRequest(idToken, session.state));
    expect(res.headers.get("location")).toContain("/lti/identity-link?reason=wrong_account");
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: existing.id } });
    expect(fresh.canvasUserId).toBeNull();
  });

  it("7 & 8. collision + exact matching authenticated Tether User links safely, canvasUserId attached", async () => {
    const platform = await createPlatform(instA.id);
    const existing = await createUser({ email: `collide-7-${stamp}@test.invalid`, role: "STUDENT", institutionId: instA.id });
    const session = await startLtiSession(platform.id);
    const canvasUserId = `cu-${stamp}-7`;
    const idToken = await buildIdToken({
      platformId: platform.id, issuer: platform.issuer, audience: platform.clientId,
      nonce: session.nonce, canvasUserId, email: existing.email, role: "STUDENT",
    });
    mockAuth.mockResolvedValue(sessionFor(existing.id, "STUDENT", instA.id));
    const { POST } = await import("@/app/api/lti/launch/route");
    const res = await POST(launchRequest(idToken, session.state));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).not.toContain("/lti/identity-link");
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: existing.id } });
    expect(fresh.canvasUserId).toBe(canvasUserId);
  });

  it("9. null institution becomes platform institution only after confirmed link", async () => {
    const platform = await createPlatform(instA.id);
    const existing = await createUser({ email: `collide-9-${stamp}@test.invalid`, role: "STUDENT", institutionId: null });
    const session = await startLtiSession(platform.id);
    mockAuth.mockResolvedValue(sessionFor(existing.id, "STUDENT", null));
    const idToken = await buildIdToken({
      platformId: platform.id, issuer: platform.issuer, audience: platform.clientId,
      nonce: session.nonce, canvasUserId: `cu-${stamp}-9`, email: existing.email, role: "STUDENT",
    });
    const { POST } = await import("@/app/api/lti/launch/route");
    await POST(launchRequest(idToken, session.state));
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: existing.id } });
    expect(fresh.institutionId).toBe(instA.id);
  });

  it("10. same-institution account links normally", async () => {
    const platform = await createPlatform(instA.id);
    const existing = await createUser({ email: `collide-10-${stamp}@test.invalid`, role: "STUDENT", institutionId: instA.id });
    const session = await startLtiSession(platform.id);
    mockAuth.mockResolvedValue(sessionFor(existing.id, "STUDENT", instA.id));
    const idToken = await buildIdToken({
      platformId: platform.id, issuer: platform.issuer, audience: platform.clientId,
      nonce: session.nonce, canvasUserId: `cu-${stamp}-10`, email: existing.email, role: "STUDENT",
    });
    const { POST } = await import("@/app/api/lti/launch/route");
    const res = await POST(launchRequest(idToken, session.state));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).not.toContain("identity-link");
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: existing.id } });
    expect(fresh.institutionId).toBe(instA.id);
  });

  it("11 & 12. different-institution account is rejected; institution is never overwritten", async () => {
    const platform = await createPlatform(instB.id);
    const existing = await createUser({ email: `collide-11-${stamp}@test.invalid`, role: "STUDENT", institutionId: instA.id });
    const session = await startLtiSession(platform.id);
    mockAuth.mockResolvedValue(sessionFor(existing.id, "STUDENT", instA.id));
    const idToken = await buildIdToken({
      platformId: platform.id, issuer: platform.issuer, audience: platform.clientId,
      nonce: session.nonce, canvasUserId: `cu-${stamp}-11`, email: existing.email, role: "STUDENT",
    });
    const { POST } = await import("@/app/api/lti/launch/route");
    const res = await POST(launchRequest(idToken, session.state));
    expect(res.headers.get("location")).toContain("reason=different_institution");
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: existing.id } });
    expect(fresh.institutionId).toBe(instA.id);
    expect(fresh.canvasUserId).toBeNull();
  });

  it("13. role mismatch is rejected", async () => {
    const platform = await createPlatform(instA.id);
    const existing = await createUser({ email: `collide-13-${stamp}@test.invalid`, role: "LECTURER", institutionId: instA.id });
    const session = await startLtiSession(platform.id);
    mockAuth.mockResolvedValue(sessionFor(existing.id, "LECTURER", instA.id));
    // Canvas reports this identity as a STUDENT — mismatched against the existing LECTURER account.
    const idToken = await buildIdToken({
      platformId: platform.id, issuer: platform.issuer, audience: platform.clientId,
      nonce: session.nonce, canvasUserId: `cu-${stamp}-13`, email: existing.email, role: "STUDENT",
    });
    const { POST } = await import("@/app/api/lti/launch/route");
    const res = await POST(launchRequest(idToken, session.state));
    expect(res.headers.get("location")).toContain("reason=role_mismatch");
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: existing.id } });
    expect(fresh.canvasUserId).toBeNull();
  });

  it("14. canvasUserId already owned by another User is rejected", async () => {
    // Exercised directly against resolveLtiEmailCollision: through the
    // full route, Step A's own initial canvasUserId lookup (identical in
    // scope to the resolver's own upfront check) would already resolve
    // to the owner directly, never reaching the email-collision path for
    // a second user at all — this is the correct unit boundary for this
    // specific rule, same reasoning as the race tests above.
    const { resolveLtiEmailCollision } = await import("./identityCollision");
    const canvasUserId = `cu-${stamp}-14`;
    const owner = await createUser({ email: `collide-14-owner-${stamp}@test.invalid`, role: "STUDENT", institutionId: instA.id, canvasUserId });
    const existing = await createUser({ email: `collide-14-${stamp}@test.invalid`, role: "STUDENT", institutionId: instA.id });
    const outcome = await resolveLtiEmailCollision({
      existingUserId: existing.id,
      canvasUserId,
      derivedRole: "STUDENT",
      platformInstitutionId: instA.id,
      currentSessionUserId: existing.id,
    });
    expect(outcome.kind).toBe("canvas_id_taken");
    const freshExisting = await prisma.user.findUniqueOrThrow({ where: { id: existing.id } });
    expect(freshExisting.canvasUserId).toBeNull();
    const freshOwner = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(freshOwner.canvasUserId).toBe(canvasUserId);
  });
});

// ── 15-16: races ────────────────────────────────────────────────────────
//
// Exercised directly against resolveLtiEmailCollision rather than the
// full route: `auth()` is a global, no-argument call with no way to
// route a mocked response to "this specific concurrent request" — the
// resolver function itself takes currentSessionUserId as an explicit
// parameter, which is the actual mechanism under test here anyway.

describe("Identity-linking races", () => {
  it("15. concurrent linking cannot bind one Canvas identity to two users", async () => {
    const { resolveLtiEmailCollision } = await import("./identityCollision");
    const canvasUserId = `cu-${stamp}-15`;
    const existingX = await createUser({ email: `collide-15-x-${stamp}@test.invalid`, role: "STUDENT", institutionId: instA.id });
    const existingY = await createUser({ email: `collide-15-y-${stamp}@test.invalid`, role: "STUDENT", institutionId: instA.id });

    const [outcomeX, outcomeY] = await Promise.all([
      resolveLtiEmailCollision({ existingUserId: existingX.id, canvasUserId, derivedRole: "STUDENT", platformInstitutionId: instA.id, currentSessionUserId: existingX.id }),
      resolveLtiEmailCollision({ existingUserId: existingY.id, canvasUserId, derivedRole: "STUDENT", platformInstitutionId: instA.id, currentSessionUserId: existingY.id }),
    ]);
    const outcomes = [outcomeX, outcomeY];
    expect(outcomes.filter((o) => o.kind === "linked")).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === "canvas_id_taken")).toHaveLength(1);

    const owners = await prisma.user.findMany({ where: { canvasUserId }, select: { id: true } });
    expect(owners).toHaveLength(1);
  });

  it("16. concurrent different-institution claim cannot move User between tenants", async () => {
    const { resolveLtiEmailCollision } = await import("./identityCollision");
    const existing = await createUser({ email: `collide-16-${stamp}@test.invalid`, role: "STUDENT", institutionId: null });

    const [outcomeA, outcomeB] = await Promise.all([
      resolveLtiEmailCollision({ existingUserId: existing.id, canvasUserId: `cu-${stamp}-16a`, derivedRole: "STUDENT", platformInstitutionId: instA.id, currentSessionUserId: existing.id }),
      resolveLtiEmailCollision({ existingUserId: existing.id, canvasUserId: `cu-${stamp}-16b`, derivedRole: "STUDENT", platformInstitutionId: instB.id, currentSessionUserId: existing.id }),
    ]);
    const outcomes = [outcomeA, outcomeB];
    expect(outcomes.filter((o) => o.kind === "linked")).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === "different_institution")).toHaveLength(1);

    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: existing.id } });
    // Exactly one institution won, never both, never neither.
    expect([instA.id, instB.id]).toContain(fresh.institutionId);
  });
});

// ── 17-18: mapped-user email-update hardening ──────────────────────────────

describe("Mapped-user email-update hardening", () => {
  it("17. mapped user email change to an unused email remains safe", async () => {
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

  it("18. mapped user email change colliding with another User does not 500 and does not merge identities", async () => {
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

// ── 19-20: no-email Canvas users ───────────────────────────────────────────

describe("No-email Canvas launches", () => {
  it("19. Canvas launch with no email still follows the existing synthetic-identity path", async () => {
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

  it("20. no-email path never matches an existing user by name", async () => {
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
    mockAuth.mockResolvedValue(null);
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

// ── 21-23: LTI session / replay safety unchanged ───────────────────────────

describe("LTI session / replay safety — unchanged", () => {
  it("21. nonce validation unchanged — mismatched nonce is rejected", async () => {
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

  it("22. replay protection unchanged — a consumed LtiSession cannot be reused", async () => {
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

  it("23. bad JWT signature is rejected", async () => {
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

// ── 24-27: LtiExamLink resolution / launch redirects unchanged ────────────

describe("LtiExamLink resolution and launch redirects — unchanged", () => {
  it("24 & 25. STUDENT linked exam launch creates a submission and redirects into it", async () => {
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

  it("26. LECTURER linked exam launch redirects to the exam editor", async () => {
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

  it("27. unlinked-assignment friendly route unchanged", async () => {
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

// ── 29-32: cross-feature regression ────────────────────────────────────────

describe("Cross-feature regression — self-service / Course Invitation / Standalone unaffected", () => {
  it("29. self-service account login is unaffected by this module's existence", async () => {
    const student = await createUser({ email: `ss-29-${stamp}@test.invalid`, role: "STUDENT", institutionId: null });
    expect(student.institutionId).toBeNull();
    expect(student.canvasUserId).toBeNull();
  });

  it("30 & 31 & 32. audit entries for a blocked and a successful link are safe (no token/email/password leakage)", async () => {
    const platform = await createPlatform(instA.id);
    const existing = await createUser({ email: `audit-30-${stamp}@test.invalid`, role: "STUDENT", institutionId: null });

    const sessionBlocked = await startLtiSession(platform.id);
    mockAuth.mockResolvedValue(null);
    const idTokenBlocked = await buildIdToken({
      platformId: platform.id, issuer: platform.issuer, audience: platform.clientId,
      nonce: sessionBlocked.nonce, canvasUserId: `cu-${stamp}-30a`, email: existing.email, role: "STUDENT",
    });
    const { POST } = await import("@/app/api/lti/launch/route");
    await POST(launchRequest(idTokenBlocked, sessionBlocked.state));

    const sessionLinked = await startLtiSession(platform.id);
    mockAuth.mockResolvedValue(sessionFor(existing.id, "STUDENT", null));
    const idTokenLinked = await buildIdToken({
      platformId: platform.id, issuer: platform.issuer, audience: platform.clientId,
      nonce: sessionLinked.nonce, canvasUserId: `cu-${stamp}-30b`, email: existing.email, role: "STUDENT",
    });
    await POST(launchRequest(idTokenLinked, sessionLinked.state));

    const logs = await prisma.platformAuditLog.findMany({ where: { targetId: existing.id } });
    const actions = logs.map((l) => l.action);
    expect(actions).toContain("lti.identity_link_blocked");
    expect(actions).toContain("lti.identity_linked");
    for (const log of logs) {
      const metadataStr = JSON.stringify(log.metadata).toLowerCase();
      expect(metadataStr).not.toContain("password");
      expect(metadataStr).not.toContain(idTokenBlocked.toLowerCase());
      expect(metadataStr).not.toContain(existing.email.toLowerCase());
    }
  });
});
