/**
 * Route-Aware Security Headers + CSP v1. See docs/security-headers-csp-v1.md.
 *
 * Deterministic, pure, dependency-free (besides deploymentEnvironment()) —
 * safe to call at Next.js config-build time (see next.config.ts) and from
 * tests. Nothing here reads a request; LTI trusted-frame origins come from
 * LTI_FRAME_ANCESTORS (server env, validated below), never from a request
 * Origin/Referer header — a request cannot make itself a trusted frame
 * ancestor.
 *
 * Route classification (see docs/security-headers-csp-v1.md, "Route frame
 * classification", derived by reading src/app/api/lti/launch/route.ts):
 * the LTI launch flow redirects into /lecturer/**, /student/**, and
 * /lti/** (identity-link handoff, not-linked) ONLY — every other page
 * (marketing home, login, password reset, platform-admin console, etc.)
 * is never a legitimate LTI iframe destination and is denied framing
 * entirely.
 */
// Relative import deliberately, not the usual "@/lib/..." alias — this
// module is required from next.config.ts, and Next.js's next.config.ts
// TypeScript transpiler does not resolve tsconfig path aliases for
// modules a config file imports transitively (only next.config.ts itself
// is alias-aware); a relative import here works everywhere (Next config
// loading, the app's own webpack/turbopack build, and Vitest) without
// relying on that unsupported resolution path.
import { deploymentEnvironment } from "./secureClientAvailability";

export type FrameRouteClass = "FRAME_DENIED" | "LTI_EMBED_COMPATIBLE";

export type PermissionsPolicyClass = "DEFAULT_DENY" | "STUDENT_EXAM_CAPTURE" | "STUDENT_SYSTEM_CHECK";

// ---------------------------------------------------------------------------
// LTI trusted frame-ancestor origins
// ---------------------------------------------------------------------------

/**
 * Validates one candidate frame-ancestor origin from LTI_FRAME_ANCESTORS.
 * Deliberately strict — an origin, not a URL: exact scheme+host(+port),
 * https only, no path/query/fragment/userinfo, no wildcard. Returns null
 * (never throws) for anything that doesn't qualify, so a single malformed
 * entry in a multi-value config can never crash header generation — it is
 * simply dropped.
 */
export function validateLtiFrameAncestorOrigin(candidate: string): string | null {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) return null;
  if (trimmed === "*") return null;
  // Reject before attempting to parse — URL() is lenient about some of
  // these (e.g. it will happily parse "javascript:alert(1)" as a URL with
  // protocol "javascript:"), so every rejection reason is checked
  // explicitly rather than trusted to URL() throwing.
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (parsed.pathname !== "" && parsed.pathname !== "/") return null;
  if (parsed.search !== "" || parsed.hash !== "") return null;
  if (parsed.hostname === "" || parsed.hostname === "*") return null;
  return parsed.origin;
}

/**
 * Parses LTI_FRAME_ANCESTORS (whitespace-separated exact HTTPS origins,
 * e.g. "https://canvas.example.edu https://another.example.edu") into a
 * deduplicated list of validated origins. An unset/empty value returns an
 * empty array — this is safe: with no configured trusted origin, the
 * LTI-compatible route family's CSP degrades to `frame-ancestors 'self'`
 * only (same-origin framing still works for same-app embedding tests;
 * cross-origin Canvas framing simply isn't trusted yet until configured).
 */
export function parseLtiFrameAncestors(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const token of raw.split(/\s+/)) {
    const validated = validateLtiFrameAncestorOrigin(token);
    if (validated) seen.add(validated);
  }
  return Array.from(seen);
}

function ltiFrameAncestorsFromEnv(): string[] {
  return parseLtiFrameAncestors(process.env.LTI_FRAME_ANCESTORS);
}

// ---------------------------------------------------------------------------
// Content-Security-Policy
// ---------------------------------------------------------------------------

