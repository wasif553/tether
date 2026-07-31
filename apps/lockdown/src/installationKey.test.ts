import { describe, it, expect } from "vitest";
import crypto from "crypto";
import {
  ensureInstallationKey,
  getInstallationInfo,
  signWithInstallationKey,
  INSTALLATION_KEY_ALGORITHM,
  INSTALLATION_KEY_PROTECTION_LEVEL,
  type InstallationKeyStore,
  type InstallationKeyStoreSchema,
  type SafeStorageLike,
} from "./installationKey";

function createFakeStore(): InstallationKeyStore {
  let value: InstallationKeyStoreSchema["installationKey"] = null;
  return {
    get: () => value,
    set: (_key, next) => {
      value = next;
    },
  };
}

/** A real, in-process AES-GCM-backed stand-in for Electron's DPAPI-backed safeStorage — genuinely encrypts/decrypts (not a no-op passthrough), so tests exercise real round-trip behaviour. */
function createFakeSafeStorage(available = true): SafeStorageLike {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => available,
    encryptString(plainText: string): Buffer {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString(encrypted: Buffer): string {
      const iv = encrypted.subarray(0, 12);
      const authTag = encrypted.subarray(12, 28);
      const ciphertext = encrypted.subarray(28);
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    },
  };
}

describe("ensureInstallationKey", () => {
  it("generates a new key on first call", () => {
    const store = createFakeStore();
    const safeStorage = createFakeSafeStorage();
    const info = ensureInstallationKey(store, safeStorage);
    expect(info.hasKey).toBe(true);
    expect(info.publicKey).toContain("BEGIN PUBLIC KEY");
    expect(info.keyAlgorithm).toBe(INSTALLATION_KEY_ALGORITHM);
    expect(info.keyProtectionLevel).toBe(INSTALLATION_KEY_PROTECTION_LEVEL);
  });

  it("never classifies as TPM_ATTESTED or TPM_UNATTESTED — only SOFTWARE_PROTECTED is implemented this pass", () => {
    const store = createFakeStore();
    const info = ensureInstallationKey(store, createFakeSafeStorage());
    expect(info.keyProtectionLevel).toBe("SOFTWARE_PROTECTED");
    expect(info.keyProtectionLevel).not.toBe("TPM_ATTESTED");
    expect(info.keyProtectionLevel).not.toBe("TPM_UNATTESTED");
  });

  it("2. two separate installations (separate stores) produce different public keys", () => {
    const infoA = ensureInstallationKey(createFakeStore(), createFakeSafeStorage());
    const infoB = ensureInstallationKey(createFakeStore(), createFakeSafeStorage());
    expect(infoA.publicKey).not.toBe(infoB.publicKey);
  });

  it("reuses the same key on a second call — does not silently regenerate", () => {
    const store = createFakeStore();
    const safeStorage = createFakeSafeStorage();
    const first = ensureInstallationKey(store, safeStorage);
    const second = ensureInstallationKey(store, safeStorage);
    expect(second.publicKey).toBe(first.publicKey);
  });

  it("does not generate or store a key when OS-backed encryption is unavailable — never falls back to storing it unencrypted", () => {
    const store = createFakeStore();
    const info = ensureInstallationKey(store, createFakeSafeStorage(false));
    expect(info.hasKey).toBe(false);
    expect(info.publicKey).toBeNull();
  });
});

describe("3. private key cannot be exported through application APIs", () => {
  it("getInstallationInfo never returns anything containing 'PRIVATE KEY'", () => {
    const store = createFakeStore();
    ensureInstallationKey(store, createFakeSafeStorage());
    const info = getInstallationInfo(store);
    expect(JSON.stringify(info)).not.toContain("PRIVATE KEY");
  });

  it("ensureInstallationKey's own return value never contains 'PRIVATE KEY' either", () => {
    const store = createFakeStore();
    const info = ensureInstallationKey(store, createFakeSafeStorage());
    expect(JSON.stringify(info)).not.toContain("PRIVATE KEY");
  });

  it("signWithInstallationKey returns only a signature string — never the key material used to produce it", () => {
    const store = createFakeStore();
    const safeStorage = createFakeSafeStorage();
    ensureInstallationKey(store, safeStorage);
    const signature = signWithInstallationKey(store, safeStorage, "some-data-to-sign");
    expect(typeof signature).toBe("string");
    expect(signature).not.toContain("PRIVATE KEY");
  });

  it("there is no exported function in this module whose name suggests key export (structural check of the module's own exports)", async () => {
    const mod = await import("./installationKey");
    const exportNames = Object.keys(mod);
    for (const name of exportNames) {
      expect(name.toLowerCase()).not.toMatch(/export.*key|get.*private.*key|raw.*key/);
    }
  });
});

describe("signWithInstallationKey", () => {
  it("6. a signature produced by the installation's key verifies against its own public key", () => {
    const store = createFakeStore();
    const safeStorage = createFakeSafeStorage();
    const info = ensureInstallationKey(store, safeStorage);
    const signature = signWithInstallationKey(store, safeStorage, "canonical-payload");
    expect(signature).not.toBeNull();
    const ok = crypto.verify(null, Buffer.from("canonical-payload", "utf8"), info.publicKey!, Buffer.from(signature!, "base64"));
    expect(ok).toBe(true);
  });

  it("returns null when no key has been generated yet", () => {
    const store = createFakeStore();
    const signature = signWithInstallationKey(store, createFakeSafeStorage(), "data");
    expect(signature).toBeNull();
  });

  it("different data produces a signature that does not verify against the original data", () => {
    const store = createFakeStore();
    const safeStorage = createFakeSafeStorage();
    const info = ensureInstallationKey(store, safeStorage);
    const signature = signWithInstallationKey(store, safeStorage, "data-a")!;
    const ok = crypto.verify(null, Buffer.from("data-b", "utf8"), info.publicKey!, Buffer.from(signature, "base64"));
    expect(ok).toBe(false);
  });
});
