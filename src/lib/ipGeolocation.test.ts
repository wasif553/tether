/**
 * Tests for IP geolocation provider logic. No internet access required —
 * all provider calls are exercised via mocked fetch.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

// Restore env and fetch mocks after each test.
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.GEOLOCATION_PROVIDER;
  delete process.env.GEOLOCATION_API_KEY;
  delete process.env.GEOLOCATION_TIMEOUT_MS;
});

// ── default / none provider ───────────────────────────────────────────────────

describe("geolocateIp — default provider", () => {
  it("returns UNAVAILABLE when GEOLOCATION_PROVIDER is unset", async () => {
    delete process.env.GEOLOCATION_PROVIDER;
    const { geolocateIp } = await import("./ipGeolocation");
    const result = await geolocateIp("203.0.113.1");
    expect(result.locationAccuracy).toBe("UNAVAILABLE");
    expect(result.country).toBeNull();
    expect(result.metadata.provider).toBe("none");
  });

  it("returns UNAVAILABLE when GEOLOCATION_PROVIDER=none", async () => {
    process.env.GEOLOCATION_PROVIDER = "none";
    const { geolocateIp } = await import("./ipGeolocation");
    const result = await geolocateIp("203.0.113.1");
    expect(result.locationAccuracy).toBe("UNAVAILABLE");
  });

  it("returns UNAVAILABLE for null IP regardless of provider", async () => {
    process.env.GEOLOCATION_PROVIDER = "ipapi";
    const fetchSpy = vi.spyOn(global, "fetch");
    const { geolocateIp } = await import("./ipGeolocation");
    const result = await geolocateIp(null);
    expect(result.locationAccuracy).toBe("UNAVAILABLE");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── ipapi provider ────────────────────────────────────────────────────────────

const MOCK_IPAPI_RESPONSE = {
  country_name: "Australia",
  country_code: "AU",
  region: "Queensland",
  city: "Brisbane",
  timezone: "Australia/Brisbane",
  org: "AS1234 Example ISP",
  proxy: false,
  vpn: false,
};

function mockFetchSuccess(body: object) {
  vi.spyOn(global, "fetch").mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status: 200 }),
  );
}

function mockFetchError() {
  vi.spyOn(global, "fetch").mockRejectedValueOnce(new Error("network error"));
}

function mockFetchTimeout() {
  vi.spyOn(global, "fetch").mockImplementationOnce(
    (_url, init) =>
      new Promise((_res, rej) => {
        // Simulate abort signal firing immediately.
        const signal = (init as RequestInit)?.signal;
        if (signal) {
          signal.addEventListener("abort", () =>
            rej(new DOMException("aborted", "AbortError")),
          );
        }
      }),
  );
}

describe("geolocateIp — ipapi provider", () => {
  it("maps country/region/city from ipapi response", async () => {
    process.env.GEOLOCATION_PROVIDER = "ipapi";
    process.env.GEOLOCATION_TIMEOUT_MS = "2000";
    mockFetchSuccess(MOCK_IPAPI_RESPONSE);

    const { geolocateIp } = await import("./ipGeolocation");
    const result = await geolocateIp("203.0.113.1");

    expect(result.country).toBe("Australia");
    expect(result.region).toBe("Queensland");
    expect(result.city).toBe("Brisbane");
    expect(result.timezone).toBe("Australia/Brisbane");
    expect(result.locationAccuracy).toBe("IP_APPROXIMATE");
    expect(result.vpnOrProxySignal).toBe(false);
    expect(result.metadata.provider).toBe("ipapi");
    expect(result.metadata.countryCode).toBe("AU");
  });

  it("sets vpnOrProxySignal=true when proxy flag is set", async () => {
    process.env.GEOLOCATION_PROVIDER = "ipapi";
    mockFetchSuccess({ ...MOCK_IPAPI_RESPONSE, proxy: true });

    const { geolocateIp } = await import("./ipGeolocation");
    const result = await geolocateIp("203.0.113.1");
    expect(result.vpnOrProxySignal).toBe(true);
  });

  it("appends API key to URL when GEOLOCATION_API_KEY is set", async () => {
    process.env.GEOLOCATION_PROVIDER = "ipapi";
    process.env.GEOLOCATION_API_KEY = "test-api-key-123";
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(MOCK_IPAPI_RESPONSE), { status: 200 }),
    );

    const { geolocateIp } = await import("./ipGeolocation");
    await geolocateIp("203.0.113.1");

    const calledUrl = String(fetchSpy.mock.calls[0][0]);
    expect(calledUrl).toContain("key=test-api-key-123");
  });

  it("returns UNAVAILABLE when provider returns HTTP error", async () => {
    process.env.GEOLOCATION_PROVIDER = "ipapi";
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response("Too Many Requests", { status: 429 }),
    );

    const { geolocateIp } = await import("./ipGeolocation");
    const result = await geolocateIp("203.0.113.1");
    expect(result.locationAccuracy).toBe("UNAVAILABLE");
  });

  it("returns UNAVAILABLE when provider returns error JSON", async () => {
    process.env.GEOLOCATION_PROVIDER = "ipapi";
    mockFetchSuccess({ error: true, reason: "Rate limit reached." });

    const { geolocateIp } = await import("./ipGeolocation");
    const result = await geolocateIp("203.0.113.1");
    expect(result.locationAccuracy).toBe("UNAVAILABLE");
  });

  it("returns UNAVAILABLE on network error", async () => {
    process.env.GEOLOCATION_PROVIDER = "ipapi";
    mockFetchError();

    const { geolocateIp } = await import("./ipGeolocation");
    const result = await geolocateIp("203.0.113.1");
    expect(result.locationAccuracy).toBe("UNAVAILABLE");
  });

  it("returns UNAVAILABLE on timeout", async () => {
    process.env.GEOLOCATION_PROVIDER = "ipapi";
    process.env.GEOLOCATION_TIMEOUT_MS = "1"; // 1ms — will abort immediately
    mockFetchTimeout();

    const { geolocateIp } = await import("./ipGeolocation");
    const result = await geolocateIp("203.0.113.1");
    expect(result.locationAccuracy).toBe("UNAVAILABLE");
  });

  it("does not include API key in any thrown error", async () => {
    process.env.GEOLOCATION_PROVIDER = "ipapi";
    process.env.GEOLOCATION_API_KEY = "secret-key-abc";
    mockFetchError();

    const { geolocateIp } = await import("./ipGeolocation");
    // Should resolve (not throw) with UNAVAILABLE.
    const result = await geolocateIp("203.0.113.1");
    expect(result.locationAccuracy).toBe("UNAVAILABLE");
    // The result must not contain the key.
    expect(JSON.stringify(result)).not.toContain("secret-key-abc");
  });
});

// ── unknown provider ──────────────────────────────────────────────────────────

describe("geolocateIp — unknown provider", () => {
  it("returns UNAVAILABLE with provider error note", async () => {
    process.env.GEOLOCATION_PROVIDER = "unknownprovider";
    const { geolocateIp } = await import("./ipGeolocation");
    const result = await geolocateIp("203.0.113.1");
    expect(result.locationAccuracy).toBe("UNAVAILABLE");
    expect(String(result.metadata.error)).toContain("unknown provider");
  });
});
