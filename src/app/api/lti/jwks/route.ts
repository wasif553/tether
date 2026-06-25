import { NextResponse } from "next/server";
import { exportJWK } from "jose";
import { getPublicKey, LTI_KEY_ID, LTI_SIGNING_ALG } from "@/lib/lti/keys";

type Jwk = {
  kty: string;
  n: string;
  e: string;
  kid: string;
  use: string;
  alg: string;
};

export async function GET() {
  let jwk: Jwk;
  try {
    const publicKey = await getPublicKey();
    const exported = await exportJWK(publicKey);
    jwk = {
      kty: exported.kty as string,
      n: exported.n as string,
      e: exported.e as string,
      kid: LTI_KEY_ID,
      use: "sig",
      alg: LTI_SIGNING_ALG,
    };
  } catch (err) {
    console.error("Failed to load LTI public key", err);
    return NextResponse.json({ error: "LTI key configuration error" }, { status: 500 });
  }

  return NextResponse.json({ keys: [jwk] });
}

export const dynamic = "force-dynamic";
