import { describe, it, expect } from "vitest";
import { normaliseOrigin, buildOriginAllowlist, resolveCanonicalOrigin, candidateOriginFromHeaders } from "./canonicalOrigin";

describe("normaliseOrigin", () => {
  it("strips path/query/trailing slash, keeping scheme + host only", () => {
    expect(normaliseOrigin("https://example.test/some/path?x=1")).toBe("https://example.test");
  });
  it("falls back to a trimmed string for an unparseable value", () => {
    expect(normaliseOrigin("not a url///")).toBe("not a url");
  });
});

describe("buildOriginAllowlist", () => {
  it("includes the app URL and de-duplicates extras", () => {
    const list = buildOriginAllowlist("https://tether-murex.vercel.app", ["https://tether-murex.vercel.app/", "https://staging.test"]);
    expect(list).toEqual(["https://tether-murex.vercel.app", "https://staging.test"]);
  });
  it("filters out undefined/empty entries", () => {
    expect(buildOriginAllowlist(undefined, [])).toEqual([]);
  });
});

describe("resolveCanonicalOrigin", () => {
  const allowlist = ["https://tether-murex.vercel.app", "https://staging.test"];

  it("throws when no origin is configured at all — never silently proceeds unconfigured", () => {
    expect(() => resolveCanonicalOrigin("https://tether-murex.vercel.app", [])).toThrow();
  });

  it("accepts a candidate that exactly matches the allowlist", () => {
    expect(resolveCanonicalOrigin("https://staging.test", allowlist)).toBe("https://staging.test");
  });

  it("falls back to the primary allowlisted origin for an unrecognised candidate", () => {
    expect(resolveCanonicalOrigin("https://attacker.test", allowlist)).toBe(allowlist[0]);
  });

  it("falls back to the primary allowlisted origin when no candidate is given", () => {
    expect(resolveCanonicalOrigin(null, allowlist)).toBe(allowlist[0]);
  });
});

describe("candidateOriginFromHeaders", () => {
  function headersFrom(map: Record<string, string>) {
    return { get: (name: string) => map[name.toLowerCase()] ?? null };
  }

  it("prefers x-forwarded-host/proto (Vercel proxy) over a plain Host header", () => {
    const headers = headersFrom({ "x-forwarded-host": "tether-murex.vercel.app", "x-forwarded-proto": "https", host: "internal-host" });
    expect(candidateOriginFromHeaders(headers)).toBe("https://tether-murex.vercel.app");
  });

  it("falls back to a plain Host header (local dev) when no forwarded headers exist", () => {
    const headers = headersFrom({ host: "localhost:3001" });
    expect(candidateOriginFromHeaders(headers)).toBe("https://localhost:3001");
  });

  it("returns null when no relevant header is present at all", () => {
    expect(candidateOriginFromHeaders(headersFrom({}))).toBeNull();
  });

  it("takes only the first value from a comma-separated forwarded header", () => {
    const headers = headersFrom({ "x-forwarded-host": "a.test, b.test", "x-forwarded-proto": "https, http" });
    expect(candidateOriginFromHeaders(headers)).toBe("https://a.test");
  });
});
