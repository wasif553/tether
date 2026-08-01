import { describe, it, expect } from "vitest";
import crypto from "crypto";
import {
  computeUserSubjectHash,
  computePublicKeyFingerprint,
  signRegistrationChallenge,
  verifyRegistrationChallengeSignature,
  validateRegistrationChallengeContext,
  signRegistrationProofOfPossession,
  verifyRegistrationProofOfPossession,
  signAttestationChallenge,
  validateAttestationChallengeContext,
  buildSystemCheckAttestationCanonicalString,
  buildExamSessionAttestationCanonicalString,
  verifyInstallationSignature,
  generateAttestationNonce,
  REGISTRATION_PURPOSE,
  ATTESTATION_PROTOCOL_VERSION,
  type RegistrationChallenge,
  type AttestationChallenge,
} from "./tetherAttestation";

// Generated synchronously at module load (not beforeAll) — several
// `describe(...)` bodies below reference these directly while building
// shared `context`/fixture objects, which run before any beforeAll hook.
const server = crypto.generateKeyPairSync("ed25519");
const serverPublicKeyPem = server.publicKey.export({ type: "spki", format: "pem" }).toString();
const serverPrivateKeyPem = server.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const instA = crypto.generateKeyPairSync("ed25519");
const installationAPublicKeyPem = instA.publicKey.export({ type: "spki", format: "pem" }).toString();
const installationAPrivateKeyPem = instA.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const instB = crypto.generateKeyPairSync("ed25519");
const installationBPublicKeyPem = instB.publicKey.export({ type: "spki", format: "pem" }).toString();

describe("computePublicKeyFingerprint", () => {
  it("2. two different installations produce different public keys and therefore different fingerprints", () => {
    expect(computePublicKeyFingerprint(installationAPublicKeyPem)).not.toBe(computePublicKeyFingerprint(installationBPublicKeyPem));
  });

  it("is deterministic for the same key", () => {
    expect(computePublicKeyFingerprint(installationAPublicKeyPem)).toBe(computePublicKeyFingerprint(installationAPublicKeyPem));
  });
});

function baseRegistrationChallenge(overrides: Partial<RegistrationChallenge> = {}): RegistrationChallenge {
  const now = Date.now();
  return {
    schemaVersion: ATTESTATION_PROTOCOL_VERSION,
    challengeId: "reg-challenge-1",
    keyId: "key-1",
    issuer: "tether-secure-client",
    purpose: REGISTRATION_PURPOSE,
    audience: "tether-installation-registration",
    userSubjectHash: computeUserSubjectHash("user-1"),
    issuedAt: new Date(now).toISOString(),
    notBefore: new Date(now).toISOString(),
    expiresAt: new Date(now + 5 * 60_000).toISOString(),
    nonce: generateAttestationNonce(),
    publicKeyFingerprint: computePublicKeyFingerprint(installationAPublicKeyPem),
    ...overrides,
  };
}

