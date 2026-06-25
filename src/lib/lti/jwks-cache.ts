import type { JWK } from "jose";

const CACHE_TTL_MS = 60 * 60 * 1000;

type CacheEntry = {
  keys: JWK[];
  expiresAt: number;
};

const jwksCache = new Map<string, CacheEntry>();

async function fetchJwks(jwksUrl: string): Promise<JWK[]> {
  const res = await fetch(jwksUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch JWKS from ${jwksUrl}: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { keys?: JWK[] };
  if (!Array.isArray(body.keys)) {
    throw new Error(`JWKS response from ${jwksUrl} did not contain a keys array`);
  }
  return body.keys;
}

export async function getPlatformJwks(jwksUrl: string): Promise<JWK[]> {
  const cached = jwksCache.get(jwksUrl);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.keys;
  }

  const keys = await fetchJwks(jwksUrl);
  jwksCache.set(jwksUrl, { keys, expiresAt: Date.now() + CACHE_TTL_MS });
  return keys;
}

export async function findPlatformJwk(jwksUrl: string, kid: string | undefined): Promise<JWK | undefined> {
  const keys = await getPlatformJwks(jwksUrl);
  if (!kid) return undefined;
  return keys.find((key) => key.kid === kid);
}

export function clearJwksCache(): void {
  jwksCache.clear();
}
