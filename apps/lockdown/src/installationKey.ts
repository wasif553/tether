/**
 * Secure Client Attestation v2 — per-installation key. See
 * docs/tether-system-check-v1.md, "Per-installation key".
 *
 * REPLACES the removed v1 design (a single Ed25519 private key compiled
 * into every packaged build — extractable from any one installation,
 * compromising every installation). Each installation now generates its
 * OWN keypair, once, on first need. The private key is encrypted at
 * rest using Electron's `safeStorage` (OS-backed: DPAPI on Windows) and
 * decrypted into memory only for the instant a signing operation needs
 * it — never written to disk in plaintext, never sent over any IPC
 * channel to the renderer, never returned by any function exported from
 * this module.
 *
 * Honest assurance-level classification (see prisma/schema.prisma,
 * TetherClientInstallation.keyProtectionLevel doc comment): this module
 * implements ONLY "SOFTWARE_PROTECTED" — a real Windows CNG/TPM-backed
 * non-exportable key (Microsoft Platform Crypto Provider) was
 * investigated but deliberately NOT implemented in this pass, since
 * shipping unverified native-crypto code (no TPM hardware was available
 * to test against in this environment) is worse than being explicit
 * about the gap — see "Known limitations" in the doc above. Ed25519 is
 * used here (matching the rest of this codebase's signing conventions)
 * rather than ECDSA P-256 specifically because no CNG integration exists
 * yet to require it; a future TPM-backed implementation would need
 * ECDSA P-256 (Windows CNG does not support Ed25519) — see
 * `keyAlgorithm` in the registration payload, which already
 * accommodates that value.
 */
import crypto from "crypto";

/**
 * A narrow structural view of Electron's `safeStorage` — only the three
 * methods this module needs. Injected (never imported from "electron"
 * directly) so this module's logic is fully unit-testable under plain
 * vitest without a live Electron runtime, exactly like
 * windowsDisplayTopologyClassifier.ts separates pure logic from its
 * Electron/native-process-dependent counterpart. main.ts passes the
 * real `electron.safeStorage` at the one call site that matters.
 */
export type SafeStorageLike = {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
};

export const INSTALLATION_KEY_ALGORITHM = "Ed25519" as const;
export const INSTALLATION_KEY_PROTECTION_LEVEL = "SOFTWARE_PROTECTED" as const;

export type InstallationKeyStoreSchema = {
  installationKey: { publicKeyPem: string; encryptedPrivateKeyBase64: string } | null;
};

/**
 * A narrow structural view of the app's electron-store instance — only
 * the get/set operations this module actually needs for the
 * "installationKey" entry. Deliberately NOT `Store<InstallationKeyStoreSchema>`:
 * electron-store's type parameter is invariant, so main.ts's real
 * `Store<StoreSchema>` (a superset schema with queuedEvents/lastExamId
 * too) would not otherwise be structurally assignable here.
 */
export type InstallationKeyStore = {
  get(key: "installationKey", defaultValue: InstallationKeyStoreSchema["installationKey"]): InstallationKeyStoreSchema["installationKey"];
  set(key: "installationKey", value: InstallationKeyStoreSchema["installationKey"]): void;
};

export type InstallationInfo = {
  hasKey: boolean;
  publicKey: string | null;
  keyAlgorithm: string;
  keyProtectionLevel: string;
};

/**
 * Generates (if not already present) a per-installation Ed25519 keypair
 * and persists it — public key in plaintext (safe, it's public), private
 * key encrypted via safeStorage. Returns only the public key and
 * metadata; the private key never leaves this function's local scope
 * during generation. Returns `{ hasKey: false, ... }` (never a silent
 * weaker fallback) if OS-backed encryption is unavailable — an
 * unencrypted-at-rest private key is not an acceptable substitute.
 */
export function ensureInstallationKey(store: InstallationKeyStore, safeStorage: SafeStorageLike): InstallationInfo {
  const existing = store.get("installationKey", null);
  if (existing) {
    return { hasKey: true, publicKey: existing.publicKeyPem, keyAlgorithm: INSTALLATION_KEY_ALGORITHM, keyProtectionLevel: INSTALLATION_KEY_PROTECTION_LEVEL };
  }

  if (!safeStorage.isEncryptionAvailable()) {
    return { hasKey: false, publicKey: null, keyAlgorithm: INSTALLATION_KEY_ALGORITHM, keyProtectionLevel: INSTALLATION_KEY_PROTECTION_LEVEL };
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const encryptedPrivateKeyBase64 = safeStorage.encryptString(privateKeyPem).toString("base64");

  store.set("installationKey", { publicKeyPem, encryptedPrivateKeyBase64 });
  return { hasKey: true, publicKey: publicKeyPem, keyAlgorithm: INSTALLATION_KEY_ALGORITHM, keyProtectionLevel: INSTALLATION_KEY_PROTECTION_LEVEL };
}

export function getInstallationInfo(store: InstallationKeyStore): InstallationInfo {
  const existing = store.get("installationKey", null);
  return {
    hasKey: existing != null,
    publicKey: existing?.publicKeyPem ?? null,
    keyAlgorithm: INSTALLATION_KEY_ALGORITHM,
    keyProtectionLevel: INSTALLATION_KEY_PROTECTION_LEVEL,
  };
}

/**
 * Signs an arbitrary UTF-8 string with the installation's private key,
 * decrypted into memory only for this call. Internal to main.ts only —
 * never exported to, or callable from, the renderer; every IPC-exposed
 * caller of this function builds its OWN fixed canonical string first
 * (see main.ts's buildSystemCheckAttestationCanonicalString /
 * buildExamSessionAttestationCanonicalString) — the renderer never
 * chooses what gets signed.
 */
export function signWithInstallationKey(store: InstallationKeyStore, safeStorage: SafeStorageLike, data: string): string | null {
  const existing = store.get("installationKey", null);
  if (!existing) return null;
  const privateKeyPem = safeStorage.decryptString(Buffer.from(existing.encryptedPrivateKeyBase64, "base64"));
  const signature = crypto.sign(null, Buffer.from(data, "utf8"), privateKeyPem);
  return signature.toString("base64");
}
