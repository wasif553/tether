import { describe, it, expect } from "vitest";
import crypto from "crypto";
import { signWithClientAttestationKey } from "./clientAttestationKey";

// The public half of the embedded private key in clientAttestationKey.ts.
// Must be configured server-side as TETHER_CLIENT_ATTESTATION_PUBLIC_KEY
// for this build to authenticate — see .env.example.
const EMBEDDED_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAVOWPXH0dOA8DKEQRDC+eiKnFTLEkTd9QniGFOaPukpI=
-----END PUBLIC KEY-----
`;

describe("signWithClientAttestationKey", () => {
  it("produces a signature that verifies against the documented public key", () => {
    const data = "SYSTEM_CHECK_ATTESTATION_V1|nonce-1|1.4.0|win32|INTERNAL_ONLY";
    const signature = signWithClientAttestationKey(data);
    const ok = crypto.verify(null, Buffer.from(data, "utf8"), EMBEDDED_PUBLIC_KEY_PEM, Buffer.from(signature, "base64"));
    expect(ok).toBe(true);
  });

  it("a signature over one string never verifies against a different string", () => {
    const signature = signWithClientAttestationKey("data-a");
    const ok = crypto.verify(null, Buffer.from("data-b", "utf8"), EMBEDDED_PUBLIC_KEY_PEM, Buffer.from(signature, "base64"));
    expect(ok).toBe(false);
  });

  it("never verifies against an unrelated keypair — confirms the embedded key is the sole signer", () => {
    const other = crypto.generateKeyPairSync("ed25519");
    const otherPublicPem = other.publicKey.export({ type: "spki", format: "pem" }).toString();
    const signature = signWithClientAttestationKey("data-a");
    const ok = crypto.verify(null, Buffer.from("data-a", "utf8"), otherPublicPem, Buffer.from(signature, "base64"));
    expect(ok).toBe(false);
  });
});
