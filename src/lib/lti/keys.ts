import { readFileSync } from "node:fs";
import { importPKCS8, importSPKI } from "jose";

export const LTI_SIGNING_ALG = "RS256";
export const LTI_KEY_ID = "ses-key-1";

function normalizePem(value: string): string {
  return value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;
}

function looksLikePem(value: string): boolean {
  return value.includes("-----BEGIN");
}

/**
 * Resolves an LTI signing key from one of three sources, in priority
 * order: a base64-encoded env var (preferred on Vercel — avoids newline
 * mangling in dashboard env var UIs), a local file path (local dev only),
 * or a raw multiline PEM env var (legacy/local fallback). Only the first
 * source present is used.
 */
function readKey(rawEnvName: string, b64EnvName: string, pathEnvName: string): string {
  const b64 = process.env[b64EnvName];
  if (b64) {
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    if (!looksLikePem(decoded)) {
      throw new Error(`${b64EnvName} did not decode to a valid PEM key`);
    }
    return decoded;
  }

  const path = process.env[pathEnvName];
  if (path) {
    return readFileSync(path, "utf8");
  }

  const raw = process.env[rawEnvName];
  if (raw) {
    return normalizePem(raw);
  }

  throw new Error(
    `Missing LTI key: set one of ${b64EnvName}, ${pathEnvName}, or ${rawEnvName}`,
  );
}

let cachedPrivateKey: CryptoKey | undefined;
let cachedPublicKey: CryptoKey | undefined;

export async function getPrivateKey(): Promise<CryptoKey> {
  if (cachedPrivateKey) return cachedPrivateKey;
  const pem = readKey("LTI_PRIVATE_KEY", "LTI_PRIVATE_KEY_B64", "LTI_PRIVATE_KEY_PATH");
  cachedPrivateKey = await importPKCS8(pem, LTI_SIGNING_ALG);
  return cachedPrivateKey;
}

export async function getPublicKey(): Promise<CryptoKey> {
  if (cachedPublicKey) return cachedPublicKey;
  const pem = readKey("LTI_PUBLIC_KEY", "LTI_PUBLIC_KEY_B64", "LTI_PUBLIC_KEY_PATH");
  cachedPublicKey = await importSPKI(pem, LTI_SIGNING_ALG);
  return cachedPublicKey;
}
