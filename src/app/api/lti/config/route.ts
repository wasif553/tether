import { NextResponse } from "next/server";
import { exportJWK } from "jose";
import { getPublicKey, LTI_KEY_ID, LTI_SIGNING_ALG } from "@/lib/lti/keys";

type LtiToolConfig = {
  title: string;
  description: string;
  oidc_initiation_url: string;
  target_link_uri: string;
  scopes: string[];
  extensions: Array<{
    platform: string;
    settings: {
      platform: string;
      placements: Array<{
        placement: string;
        message_type: string;
        target_link_uri: string;
      }>;
    };
  }>;
  public_jwk: {
    kty: string;
    n: string;
    e: string;
    kid: string;
    use: string;
    alg: string;
  };
};

export async function GET() {
  const appUrl = process.env.APP_URL;
  if (!appUrl) {
    return NextResponse.json(
      { error: "Missing required environment variable: APP_URL" },
      { status: 500 },
    );
  }

  let publicJwk;
  try {
    const publicKey = await getPublicKey();
    publicJwk = await exportJWK(publicKey);
  } catch (err) {
    console.error("Failed to load LTI public key", err);
    return NextResponse.json({ error: "LTI key configuration error" }, { status: 500 });
  }

  const targetLinkUri = `${appUrl}/api/lti/launch`;

  const config: LtiToolConfig = {
    title: "Safe Exam System",
    description: "Cheat-proof online examination platform",
    oidc_initiation_url: `${appUrl}/api/lti/login`,
    target_link_uri: targetLinkUri,
    scopes: [
      "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem",
      "https://purl.imsglobal.org/spec/lti-ags/scope/result.readonly",
      "https://purl.imsglobal.org/spec/lti-ags/scope/score",
      "https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly",
    ],
    extensions: [
      {
        platform: "canvas.instructure.com",
        settings: {
          platform: "canvas.instructure.com",
          placements: [
            {
              placement: "assignment_selection",
              message_type: "LtiDeepLinkingRequest",
              target_link_uri: targetLinkUri,
            },
          ],
        },
      },
    ],
    public_jwk: {
      kty: publicJwk.kty as string,
      n: publicJwk.n as string,
      e: publicJwk.e as string,
      kid: LTI_KEY_ID,
      use: "sig",
      alg: LTI_SIGNING_ALG,
    },
  };

  return NextResponse.json(config);
}

export const dynamic = "force-dynamic";
