import { describe, it, expect, beforeAll } from "vitest";
import crypto from "crypto";
import {
  canonicalJsonStringify,
  computeManifestHash,
  computePolicyHash,
  computeStudentSubjectHash,
  generateLaunchNonce,
  hashNonce,
  signManifest,
  verifyManifestSignature,
  validateManifestContext,
  type SecureLaunchManifest,
} from "./secureLaunchManifest";

let publicKeyPem: string;
let privateKeyPem: string;

beforeAll(() => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
});

function baseManifest(overrides: Partial<SecureLaunchManifest> = {}): SecureLaunchManifest {
  const now = Date.now();
  return {
    schemaVersion: 1,
    manifestId: "manifest-1",
    keyId: "key-1",
    issuer: "tether-secure-client",
    audience: "tether-secure-client",
    institutionId: "inst-1",
    examId: "exam-1",
    submissionId: "sub-1",
    studentSubjectHash: computeStudentSubjectHash("student-1"),
    configurationId: null,
    clientType: "MOCK_TETHER_CLIENT",
    policyHash: "policy-hash",
    canonicalExamOrigin: "https://example.test",
    launchPath: "/student/exams/exam-1",
    issuedAt: new Date(now).toISOString(),
    notBefore: new Date(now).toISOString(),
    expiresAt: new Date(now + 5 * 60_000).toISOString(),
    nonce: generateLaunchNonce(),
    minimumClientVersion: null,
    allowedPlatform: [],
    heartbeatIntervalSeconds: 30,
    heartbeatGraceSeconds: 90,
    requiredChecks: [],
    permittedCapabilities: [],
    ...overrides,
  };
}

describe("canonicalJsonStringify", () => {
  it("sorts object keys recursively regardless of insertion order", () => {
    const a = canonicalJsonStringify({ b: 1, a: { d: 2, c: 3 } });
    const b = canonicalJsonStringify({ a: { c: 3, d: 2 }, b: 1 });
    expect(a).toBe(b);
  });

  it("preserves array order (order can be meaningful)", () => {
    const result = canonicalJsonStringify({ items: [3, 1, 2] });
    expect(result).toContain("[3,1,2]");
  });
});

describe("computeManifestHash / computePolicyHash", () => {
  it("is deterministic for the same manifest", () => {
    const manifest = baseManifest();
    expect(computeManifestHash(manifest)).toBe(computeManifestHash(manifest));
  });

  it("changes when any field changes", () => {
    const manifest = baseManifest();
    const changed = { ...manifest, examId: "exam-2" };
    expect(computeManifestHash(manifest)).not.toBe(computeManifestHash(changed));
  });

  it("computePolicyHash is stable for structurally-equal policies regardless of key order", () => {
    const h1 = computePolicyHash({ a: 1, b: 2 });
    const h2 = computePolicyHash({ b: 2, a: 1 });
    expect(h1).toBe(h2);
  });
});

describe("computeStudentSubjectHash", () => {
  it("never contains the raw student id and is deterministic", () => {
    const hash = computeStudentSubjectHash("student-42");
    expect(hash).not.toContain("student-42");
    expect(hash).toBe(computeStudentSubjectHash("student-42"));
    expect(hash).not.toBe(computeStudentSubjectHash("student-43"));
  });
});