describe("registration challenge + proof of possession", () => {
  it("a genuinely signed registration challenge verifies true", () => {
    const challenge = baseRegistrationChallenge();
    const signature = signRegistrationChallenge(challenge, serverPrivateKeyPem);
    expect(verifyRegistrationChallengeSignature(challenge, signature, serverPublicKeyPem)).toBe(true);
  });

  it("VALID for a correctly signed, current challenge", () => {
    const challenge = baseRegistrationChallenge();
    const signature = signRegistrationChallenge(challenge, serverPrivateKeyPem);
    const result = validateRegistrationChallengeContext(challenge, signature, serverPublicKeyPem, {
      expectedAudience: "tether-installation-registration",
      expectedUserSubjectHash: computeUserSubjectHash("user-1"),
      expectedPublicKeyFingerprint: computePublicKeyFingerprint(installationAPublicKeyPem),
      nowMs: Date.now(),
    });
    expect(result).toBe("VALID");
  });

  it("WRONG_SUBJECT if issued to a different user", () => {
    const challenge = baseRegistrationChallenge({ userSubjectHash: computeUserSubjectHash("someone-else") });
    const signature = signRegistrationChallenge(challenge, serverPrivateKeyPem);
    const result = validateRegistrationChallengeContext(challenge, signature, serverPublicKeyPem, {
      expectedAudience: "tether-installation-registration",
      expectedUserSubjectHash: computeUserSubjectHash("user-1"),
      expectedPublicKeyFingerprint: computePublicKeyFingerprint(installationAPublicKeyPem),
      nowMs: Date.now(),
    });
    expect(result).toBe("WRONG_SUBJECT");
  });

  it("WRONG_PUBLIC_KEY if the challenge was issued for a different key than the one now being registered", () => {
    const challenge = baseRegistrationChallenge({ publicKeyFingerprint: computePublicKeyFingerprint(installationBPublicKeyPem) });
    const signature = signRegistrationChallenge(challenge, serverPrivateKeyPem);
    const result = validateRegistrationChallengeContext(challenge, signature, serverPublicKeyPem, {
      expectedAudience: "tether-installation-registration",
      expectedUserSubjectHash: computeUserSubjectHash("user-1"),
      expectedPublicKeyFingerprint: computePublicKeyFingerprint(installationAPublicKeyPem),
      nowMs: Date.now(),
    });
    expect(result).toBe("WRONG_PUBLIC_KEY");
  });

  it("public-key-fingerprint tampering (post-signing) invalidates the signature", () => {
    const challenge = baseRegistrationChallenge();
    const signature = signRegistrationChallenge(challenge, serverPrivateKeyPem);
    const tampered = { ...challenge, publicKeyFingerprint: computePublicKeyFingerprint(installationBPublicKeyPem) };
    const result = validateRegistrationChallengeContext(tampered, signature, serverPublicKeyPem, {
      expectedAudience: "tether-installation-registration",
      expectedUserSubjectHash: computeUserSubjectHash("user-1"),
      expectedPublicKeyFingerprint: computePublicKeyFingerprint(installationBPublicKeyPem),
      nowMs: Date.now(),
    });
    expect(result).toBe("INVALID_SIGNATURE");
  });

  it("proof-of-possession: a signature over the challenge nonce verifies against the SAME keypair only", () => {
    const nonce = generateAttestationNonce();
    const signature = signRegistrationProofOfPossession(nonce, installationAPrivateKeyPem);
    expect(verifyRegistrationProofOfPossession(nonce, signature, installationAPublicKeyPem)).toBe(true);
    // A different installation's public key never verifies installation A's signature.
    expect(verifyRegistrationProofOfPossession(nonce, signature, installationBPublicKeyPem)).toBe(false);
  });
});

function baseAttestationChallenge(overrides: Partial<AttestationChallenge> = {}): AttestationChallenge {
  const now = Date.now();
  return {
    schemaVersion: ATTESTATION_PROTOCOL_VERSION,
    challengeId: "attest-challenge-1",
    keyId: "key-1",
    issuer: "tether-secure-client",
    purpose: "SYSTEM_CHECK",
    audience: "tether-attestation",
    userSubjectHash: computeUserSubjectHash("user-1"),
    installationId: "install-1",
    installationPublicKeyFingerprint: computePublicKeyFingerprint(installationAPublicKeyPem),
    issuedAt: new Date(now).toISOString(),
    notBefore: new Date(now).toISOString(),
    expiresAt: new Date(now + 2 * 60_000).toISOString(),
    nonce: generateAttestationNonce(),
    examId: null,
    submissionId: null,
    policyHash: null,
    secureClientSessionId: null,
    institutionId: null,
    allowedClientType: null,
    displayPolicy: null,
    requiredMinimumClientVersion: null,
    ...overrides,
  };
}

