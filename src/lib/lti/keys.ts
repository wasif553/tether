import { importPKCS8, importSPKI } from "jose";

export const LTI_SIGNING_ALG = "RS256";
export const LTI_KEY_ID = "ses-key-1";

function normalizePem(value: string): string {
  return value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;
}

function readEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return normalizePem(value);
}

let cachedPrivateKey: CryptoKey | undefined;
let cachedPublicKey: CryptoKey | undefined;

export async function getPrivateKey(): Promise<CryptoKey> {
  if (cachedPrivateKey) return cachedPrivateKey;
  const pem = readEnv("LTI_PRIVATE_KEY");
  cachedPrivateKey = await importPKCS8(pem, LTI_SIGNING_ALG);
  return cachedPrivateKey;
}

export async function getPublicKey(): Promise<CryptoKey> {
  if (cachedPublicKey) return cachedPublicKey;
  const pem = readEnv("LTI_PUBLIC_KEY");
  cachedPublicKey = await importSPKI(pem, LTI_SIGNING_ALG);
  return cachedPublicKey;
}