describe("nonce generation and hashing", () => {
  it("generates unique, URL-safe nonces", () => {
    const a = generateLaunchNonce();
    const b = generateLaunchNonce();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("hashNonce is deterministic and never returns the raw nonce", () => {
    const nonce = generateLaunchNonce();
    const hash = hashNonce(nonce);
    expect(hash).not.toBe(nonce);
    expect(hash).toBe(hashNonce(nonce));
  });
});

describe("signManifest / verifyManifestSignature", () => {
  it("a validly-signed manifest verifies true against the matching public key", () => {
    const manifest = baseManifest();
    const signature = signManifest(manifest, privateKeyPem);
    expect(verifyManifestSignature(manifest, signature, publicKeyPem)).toBe(true);
  });

  it("a tampered manifest field invalidates the signature", () => {
    const manifest = baseManifest();
    const signature = signManifest(manifest, privateKeyPem);
    const tampered = { ...manifest, submissionId: "attacker-submission" };
    expect(verifyManifestSignature(tampered, signature, publicKeyPem)).toBe(false);
  });

  it("a signature from a different key pair fails verification", () => {
    const manifest = baseManifest();
    const other = crypto.generateKeyPairSync("ed25519");
    const wrongPrivate = other.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const signature = signManifest(manifest, wrongPrivate);
    expect(verifyManifestSignature(manifest, signature, publicKeyPem)).toBe(false);
  });

  it("never throws on a garbage signature or key, just returns false", () => {
    const manifest = baseManifest();
    expect(verifyManifestSignature(manifest, "not-base64-!!!", publicKeyPem)).toBe(false);
    expect(verifyManifestSignature(manifest, "AAAA", "not a pem key")).toBe(false);
  });
});

describe("validateManifestContext", () => {
  const expectedAudience = "tether-secure-client";
  const expectedOrigin = "https://example.test";

  function contextFor(manifest: SecureLaunchManifest, nowMs: number) {
    return { expectedAudience, expectedOrigin, expectedPolicyHash: manifest.policyHash, nowMs };
  }

  it("returns VALID for a well-formed, current, correctly-scoped manifest", () => {
    const manifest = baseManifest();
    const signature = signManifest(manifest, privateKeyPem);
    const result = validateManifestContext(manifest, signature, publicKeyPem, contextFor(manifest, Date.now()));
    expect(result).toBe("VALID");
  });

  it("INVALID_SIGNATURE takes priority over every other check", () => {
    const manifest = baseManifest({ audience: "wrong-audience", policyHash: "wrong" });
    const result = validateManifestContext(manifest, "garbage-signature", publicKeyPem, contextFor(manifest, Date.now()));
    expect(result).toBe("INVALID_SIGNATURE");
  });

  it("rejects an expired manifest as EXPIRED (replay/expiry protection)", () => {
    const manifest = baseManifest({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    const signature = signManifest(manifest, privateKeyPem);
    const result = validateManifestContext(manifest, signature, publicKeyPem, contextFor(manifest, Date.now()));
    expect(result).toBe("EXPIRED");
  });

  it("rejects a not-yet-valid manifest as NOT_YET_VALID", () => {
    const manifest = baseManifest({ notBefore: new Date(Date.now() + 60_000).toISOString() });
    const signature = signManifest(manifest, privateKeyPem);
    const result = validateManifestContext(manifest, signature, publicKeyPem, contextFor(manifest, Date.now()));
    expect(result).toBe("NOT_YET_VALID");
  });

  it("rejects a mismatched audience as WRONG_AUDIENCE", () => {
    const manifest = baseManifest({ audience: "some-other-audience" });
    const signature = signManifest(manifest, privateKeyPem);
    const result = validateManifestContext(manifest, signature, publicKeyPem, contextFor(manifest, Date.now()));
    expect(result).toBe("WRONG_AUDIENCE");
  });

  it("rejects a mismatched origin as WRONG_ORIGIN", () => {
    const manifest = baseManifest({ canonicalExamOrigin: "https://attacker.test" });
    const signature = signManifest(manifest, privateKeyPem);
    const result = validateManifestContext(manifest, signature, publicKeyPem, contextFor(manifest, Date.now()));
    expect(result).toBe("WRONG_ORIGIN");
  });

  it("rejects a manifest bound to a different policy as POLICY_HASH_MISMATCH", () => {
    const manifest = baseManifest();
    const signature = signManifest(manifest, privateKeyPem);
    const context = { expectedAudience, expectedOrigin, expectedPolicyHash: "a-different-policy-hash", nowMs: Date.now() };
    const result = validateManifestContext(manifest, signature, publicKeyPem, context);
    expect(result).toBe("POLICY_HASH_MISMATCH");
  });
});