describe("purpose-bound attestation challenge", () => {
  const context = {
    expectedPurpose: "SYSTEM_CHECK" as const,
    expectedAudience: "tether-attestation",
    expectedUserSubjectHash: computeUserSubjectHash("user-1"),
    expectedInstallationId: "install-1",
    expectedInstallationPublicKeyFingerprint: computePublicKeyFingerprint(installationAPublicKeyPem),
  };

  it("VALID for a correctly signed, correctly bound challenge", () => {
    const challenge = baseAttestationChallenge();
    const signature = signAttestationChallenge(challenge, serverPrivateKeyPem);
    expect(validateAttestationChallengeContext(challenge, signature, serverPublicKeyPem, { ...context, nowMs: Date.now() })).toBe("VALID");
  });

  it("16. purpose tampering is rejected — EXAM_SESSION relabelled as SYSTEM_CHECK fails signature verification", () => {
    const challenge = baseAttestationChallenge({ purpose: "EXAM_SESSION" });
    const signature = signAttestationChallenge(challenge, serverPrivateKeyPem);
    // Re-labelled back to SYSTEM_CHECK AFTER signing — invalidates the signature.
    const tampered = { ...challenge, purpose: "SYSTEM_CHECK" as const };
    expect(validateAttestationChallengeContext(tampered, signature, serverPublicKeyPem, { ...context, nowMs: Date.now() })).toBe("INVALID_SIGNATURE");
  });

  it("12. user/subject tampering is rejected — a challenge genuinely issued for a different user is rejected against this user's expected subject", () => {
    const challenge = baseAttestationChallenge({ userSubjectHash: computeUserSubjectHash("attacker") });
    const signature = signAttestationChallenge(challenge, serverPrivateKeyPem);
    expect(validateAttestationChallengeContext(challenge, signature, serverPublicKeyPem, { ...context, nowMs: Date.now() })).toBe("WRONG_SUBJECT");
  });

  it("also rejects if the userSubjectHash field is tampered with AFTER signing (invalidates the signature itself)", () => {
    const challenge = baseAttestationChallenge();
    const signature = signAttestationChallenge(challenge, serverPrivateKeyPem);
    const tampered = { ...challenge, userSubjectHash: computeUserSubjectHash("attacker") };
    expect(validateAttestationChallengeContext(tampered, signature, serverPublicKeyPem, { ...context, nowMs: Date.now() })).toBe("INVALID_SIGNATURE");
  });

  it("a challenge bound to a DIFFERENT installation id is rejected when checked against this installation's expected id", () => {
    const challenge = baseAttestationChallenge({ installationId: "someone-elses-installation" });
    const signature = signAttestationChallenge(challenge, serverPrivateKeyPem);
    expect(validateAttestationChallengeContext(challenge, signature, serverPublicKeyPem, { ...context, nowMs: Date.now() })).toBe("INVALID_SIGNATURE");
  });

  it("17. expiry tampering (extending expiresAt after signing) invalidates the signature", () => {
    const challenge = baseAttestationChallenge();
    const signature = signAttestationChallenge(challenge, serverPrivateKeyPem);
    const tampered = { ...challenge, expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString() };
    expect(validateAttestationChallengeContext(tampered, signature, serverPublicKeyPem, { ...context, nowMs: Date.now() })).toBe("INVALID_SIGNATURE");
  });

  it("EXPIRED once past expiresAt, for a genuinely-signed challenge", () => {
    const challenge = baseAttestationChallenge();
    const signature = signAttestationChallenge(challenge, serverPrivateKeyPem);
    const future = Date.parse(challenge.expiresAt) + 1000;
    expect(validateAttestationChallengeContext(challenge, signature, serverPublicKeyPem, { ...context, nowMs: future })).toBe("EXPIRED");
  });

  it("UNSUPPORTED_PROTOCOL_VERSION for a challenge signed under a different schemaVersion, even if the signature itself is genuine", () => {
    const challenge = baseAttestationChallenge({ schemaVersion: ATTESTATION_PROTOCOL_VERSION + 1 });
    const signature = signAttestationChallenge(challenge, serverPrivateKeyPem);
    expect(validateAttestationChallengeContext(challenge, signature, serverPublicKeyPem, { ...context, nowMs: Date.now() })).toBe("UNSUPPORTED_PROTOCOL_VERSION");
  });

  it("EXAM_SESSION session-id tampering (post-signing) invalidates the signature", () => {
    const challenge = baseAttestationChallenge({ purpose: "EXAM_SESSION", secureClientSessionId: "session-1" });
    const signature = signAttestationChallenge(challenge, serverPrivateKeyPem);
    const tampered = { ...challenge, secureClientSessionId: "a-different-session" };
    expect(
      validateAttestationChallengeContext(tampered, signature, serverPublicKeyPem, {
        ...context,
        expectedPurpose: "EXAM_SESSION",
        nowMs: Date.now(),
      }),
    ).toBe("INVALID_SIGNATURE");
  });
});

