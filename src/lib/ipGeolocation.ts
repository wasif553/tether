/**
 * IP geolocation for Academic Integrity Network Evidence v1.
 *
 * Default: GEOLOCATION_PROVIDER is unset or "none" — all geo fields
 * return null and locationAccuracy is "UNAVAILABLE". No IP address is
 * sent to any third party.
 *
 * To enable: set GEOLOCATION_PROVIDER=<name> in the environment. See
 * docs/network-evidence-and-ip-location.md for provider guidance and
 * the privacy obligations that come with enabling a provider.
 *
 * IMPORTANT — before enabling a provider in production:
 *   1. Review the provider's terms of service and data retention policy.
 *   2. Determine whether the provider must be listed as a privacy
 *      sub-processor under your institution's privacy framework.
 *   3. Ensure your student privacy notice names the provider or covers
 *      IP geolocation by a third party.
 *   4. Confirm the provider is approved by the institution.
 *
 * Supported providers:
 *   - none (default) — UNAVAILABLE, no external call
 *   - ipapi          — https://ipapi.co, free tier, no key required;
 *                      set GEOLOCATION_API_KEY for higher rate limits
 *
 * Safety contract:
 *   - Never throws. Returns UNAVAILABLE on any error or timeout.
 *   - Never logs the IP address.
 *   - Never called for private/null IPs.
 *   - Called only after the student has been authenticated and allowed
 *     to start/submit — never on rejected attempts.
 */

export type GeoResult = {
  country: string | null;
  region: string | null;
  city: string | null;
  timezone: string | null;
  locationAccuracy: "IP_APPROXIMATE" | "UNAVAILABLE";
  vpnOrProxySignal: boolean;
  metadata: Record<string, unknown>;
};

export const UNAVAILABLE_GEO: GeoResult = {
  country: null,
  region: null,
  city: null,
  timezone: null,
  locationAccuracy: "UNAVAILABLE",
  vpnOrProxySignal: false,
  metadata: { provider: "none" },
};

const DEFAULT_TIMEOUT_MS = 2000;

function getTimeoutMs(): number {
  const raw = process.env.GEOLOCATION_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

/**
 * Fetches a URL with an AbortController timeout. Returns null if the
 * request times out, throws a network error, or returns a non-2xx status.
 * Never includes the IP address in any log output.
 */
async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok ? res : null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

// ── ipapi.co provider ─────────────────────────────────────────────────────────

/**
 * Maps an ipapi.co JSON response to GeoResult. The API returns a plain
 * JSON object with named fields. All fields are optional in case the
 * free tier or partial responses omit them.
 */
function mapIpapiResponse(data: Record<string, unknown>): GeoResult {
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const bool = (v: unknown) => v === true;

  return {
    country: str(data.country_name),
    region: str(data.region),
    city: str(data.city),
    timezone: str(data.timezone),
    locationAccuracy: "IP_APPROXIMATE",
    // ipapi.co free tier does not return a VPN/proxy signal; only paid
    // plans include this. Treated as false unless explicitly provided.
    vpnOrProxySignal: bool(data.proxy) || bool(data.vpn),
    metadata: {
      provider: "ipapi",
      countryCode: str(data.country_code),
      org: str(data.org),
    },
  };
}

async function geolocateViaIpapi(ip: string): Promise<GeoResult> {
  const apiKey = process.env.GEOLOCATION_API_KEY;
  const timeoutMs = getTimeoutMs();

  // Build the URL. The key is appended as a query param when present.
  // Never include the IP in log output.
  const base = `https://ipapi.co/${ip}/json/`;
  const url = apiKey ? `${base}?key=${apiKey}` : base;

  const res = await fetchWithTimeout(url, timeoutMs);
  if (!res) return UNAVAILABLE_GEO;

  let data: Record<string, unknown>;
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    return UNAVAILABLE_GEO;
  }

  // ipapi.co returns { "error": true, "reason": "..." } for bad keys /
  // rate limits. Treat as UNAVAILABLE — never log the raw response.
  if (data.error) return UNAVAILABLE_GEO;

  return mapIpapiResponse(data);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Looks up approximate geographic information for an IP address.
 *
 * Returns UNAVAILABLE if:
 *   - ip is null
 *   - GEOLOCATION_PROVIDER is unset or "none"
 *   - the provider call times out or returns an error
 *
 * Never throws. Never logs the IP address.
 */
export async function geolocateIp(ip: string | null): Promise<GeoResult> {
  if (!ip) return UNAVAILABLE_GEO;

  const provider = (process.env.GEOLOCATION_PROVIDER ?? "none").toLowerCase().trim();

  if (provider === "none" || !provider) {
    return UNAVAILABLE_GEO;
  }

  if (provider === "ipapi") {
    try {
      return await geolocateViaIpapi(ip);
    } catch {
      return UNAVAILABLE_GEO;
    }
  }

  // Unknown provider — return UNAVAILABLE rather than crashing.
  return {
    ...UNAVAILABLE_GEO,
    metadata: { provider, error: "unknown provider — check GEOLOCATION_PROVIDER" },
  };
}
