import type { NextConfig } from "next";
import { buildContentSecurityPolicy, buildPermissionsPolicy, X_CONTENT_TYPE_OPTIONS, REFERRER_POLICY } from "./src/lib/securityHeaders";

// Route-Aware Security Headers + CSP v1 — see docs/security-headers-csp-v1.md
// and src/lib/securityHeaders.ts (the single source of truth for CSP/
// Permissions-Policy content; this file only wires route `source` patterns
// to that module's output). Evaluated at build time (once per Vercel
// deployment, which is exactly when VERCEL_ENV is correct for that
// deployment target — see deploymentEnvironment() in
// src/lib/secureClientAvailability.ts).
//
// Ordering matters: Next.js merges headers() rules by source-pattern match,
// and when two rules match the same request path and set the SAME header
// key, the LATER rule's value wins for that key (a header key a later,
// more specific rule does NOT mention is left as whatever the earlier,
// broader rule set). Rules below are ordered broad -> specific so that:
//   1. every route starts FRAME_DENIED (CSP frame-ancestors 'none',
//      Permissions-Policy deny-all, nosniff, referrer-policy) — the safe
//      default for anything not explicitly reclassified below;
//   2. the LTI-compatible route families (/lecturer/**, /student/**,
//      /lti/**) override ONLY the CSP header, to frame-ancestors 'self'
//      plus validated LTI_FRAME_ANCESTORS origins — and critically never
//      receive X-Frame-Options at all (see step 5's dedicated sources
//      below, which never overlap these three prefixes);
//   3. the two genuine student capture routes override ONLY
//      Permissions-Policy, to allow exactly the capability their own
//      browser code requests;
//   4. X-Frame-Options: DENY is applied last, opt-in, only to the specific
//      non-LTI-sensitive HTML pages named in the spec — never as a
//      blanket catch-all, so it can never leak onto an LTI-compatible path.
async function headers(): Promise<NonNullable<Awaited<ReturnType<NonNullable<NextConfig["headers"]>>>>> {
  const baseSecurityHeaders = [
    { key: "X-Content-Type-Options", value: X_CONTENT_TYPE_OPTIONS },
    { key: "Referrer-Policy", value: REFERRER_POLICY },
  ];

  return [
    // 1. Global default: FRAME_DENIED CSP + deny-all Permissions-Policy.
    {
      source: "/:path*",
      headers: [
        ...baseSecurityHeaders,
        { key: "Content-Security-Policy", value: buildContentSecurityPolicy("FRAME_DENIED") },
        { key: "Permissions-Policy", value: buildPermissionsPolicy("DEFAULT_DENY") },
      ],
    },
    // 2. LTI-compatible route families — CSP override only (frame-ancestors
    //    'self' <trusted LTI origins>). Deliberately no X-Frame-Options.
    {
      source: "/lecturer/:path*",
      headers: [{ key: "Content-Security-Policy", value: buildContentSecurityPolicy("LTI_EMBED_COMPATIBLE") }],
    },
    {
      source: "/student/:path*",
      headers: [{ key: "Content-Security-Policy", value: buildContentSecurityPolicy("LTI_EMBED_COMPATIBLE") }],
    },
    {
      source: "/lti/:path*",
      headers: [{ key: "Content-Security-Policy", value: buildContentSecurityPolicy("LTI_EMBED_COMPATIBLE") }],
    },
    // 3. Student capture routes — Permissions-Policy override only.
    {
      source: "/student/exams/:path*",
      headers: [{ key: "Permissions-Policy", value: buildPermissionsPolicy("STUDENT_EXAM_CAPTURE") }],
    },
    {
      source: "/student/system-check",
      headers: [{ key: "Permissions-Policy", value: buildPermissionsPolicy("STUDENT_SYSTEM_CHECK") }],
    },
    // 4. Explicit, opt-in X-Frame-Options for known non-LTI-sensitive HTML
    //    pages only — never a catch-all (see comment above).
    {
      source: "/",
      headers: [{ key: "X-Frame-Options", value: "DENY" }],
    },
    {
      source: "/login",
      headers: [{ key: "X-Frame-Options", value: "DENY" }],
    },
    {
      source: "/forgot-password",
      headers: [{ key: "X-Frame-Options", value: "DENY" }],
    },
    {
      source: "/reset-password",
      headers: [{ key: "X-Frame-Options", value: "DENY" }],
    },
    {
      source: "/signup",
      headers: [{ key: "X-Frame-Options", value: "DENY" }],
    },
    {
      source: "/platform/:path*",
      headers: [{ key: "X-Frame-Options", value: "DENY" }],
    },
    {
      source: "/pilot",
      headers: [{ key: "X-Frame-Options", value: "DENY" }],
    },
    {
      source: "/lockdown-browser",
      headers: [{ key: "X-Frame-Options", value: "DENY" }],
    },
    {
      source: "/privacy/:path*",
      headers: [{ key: "X-Frame-Options", value: "DENY" }],
    },
  ];
}

const nextConfig: NextConfig = {
  headers,
};

export default nextConfig;
