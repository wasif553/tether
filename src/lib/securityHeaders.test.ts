/**
 * Route-Aware Security Headers + CSP v1 — unit tests. See
 * docs/security-headers-csp-v1.md. Pure/deterministic — no DB, no network,
 * no Next.js server required.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  validateLtiFrameAncestorOrigin,
  parseLtiFrameAncestors,
  buildFrameAncestorsDirective,
  buildContentSecurityPolicy,
  buildPermissionsPolicy,
  X_CONTENT_TYPE_OPTIONS,
  REFERRER_POLICY,
} from "./securityHeaders";

const originalVercelEnv = process.env.VERCEL_ENV;
const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = originalVercelEnv;
  if (originalNodeEnv === undefined) delete (process.env as Record<string, string | undefined>).NODE_ENV;
  else (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
});

describe("validateLtiFrameAncestorOrigin", () => {
  it("accepts an exact HTTPS origin", () => {
    expect(validateLtiFrameAncestorOrigin("https://canvas.example.edu")).toBe("https://canvas.example.edu");
  });

  it("normalizes a trailing slash to a bare origin", () => {
    expect(validateLtiFrameAncestorOrigin("https://canvas.example.edu/")).toBe("https://canvas.example.edu");
  });

  it("[6] rejects a wildcard", () => {
    expect(validateLtiFrameAncestorOrigin("*")).toBeNull();
  });

  it("[7] rejects an HTTP (non-HTTPS) origin", () => {
    expect(validateLtiFrameAncestorOrigin("http://canvas.example.edu")).toBeNull();
  });

  it("[5] rejects a javascript: pseudo-origin", () => {
    expect(validateLtiFrameAncestorOrigin("javascript:alert(1)")).toBeNull();
  });

  it("[5] rejects an origin with embedded credentials", () => {
    expect(validateLtiFrameAncestorOrigin("https://user:pass@canvas.example.edu")).toBeNull();
  });

  it("[5] rejects an origin with a non-root path", () => {
    expect(validateLtiFrameAncestorOrigin("https://canvas.example.edu/some/path")).toBeNull();
  });

  it("[5] rejects an origin with a query string", () => {
    expect(validateLtiFrameAncestorOrigin("https://canvas.example.edu?x=1")).toBeNull();
  });

  it("rejects a malformed, non-URL value without throwing", () => {
    expect(validateLtiFrameAncestorOrigin("not a url at all")).toBeNull();
  });

  it("rejects an empty string", () => {
    expect(validateLtiFrameAncestorOrigin("   ")).toBeNull();
  });

  it("accepts an exact origin with a non-default port", () => {
    expect(validateLtiFrameAncestorOrigin("https://canvas.example.edu:8443")).toBe("https://canvas.example.edu:8443");
  });

  // Security correction — wildcard subdomain rejection. URL() happily
  // parses "https://*.instructure.com" as well-formed with hostname
  // "*.instructure.com"; the original `hostname === "*"` check only
  // caught a bare wildcard host, letting a wildcard SUBDOMAIN slip
  // through validation despite the "exact HTTPS origins only" contract.
  describe("wildcard hostname rejection (security correction)", () => {
    it.each([
      "https://*.instructure.com",
      "https://*.example.edu",
      "https://canvas.*.example.edu",
      "https://foo*.example.edu",
      "https://*foo.example.edu",
    ])("rejects %s", (candidate) => {
      expect(validateLtiFrameAncestorOrigin(candidate)).toBeNull();
    });

    it("still accepts legitimate exact origins with no wildcard", () => {
      expect(validateLtiFrameAncestorOrigin("https://canvas.example.edu")).toBe("https://canvas.example.edu");
      expect(validateLtiFrameAncestorOrigin("https://canvas.example.edu:8443")).toBe("https://canvas.example.edu:8443");
    });

    it("still rejects everything the original rules covered (http, credentials, non-root path, query, fragment, javascript:, malformed)", () => {
      expect(validateLtiFrameAncestorOrigin("http://canvas.example.edu")).toBeNull();
      expect(validateLtiFrameAncestorOrigin("https://user:pass@canvas.example.edu")).toBeNull();
      expect(validateLtiFrameAncestorOrigin("https://canvas.example.edu/some/path")).toBeNull();
      expect(validateLtiFrameAncestorOrigin("https://canvas.example.edu?x=1")).toBeNull();
      expect(validateLtiFrameAncestorOrigin("https://canvas.example.edu#frag")).toBeNull();
      expect(validateLtiFrameAncestorOrigin("javascript:alert(1)")).toBeNull();
      expect(validateLtiFrameAncestorOrigin("not a url at all")).toBeNull();
    });
  });
});

describe("parseLtiFrameAncestors", () => {
  it("parses multiple whitespace-separated valid origins", () => {
    expect(parseLtiFrameAncestors("https://canvas.example.edu https://another.example.edu")).toEqual([
      "https://canvas.example.edu",
      "https://another.example.edu",
    ]);
  });

  it("drops invalid entries while keeping valid ones, never throwing", () => {
    expect(parseLtiFrameAncestors("https://canvas.example.edu * http://insecure.example.edu javascript:alert(1)")).toEqual([
      "https://canvas.example.edu",
    ]);
  });

  it("deduplicates identical origins", () => {
    expect(parseLtiFrameAncestors("https://canvas.example.edu https://canvas.example.edu")).toEqual(["https://canvas.example.edu"]);
  });

  it("returns an empty array for unset/empty input", () => {
    expect(parseLtiFrameAncestors(undefined)).toEqual([]);
    expect(parseLtiFrameAncestors("")).toEqual([]);
    expect(parseLtiFrameAncestors("   ")).toEqual([]);
  });

  it("security correction: drops a wildcard subdomain origin while keeping a legitimate exact one", () => {
    expect(parseLtiFrameAncestors("https://canvas.example.edu https://*.instructure.com")).toEqual(["https://canvas.example.edu"]);
  });

  it("security correction: the resulting frame-ancestors CSP directive never contains a wildcard", () => {
    const origins = parseLtiFrameAncestors("https://canvas.example.edu https://*.instructure.com");
    const csp = buildContentSecurityPolicy("LTI_EMBED_COMPATIBLE", origins);
    const frameAncestors = csp.split(";").find((d) => d.trim().startsWith("frame-ancestors"));
    expect(frameAncestors).toBeDefined();
    expect(frameAncestors).not.toContain("*");
    expect(frameAncestors?.trim()).toBe("frame-ancestors 'self' https://canvas.example.edu");
  });
});

describe("buildFrameAncestorsDirective", () => {
  it("[1] FRAME_DENIED is always exactly frame-ancestors 'none'", () => {
    expect(buildFrameAncestorsDirective("FRAME_DENIED", ["https://canvas.example.edu"])).toBe("frame-ancestors 'none'");
  });

  it("[3] LTI_EMBED_COMPATIBLE includes 'self' plus every validated trusted origin", () => {
    expect(buildFrameAncestorsDirective("LTI_EMBED_COMPATIBLE", ["https://canvas.example.edu"])).toBe(
      "frame-ancestors 'self' https://canvas.example.edu",
    );
  });

  it("LTI_EMBED_COMPATIBLE with no configured trusted origins is still 'self' only, never a wildcard", () => {
    expect(buildFrameAncestorsDirective("LTI_EMBED_COMPATIBLE", [])).toBe("frame-ancestors 'self'");
  });
});

describe("buildContentSecurityPolicy", () => {
  it("[2] FRAME_DENIED route CSP contains frame-ancestors 'none'", () => {
    expect(buildContentSecurityPolicy("FRAME_DENIED", [])).toContain("frame-ancestors 'none'");
  });

  it("[3] LTI-compatible route CSP contains the trusted exact Canvas origin in frame-ancestors", () => {
    const csp = buildContentSecurityPolicy("LTI_EMBED_COMPATIBLE", ["https://canvas.example.edu"]);
    expect(csp).toContain("frame-ancestors 'self' https://canvas.example.edu");
  });

  it("[8] never contains unsafe-eval, in any environment", () => {
    process.env.VERCEL_ENV = "production";
    expect(buildContentSecurityPolicy("FRAME_DENIED", [])).not.toContain("unsafe-eval");
    expect(buildContentSecurityPolicy("LTI_EMBED_COMPATIBLE", [])).not.toContain("unsafe-eval");
  });

  it("[9] does not contain a wildcard default-src, script-src, connect-src, or frame-ancestors", () => {
    const csp = buildContentSecurityPolicy("LTI_EMBED_COMPATIBLE", ["https://canvas.example.edu"]);
    expect(csp).not.toMatch(/default-src[^;]*\*/);
    expect(csp).not.toMatch(/script-src[^;]*\*/);
    expect(csp).not.toMatch(/connect-src[^;]*\*/);
    expect(csp).not.toMatch(/frame-ancestors[^;]*\*/);
  });

  it("does not add data: or unvalidated blob: to script-src", () => {
    const csp = buildContentSecurityPolicy("FRAME_DENIED", []);
    const scriptSrc = csp.split(";").find((d) => d.trim().startsWith("script-src"));
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).not.toContain("data:");
    expect(scriptSrc).not.toContain("blob:");
  });

  it("includes upgrade-insecure-requests only in Production (VERCEL_ENV=production)", () => {
    process.env.VERCEL_ENV = "production";
    expect(buildContentSecurityPolicy("FRAME_DENIED", [])).toContain("upgrade-insecure-requests");

    process.env.VERCEL_ENV = "preview";
    expect(buildContentSecurityPolicy("FRAME_DENIED", [])).not.toContain("upgrade-insecure-requests");

    delete process.env.VERCEL_ENV;
    (process.env as Record<string, string | undefined>).NODE_ENV = "development";
    expect(buildContentSecurityPolicy("FRAME_DENIED", [])).not.toContain("upgrade-insecure-requests");
  });
});

