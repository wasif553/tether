/**
 * LTI email normalization hardening — DB-backed route tests. See
 * docs/lti-identity-collision-hardening-v1.md.
 *
 * Requires the local test Postgres instance (run via
 * `npm run release:validate`) — src/lib/prisma.ts's
 * assertSafeDatabaseUrlForTests guard blocks a plain `vitest run`.
 *
 * Covers the actual defect: Canvas/LTI supplied an email in a different
 * case/whitespace representation than the stored (self-service-
 * normalized) User.email, so an exact-string lookup missed a real
 * collision. Confirms normalization now makes case-only differences
 * detected as the same candidate identity, WITHOUT making email alone
 * sufficient to link (ownership confirmation is still required), and
 * that the raw signed claim evidence (launchClaimsJson) is never
 * mutated by normalization.
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

const stamp = Date.now();
const cleanupUserIds: string[] = [];
const cleanupPlatformIds: string[] = [];

function sessionFor(userId: string, role: "STUDENT" | "LECTURER", institutionId: string | null) {
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
    return new Response(JSON.stringify({ keys: keys ?? [] }), { status: 200 });
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
  return prisma.ltiSession.create({
    data: { platformId, nonce, state, expiresAt: new Date(Date.now() + 60_000), consumed: false },
  });
}

async function buildIdToken(opts: {
  platformId: string;
  issuer: string;
  audience: string;
  nonce: string;
  canvasUserId: string;
  email?: string;
  role?: "STUDENT" | "LECTURER";
}) {
  const keys = platformKeys.get(opts.platformId);
  if (!keys) throw new Error("no test keypair for platform");
  const payload: Record<string, unknown> = {
    nonce: opts.nonce,
    name: "Canvas User",
    "https://purl.imsglobal.org/spec/lti/claim/roles": STUDENT_ROLE_CLAIM,
  };
  if (opts.email !== undefined) payload.email = opts.email;

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

function extractHandoff(location: string): string {
  const url = new URL(location);
  const handoff = url.searchParams.get("handoff");
  if (!handoff) throw new Error(`no handoff in redirect location: ${location}`);
  return handoff;
}

let instA: { id: string };

beforeAll(async () => {
  clearJwksCache();
  instA = await getOrCreateTestInstitution(`lti-email-norm-a-${stamp}`);
});

afterAll(async () => {
  await prisma.platformAuditLog.deleteMany({ where: { targetId: { in: cleanupUserIds } } });
  await prisma.ltiLaunch.deleteMany({ where: { platformId: { in: cleanupPlatformIds } } });
  await prisma.ltiSession.deleteMany({ where: { platformId: { in: cleanupPlatformIds } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  await prisma.ltiPlatform.deleteMany({ where: { id: { in: cleanupPlatformIds } } });
});

describe("Case-only email collision is now detected", () => {
  it("4 & 5 & 6. a case-differing Canvas email collides with an existing lowercase self-service User, no duplicate is created, and a signed handoff is issued", async () => {
    const platform = await createPlatform(instA.id);
    const lowercaseEmail = `stanley.wisoky-${stamp}@example.org`;
    const existing = await createUser({ email: lowercaseEmail, role: "STUDENT", institutionId: null });

    const session = await startLtiSession(platform.id);
    const mixedCaseClaim = `  Stanley.Wisoky-${stamp}@Example.Org  `;
    const idToken = await buildIdToken({
      platformId: platform.id, issuer: platform.issuer, audience: platform.clientId,
      nonce: session.nonce, canvasUserId: `cu-norm-${stamp}-1`, email: mixedCaseClaim, role: "STUDENT",
    });

    const { POST } = await import("@/app/api/lti/launch/route");
    const res = await POST(launchRequest(idToken, session.state));
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/lti/identity-link?handoff=");
    const handoff = extractHandoff(location);
    expect(handoff).toBeTruthy();

    // No duplicate User — only the original self-service account exists
    // for this normalized email.
    const matches = await prisma.user.count({ where: { email: lowercaseEmail } });
    expect(matches).toBe(1);
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: existing.id } });
    expect(fresh.canvasUserId).toBeNull(); // not linked yet — collision only
  });

  it("7. email match alone still does NOT link the account (no session -> requires_login-style handoff, zero writes)", async () => {
    const platform = await createPlatform(instA.id);
    const lowercaseEmail = `nolinkalone-${stamp}@example.org`;
    const existing = await createUser({ email: lowercaseEmail, role: "STUDENT", institutionId: null });
    const session = await startLtiSession(platform.id);
    const idToken = await buildIdToken({
      platformId: platform.id, issuer: platform.issuer, audience: platform.clientId,
      nonce: session.nonce, canvasUserId: `cu-norm-${stamp}-7`, email: lowercaseEmail.toUpperCase(), role: "STUDENT",
    });
    const { POST } = await import("@/app/api/lti/launch/route");
    const res = await POST(launchRequest(idToken, session.state));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/lti/identity-link?handoff=");
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: existing.id } });
    expect(fresh.canvasUserId).toBeNull();
    expect(fresh.institutionId).toBeNull();
  });

  it("8. the exact authenticated Tether user must still explicitly confirm — a different signed-in user cannot use the normalized-match handoff", async () => {
    const platform = await createPlatform(instA.id);
    const lowercaseEmail = `confirm-required-${stamp}@example.org`;
    const existing = await createUser({ email: lowercaseEmail, role: "STUDENT", institutionId: null });
    const otherUser = await createUser({ email: `other-${stamp}@example.org`, role: "STUDENT", institutionId: instA.id });
    const session = await startLtiSession(platform.id);
    const idToken = await buildIdToken({
      platformId: platform.id, issuer: platform.issuer, audience: platform.clientId,
      nonce: session.nonce, canvasUserId: `cu-norm-${stamp}-8`, email: lowercaseEmail.toUpperCase(), role: "STUDENT",
    });
    const { POST: launch } = await import("@/app/api/lti/launch/route");
    const launchRes = await launch(launchRequest(idToken, session.state));
    const handoff = extractHandoff(launchRes.headers.get("location") ?? "");

    mockAuth.mockResolvedValue(sessionFor(otherUser.id, "STUDENT", instA.id));
    const { POST: confirm } = await import("@/app/api/lti/identity-link/confirm/route");
    const confirmRes = await confirm(
      new Request("http://test.local/api/lti/identity-link/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handoff }),
      }),
    );
    const body = await confirmRes.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("wrong_account");
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: existing.id } });
    expect(fresh.canvasUserId).toBeNull();
  });
});

describe("9. normal new-user provisioning stores the normalized lowercase email", () => {
  it("a brand-new Canvas identity with an unused, mixed-case email is created with a lowercase, trimmed User.email", async () => {
    const platform = await createPlatform(instA.id);
    const session = await startLtiSession(platform.id);
    const mixedCase = `  New.User-${stamp}@Example.ORG  `;
    const idToken = await buildIdToken({
      platformId: platform.id, issuer: platform.issuer, audience: platform.clientId,
      nonce: session.nonce, canvasUserId: `cu-norm-${stamp}-9`, email: mixedCase, role: "STUDENT",
    });
    const { POST } = await import("@/app/api/lti/launch/route");
    const res = await POST(launchRequest(idToken, session.state));
    expect(res.status).toBe(302);
    const user = await prisma.user.findFirstOrThrow({ where: { canvasUserId: `cu-norm-${stamp}-9` } });
    cleanupUserIds.push(user.id);
    expect(user.email).toBe(`new.user-${stamp}@example.org`);
  });
});

describe("10 & 11. mapped-user email canonicalization", () => {
  it("10. a mapped user's historical uppercase email is canonicalized to lowercase when the normalized email is unused", async () => {
    const platform = await createPlatform(instA.id);
    const canvasUserId = `cu-norm-${stamp}-10`;
    const historicalEmail = `Historical.Upper-${stamp}@Example.org`;
    const existing = await createUser({ email: historicalEmail, role: "STUDENT", institutionId: instA.id, canvasUserId });
    const session = await startLtiSession(platform.id);
    // Canvas now sends the SAME logical address, differently cased/whitespaced.
    const idToken = await buildIdToken({
      platformId: platform.id, issuer: platform.issuer, audience: platform.clientId,
      nonce: session.nonce, canvasUserId, email: `  ${historicalEmail.toUpperCase()}  `, role: "STUDENT",
    });
    const { POST } = await import("@/app/api/lti/launch/route");
    const res = await POST(launchRequest(idToken, session.state));
    expect(res.status).toBe(302);
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: existing.id } });
    expect(fresh.email).toBe(historicalEmail.toLowerCase());
  });

  it("11. a mapped user's normalized email collision with a DIFFERENT User does not overwrite or merge", async () => {
    const platform = await createPlatform(instA.id);
    const canvasUserId = `cu-norm-${stamp}-11`;
    const collidingLowercase = `taken-${stamp}@example.org`;
    const otherUser = await createUser({ email: collidingLowercase, role: "STUDENT", institutionId: instA.id });
    const mappedOriginalEmail = `mapped-original-${stamp}@example.org`;
    const existing = await createUser({ email: mappedOriginalEmail, role: "STUDENT", institutionId: instA.id, canvasUserId });
    const session = await startLtiSession(platform.id);
    const idToken = await buildIdToken({
      platformId: platform.id, issuer: platform.issuer, audience: platform.clientId,
      nonce: session.nonce, canvasUserId, email: collidingLowercase.toUpperCase(), role: "STUDENT",
    });
    const { POST } = await import("@/app/api/lti/launch/route");
    const res = await POST(launchRequest(idToken, session.state));
    expect(res.status).toBe(302); // not a 500, not a merge
    const freshExisting = await prisma.user.findUniqueOrThrow({ where: { id: existing.id } });
    expect(freshExisting.email).toBe(mappedOriginalEmail); // unchanged
    expect(freshExisting.canvasUserId).toBe(canvasUserId); // launch continued on the mapped identity
    const freshOther = await prisma.user.findUniqueOrThrow({ where: { id: otherUser.id } });
    expect(freshOther.email).toBe(collidingLowercase); // untouched
  });
});

describe("12. raw launchClaimsJson preserves the platform-supplied email exactly", () => {
  it("the stored claims JSON email is the original mixed-case/whitespace string, not the normalized operational value", async () => {
    const platform = await createPlatform(instA.id);
    const session = await startLtiSession(platform.id);
    const rawClaimEmail = `  Raw.Claim-${stamp}@EXAMPLE.org  `;
    const idToken = await buildIdToken({
      platformId: platform.id, issuer: platform.issuer, audience: platform.clientId,
      nonce: session.nonce, canvasUserId: `cu-norm-${stamp}-12`, email: rawClaimEmail, role: "STUDENT",
    });
    const { POST } = await import("@/app/api/lti/launch/route");
    const res = await POST(launchRequest(idToken, session.state));
    expect(res.status).toBe(302);
    const user = await prisma.user.findFirstOrThrow({ where: { canvasUserId: `cu-norm-${stamp}-12` } });
    cleanupUserIds.push(user.id);
    expect(user.email).toBe(rawClaimEmail.trim().toLowerCase()); // operational: normalized

    const launch = await prisma.ltiLaunch.findFirstOrThrow({ where: { canvasUserId: `cu-norm-${stamp}-12` } });
    const claims = launch.launchClaimsJson as { email?: string } | null;
    expect(claims?.email).toBe(rawClaimEmail); // raw evidence: untouched, exact original string
  });
});
