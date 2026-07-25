/**
 * Tether Secure Client Foundation v1 — Safe Exam Browser key encryption.
 * See docs/secure-client-foundation-seb-v1.md.
 *
 * Server-only (uses Node's `crypto`). Encrypts/decrypts the raw Browser
 * Exam Key / Config Key value that MUST be recoverable server-side to
 * compute the official SEB per-request hash (expectedHash =
 * SHA256(requestUrl + rawKey) — see sebBrowserExamKey.ts). AES-256-GCM
 * with a server-only secret (`SEB_KEY_ENCRYPTION_SECRET`) — never
 * committed, never logged, never returned in any API response. Falls
 * back to a random per-process secret exactly like
 * EXAM_BINDING_HMAC_SECRET/NETWORK_EVIDENCE_SALT elsewhere in this repo
 * (intentional for the pilot; set the real env var in production so
 * encrypted keys survive a restart/redeploy).
 */
import crypto from "crypto";

const _fallbackSecret = crypto.randomBytes(32);

function getEncryptionKey(): Buffer {
  const configured = process.env.SEB_KEY_ENCRYPTION_SECRET;
  if (configured) {
    // Accept either a 64-char hex string (32 bytes) or derive a 32-byte
    // key from whatever was provided via SHA-256 — never throws on a
    // differently-shaped secret.
    if (/^[0-9a-f]{64}$/i.test(configured)) return Buffer.from(configured, "hex");
    return crypto.createHash("sha256").update(configured).digest();
  }
  return _fallbackSecret;
}

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12;

/** Encrypts a raw key value. Output format: `<ivHex>:<authTagHex>:<ciphertextHex>` — safe to store in one text column. */
export function encryptSebKeyValue(rawValue: string): string {
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(rawValue, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

/** Decrypts a value produced by encryptSebKeyValue. Returns null on any malformed/tampered input rather than throwing. */
export function decryptSebKeyValue(packed: string): string | null {
  const parts = packed.split(":");
  if (parts.length !== 3) return null;
  const [ivHex, authTagHex, ciphertextHex] = parts;
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, getEncryptionKey(), Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, "hex")), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    return null;
  }
}