describe("buildPermissionsPolicy", () => {
  it("[12] public/default route denies camera and display-capture", () => {
    const policy = buildPermissionsPolicy("DEFAULT_DENY");
    expect(policy).toContain("camera=()");
    expect(policy).toContain("display-capture=()");
    expect(policy).toContain("microphone=()");
    expect(policy).toContain("geolocation=()");
  });

  it("[13] student exam route retains exactly the capabilities Tether's own exam capture code uses", () => {
    const policy = buildPermissionsPolicy("STUDENT_EXAM_CAPTURE");
    expect(policy).toContain("camera=(self)");
    expect(policy).toContain("display-capture=(self)");
    // Exam capture never requests microphone audio (getUserMedia is always
    // called with audio: false on this page) — must stay denied.
    expect(policy).toContain("microphone=()");
  });

  it("student system-check route allows exactly its own camera+microphone diagnostic, no display-capture", () => {
    const policy = buildPermissionsPolicy("STUDENT_SYSTEM_CHECK");
    expect(policy).toContain("camera=(self)");
    expect(policy).toContain("microphone=(self)");
    expect(policy).toContain("display-capture=()");
  });
});

describe("X-Content-Type-Options / Referrer-Policy constants", () => {
  it("[10] X-Content-Type-Options is nosniff", () => {
    expect(X_CONTENT_TYPE_OPTIONS).toBe("nosniff");
  });

  it("[11] Referrer-Policy is strict-origin-when-cross-origin", () => {
    expect(REFERRER_POLICY).toBe("strict-origin-when-cross-origin");
  });
});
