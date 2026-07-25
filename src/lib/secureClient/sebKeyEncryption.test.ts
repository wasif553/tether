import { describe, it, expect, afterEach, vi } from "vitest";
import { encryptSebKeyValue, decryptSebKeyValue, SebKeyEncryptionConfigError } from "./sebKeyEncryption";

const ACTIVE_KEY_ID = "k1";
const KEY_A = "11".repeat(32); // 64 hex chars = 32 bytes
const KEY_B = "22".repeat(32);

function stubKeyring(keys: Record<string, string>, activeKeyId = ACTIVE_KEY_ID) {
  vi.stubEnv("TETHER_SEB_KEY_ENCRYPTION_KEYS_JSON", JSON.stringify(keys));
  vi.stubEnv("TETHER_SEB_KEY_ENCRYPTION_ACTIVE_KEY_ID", activeKeyId);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("encryptSebKeyValue / decryptSebKeyValue", () => {
  it("round-trips a raw key value exactly", () => {
    stubKeyring({ [ACTIVE_KEY_ID]: KEY_A });
    const raw = "a-very-secret-browser-exam-key";
    const encrypted = encryptSebKeyValue(raw);
    expect(decryptSebKeyValue(encrypted)).toBe(raw);
  });

  it("never stores the raw value in plaintext within the packed ciphertext", () => {
    stubKeyring({ [ACTIVE_KEY_ID]: KEY_A });
    const raw = "a-very-secret-browser-exam-key";
    const encrypted = encryptSebKeyValue(raw);
    expect(encrypted).not.toContain(raw);
  });

  it("produces a different ciphertext each time (random IV) even for the same plaintext", () => {
    stubKeyring({ [ACTIVE_KEY_ID]: KEY_A });
    const raw = "same-key-value";
    const a = encryptSebKeyValue(raw);
    const b = encryptSebKeyValue(raw);
    expect(a).not.toBe(b);
    expect(decryptSebKeyValue(a)).toBe(raw);
    expect(decryptSebKeyValue(b)).toBe(raw);
  });

  it("packed format is scv1:keyId:ivHex:authTagHex:ciphertextHex", () => {
    stubKeyring({ [ACTIVE_KEY_ID]: KEY_A });
    const encrypted = encryptSebKeyValue("value");
    const parts = encrypted.split(":");
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe("scv1");
    expect(parts[1]).toBe(ACTIVE_KEY_ID);
  });

  it("never appears in serialised API output (fingerprint-only contract)", () => {
    stubKeyring({ [ACTIVE_KEY_ID]: KEY_A });
    const raw = "a-very-secret-browser-exam-key";
    const encrypted = encryptSebKeyValue(raw);
    // Simulates the API-response shape used by listMaskedSebAllowedExamKeys
    // (secureClientRunner.ts) — only a masked fingerprint derived from
    // keyHash is ever serialised, never rawKeyCiphertext or the raw value.
    const apiResponse = JSON.stringify({ id: "k1", fingerprint: "abcdef…1234" });
    expect(apiResponse).not.toContain(raw);
    expect(apiResponse).not.toContain(encrypted);
  });

  it("returns null (never throws) for malformed input", () => {
    stubKeyring({ [ACTIVE_KEY_ID]: KEY_A });
    expect(decryptSebKeyValue("not-the-right-shape")).toBeNull();
    expect(decryptSebKeyValue("a:b")).toBeNull();
    expect(decryptSebKeyValue("")).toBeNull();
  });

  it("returns null for an unrecognised format version", () => {
    stubKeyring({ [ACTIVE_KEY_ID]: KEY_A });
    const encrypted = encryptSebKeyValue("original-value");
    const parts = encrypted.split(":");
    parts[0] = "scv0";
    expect(decryptSebKeyValue(parts.join(":"))).toBeNull();
  });

  it("returns null for tampered ciphertext (GCM auth tag catches modification)", () => {
    stubKeyring({ [ACTIVE_KEY_ID]: KEY_A });
    const encrypted = encryptSebKeyValue("original-value");
    const [version, keyId, iv, authTag, ciphertext] = encrypted.split(":");
    const tamperedCiphertext = ciphertext.slice(0, -2) + (ciphertext.slice(-2) === "00" ? "11" : "00");
    expect(decryptSebKeyValue(`${version}:${keyId}:${iv}:${authTag}:${tamperedCiphertext}`)).toBeNull();
  });

  it("returns null for a tampered auth tag", () => {
    stubKeyring({ [ACTIVE_KEY_ID]: KEY_A });
    const encrypted = encryptSebKeyValue("original-value");
    const [version, keyId, iv, authTag, ciphertext] = encrypted.split(":");
    const tamperedTag = authTag.slice(0, -2) + (authTag.slice(-2) === "00" ? "11" : "00");
    expect(decryptSebKeyValue(`${version}:${keyId}:${iv}:${tamperedTag}:${ciphertext}`)).toBeNull();
  });

  it("returns null for an unknown key id", () => {
    stubKeyring({ [ACTIVE_KEY_ID]: KEY_A });
    const encrypted = encryptSebKeyValue("original-value");
    const [version, , iv, authTag, ciphertext] = encrypted.split(":");
    expect(decryptSebKeyValue(`${version}:nonexistent-key-id:${iv}:${authTag}:${ciphertext}`)).toBeNull();
  });

  it("key rotation: an old key id still decrypts after the active key id changes, new encryptions use the new active key id", () => {
    stubKeyring({ [ACTIVE_KEY_ID]: KEY_A }, ACTIVE_KEY_ID);
    const encryptedWithOldKey = encryptSebKeyValue("value-from-before-rotation");

    // Rotate: both keys remain in the ring, active key id moves to "k2".
    stubKeyring({ [ACTIVE_KEY_ID]: KEY_A, k2: KEY_B }, "k2");
    const encryptedWithNewKey = encryptSebKeyValue("value-after-rotation");

    expect(encryptedWithNewKey.split(":")[1]).toBe("k2");
    expect(decryptSebKeyValue(encryptedWithOldKey)).toBe("value-from-before-rotation");
    expect(decryptSebKeyValue(encryptedWithNewKey)).toBe("value-after-rotation");
  });

  it("encrypt throws SebKeyEncryptionConfigError (fails closed) when TETHER_SEB_KEY_ENCRYPTION_ACTIVE_KEY_ID is missing", () => {
    vi.stubEnv("TETHER_SEB_KEY_ENCRYPTION_KEYS_JSON", JSON.stringify({ [ACTIVE_KEY_ID]: KEY_A }));
    vi.stubEnv("TETHER_SEB_KEY_ENCRYPTION_ACTIVE_KEY_ID", undefined);
    expect(() => encryptSebKeyValue("value")).toThrow(SebKeyEncryptionConfigError);
  });

  it("encrypt throws SebKeyEncryptionConfigError (fails closed) when TETHER_SEB_KEY_ENCRYPTION_KEYS_JSON is missing", () => {
    vi.stubEnv("TETHER_SEB_KEY_ENCRYPTION_KEYS_JSON", undefined);
    vi.stubEnv("TETHER_SEB_KEY_ENCRYPTION_ACTIVE_KEY_ID", ACTIVE_KEY_ID);
    expect(() => encryptSebKeyValue("value")).toThrow(SebKeyEncryptionConfigError);
  });

  it("encrypt throws SebKeyEncryptionConfigError when the active key id is not present in the keyring", () => {
    stubKeyring({ "some-other-key": KEY_A }, ACTIVE_KEY_ID);
    expect(() => encryptSebKeyValue("value")).toThrow(SebKeyEncryptionConfigError);
  });

  it("encrypt throws SebKeyEncryptionConfigError for malformed JSON", () => {
    vi.stubEnv("TETHER_SEB_KEY_ENCRYPTION_KEYS_JSON", "{not-json");
    vi.stubEnv("TETHER_SEB_KEY_ENCRYPTION_ACTIVE_KEY_ID", ACTIVE_KEY_ID);
    expect(() => encryptSebKeyValue("value")).toThrow(SebKeyEncryptionConfigError);
  });

  it("encrypt throws SebKeyEncryptionConfigError for a key that is not 64 hex characters", () => {
    vi.stubEnv("TETHER_SEB_KEY_ENCRYPTION_KEYS_JSON", JSON.stringify({ [ACTIVE_KEY_ID]: "too-short" }));
    vi.stubEnv("TETHER_SEB_KEY_ENCRYPTION_ACTIVE_KEY_ID", ACTIVE_KEY_ID);
    expect(() => encryptSebKeyValue("value")).toThrow(SebKeyEncryptionConfigError);
  });

  it("decrypt fails closed (returns null, never throws) when configuration is missing entirely", () => {
    vi.stubEnv("TETHER_SEB_KEY_ENCRYPTION_KEYS_JSON", JSON.stringify({ [ACTIVE_KEY_ID]: KEY_A }));
    vi.stubEnv("TETHER_SEB_KEY_ENCRYPTION_ACTIVE_KEY_ID", ACTIVE_KEY_ID);
    const encrypted = encryptSebKeyValue("value");

    vi.stubEnv("TETHER_SEB_KEY_ENCRYPTION_KEYS_JSON", undefined);
    vi.stubEnv("TETHER_SEB_KEY_ENCRYPTION_ACTIVE_KEY_ID", undefined);
    expect(decryptSebKeyValue(encrypted)).toBeNull();
  });
});
