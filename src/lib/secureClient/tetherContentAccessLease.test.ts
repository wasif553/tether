/**
 * Release-blocking server content-boundary audit — see
 * tetherContentAccessLease.ts's own doc comment for the vulnerability
 * this closes, and the release-blocker follow-up review requiring the
 * lease to be bound to native installation-key proof (never legacy
 * attestation) and to the installation's own key fingerprint.
 */
import { describe, it, expect, beforeAll } from "vitest";
import crypto from "crypto";
import {
  CONTENT_ACCESS_LEASE_TTL_SECONDS,
  buildContentAccessLeaseClaims,
  encodeContentAccessLeaseCookieValue,
  decodeAndVerifyContentAccessLeaseCookieValue,
  isContentAccessLeaseExpired,
  contentAccessLeaseMatches,
} from "./tetherContentAccessLease";

let publicKeyPem: string;
let privateKeyPem: string;

beforeAll(() => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
});

const baseParams = {
  keyId: "key-1",
  submissionId: "sub-1",
  secureClientSessionId: "session-1",
  installationKeyFingerprint: "installation-fingerprint-1",
  studentId: "student-1",
};

describe("encodeContentAccessLeaseCookieValue / decodeAndVerifyContentAccessLeaseCookieValue", () => {
  it("REQUIRED TEST: a validly-issued lease round-trips and verifies against the matching public key", () => {
    const claims = buildContentAccessLeaseClaims(baseParams);
    const cookieValue = encodeContentAccessLeaseCookieValue(claims, privateKeyPem);
    const decoded = decodeAndVerifyContentAccessLeaseCookieValue(cookieValue, publicKeyPem);
    expect(decoded).not.toBeNull();
    expect(decoded?.submissionId).toBe("sub-1");
    expect(decoded?.secureClientSessionId).toBe("session-1");
    expect(decoded?.installationKeyFingerprint).toBe("installation-fingerprint-1");
  });

  it("REQUIRED TEST 3 / I: a plain spoofed/fabricated cookie value cannot satisfy the gate", () => {
    expect(decodeAndVerifyContentAccessLeaseCookieValue("not-a-real-lease", publicKeyPem)).toBeNull();
    expect(decodeAndVerifyContentAccessLeaseCookieValue("YQ.Yg", publicKeyPem)).toBeNull();
    expect(decodeAndVerifyContentAccessLeaseCookieValue("", publicKeyPem)).toBeNull();
  });

  it("a signature from a different key pair fails verification — a forged claims blob cannot be self-signed by an attacker without this server's private key", () => {
    const claims = buildContentAccessLeaseClaims(baseParams);
    const other = crypto.generateKeyPairSync("ed25519");
    const wrongPrivate = other.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const cookieValue = encodeContentAccessLeaseCookieValue(claims, wrongPrivate);
    expect(decodeAndVerifyContentAccessLeaseCookieValue(cookieValue, publicKeyPem)).toBeNull();
  });

  it("a tampered claims segment (e.g. submissionId swapped) invalidates the signature", () => {
    const claims = buildContentAccessLeaseClaims(baseParams);
    const cookieValue = encodeContentAccessLeaseCookieValue(claims, privateKeyPem);
    const [, signaturePart] = cookieValue.split(".");
    const tamperedClaims = { ...claims, submissionId: "attacker-submission" };
    const tamperedClaimsPart = Buffer.from(JSON.stringify(tamperedClaims), "utf8").toString("base64url");
    const tamperedCookie = `${tamperedClaimsPart}.${signaturePart}`;
    expect(decodeAndVerifyContentAccessLeaseCookieValue(tamperedCookie, publicKeyPem)).toBeNull();
  });

  it("never throws on a garbage cookie value or key, just returns null", () => {
    expect(decodeAndVerifyContentAccessLeaseCookieValue("!!!not-base64!!!.also-garbage", publicKeyPem)).toBeNull();
    const claims = buildContentAccessLeaseClaims(baseParams);
    const cookieValue = encodeContentAccessLeaseCookieValue(claims, privateKeyPem);
    expect(decodeAndVerifyContentAccessLeaseCookieValue(cookieValue, "not a pem key")).toBeNull();
  });
});

