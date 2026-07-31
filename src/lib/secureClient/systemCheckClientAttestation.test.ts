import { describe, it, expect, beforeAll } from "vitest";
import crypto from "crypto";
import {
  buildSystemCheckAttestationCanonicalString,
  verifyClientAttestation,
  clientAttestationPublicKey,
  ClientAttestationKeyNotConfiguredError,
  type ClientAttestationFacts,
} from "./systemCheckClientAttestation";

let genuinePublicKeyPem: string;
let genuinePrivateKeyPem: string;

beforeAll(() => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  genuinePublicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  genuinePrivateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
});

function genuinelySign(facts: Omit<ClientAttestationFacts, "signature">, privateKeyPem: string): ClientAttestationFacts {
  const canonicalString = buildSystemCheckAttestationCanonicalString(facts);
  const signature = crypto.sign(null, Buffer.from(canonicalString, "utf8"), privateKeyPem).toString("base64");
  return { ...facts, signature };
}

const baseFacts = { nonce: "test-nonce-1", clientVersion: "1.4.0", platform: "win32", displayTopologyClassification: "INTERNAL_ONLY" };

describe("buildSystemCheckAttestationCanonicalString", () => {
  it("is deterministic and pipe-delimited with a fixed version prefix", () => {
    expect(buildSystemCheckAttestationCanonicalString(baseFacts)).toBe("SYSTEM_CHECK_ATTESTATION_V1|test-nonce-1|1.4.0|win32|INTERNAL_ONLY");
  });

  it("differs if any single field changes", () => {
    const a = buildSystemCheckAttestationCanonicalString(baseFacts);
    const b = buildSystemCheckAttestationCanonicalString({ ...baseFacts, displayTopologyClassification: "EXTEND" });
    expect(a).not.toBe(b);
  });
});

describe("verifyClientAttestation — the core of what makes Chrome unable to fabricate a verification", () => {
  it("a signature genuinely produced by the matching private key verifies true", () => {
    const facts = genuinelySign(baseFacts, genuinePrivateKeyPem);
    expect(verifyClientAttestation(facts, genuinePublicKeyPem)).toBe(true);
  });

  it("1/2/3. a self-generated Chrome-side keypair (WebCrypto-equivalent) never verifies against the server's configured public key — Chrome does not, and cannot, possess the embedded private key", () => {
    const chromeKeys = crypto.generateKeyPairSync("ed25519");
    const chromePrivate = chromeKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    // Chrome signs with ITS OWN key, fabricating every native fact.
    const forged = genuinelySign({ nonce: "test-nonce-1", clientVersion: "1.4.0", platform: "win32", displayTopologyClassification: "INTERNAL_ONLY" }, chromePrivate);
    // The server only ever configures the ONE genuine public key.
    expect(verifyClientAttestation(forged, genuinePublicKeyPem)).toBe(false);
  });

  it("rejects a genuinely-signed attestation if any bound fact is tampered with afterward", () => {
    const facts = genuinelySign(baseFacts, genuinePrivateKeyPem);
    const tampered = { ...facts, clientVersion: "99.0.0" };
    expect(verifyClientAttestation(tampered, genuinePublicKeyPem)).toBe(false);
  });

  it("rejects tampering with the display topology specifically (cannot claim a single display while attesting a duplicated one)", () => {
    const facts = genuinelySign(baseFacts, genuinePrivateKeyPem);
    const tampered = { ...facts, displayTopologyClassification: "CLONE_OR_DUPLICATE" };
    expect(verifyClientAttestation(tampered, genuinePublicKeyPem)).toBe(false);
  });

  it("rejects tampering with the nonce (would allow reusing one signature across different challenges)", () => {
    const facts = genuinelySign(baseFacts, genuinePrivateKeyPem);
    const tampered = { ...facts, nonce: "a-different-nonce" };
    expect(verifyClientAttestation(tampered, genuinePublicKeyPem)).toBe(false);
  });

  it("never throws on a malformed signature", () => {
    expect(verifyClientAttestation({ ...baseFacts, signature: "not-valid-base64-!!!" }, genuinePublicKeyPem)).toBe(false);
  });
});

describe("clientAttestationPublicKey", () => {
  it("throws ClientAttestationKeyNotConfiguredError when unset — fails closed, never treats a missing key as 'accept everything'", () => {
    const original = process.env.TETHER_CLIENT_ATTESTATION_PUBLIC_KEY;
    delete process.env.TETHER_CLIENT_ATTESTATION_PUBLIC_KEY;
    try {
      expect(() => clientAttestationPublicKey()).toThrow(ClientAttestationKeyNotConfiguredError);
    } finally {
      if (original !== undefined) process.env.TETHER_CLIENT_ATTESTATION_PUBLIC_KEY = original;
    }
  });
});
