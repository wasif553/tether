/**
 * Route-Aware Security Headers + CSP v1 — tests the ACTUAL next.config.ts
 * headers() rule wiring (not just the pure string-builders in
 * src/lib/securityHeaders.ts), so a route-classification mistake in
 * next.config.ts itself (e.g. an X-Frame-Options rule accidentally
 * matching an LTI-compatible path) would fail here even if
 * securityHeaders.test.ts still passed. See docs/security-headers-csp-v1.md.
 */
import { describe, expect, it } from "vitest";
import nextConfig from "./next.config";

type HeaderRule = { source: string; headers: { key: string; value: string }[] };

async function getRules(): Promise<HeaderRule[]> {
  const rules = await nextConfig.headers!();
  return rules as unknown as HeaderRule[];
}

function headerValue(rules: HeaderRule[], source: string, key: string): string | undefined {
  for (const rule of rules) {
    if (rule.source !== source) continue;
    const match = rule.headers.find((h) => h.key === key);
    if (match) return match.value;
  }
  return undefined;
}

function anyRuleSetsHeader(rules: HeaderRule[], source: string, key: string): boolean {
  return rules.some((rule) => rule.source === source && rule.headers.some((h) => h.key === key));
}

describe("next.config.ts headers() route wiring", () => {
  it("[1][2] FRAME_DENIED route (/login): a rule sets frame-ancestors 'none' and a rule sets X-Frame-Options DENY", async () => {
    const rules = await getRules();
    // The catch-all /:path* rule is the one that actually carries CSP for
    // "/login" (no more specific CSP override exists for it) — assert on
    // that rule directly, exactly as Next.js would apply it.
    const csp = headerValue(rules, "/:path*", "Content-Security-Policy");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(headerValue(rules, "/login", "X-Frame-Options")).toBe("DENY");
  });

  it("[3][4] LTI-compatible route (/lecturer/:path*): CSP overrides frame-ancestors to 'self' + trusted origins, and no rule sets X-Frame-Options for it", async () => {
    const rules = await getRules();
    const csp = headerValue(rules, "/lecturer/:path*", "Content-Security-Policy");
    expect(csp).toBeDefined();
    expect(csp).toMatch(/frame-ancestors 'self'/);
    expect(anyRuleSetsHeader(rules, "/lecturer/:path*", "X-Frame-Options")).toBe(false);
    expect(anyRuleSetsHeader(rules, "/student/:path*", "X-Frame-Options")).toBe(false);
    expect(anyRuleSetsHeader(rules, "/lti/:path*", "X-Frame-Options")).toBe(false);
  });

  it("every X-Frame-Options rule source is a known non-LTI-sensitive page, never overlapping /lecturer, /student, or /lti", async () => {
    const rules = await getRules();
    const xfoSources = rules.filter((r) => r.headers.some((h) => h.key === "X-Frame-Options")).map((r) => r.source);
    for (const source of xfoSources) {
      expect(source.startsWith("/lecturer")).toBe(false);
      expect(source.startsWith("/student")).toBe(false);
      expect(source.startsWith("/lti")).toBe(false);
    }
  });

  it("student exam route Permissions-Policy override allows camera+display-capture, denies microphone", async () => {
    const rules = await getRules();
    const policy = headerValue(rules, "/student/exams/:path*", "Permissions-Policy");
    expect(policy).toContain("camera=(self)");
    expect(policy).toContain("display-capture=(self)");
    expect(policy).toContain("microphone=()");
  });

  it("global default rule sets X-Content-Type-Options nosniff and Referrer-Policy strict-origin-when-cross-origin", async () => {
    const rules = await getRules();
    expect(headerValue(rules, "/:path*", "X-Content-Type-Options")).toBe("nosniff");
    expect(headerValue(rules, "/:path*", "Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("no rule ever sets Access-Control-Allow-Origin (Tether app code adds no CORS headers)", async () => {
    const rules = await getRules();
    expect(anyRuleSetsHeader(rules, "/:path*", "Access-Control-Allow-Origin")).toBe(false);
    for (const rule of rules) {
      expect(rule.headers.some((h) => h.key.toLowerCase() === "access-control-allow-origin")).toBe(false);
    }
  });
});