describe("isContentAccessLeaseExpired", () => {
  it("REQUIRED TEST: an unexpired lease within its TTL is not expired", () => {
    const claims = buildContentAccessLeaseClaims({ ...baseParams, nowMs: 1_000_000 });
    expect(isContentAccessLeaseExpired(claims, 1_000_000 + 60_000)).toBe(false);
  });

  it("a lease past its expiresAt is expired", () => {
    const claims = buildContentAccessLeaseClaims({ ...baseParams, nowMs: 1_000_000, ttlSeconds: 60 });
    expect(isContentAccessLeaseExpired(claims, 1_000_000 + 61_000)).toBe(true);
  });

  it("defaults to the module's own TTL constant when none is supplied", () => {
    const claims = buildContentAccessLeaseClaims({ ...baseParams, nowMs: 0 });
    const expiresAtMs = Date.parse(claims.expiresAt);
    expect(expiresAtMs).toBe(CONTENT_ACCESS_LEASE_TTL_SECONDS * 1000);
  });

  it("a malformed expiresAt fails closed (treated as expired), never treated as valid", () => {
    const claims = buildContentAccessLeaseClaims(baseParams);
    const malformed = { ...claims, expiresAt: "not-a-date" };
    expect(isContentAccessLeaseExpired(malformed, Date.now())).toBe(true);
  });
});

describe("contentAccessLeaseMatches", () => {
  it("REQUIRED TEST 1: matches when submission, student, current secure-client session id, and installation key fingerprint all agree", () => {
    const claims = buildContentAccessLeaseClaims(baseParams);
    expect(
      contentAccessLeaseMatches(claims, {
        submissionId: "sub-1",
        studentId: "student-1",
        currentSecureClientSessionId: "session-1",
        currentInstallationKeyFingerprint: "installation-fingerprint-1",
      }),
    ).toBe(true);
  });

  it("REQUIRED TEST 2 / 8: a lease bound to a superseded secure-client session (a new legitimate Tether launch) does not match the CURRENT session, even though its signature is still valid", () => {
    const claims = buildContentAccessLeaseClaims(baseParams);
    expect(
      contentAccessLeaseMatches(claims, {
        submissionId: "sub-1",
        studentId: "student-1",
        currentSecureClientSessionId: "a-newer-session",
        currentInstallationKeyFingerprint: "installation-fingerprint-1",
      }),
    ).toBe(false);
  });

  it("REQUIRED TEST J/K: a lease whose installation key fingerprint no longer matches the session's CURRENT installation (superseded or a different/revoked installation took over) is denied even though the session id and signature are still valid", () => {
    const claims = buildContentAccessLeaseClaims(baseParams);
    expect(
      contentAccessLeaseMatches(claims, {
        submissionId: "sub-1",
        studentId: "student-1",
        currentSecureClientSessionId: "session-1",
        currentInstallationKeyFingerprint: "a-different-installation-fingerprint",
      }),
    ).toBe(false);
  });

  it("fails closed when the CURRENT installation key fingerprint is null (no proof of installation-key possession on the live session)", () => {
    const claims = buildContentAccessLeaseClaims(baseParams);
    expect(
      contentAccessLeaseMatches(claims, {
        submissionId: "sub-1",
        studentId: "student-1",
        currentSecureClientSessionId: "session-1",
        currentInstallationKeyFingerprint: null,
      }),
    ).toBe(false);
  });

  it("fails closed when the lease's OWN installation key fingerprint is null, even if it happens to equal the current one", () => {
    const claims = buildContentAccessLeaseClaims({ ...baseParams, installationKeyFingerprint: null });
    expect(
      contentAccessLeaseMatches(claims, {
        submissionId: "sub-1",
        studentId: "student-1",
        currentSecureClientSessionId: "session-1",
        currentInstallationKeyFingerprint: null,
      }),
    ).toBe(false);
  });

  it("a lease for a different submission does not match", () => {
    const claims = buildContentAccessLeaseClaims(baseParams);
    expect(
      contentAccessLeaseMatches(claims, {
        submissionId: "a-different-submission",
        studentId: "student-1",
        currentSecureClientSessionId: "session-1",
        currentInstallationKeyFingerprint: "installation-fingerprint-1",
      }),
    ).toBe(false);
  });

  it("a lease for a different student does not match (subject hash comparison, never a raw id)", () => {
    const claims = buildContentAccessLeaseClaims(baseParams);
    expect(
      contentAccessLeaseMatches(claims, {
        submissionId: "sub-1",
        studentId: "a-different-student",
        currentSecureClientSessionId: "session-1",
        currentInstallationKeyFingerprint: "installation-fingerprint-1",
      }),
    ).toBe(false);
  });
});

describe("buildContentAccessLeaseClaims", () => {
  it("never embeds the raw student id anywhere in the claims", () => {
    const claims = buildContentAccessLeaseClaims(baseParams);
    expect(JSON.stringify(claims)).not.toContain("student-1");
  });
});
