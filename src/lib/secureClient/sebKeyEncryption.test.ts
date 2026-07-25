import { describe, it, expect } from "vitest";
import { encryptSebKeyValue, decryptSebKeyValue } from "./sebKeyEncryption";

describe("encryptSebKeyValue / decryptSebKeyValue", () => {
  it("round-trips a raw key value exactly", () => {
    const raw = "a-very-secret-browser-exam-key";
    const encrypted = encryptSebKeyValue(raw);
    expect(decryptSebKeyValue(encrypted)).toBe(raw);
  });

  it("never stores the raw value in plaintext within the packed ciphertext", () => {
    const raw = "a-very-secret-browser-exam-key";
    const encrypted = encryptSebKeyValue(raw);
    expect(encrypted).not.toContain(raw);
  });

  it("produces a different ciphertext each time (random IV) even for the same plaintext", () => {
    const raw = "same-key-value";
    const a = encryptSebKeyValue(raw);
    const b = encryptSebKeyValue(raw);
    expect(a).not.toBe(b);
    expect(decryptSebKeyValue(a)).toBe(raw);
    expect(decryptSebKeyValue(b)).toBe(raw);
  });

  it("packed format is ivHex:authTagHex:ciphertextHex", () => {
    const encrypted = encryptSebKeyValue("value");
    expect(encrypted.split(":")).toHaveLength(3);
  });

  it("returns null (never throws) for malformed input", () => {
    expect(decryptSebKeyValue("not-the-right-shape")).toBeNull();
    expect(decryptSebKeyValue("a:b")).toBeNull();
    expect(decryptSebKeyValue("")).toBeNull();
  });

  it("returns null for tampered ciphertext (GCM auth tag catches modification)", () => {
    const encrypted = encryptSebKeyValue("original-value");
    const [iv, authTag, ciphertext] = encrypted.split(":");
    const tamperedCiphertext = ciphertext.slice(0, -2) + (ciphertext.slice(-2) === "00" ? "11" : "00");
    expect(decryptSebKeyValue(`${iv}:${authTag}:${tamperedCiphertext}`)).toBeNull();
  });
});
