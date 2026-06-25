import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";

const LTI_SESSION_TTL_MS = 60 * 1000;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  const iss = searchParams.get("iss");
  const loginHint = searchParams.get("login_hint");
  const ltiMessageHint = searchParams.get("lti_message_hint");

  if (!iss) {
    return NextResponse.json({ error: "Unknown platform" }, { status: 400 });
  }

  const platform = await prisma.ltiPlatform.findUnique({ where: { issuer: iss } });
  if (!platform) {
    console.error(`LTI login: unknown platform issuer "${iss}"`);
    return NextResponse.json({ error: "Unknown platform" }, { status: 400 });
  }

  const appUrl = process.env.APP_URL;
  if (!appUrl) {
    console.error("LTI login: missing required environment variable APP_URL");
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
  authUrl.searchParams.set("redirect_uri", `${appUrl}/api/lti/launch`);
  if (loginHint) authUrl.searchParams.set("login_hint", loginHint);
  if (ltiMessageHint) authUrl.searchParams.set("lti_message_hint", ltiMessageHint);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("nonce", nonce);

  return NextResponse.redirect(authUrl.toString(), 302);
}

export const dynamic = "force-dynamic";
