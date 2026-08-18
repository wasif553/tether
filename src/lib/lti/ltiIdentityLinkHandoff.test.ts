/**
 * Canvas/LTI identity-collision browser-flow hardening — DB-backed
 * route tests. See docs/lti-identity-collision-hardening-v1.md.
 *
 * Requires the local test Postgres instance (run via
 * `npm run release:validate`) — src/lib/prisma.ts's
 * assertSafeDatabaseUrlForTests guard blocks a plain `vitest run`.
 *
 * Covers the signed hand-off token itself, the same-site confirmation
 * endpoint (POST /api/lti/identity-link/confirm) and every
 * resolveLtiEmailCollision outcome reachable through it, the full
 * end-to-end path from a collision launch through confirmation to a
 * brand-new second LTI launch finding the Step A mapping, and the
 * dedicated callback-safety checker for the hand-off query string.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { randomBytes, hkdfSync } from "node:crypto";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("../prisma");
const { getOrCreateTestInstitution } = await import("../testInstitution");
const { clearJwksCache } = await import("./jwks-cache");
const {
  createIdentityLinkHandoff,
  verifyIdentityLinkHandoff,
  IDENTITY_LINK_HANDOFF_TTL_SECONDS,
} = await import("./identityLinkHandoff");
const { isSafeLtiIdentityLinkCallbackUrl, isSafeAppCallbackUrl } = await import("../safeCallbackUrl");

const STUDENT_ROLE_CLAIM = ["http://purl.imsglobal.org/vocab/lis/v2/membership#Learner"];

const stamp = Date.now();
const cleanupUserIds: string[] = [];
const cleanupPlatformIds: string[] = [];

function sessionFor(userId: string, role: "STUDENT" | "LECTURER", institutionId: string | null) {
  return { user: { id: userId, email: `${userId}@test.invalid`, name: "Test", role, institutionId } };
}

function jsonRequest(body: unknown) {
  return new Request("http://test.local/api/lti/identity-link/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
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
let instB: { id: string };

beforeAll(async () => {
  clearJwksCache();
  instA = await getOrCreateTestInstitution(`lti-handoff-a-${stamp}`);
  instB = await getOrCreateTestInstitution(`lti-handoff-b-${stamp}`);
});

afterAll(async () => {
  await prisma.platformAuditLog.deleteMany({ where: { targetId: { in: cleanupUserIds } } });
  await prisma.ltiLaunch.deleteMany({ where: { platformId: { in: cleanupPlatformIds } } });
  await prisma.ltiSession.deleteMany({ where: { platformId: { in: cleanupPlatformIds } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  await prisma.ltiPlatform.deleteMany({ where: { id: { in: cleanupPlatformIds } } });
});

// ── The signed hand-off token ────────────────────────────────────────────

describe("createIdentityLinkHandoff / verifyIdentityLinkHandoff", () => {
  it("4. handoff has a short expiry matching IDENTITY_LINK_HANDOFF_TTL_SECONDS (5-10 minutes)", () => {
    expect(IDENTITY_LINK_HANDOFF_TTL_SECONDS).toBeGreaterThanOrEqual(5 * 60);
    expect(IDENTITY_LINK_HANDOFF_TTL_SECONDS).toBeLessThanOrEqual(10 * 60);
  });

  it("round-trips existingUserId/canvasUserId/platformId/derivedRole", async () => {
    const token = await createIdentityLinkHandoff({
      existingUserId: "user-1", canvasUserId: "canvas-1", platformId: "platform-1", derivedRole: "STUDENT",
    });
    const verified = await verifyIdentityLinkHandoff(token);
    expect(verified).toEqual({ existingUserId: "user-1", canvasUserId: "canvas-1", platformId: "platform-1", derivedRole: "STUDENT" });
  });

  it("5. a tampered handoff is rejected", async () => {
    const token = await createIdentityLinkHandoff({
      existingUserId: "user-1", canvasUserId: "canvas-1", platformId: "platform-1", derivedRole: "STUDENT",
    });
    const tampered = token.slice(0, -4) + "abcd";
    const verified = await verifyIdentityLinkHandoff(tampered);
    expect(verified).toBeNull();
  });

  it("6. an expired handoff is rejected", async () => {
    // Sign directly with the same derivation this module uses, but with
    // an already-past expiry — exercising real expiry verification
    // rather than waiting out the real TTL.
    const secret = process.env.AUTH_SECRET;
    if (!secret) throw new Error("AUTH_SECRET not set in test env");
    const key = new Uint8Array(hkdfSync("sha256", secret, "", "lti-identity-link-handoff-v1", 32));
    const expiredToken = await new SignJWT({
      existingUserId: "user-1", canvasUserId: "canvas-1", platformId: "platform-1", derivedRole: "STUDENT",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1800)
      .sign(key);
    const verified = await verifyIdentityLinkHandoff(expiredToken);
    expect(verified).toBeNull();
  });

  it("a handoff signed with a different (wrong) key is rejected", async () => {
    const wrongKey = new Uint8Array(32).fill(7);
    const token = await new SignJWT({
      existingUserId: "user-1", canvasUserId: "canvas-1", platformId: "platform-1", derivedRole: "STUDENT",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(wrongKey);
    const verified = await verifyIdentityLinkHandoff(token);
    expect(verified).toBeNull();
  });
});

// ── The collision launch never needs a session cookie ──────────────────────

describe("1 & 2 & 3. collision launch never depends on auth() and never creates a duplicate User", () => {
  it("collision launch succeeds and yields a verifiable handoff with no Auth.js session mock configured at all", async () => {
    // mockAuth is deliberately left with no configured return value — if
    // the launch route called auth() at all, this would be undefined,
    // which is exactly what an absent/ignored cross-site cookie would
    // also produce. The launch must still succeed either way.
    mockAuth.mockReset();
    const platform = await createPlatform(instA.id);
    const existing = await createUser({ email: `handoff-1-${stamp}@test.invalid`, role: "STUDENT", institutionId: null });
    const session = await startLtiSession(platform.id);
    const idToken = await buildIdToken({
      platformId: platform.id, issuer: platform.issuer, audience: platform.clientId,
      nonce: session.nonce, canvasUserId: `cu-h-${stamp}-1`, email: existing.email, role: "STUDENT",
    });
    const { POST } = await import("@/app/api/lti/launch/route");
    const res = await POST(launchRequest(idToken, session.state));
    expect(res.status).toBe(302);
    expect(mockAuth).not.toHaveBeenCalled();
    const handoff = extractHandoff(res.headers.get("location") ?? "");
    const verified = await verifyIdentityLinkHandoff(handoff);
    expect(verified?.existingUserId).toBe(existing.id);
    expect(verified?.canvasUserId).toBe(`cu-h-${stamp}-1`);

    const count = await prisma.user.count({ where: { email: existing.email } });
    expect(count).toBe(1);
  });
});

// ── Confirmation endpoint ───────────────────────────────────────────────────

describe("POST /api/lti/identity-link/confirm", () => {
  it("8. unauthenticated confirm is rejected", async () => {
    mockAuth.mockResolvedValue(null);
    const handoff = await createIdentityLinkHandoff({
      existingUserId: "whoever", canvasUserId: "cu-x", platformId: "plat-x", derivedRole: "STUDENT",
    });
    const { POST } = await import("@/app/api/lti/identity-link/confirm/route");
    const res = await POST(jsonRequest({ handoff }));
    expect(res.status).toBe(401);
  });

  it("7. a different authenticated Tether user cannot confirm", async () => {
    const platform = await createPlatform(instA.id);
    const existing = await createUser({ email: `confirm-7-${stamp}@test.invalid`, role: "STUDENT", institutionId: null });
    const otherUser = await createUser({ email: `confirm-7-other-${stamp}@test.invalid`, role: "STUDENT", institutionId: instA.id });
    const handoff = await createIdentityLinkHandoff({
      existingUserId: existing.id, canvasUserId: `cu-h-${stamp}-7`, platformId: platform.id, derivedRole: "STUDENT",
    });
    mockAuth.mockResolvedValue(sessionFor(otherUser.id, "STUDENT", instA.id));
    const { POST } = await import("@/app/api/lti/identity-link/confirm/route");
    const res = await POST(jsonRequest({ handoff }));
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("wrong_account");
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: existing.id } });
    expect(fresh.canvasUserId).toBeNull();
  });

  it("9 & 10 & 11. the exact authenticated existing user can confirm, and canvasUserId is attached (email alone never links)", async () => {
    const platform = await createPlatform(instA.id);
    const existing = await createUser({ email: `confirm-9-${stamp}@test.invalid`, role: "STUDENT", institutionId: instA.id });
    const canvasUserId = `cu-h-${stamp}-9`;
    const handoff = await createIdentityLinkHandoff({
      existingUserId: existing.id, canvasUserId, platformId: platform.id, derivedRole: "STUDENT",
    });
    mockAuth.mockResolvedValue(sessionFor(existing.id, "STUDENT", instA.id));
    const { POST } = await import("@/app/api/lti/identity-link/confirm/route");
    const res = await POST(jsonRequest({ handoff }));
    const body = await res.json();
    expect(body.ok).toBe(true);
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: existing.id } });
    expect(fresh.canvasUserId).toBe(canvasUserId);
  });

  it("12. null institution safely claims the platform's institution on confirm", async () => {
    const platform = await createPlatform(instA.id);
    const existing = await createUser({ email: `confirm-12-${stamp}@test.invalid`, role: "STUDENT", institutionId: null });
    const handoff = await createIdentityLinkHandoff({
      existingUserId: existing.id, canvasUserId: `cu-h-${stamp}-12`, platformId: platform.id, derivedRole: "STUDENT",
    });
    mockAuth.mockResolvedValue(sessionFor(existing.id, "STUDENT", null));
    const { POST } = await import("@/app/api/lti/identity-link/confirm/route");
    await POST(jsonRequest({ handoff }));
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: existing.id } });
    expect(fresh.institutionId).toBe(instA.id);
  });

  it("13. a different-institution account is rejected on confirm, never moved", async () => {
    const platform = await createPlatform(instB.id);
    const existing = await createUser({ email: `confirm-13-${stamp}@test.invalid`, role: "STUDENT", institutionId: instA.id });
    const handoff = await createIdentityLinkHandoff({
      existingUserId: existing.id, canvasUserId: `cu-h-${stamp}-13`, platformId: platform.id, derivedRole: "STUDENT",
    });
    mockAuth.mockResolvedValue(sessionFor(existing.id, "STUDENT", instA.id));
    const { POST } = await import("@/app/api/lti/identity-link/confirm/route");
    const res = await POST(jsonRequest({ handoff }));
    const body = await res.json();
    expect(body.reason).toBe("different_institution");
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: existing.id } });
    expect(fresh.institutionId).toBe(instA.id);
    expect(fresh.canvasUserId).toBeNull();
  });

  it("14. role mismatch is rejected on confirm", async () => {
    const platform = await createPlatform(instA.id);
    const existing = await createUser({ email: `confirm-14-${stamp}@test.invalid`, role: "LECTURER", institutionId: instA.id });
    const handoff = await createIdentityLinkHandoff({
      existingUserId: existing.id, canvasUserId: `cu-h-${stamp}-14`, platformId: platform.id, derivedRole: "STUDENT",
    });
    mockAuth.mockResolvedValue(sessionFor(existing.id, "LECTURER", instA.id));
    const { POST } = await import("@/app/api/lti/identity-link/confirm/route");
    const res = await POST(jsonRequest({ handoff }));
    const body = await res.json();
    expect(body.reason).toBe("role_mismatch");
  });

  it("15. Canvas-id ownership collision is rejected on confirm", async () => {
    const platform = await createPlatform(instA.id);
    const canvasUserId = `cu-h-${stamp}-15`;
    const owner = await createUser({ email: `confirm-15-owner-${stamp}@test.invalid`, role: "STUDENT", institutionId: instA.id, canvasUserId });
    const existing = await createUser({ email: `confirm-15-${stamp}@test.invalid`, role: "STUDENT", institutionId: instA.id });
    const handoff = await createIdentityLinkHandoff({
      existingUserId: existing.id, canvasUserId, platformId: platform.id, derivedRole: "STUDENT",
    });
    mockAuth.mockResolvedValue(sessionFor(existing.id, "STUDENT", instA.id));
    const { POST } = await import("@/app/api/lti/identity-link/confirm/route");
    const res = await POST(jsonRequest({ handoff }));
    const body = await res.json();
    expect(body.reason).toBe("canvas_id_taken");
    const freshOwner = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(freshOwner.canvasUserId).toBe(canvasUserId);
  });

  it("16. concurrent confirmation of the SAME handoff is safe — exactly one User ends up with the canvasUserId", async () => {
    const platform = await createPlatform(instA.id);
    const existing = await createUser({ email: `confirm-16-${stamp}@test.invalid`, role: "STUDENT", institutionId: instA.id });
    const canvasUserId = `cu-h-${stamp}-16`;
    const handoff = await createIdentityLinkHandoff({
      existingUserId: existing.id, canvasUserId, platformId: platform.id, derivedRole: "STUDENT",
    });
    mockAuth.mockResolvedValue(sessionFor(existing.id, "STUDENT", instA.id));
    const { POST } = await import("@/app/api/lti/identity-link/confirm/route");
    const [r1, r2] = await Promise.all([POST(jsonRequest({ handoff })), POST(jsonRequest({ handoff }))]);
    const [b1, b2] = await Promise.all([r1.json(), r2.json()]);
    expect(b1.ok).toBe(true);
    expect(b2.ok).toBe(true);
    const owners = await prisma.user.findMany({ where: { canvasUserId }, select: { id: true } });
    expect(owners).toHaveLength(1);
    expect(owners[0].id).toBe(existing.id);
  });

  it("17 & 18. successful confirmation creates no LtiLaunch row and never revives the original (consumed) LtiSession", async () => {
    const platform = await createPlatform(instA.id);
    const existing = await createUser({ email: `confirm-17-${stamp}@test.invalid`, role: "STUDENT", institutionId: null });
    const session = await startLtiSession(platform.id);
    const canvasUserId = `cu-h-${stamp}-17`;
    const idToken = await buildIdToken({
      platformId: platform.id, issuer: platform.issuer, audience: platform.clientId,
      nonce: session.nonce, canvasUserId, email: existing.email, role: "STUDENT",
    });
    const { POST: launch } = await import("@/app/api/lti/launch/route");
    const launchRes = await launch(launchRequest(idToken, session.state));
    const handoff = extractHandoff(launchRes.headers.get("location") ?? "");

    const consumedSession = await prisma.ltiSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(consumedSession.consumed).toBe(true);

    mockAuth.mockResolvedValue(sessionFor(existing.id, "STUDENT", null));
    const { POST: confirm } = await import("@/app/api/lti/identity-link/confirm/route");
    await confirm(jsonRequest({ handoff }));

    const launchCount = await prisma.ltiLaunch.count({ where: { platformId: platform.id } });
    expect(launchCount).toBe(0);
    const stillConsumed = await prisma.ltiSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(stillConsumed.consumed).toBe(true);

    // Replaying the original (now-linked) launch must still fail — the
    // handoff never makes the original LtiSession reusable.
    const replay = await launch(launchRequest(idToken, session.state));
    expect(replay.status).toBe(403);
  });

  it("19. after confirmation, a brand-new LTI launch finds the Step A mapping and proceeds completely normally", async () => {
    const platform = await createPlatform(instA.id);
    const existing = await createUser({ email: `confirm-19-${stamp}@test.invalid`, role: "STUDENT", institutionId: null });
    const canvasUserId = `cu-h-${stamp}-19`;

    const firstSession = await startLtiSession(platform.id);
    const firstIdToken = await buildIdToken({
      platformId: platform.id, issuer: platform.issuer, audience: platform.clientId,
      nonce: firstSession.nonce, canvasUserId, email: existing.email, role: "STUDENT",
    });
    const { POST: launch } = await import("@/app/api/lti/launch/route");
    const firstRes = await launch(launchRequest(firstIdToken, firstSession.state));
    const handoff = extractHandoff(firstRes.headers.get("location") ?? "");

    mockAuth.mockResolvedValue(sessionFor(existing.id, "STUDENT", null));
    const { POST: confirm } = await import("@/app/api/lti/identity-link/confirm/route");
    const confirmRes = await confirm(jsonRequest({ handoff }));
    expect((await confirmRes.json()).ok).toBe(true);

    // A genuinely new login/launch — new nonce, new state, new signed
    // id_token — using the SAME canvasUserId.
    const secondSession = await startLtiSession(platform.id);
    const secondIdToken = await buildIdToken({
      platformId: platform.id, issuer: platform.issuer, audience: platform.clientId,
      nonce: secondSession.nonce, canvasUserId, email: existing.email, role: "STUDENT",
    });
    const secondRes = await launch(launchRequest(secondIdToken, secondSession.state));
    expect(secondRes.status).toBe(302);
    expect(secondRes.headers.get("location")).not.toContain("identity-link");
    // No collision logic involved this time — Step A found the mapping
    // directly, so a normal session cookie was set.
    expect(
      secondRes.cookies.get("authjs.session-token") ?? secondRes.cookies.get("__Secure-authjs.session-token"),
    ).toBeTruthy();

    const users = await prisma.user.findMany({ where: { canvasUserId } });
    expect(users).toHaveLength(1);
    expect(users[0].id).toBe(existing.id);
  });
});

// ── Callback safety for the hand-off query string ──────────────────────────

describe("isSafeLtiIdentityLinkCallbackUrl", () => {
  it("accepts the bare identity-link path", () => {
    expect(isSafeLtiIdentityLinkCallbackUrl("/lti/identity-link")).toBe(true);
  });

  it("accepts the identity-link path with a handoff query string", () => {
    expect(isSafeLtiIdentityLinkCallbackUrl("/lti/identity-link?handoff=abc.def.ghi")).toBe(true);
    expect(isSafeAppCallbackUrl("/lti/identity-link?handoff=abc.def.ghi")).toBe(true);
  });

  it("rejects an absolute or protocol-relative URL", () => {
    expect(isSafeLtiIdentityLinkCallbackUrl("https://evil.example.com/lti/identity-link?handoff=x")).toBe(false);
    expect(isSafeLtiIdentityLinkCallbackUrl("//evil.example.com/lti/identity-link")).toBe(false);
  });

  it("rejects an attempt to smuggle a new path/fragment/authority into the query string", () => {
    expect(isSafeLtiIdentityLinkCallbackUrl("/lti/identity-link?handoff=x/../../platform")).toBe(false);
    expect(isSafeLtiIdentityLinkCallbackUrl("/lti/identity-link?handoff=x#https://evil.example.com")).toBe(false);
    expect(isSafeLtiIdentityLinkCallbackUrl("/lti/identity-link?handoff=x@evil.example.com")).toBe(false);
  });

  it("rejects a different path entirely", () => {
    expect(isSafeLtiIdentityLinkCallbackUrl("/lti/not-linked?handoff=x")).toBe(false);
    expect(isSafeLtiIdentityLinkCallbackUrl("/platform/institutions")).toBe(false);
  });

  it("rejects null/empty", () => {
    expect(isSafeLtiIdentityLinkCallbackUrl(null)).toBe(false);
    expect(isSafeLtiIdentityLinkCallbackUrl("")).toBe(false);
  });
});