describe("installation-signed attestation payloads (the proof Chrome cannot fabricate)", () => {
  const systemCheckFacts = {
    nonce: "nonce-1",
    installationPublicKeyFingerprint: computePublicKeyFingerprint(installationAPublicKeyPem),
    clientVersion: "1.5.0",
    platform: "win32",
    displayTopologyClassification: "INTERNAL_ONLY",
  };

  it("6/11. a SYSTEM_CHECK canonical string differs from an EXAM_SESSION one built from the same nonce/fingerprint — a signature over one is never valid for the other", () => {
    const systemCheckString = buildSystemCheckAttestationCanonicalString(systemCheckFacts);
    const examSessionString = buildExamSessionAttestationCanonicalString({
      ...systemCheckFacts,
      displayCount: 1,
      examId: "exam-1",
      submissionId: "sub-1",
      policyHash: "policy-hash-1",
      secureClientSessionId: "session-1",
      capabilities: "1,1,1,1",
      timestamp: new Date(0).toISOString(),
    });
    expect(systemCheckString).not.toBe(examSessionString);

    const signature = crypto.sign(null, Buffer.from(systemCheckString, "utf8"), installationAPrivateKeyPem).toString("base64");
    expect(verifyInstallationSignature(systemCheckString, signature, installationAPublicKeyPem)).toBe(true);
    expect(verifyInstallationSignature(examSessionString, signature, installationAPublicKeyPem)).toBe(false);
  });

  it("7. wrong installation key is rejected — a signature from installation B never verifies against installation A's registered key", () => {
    const canonicalString = buildSystemCheckAttestationCanonicalString(systemCheckFacts);
    const wrongKeys = crypto.generateKeyPairSync("ed25519");
    const wrongPrivate = wrongKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const forgedSignature = crypto.sign(null, Buffer.from(canonicalString, "utf8"), wrongPrivate).toString("base64");
    expect(verifyInstallationSignature(canonicalString, forgedSignature, installationAPublicKeyPem)).toBe(false);
  });

  it("20. fabricated native facts invalidate the signature", () => {
    const canonicalString = buildSystemCheckAttestationCanonicalString(systemCheckFacts);
    const signature = crypto.sign(null, Buffer.from(canonicalString, "utf8"), installationAPrivateKeyPem).toString("base64");
    const tamperedString = buildSystemCheckAttestationCanonicalString({ ...systemCheckFacts, displayTopologyClassification: "CLONE_OR_DUPLICATE" });
    expect(verifyInstallationSignature(tamperedString, signature, installationAPublicKeyPem)).toBe(false);
  });

  it("14. submission tampering (EXAM_SESSION) invalidates the signature", () => {
    const facts = {
      ...systemCheckFacts,
      displayCount: 1,
      examId: "exam-1",
      submissionId: "sub-1",
      policyHash: "policy-hash-1",
      secureClientSessionId: "session-1",
      capabilities: "1,1,1,1",
      timestamp: new Date(0).toISOString(),
    };
    const canonicalString = buildExamSessionAttestationCanonicalString(facts);
    const signature = crypto.sign(null, Buffer.from(canonicalString, "utf8"), installationAPrivateKeyPem).toString("base64");
    const tamperedString = buildExamSessionAttestationCanonicalString({ ...facts, submissionId: "a-different-submission" });
    expect(verifyInstallationSignature(tamperedString, signature, installationAPublicKeyPem)).toBe(false);
  });

  it("13. exam tampering (EXAM_SESSION) invalidates the signature", () => {
    const facts = {
      ...systemCheckFacts,
      displayCount: 1,
      examId: "exam-1",
      submissionId: "sub-1",
      policyHash: "policy-hash-1",
      secureClientSessionId: "session-1",
      capabilities: "1,1,1,1",
      timestamp: new Date(0).toISOString(),
    };
    const canonicalString = buildExamSessionAttestationCanonicalString(facts);
    const signature = crypto.sign(null, Buffer.from(canonicalString, "utf8"), installationAPrivateKeyPem).toString("base64");
    const tamperedString = buildExamSessionAttestationCanonicalString({ ...facts, examId: "a-different-exam" });
    expect(verifyInstallationSignature(tamperedString, signature, installationAPublicKeyPem)).toBe(false);
  });

  it("15. policy-hash tampering (EXAM_SESSION) invalidates the signature", () => {
    const facts = {
      ...systemCheckFacts,
      displayCount: 1,
      examId: "exam-1",
      submissionId: "sub-1",
      policyHash: "policy-hash-1",
      secureClientSessionId: "session-1",
      capabilities: "1,1,1,1",
      timestamp: new Date(0).toISOString(),
    };
    const canonicalString = buildExamSessionAttestationCanonicalString(facts);
    const signature = crypto.sign(null, Buffer.from(canonicalString, "utf8"), installationAPrivateKeyPem).toString("base64");
    const tamperedString = buildExamSessionAttestationCanonicalString({ ...facts, policyHash: "a-different-policy-hash" });
    expect(verifyInstallationSignature(tamperedString, signature, installationAPublicKeyPem)).toBe(false);
  });

  it("never throws on a malformed signature", () => {
    const canonicalString = buildSystemCheckAttestationCanonicalString(systemCheckFacts);
    expect(verifyInstallationSignature(canonicalString, "not-valid-base64-!!!", installationAPublicKeyPem)).toBe(false);
  });
});
