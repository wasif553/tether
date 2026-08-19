/**
 * LTI Reference Platform compatibility repair — DB-backed route tests.
 *
 * Requires the local test Postgres instance (run via
 * `npm run release:validate`) — src/lib/prisma.ts's
 * assertSafeDatabaseUrlForTests guard blocks a plain `vitest run`.
 *
 * Covers GET and POST login initiation (POST is the 1EdTech LTI 1.3
 * Reference Implementation platform's own method — the defect this pass
 * fixes was a 405 for exactly that), the trusted-origin fallback for
 * Vercel Preview deployments, and that no incoming initiation parameter
 * (client_id, lti_deployment_id, redirect_uri, authEndpoint) can ever
 * override Tether's own registered platform configuration.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";

const { prisma } = await import("../prisma");

const stamp = Date.now();
const cleanupPlatformIds: string[] = [];

async function createPlatform(overrides: Partial<{ authEndpoint: string; clientId: string; deploymentId: string }> = {}) {
  const platform = await prisma.ltiPlatform.create({
    data: {
      issuer: `https://login-test-${randomBytes(8).toString("hex")}.example.com`,
      clientId: overrides.clientId ?? `client-${randomBytes(6).toString("hex")}`,
      authEndpoint: overrides.authEndpoint ?? "https://example.com/platforms/1/authorizations/new",
      tokenEndpoint: "https://example.com/platforms/1/access_tokens",
      jwksUrl: "https://example.com/platforms/1/platform_keys/1.json",
      deploymentId: overrides.deploymentId ?? "1",
      institutionId: null,
    },
  });
  cleanupPlatformIds.push(platform.id);
  return platform;
}

function getRequest(params: Record<string, string>) {
  const url = new URL("http://test.local/api/lti/login");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url, { method: "GET" });
}

function postFormRequest(params: Record<string, string>) {
  const body = new URLSearchParams(params);
  return new Request("http://test.local/api/lti/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

const originalEnv = { APP_URL: process.env.APP_URL, VERCEL_URL: process.env.VERCEL_URL };

function setEnv(appUrl: string | undefined, vercelUrl: string | undefined) {
  if (appUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = appUrl;
  if (vercelUrl === undefined) delete process.env.VERCEL_URL;
  else process.env.VERCEL_URL = vercelUrl;
}

beforeEach(() => {
  setEnv(originalEnv.APP_URL, originalEnv.VERCEL_URL);
});

afterAll(async () => {
  setEnv(originalEnv.APP_URL, originalEnv.VERCEL_URL);
  await prisma.ltiSession.deleteMany({ where: { platformId: { in: cleanupPlatformIds } } });
  await prisma.ltiPlatform.deleteMany({ where: { id: { in: cleanupPlatformIds } } });
});

describe("GET/POST /api/lti/login — login initiation", () => {
  it("1 & 13 & 14. GET login initiation works, creates an LtiSession, and redirects to the registered authEndpoint", async () => {
    const platform = await createPlatform();
    const { GET } = await import("@/app/api/lti/login/route");
    const res = await GET(getRequest({ iss: platform.issuer, login_hint: "hint-1" }));
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(platform.authEndpoint);
    expect(location.searchParams.get("client_id")).toBe(platform.clientId);
    expect(location.searchParams.get("login_hint")).toBe("hint-1");
    const state = location.searchParams.get("state");
    const nonce = location.searchParams.get("nonce");
    expect(state).toBeTruthy();
    expect(nonce).toBeTruthy();

    const session = await prisma.ltiSession.findUniqueOrThrow({ where: { state: state! } });
    expect(session.nonce).toBe(nonce);
    expect(session.consumed).toBe(false);
    expect(session.platformId).toBe(platform.id);
  });

  it("2. POST form-encoded login initiation works (the 1EdTech reference platform's own method)", async () => {
    const platform = await createPlatform();
    const { POST } = await import("@/app/api/lti/login/route");
    const res = await POST(postFormRequest({ iss: platform.issuer, login_hint: "hint-2" }));
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(platform.authEndpoint);
    expect(location.searchParams.get("login_hint")).toBe("hint-2");
    const state = location.searchParams.get("state");
    const session = await prisma.ltiSession.findUniqueOrThrow({ where: { state: state! } });
    expect(session.platformId).toBe(platform.id);
  });

  it("3. GET and POST produce equivalent OIDC redirect semantics (same param set, both create a fresh LtiSession)", async () => {
    const platform = await createPlatform();
    const { GET, POST } = await import("@/app/api/lti/login/route");
    const getRes = await GET(getRequest({ iss: platform.issuer, login_hint: "h", lti_message_hint: "m" }));
    const postRes = await POST(postFormRequest({ iss: platform.issuer, login_hint: "h", lti_message_hint: "m" }));
    const getLoc = new URL(getRes.headers.get("location") ?? "");
    const postLoc = new URL(postRes.headers.get("location") ?? "");
    const paramNames = (u: URL) => [...u.searchParams.keys()].sort();
    expect(paramNames(getLoc)).toEqual(paramNames(postLoc));
    expect(getLoc.searchParams.get("state")).not.toBe(postLoc.searchParams.get("state"));
    expect(getLoc.searchParams.get("nonce")).not.toBe(postLoc.searchParams.get("nonce"));
  });

  it("4. unknown issuer rejected for GET", async () => {
    const { GET } = await import("@/app/api/lti/login/route");
    const res = await GET(getRequest({ iss: `https://unknown-${stamp}.example.com` }));
    expect(res.status).toBe(400);
  });

  it("5. unknown issuer rejected for POST", async () => {
    const { POST } = await import("@/app/api/lti/login/route");
    const res = await POST(postFormRequest({ iss: `https://unknown-post-${stamp}.example.com` }));
    expect(res.status).toBe(400);
  });

  it("6. POST cannot override registered clientId — mismatched client_id is rejected, matching client_id is a harmless no-op", async () => {
    const platform = await createPlatform();
    const { POST } = await import("@/app/api/lti/login/route");

    const mismatched = await POST(postFormRequest({ iss: platform.issuer, client_id: "totally-different-client" }));
    expect(mismatched.status).toBe(400);

    const matching = await POST(postFormRequest({ iss: platform.issuer, client_id: platform.clientId }));
    expect(matching.status).toBe(302);
    const location = new URL(matching.headers.get("location") ?? "");
    expect(location.searchParams.get("client_id")).toBe(platform.clientId);
  });

  it("7. an injected authEndpoint-like field cannot redirect the request anywhere but the registered authEndpoint", async () => {
    const platform = await createPlatform();
    const { POST } = await import("@/app/api/lti/login/route");
    // authEndpoint is not a real LTI/OIDC initiation parameter — Tether
    // never reads one from the request at all — but prove a bogus field
    // by that name is simply ignored rather than accidentally wired up.
    const res = await POST(postFormRequest({ iss: platform.issuer, authEndpoint: "https://evil.example.com/auth" }));
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(platform.authEndpoint);
  });

  it("8. POST cannot inject an arbitrary redirect_uri", async () => {
    const platform = await createPlatform();
    setEnv("https://tether.example.com", undefined);
    const { POST } = await import("@/app/api/lti/login/route");
    const res = await POST(
      postFormRequest({ iss: platform.issuer, redirect_uri: "https://evil.example.com/steal", target_link_uri: "https://evil.example.com/steal2" }),
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.searchParams.get("redirect_uri")).toBe("https://tether.example.com/api/lti/launch");
  });

  it("9. APP_URL wins when configured", async () => {
    const platform = await createPlatform();
    setEnv("https://production.example.com", "some-vercel-host.vercel.app");
    const { GET } = await import("@/app/api/lti/login/route");
    const res = await GET(getRequest({ iss: platform.issuer }));
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.searchParams.get("redirect_uri")).toBe("https://production.example.com/api/lti/launch");
  });

  it("10 & 11. VERCEL_URL safely provides the Preview origin when APP_URL is missing, normalized to https", async () => {
    const platform = await createPlatform();
    setEnv(undefined, "tether-abc123-tether5.vercel.app");
    const { GET } = await import("@/app/api/lti/login/route");
    const res = await GET(getRequest({ iss: platform.issuer }));
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.searchParams.get("redirect_uri")).toBe("https://tether-abc123-tether5.vercel.app/api/lti/launch");
  });

  it("12. missing APP_URL and missing VERCEL_URL fails closed, no LtiSession created", async () => {
    const platform = await createPlatform();
    setEnv(undefined, undefined);
    const { GET } = await import("@/app/api/lti/login/route");
    const res = await GET(getRequest({ iss: platform.issuer }));
    expect(res.status).toBe(500);
    const count = await prisma.ltiSession.count({ where: { platformId: platform.id } });
    expect(count).toBe(0);
  });
});

describe("resolveLtiToolOrigin", () => {
  afterEach(() => setEnv(originalEnv.APP_URL, originalEnv.VERCEL_URL));

  it("prefers APP_URL over VERCEL_URL", async () => {
    setEnv("https://configured.example.com", "some-host.vercel.app");
    const { resolveLtiToolOrigin } = await import("../appOrigin");
    expect(resolveLtiToolOrigin()).toBe("https://configured.example.com");
  });

  it("falls back to a normalized https VERCEL_URL", async () => {
    setEnv(undefined, "bare-host.vercel.app");
    const { resolveLtiToolOrigin } = await import("../appOrigin");
    expect(resolveLtiToolOrigin()).toBe("https://bare-host.vercel.app");
  });

  it("returns null when neither is available", async () => {
    setEnv(undefined, undefined);
    const { resolveLtiToolOrigin } = await import("../appOrigin");
    expect(resolveLtiToolOrigin()).toBeNull();
  });
});
