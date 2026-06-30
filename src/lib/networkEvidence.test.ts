import { describe, it, expect } from "vitest";
import {
  getClientIpFromRequest,
  parseUserAgent,
  networkReviewSignal,
} from "./networkEvidence";

// ── getClientIpFromRequest ───────────────────────────────────────────────────

function makeReq(headers: Record<string, string>): Request {
  return new Request("https://example.com", { headers });
}

describe("getClientIpFromRequest", () => {
  it("returns cf-connecting-ip when present", () => {
    const req = makeReq({ "cf-connecting-ip": "1.2.3.4" });
    expect(getClientIpFromRequest(req)).toBe("1.2.3.4");
  });

  it("returns first public IP from x-forwarded-for", () => {
    const req = makeReq({ "x-forwarded-for": "203.0.113.1, 10.0.0.1" });
    expect(getClientIpFromRequest(req)).toBe("203.0.113.1");
  });

  it("skips private IPs in x-forwarded-for and returns first public one", () => {
    const req = makeReq({ "x-forwarded-for": "10.0.0.1, 192.168.1.1, 8.8.8.8" });
    expect(getClientIpFromRequest(req)).toBe("8.8.8.8");
  });

  it("returns x-real-ip when no x-forwarded-for", () => {
    const req = makeReq({ "x-real-ip": "5.6.7.8" });
    expect(getClientIpFromRequest(req)).toBe("5.6.7.8");
  });

  it("returns null when no usable IP header", () => {
    const req = makeReq({});
    expect(getClientIpFromRequest(req)).toBeNull();
  });

  it("returns null for private x-real-ip", () => {
    const req = makeReq({ "x-real-ip": "192.168.1.1" });
    expect(getClientIpFromRequest(req)).toBeNull();
  });

  it("prefers cf-connecting-ip over x-forwarded-for", () => {
    const req = makeReq({
      "cf-connecting-ip": "1.1.1.1",
      "x-forwarded-for": "2.2.2.2",
    });
    expect(getClientIpFromRequest(req)).toBe("1.1.1.1");
  });
});

// ── parseUserAgent ────────────────────────────────────────────────────────────

describe("parseUserAgent", () => {
  it("detects Chrome on Windows desktop", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    const result = parseUserAgent(ua);
    expect(result.browserName).toBe("Chrome");
    expect(result.osName).toBe("Windows");
    expect(result.deviceType).toBe("desktop");
  });

  it("detects Firefox on Linux", () => {
    const ua = "Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/119.0";
    const result = parseUserAgent(ua);
    expect(result.browserName).toBe("Firefox");
    expect(result.osName).toBe("Linux");
    expect(result.deviceType).toBe("desktop");
  });

  it("detects Safari on iOS mobile", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    const result = parseUserAgent(ua);
    expect(result.browserName).toBe("Safari");
    expect(result.osName).toBe("iOS");
    expect(result.deviceType).toBe("mobile");
  });

  it("detects Edge", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";
    const result = parseUserAgent(ua);
    expect(result.browserName).toBe("Edge");
  });

  it("detects SES Lockdown Browser", () => {
    const ua = "SESLockdown/1.0 Windows";
    const result = parseUserAgent(ua);
    expect(result.browserName).toBe("SES Lockdown Browser");
  });

  it("returns nulls for empty UA", () => {
    const result = parseUserAgent(null);
    expect(result.browserName).toBeNull();
    expect(result.osName).toBeNull();
    expect(result.deviceType).toBeNull();
  });
});

// ── networkReviewSignal ───────────────────────────────────────────────────────

describe("networkReviewSignal", () => {
  const makeStart = (country: string | null, ip: string | null) => ({ country, ipAddress: ip });
  const makeSubmit = (country: string | null, ip: string | null, networkChanged: boolean) => ({
    country,
    ipAddress: ip,
    networkChanged,
  });

  it("returns Normal when both null", () => {
    expect(networkReviewSignal(null, null)).toBe("Normal");
  });

  it("returns Normal when same country and no network change", () => {
    expect(
      networkReviewSignal(
        makeStart("AU", "1.2.3.4"),
        makeSubmit("AU", "1.2.3.4", false),
      ),
    ).toBe("Normal");
  });

  it("returns Needs review when IP changed", () => {
    expect(
      networkReviewSignal(
        makeStart("AU", "1.2.3.4"),
        makeSubmit("AU", "5.6.7.8", true),
      ),
    ).toBe("Needs review");
  });

  it("returns High review signal when country differs", () => {
    expect(
      networkReviewSignal(
        makeStart("AU", "1.2.3.4"),
        makeSubmit("US", "5.6.7.8", false),
      ),
    ).toBe("High review signal");
  });

  it("country difference takes precedence over networkChanged", () => {
    expect(
      networkReviewSignal(
        makeStart("AU", "1.2.3.4"),
        makeSubmit("US", "5.6.7.8", true),
      ),
    ).toBe("High review signal");
  });
});
