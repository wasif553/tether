/**
 * IP geolocation stub for Academic Integrity Network Evidence v1. In
 * v1 no external provider is configured by default — all fields return
 * null and locationAccuracy returns "UNAVAILABLE". This keeps the
 * feature functional (exam start/submit still capture IP and UA) without
 * requiring a paid or rate-limited API.
 *
 * To add a provider, set GEOLOCATION_PROVIDER=<name> in the environment
 * and implement its branch below. The provider must return the same
 * GeoResult shape. It must never throw — return the UNAVAILABLE result
 * instead of propagating errors, so exam flow is never broken.
 *
 * See docs/network-evidence-and-ip-location.md for provider guidance.
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

const UNAVAILABLE: GeoResult = {
  country: null,
  region: null,
  city: null,
  timezone: null,
  locationAccuracy: "UNAVAILABLE",
  vpnOrProxySignal: false,
  metadata: { provider: "none" },
};

/**
 * Looks up approximate geographic information for an IP address.
 * Returns UNAVAILABLE if no provider is configured, the IP is null, or
 * the provider call fails. Never throws.
 */
export async function geolocateIp(ip: string | null): Promise<GeoResult> {
  if (!ip) return UNAVAILABLE;

  const provider = process.env.GEOLOCATION_PROVIDER;

  if (!provider || provider === "none") {
    return UNAVAILABLE;
  }

  // Future providers: add branches here keyed on GEOLOCATION_PROVIDER.
  // Each branch must catch its own errors and return UNAVAILABLE on failure.
  // Example structure (not implemented):
  //
  // if (provider === "ipapi") {
  //   try {
  //     const res = await fetch(`https://ipapi.co/${ip}/json/`);
  //     const data = await res.json();
  //     return {
  //       country: data.country_name ?? null,
  //       region: data.region ?? null,
  //       city: data.city ?? null,
  //       timezone: data.timezone ?? null,
  //       locationAccuracy: "IP_APPROXIMATE",
  //       vpnOrProxySignal: false,
  //       metadata: { provider: "ipapi" },
  //     };
  //   } catch {
  //     return UNAVAILABLE;
  //   }
  // }

  return UNAVAILABLE;
}
