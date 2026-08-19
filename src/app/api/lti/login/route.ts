/**
 * LTI Reference Platform compatibility repair — see
 * docs/lti-identity-collision-hardening-v1.md's "LTI login initiation"
 * section (if present) or the commit message for this pass.
 *
 * LTI 1.3 / OIDC third-party login initiation permits a platform to
 * hit this endpoint with either GET query parameters or a POST
 * form-encoded body — the 1EdTech LTI 1.3 Reference Implementation
 * platform (used for manual Preview testing) uses POST, while Canvas
 * has historically used GET. Both methods share one internal handler
 * so the security/business logic (issuer lookup, state/nonce
 * generation, registered-config-only redirect construction) exists in
 * exactly one place.
 */
import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { resolveLtiToolOrigin } from "@/lib/appOrigin";

const LTI_SESSION_TTL_MS = 60 * 1000;

type LoginInitiationParams = {
  iss: string | null;
  loginHint: string | null;
  ltiMessageHint: string | null;
  clientId: string | null;
  ltiDeploymentId: string | null;
};

async function handleLoginInitiation(params: LoginInitiationParams): Promise<NextResponse> {
  const { iss, loginHint, ltiMessageHint, clientId, ltiDeploymentId } = params;

  if (!iss) {
    return NextResponse.json({ error: "Unknown platform" }, { status: 400 });
  }

  const platform = await prisma.ltiPlatform.findUnique({ where: { issuer: iss } });
  if (!platform) {
    console.error(`LTI login: unknown platform issuer "${iss}"`);
    return NextResponse.json({ error: "Unknown platform" }, { status: 400 });
  }

  // Optional validation (never an override): registered server-side
  // platform configuration remains authoritative regardless of what
  // this request supplies — client_id/lti_deployment_id below are used
  // only to reject an obviously mismatched initiation request, never to
  // change which clientId/deploymentId Tether actually uses. A caller
  // that omits these optional LTI/OIDC fields entirely is unaffected.
  if (clientId && clientId !== platform.clientId) {
    console.error(
      `LTI login: client_id "${clientId}" in initiation request did not match registered platform ${platform.id} — rejecting`,
    );
    return NextResponse.json({ error: "Unknown platform" }, { status: 400 });
  }
  if (ltiDeploymentId && ltiDeploymentId !== platform.deploymentId) {
    console.error(
      `LTI login: lti_deployment_id "${ltiDeploymentId}" in initiation request did not match registered platform ${platform.id} — rejecting`,
    );
    return NextResponse.json({ error: "Unknown platform" }, { status: 400 });
  }

  // target_link_uri (if the platform supplies one) is deliberately never
  // read here at all — Tether's own registered launch endpoint below is
  // the only redirect_uri ever used; an incoming target_link_uri is
  // never treated as a redirect target.

  const toolOrigin = resolveLtiToolOrigin();
  if (!toolOrigin) {
    console.error("LTI login: no trusted tool origin available (APP_URL and VERCEL_URL both missing)");
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }

  const state = randomBytes(32).toString("hex");
  const nonce = randomBytes(32).toString("hex");

  await prisma.ltiSession.create({
    data: {
      platformId: platform.id,
      nonce,
      state,
      expiresAt: new Date(Date.now() + LTI_SESSION_TTL_MS),
      consumed: false,
    },
  });

  const authUrl = new URL(platform.authEndpoint);
  authUrl.searchParams.set("response_type", "id_token");
  authUrl.searchParams.set("response_mode", "form_post");
  authUrl.searchParams.set("scope", "openid");
  authUrl.searchParams.set("client_id", platform.clientId);
  authUrl.searchParams.set("redirect_uri", `${toolOrigin}/api/lti/launch`);
  if (loginHint) authUrl.searchParams.set("login_hint", loginHint);
  if (ltiMessageHint) authUrl.searchParams.set("lti_message_hint", ltiMessageHint);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("nonce", nonce);

  return NextResponse.redirect(authUrl.toString(), 302);
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  return handleLoginInitiation({
    iss: searchParams.get("iss"),
    loginHint: searchParams.get("login_hint"),
    ltiMessageHint: searchParams.get("lti_message_hint"),
    clientId: searchParams.get("client_id"),
    ltiDeploymentId: searchParams.get("lti_deployment_id"),
  });
}

export async function POST(req: Request) {
  let params: URLSearchParams;
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const formData = await req.formData();
    params = new URLSearchParams();
    for (const [key, value] of formData.entries()) {
      if (typeof value === "string") params.set(key, value);
    }
  } else {
    // application/x-www-form-urlencoded (the standard OIDC third-party
    // login initiation content type) — and a safe fallback for any
    // request whose content-type is missing/misreported but whose body
    // is still form-encoded text.
    const text = await req.text();
    params = new URLSearchParams(text);
  }

  return handleLoginInitiation({
    iss: params.get("iss"),
    loginHint: params.get("login_hint"),
    ltiMessageHint: params.get("lti_message_hint"),
    clientId: params.get("client_id"),
    ltiDeploymentId: params.get("lti_deployment_id"),
  });
}

export const dynamic = "force-dynamic";