/**
 * frame-ancestors value for a route class. FRAME_DENIED is always exactly
 * 'none'. LTI_EMBED_COMPATIBLE is 'self' plus every validated trusted LTI
 * origin — never a bare '*', never an unvalidated/raw request value.
 */
export function buildFrameAncestorsDirective(routeClass: FrameRouteClass, trustedOrigins: string[] = ltiFrameAncestorsFromEnv()): string {
  if (routeClass === "FRAME_DENIED") return "frame-ancestors 'none'";
  const sources = ["'self'", ...trustedOrigins];
  return `frame-ancestors ${sources.join(" ")}`;
}

/**
 * Full CSP for a route class. See docs/security-headers-csp-v1.md,
 * "Resource/CSP dependency audit" for the evidence behind each directive:
 *   - script-src/style-src need 'unsafe-inline' because Next.js App
 *     Router's own RSC-streaming bootstrap emits inline <script> tags
 *     (self.__next_f.push(...)) and its built-in not-found boundary emits
 *     an inline <style>; a nonce-based CSP would force those (and any
 *     statically-generatable page using them) into fully dynamic
 *     rendering, which this P1 pass explicitly defers (see spec).
 *   - img-src allows blob: for the lecturer evidence-frame viewer, which
 *     turns a same-origin API response into a blob: object URL
 *     (src/app/lecturer/submissions/[id]/evidence/page.tsx).
 *   - connect-src allows https://storage.googleapis.com because the
 *     on-device camera integrity detector (src/lib/cameraObjectDetector.ts)
 *     loads its TensorFlow.js coco-ssd model weights from the package's
 *     default CDN base URL at runtime — no custom modelUrl is configured.
 *   - No other external script/style/font/image/connect host is used by
 *     any browser code found in the audit — nothing is added on
 *     speculation.
 * Never contains 'unsafe-eval', a wildcard default-src/script-src/
 * connect-src/frame-ancestors, or `data:`/`blob:` in script-src.
 */
export function buildContentSecurityPolicy(routeClass: FrameRouteClass, trustedLtiOrigins: string[] = ltiFrameAncestorsFromEnv()): string {
  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    "img-src 'self' blob:",
    "font-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline'",
    "connect-src 'self' https://storage.googleapis.com",
    "frame-src 'none'",
    buildFrameAncestorsDirective(routeClass, trustedLtiOrigins),
  ];
  if (deploymentEnvironment() === "production") directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

// ---------------------------------------------------------------------------
// Permissions-Policy
// ---------------------------------------------------------------------------

/**
 * Permissions-Policy for a route class. Deliberately opt-in per route —
 * every capability is denied by default; only the two genuine student
 * capture surfaces (found in the audit: src/app/student/exams/[id]/page.tsx
 * for camera+screen-share, src/app/student/system-check/page.tsx for
 * camera+microphone diagnostics) allow anything, and only exactly what
 * that page's own browser code calls. This never changes what Tether
 * captures or when — it only prevents an embedding/iframe context from
 * granting a capability the page itself never requests.
 */
export function buildPermissionsPolicy(policyClass: PermissionsPolicyClass): string {
  switch (policyClass) {
    case "STUDENT_EXAM_CAPTURE":
      // getUserMedia({ video: true, audio: false }) + getDisplayMedia({ video: true, audio: false }).
      return "geolocation=(), microphone=(), camera=(self), display-capture=(self)";
    case "STUDENT_SYSTEM_CHECK":
      // getUserMedia({ video: true }) and getUserMedia({ audio: true }) diagnostic checks — no screen-share check here.
      return "geolocation=(), microphone=(self), camera=(self), display-capture=()";
    case "DEFAULT_DENY":
    default:
      return "geolocation=(), microphone=(), camera=(), display-capture=()";
  }
}

export const X_CONTENT_TYPE_OPTIONS = "nosniff";
export const REFERRER_POLICY = "strict-origin-when-cross-origin";
