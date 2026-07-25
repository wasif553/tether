/**
 * Tether Secure Client Foundation v1 — Safe Exam Browser key encryption.
 * See docs/secure-client-foundation-seb-v1.md.
 *
 * Server-only (uses Node's `crypto`). Encrypts/decrypts the raw Browser
 * Exam Key / Config Key value that MUST be recoverable server-side to
 * compute the official SEB per-request hash (expectedHash =
 * SHA256(requestUrl + rawKey) — see sebBrowserExamKey.ts).
 *
 * Hardening pass (see docs/migration-ledger.md hardening commit): this
 * module now supports authenticated encryption with an explicit format
 * version and key id, and NEVER generates or falls back to a runtime
 * secret. A missing/malformed TETHER_SEB_KEY_ENCRYPTION_ACTIVE_KEY_ID /
 * TETHER_SEB_KEY_ENCRYPTION_KEYS_JSON is a hard configuration error
 * (fails closed) — this replaces the previous SEB_KEY_ENCRYPTION_SECRET /
 * random-per-process-secret fallback, which could (a) silently encrypt
 * with a key that is lost on restart/redeploy and (b) never actually
 * enforced that a real secret was configured in any environment. Since
 * the migration that creates SebAllowedExamKey has NOT been applied
 * anywhere (see docs/migration-ledger.md — still PENDING), no ciphertext
 * in the old `ivHex:authTagHex:ciphertextHex` format exists in any
 * database, so there is no backward-compatibility burden here.
 *
 * Key rotation: TETHER_SEB_KEY_ENCRYPTION_KEYS_JSON is a JSON object
 * mapping every known key id to a 32-byte AES-256 key (64 hex
 * characters). TETHER_SEB_KEY_ENCRYPTION_ACTIVE_KEY_ID selects which of
 * those keys new encryptions use. Retired key ids may remain in the JSON
 * map indefinitely so previously-encrypted values can still be decrypted
 * after the active key id changes — see decryptSebKeyValue.
 *
 * Never committed: both env vars are secrets and must never be set in
 * NEXT_PUBLIC_* (this module never reads a NEXT_PUBLIC_ variable, and
 * never reads anything from a request/client — server-only, exactly like
 * SEB_KEY_ENCRYPTION_SECRET was before it).
 */
import crypto from "crypto";

export class SebKeyEncryptionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SebKeyEncryptionConfigError";
  }
}

/** Bumped only if the packed ciphertext layout changes in a way old values can't be read as. */
const FORMAT_VERSION = "scv1";
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12;
const HEX_KEY_PATTERN = /^[0-9a-f]{64}$/i;
const ENV_KEYRING_VAR = "TETHER_SEB_KEY_ENCRYPTION_KEYS_JSON";
const ENV_ACTIVE_KEY_ID_VAR = "TETHER_SEB_KEY_ENCRYPTION_ACTIVE_KEY_ID";

type Keyring = ReadonlyMap<string, Buffer>;

function parseKeyringJson(raw: string): Keyring {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SebKeyEncryptionConfigError(`${ENV_KEYRING_VAR} is not valid JSON.`);
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SebKeyEncryptionConfigError(`${ENV_KEYRING_VAR} must be a JSON object mapping keyId -> 64-character hex key.`);
  }
  const keyring = new Map<string, Buffer>();
  for (const [keyId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string" || !HEX_KEY_PATTERN.test(value)) {
      throw new SebKeyEncryptionConfigError(`${ENV_KEYRING_VAR} entry "${keyId}" must be a 64-character hex string (32 bytes).`);
    }
    keyring.set(keyId, Buffer.from(value, "hex"));
  }
  return keyring;
}

/**
 * Loads the configured keyring fresh from the environment on every call —
 * deliberately uncached, so a live secret rotation (or a test stubbing
 * env vars) takes effect immediately. Never generates a key at runtime:
 * missing or malformed configuration is a hard configuration error, never
 * a silent fallback.
 */
function loadKeyring(): Keyring {
  const raw = process.env[ENV_KEYRING_VAR];
  if (!raw) throw new SebKeyEncryptionConfigError(`${ENV_KEYRING_VAR} is not configured.`);
  return parseKeyringJson(raw);
}

function loadActiveKeyId(): string {
  const keyId = process.env[ENV_ACTIVE_KEY_ID_VAR];
  if (!keyId) throw new SebKeyEncryptionConfigError(`${ENV_ACTIVE_KEY_ID_VAR} is not configured.`);
  return keyId;
}

/**
 * Encrypts a raw SEB Browser Exam Key / Config Key value with the current
 * active key. Output format:
 * `scv1:<keyId>:<ivHex>:<authTagHex>:<ciphertextHex>` — safe to store in
 * one text column (SebAllowedExamKey.rawKeyCiphertext).
 *
 * Fails closed: throws SebKeyEncryptionConfigError (never falls back to a
 * runtime-generated key) if the active key id or keyring is missing or
 * malformed, or the active key id is not present in the keyring. Callers
 * (see addSebAllowedExamKey in secureClientRunner.ts) must treat this as a
 * hard failure — never catch-and-continue with an unencrypted value.
 */
export function encryptSebKeyValue(rawValue: string): string {
  const activeKeyId = loadActiveKeyId();
  const keyring = loadKeyring();
  const key = keyring.get(activeKeyId);
  if (!key) throw new SebKeyEncryptionConfigError(`Active key id "${activeKeyId}" is not present in ${ENV_KEYRING_VAR}.`);

  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(rawValue, "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  // Cleared once no longer needed — best-effort defence-in-depth, not a
  // guarantee against a heap dump, but costs nothing to do.
  plaintext.fill(0);
  const authTag = cipher.getAuthTag();
  return `${FORMAT_VERSION}:${activeKeyId}:${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

/**
 * Decrypts a value produced by encryptSebKeyValue. Returns null — never
 * throws, never logs the input or any partial result — for any malformed
 * shape, unknown format version, unknown key id, tampered ciphertext/tag,
 * or missing/malformed encryption configuration. Every existing caller
 * already treats null as "this key cannot be recovered right now" (see
 * loadActiveRawKeys in secureClientRunner.ts), so this preserves the
 * original fail-closed contract while adding key-rotation support: any
 * key id still present in the keyring — active or retired — can be
 * decrypted; only encryption always uses the current active key id.
 */
export function decryptSebKeyValue(packed: string): string | null {
  const parts = packed.split(":");
  if (parts.length !== 5) return null;
  const [version, keyId, ivHex, authTagHex, ciphertextHex] = parts;
  if (version !== FORMAT_VERSION) return null;

  let keyring: Keyring;
  try {
    keyring = loadKeyring();
  } catch {
    return null;
  }
  const key = keyring.get(keyId);
  if (!key) return null;

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, "hex")), decipher.final()]);
    const result = plaintext.toString("utf8");
    plaintext.fill(0);
    return result;
  } catch {
    return null;
  }
}
