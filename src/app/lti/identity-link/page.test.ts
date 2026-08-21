/**
 * Route-Aware Security Headers P1 — security corrections. See
 * docs/security-headers-csp-v1.md, "Identity-link escape test".
 *
 * /login is deliberately frame-denied (CSP frame-ancestors 'none' +
 * X-Frame-Options: DENY). When /lti/identity-link is reached from an
 * embedded Canvas LTI launch and the visitor isn't signed in, the "Sign
 * in to Tether" link must escape the iframe (target="_top") rather than
 * navigate in-frame (which the frame-denied /login would refuse to
 * render) — and must never weaken /login's own framing policy to make
 * that work.
 *
 * This repo has no DOM/testing-library dependency, and the page component
 * itself calls React hooks (useSearchParams, useSession) that can't be
 * invoked directly outside a real render. Two proofs instead, neither
 * requiring a rendering harness:
 *   1. buildIdentityLinkSignInHref (extracted, pure, hook-free) proves the
 *      callbackUrl/handoff construction is unchanged.
 *   2. A source-level assertion proves the JSX literally carries
 *      target="_top" on the same anchor that uses that href — the
 *      attribute is a static literal, not conditionally computed, so
 *      reading the source is a precise, honest proof of what ships.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildIdentityLinkSignInHref } from "./page";
import { isSafeLtiIdentityLinkCallbackUrl } from "@/lib/safeCallbackUrl";

describe("buildIdentityLinkSignInHref", () => {
  it("preserves the exact handoff in the returnTo path", () => {
    const { returnTo } = buildIdentityLinkSignInHref("abc.def.ghi");
    expect(returnTo).toBe("/lti/identity-link?handoff=abc.def.ghi");
  });

  it("builds a /login href carrying the encoded returnTo as callbackUrl", () => {
    const { returnTo, loginHref } = buildIdentityLinkSignInHref("abc.def.ghi");
    expect(loginHref).toBe(`/login?callbackUrl=${encodeURIComponent(returnTo)}`);
  });

  it("the produced returnTo passes the existing safe-callback-url guard unchanged", () => {
    const { returnTo } = buildIdentityLinkSignInHref("abc.def.ghi");
    expect(isSafeLtiIdentityLinkCallbackUrl(returnTo)).toBe(true);
  });

  it("URL-encodes a handoff containing characters that would otherwise break the query string", () => {
    const { returnTo } = buildIdentityLinkSignInHref("a.b.c&evil=1");
    expect(returnTo).toBe("/lti/identity-link?handoff=a.b.c%26evil%3D1");
    expect(isSafeLtiIdentityLinkCallbackUrl(returnTo)).toBe(true);
  });
});

describe("identity-link 'Sign in to Tether' anchor escapes the LTI iframe", () => {
  const source = readFileSync(path.join(__dirname, "page.tsx"), "utf-8");

  it("the anchor using loginHref carries target=\"_top\"", () => {
    const anchorMatch = source.match(/<a\s+href=\{loginHref\}[\s\S]*?<\/a>/);
    expect(anchorMatch).not.toBeNull();
    const anchorSource = anchorMatch![0];
    expect(anchorSource).toContain('target="_top"');
    expect(anchorSource).toContain("Sign in to Tether");
  });

  it("navigation is never triggered automatically — no window.top.location assignment anywhere in the page", () => {
    expect(source).not.toMatch(/window\.top\.location\s*=/);
  });

  it("the login href is still built from buildIdentityLinkSignInHref, not a hardcoded/altered path", () => {
    expect(source).toContain("buildIdentityLinkSignInHref(handoff)");
  });
});
