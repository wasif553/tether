import { describe, it, expect, beforeAll } from "vitest";
import crypto from "crypto";
import {
  computeChallengeHash,
  computeUserSubjectHash,
  signChallenge,
  verifyChallengeSignature,
  validateChallengeContext,
  generateSystemCheckNonce,
  hashNonce,
  SYSTEM_CHECK_CHALLENGE_PURPOSE,
  type SystemCheckChallenge,
} from "./systemCheckChallenge";

let publicKeyPem: string;
let privateKeyPem: string;

beforeAll(() => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
});

function baseChallenge(overrides: Partial<SystemCheckChallenge> = {}): SystemCheckChallenge {
  const now = Date.now();
  return {
    schemaVersion: 1,
    challengeId: "challenge-1",
    keyId: "key-1",
    issuer: "tether-secure-client",
    purpose: "SYSTEM_CHECK",
    audience: "tether-secure-client",
    userSubjectHash: computeUserSubjectHash("user-1"),
    issuedAt: new Date(now).toISOString(),
    notBefore: new Date(now).toISOString(),
    expiresAt: new Date(now + 5 * 60_000).toISOString(),
    nonce: generateSystemCheckNonce(),
    ...overrides,
  };
}

describe("signChallenge / verifyChallengeSignature", () => {
  it("a genuinely signed challenge verifies true", () => {
    const challenge = baseChallenge();
    const signature = signChallenge(challenge, privateKeyPem);
    expect(verifyChallengeSignature(challenge, signature, publicKeyPem)).toBe(true);
  });

  it("a tampered field invalidates the signature", () => {
    const challenge = baseChallenge();
    const signature = signChallenge(challenge, privateKeyPem);
    const tampered = { ...challenge, userSubjectHash: computeUserSubjectHash("attacker") };
    expect(verifyChallengeSignature(tampered, signature, publicKeyPem)).toBe(false);
  });

  it("a signature from the wrong key never verifies", () => {
    const other = crypto.generateKeyPairSync("ed25519");
    const otherPrivate = other.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const challenge = baseChallenge();
    const signature = signChallenge(challenge, otherPrivate);
    expect(verifyChallengeSignature(challenge, signature, publicKeyPem)).toBe(false);
  });

  it("never throws on a malformed signature", () => {
    const challenge = baseChallenge();
    expect(verifyChallengeSignature(challenge, "not-base64-!!!", publicKeyPem)).toBe(false);
  });
});

describe("computeUserSubjectHash / computeChallengeHash", () => {
  it("never embeds the raw user id in the hash output", () => {
    const hash = computeUserSubjectHash("user-12345");
    expect(hash).not.toContain("user-12345");
  });

  it("is deterministic for the same user id", () => {
    expect(computeUserSubjectHash("user-1")).toBe(computeUserSubjectHash("user-1"));
  });

  it("differs for different user ids", () => {
    expect(computeUserSubjectHash("user-1")).not.toBe(computeUserSubjectHash("user-2"));
  });

  it("computeChallengeHash is deterministic for the same challenge", () => {
    const challenge = baseChallenge();
    expect(computeChallengeHash(challenge)).toBe(computeChallengeHash({ ...challenge }));
  });
});

describe("nonce", () => {
  it("generateSystemCheckNonce produces distinct values", () => {
    expect(generateSystemCheckNonce()).not.toBe(generateSystemCheckNonce());
  });

  it("hashNonce never leaks the raw nonce", () => {
    const nonce = generateSystemCheckNonce();
    expect(hashNonce(nonce)).not.toContain(nonce);
  });
});

describe("validateChallengeContext", () => {
  const expectedAudience = "tether-secure-client";
  const expectedUserSubjectHash = computeUserSubjectHash("user-1");

  function validate(challenge: SystemCheckChallenge, signature: string, nowMs = Date.now()) {
    return validateChallengeContext(challenge, signature, publicKeyPem, { expectedAudience, expectedUserSubjectHash, nowMs });
  }

  it("VALID for a correctly signed, current, correctly scoped challenge", () => {
    const challenge = baseChallenge();
    const signature = signChallenge(challenge, privateKeyPem);
    expect(validate(challenge, signature)).toBe("VALID");
  });

  it("INVALID_SIGNATURE for a tampered challenge", () => {
    const challenge = baseChallenge();
    const signature = signChallenge(challenge, privateKeyPem);
    expect(validate({ ...challenge, audience: "someone-else" }, signature)).toBe("INVALID_SIGNATURE");
  });

  it("WRONG_PURPOSE if the purpose is anything other than SYSTEM_CHECK", () => {
    const challenge = baseChallenge({ purpose: "EXAM_LAUNCH" as unknown as "SYSTEM_CHECK" });
    const signature = signChallenge(challenge, privateKeyPem);
    expect(validate(challenge, signature)).toBe("WRONG_PURPOSE");
  });

  it("WRONG_SUBJECT if the challenge was issued to a different authenticated user", () => {
    const challenge = baseChallenge({ userSubjectHash: computeUserSubjectHash("a-different-user") });
    const signature = signChallenge(challenge, privateKeyPem);
    expect(validate(challenge, signature)).toBe("WRONG_SUBJECT");
  });

  it("EXPIRED once past expiresAt", () => {
    const challenge = baseChallenge();
    const signature = signChallenge(challenge, privateKeyPem);
    const future = Date.parse(challenge.expiresAt) + 1000;
    expect(validate(challenge, signature, future)).toBe("EXPIRED");
  });

  it("NOT_YET_VALID before notBefore", () => {
    const now = Date.now();
    const challenge = baseChallenge({ notBefore: new Date(now + 60_000).toISOString() });
    const signature = signChallenge(challenge, privateKeyPem);
    expect(validate(challenge, signature, now)).toBe("NOT_YET_VALID");
  });

  it("WRONG_AUDIENCE if the audience does not match", () => {
    const challenge = baseChallenge({ audience: "not-the-expected-audience" });
    const signature = signChallenge(challenge, privateKeyPem);
    expect(validate(challenge, signature)).toBe("WRONG_AUDIENCE");
  });

  it("SYSTEM_CHECK_CHALLENGE_PURPOSE constant matches the literal type", () => {
    expect(SYSTEM_CHECK_CHALLENGE_PURPOSE).toBe("SYSTEM_CHECK");
  });
});
