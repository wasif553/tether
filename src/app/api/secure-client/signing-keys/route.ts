/**
 * Tether Secure Client Foundation v1 — see
 * docs/secure-client-foundation-seb-v1.md.
 *
 * GET /api/secure-client/signing-keys
 *
 * Exposes ONLY public verification material — the Ed25519 public key and
 * its key identifier. Never the private key. Publicly readable (no auth
 * required): a future Tether client needs this to verify manifests
 * offline, exactly like any public-key distribution endpoint.
 */
import { NextResponse } from "next/server";
import { getSigningKeyId } from "@/lib/secureClientRunner";

export async function GET() {
  const publicKey = process.env.TETHER_SECURE_CLIENT_SIGNING_PUBLIC_KEY;
  if (!publicKey) {
    return NextResponse.json({ error: "Secure-client signing is not configured" }, { status: 503 });
  }
  return NextResponse.json({
    keyId: getSigningKeyId(),
    algorithm: "Ed25519",
    publicKey,
  });
}

export const dynamic = "force-dynamic";
