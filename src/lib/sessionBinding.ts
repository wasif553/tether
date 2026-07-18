/**
 * Exam Session Binding v1 — cryptographic and low-entropy classification
 * helpers. See docs/exam-session-binding-v1.md.
 *
 * Server-only (uses Node's `crypto`), but deliberately has NO Prisma and
 * NO Next.js import — the pure classification rules that consume this
 * module's output live separately in src/lib/sessionIntegrity.ts so they
 * stay unit-testable with plain string/number inputs. This module is the
 * one place raw IPs/user-agents/tokens are ever touched before being
 * reduced to a hash or a coarse category.
 *
 * NEVER stores or returns a raw IP address, a raw session/device token,
 * the raw user-agent string (beyond what's needed to derive family/OS/
 * device once), or the HMAC secret itself.
 */
import crypto from "crypto";
import { parseUserAgent } from "@/lib/networkEvidence";

// ---------------------------------------------------------------------------
// HMAC secret
// ---------------------------------------------------------------------------

/**
 * Falls back to a random per-process secret (consistent within one server
 * process, changes on restart/redeploy) exactly like NETWORK_EVIDENCE_SALT
 * in src/lib/networkEvidence.ts — intentional for the pilot. Set
 * EXAM_BINDING_HMAC_SECRET in production for hashes stable across
 * restarts. Deliberately a distinct secret from AUTH_SECRET (never reused)
 * so rotating one never invalidates the other.
 */
const _fallbackHmacSecret = crypto.randomBytes(32).toString("hex");
function getHmacSecret(): string {
  return process.env.EXAM_BINDING_HMAC_SECRET ?? _fallbackHmacSecret;
}

/** HMAC-SHA256 of a value with the server secret — never an unsalted hash. */
export function hmacHash(value: string): string {
  return crypto.createHmac("sha256", getHmacSecret()).update(value).digest("hex");
}

/** Cryptographically random, URL-safe token for a browser-session or device cookie. */
export function generateRandomToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

export const BROWSER_SESSION_COOKIE_NAME = "exam_bst";
export const DEVICE_TOKEN_COOKIE_NAME = "exam_dt";

/** Matches a typical exam attempt duration ceiling — long enough to cover any single attempt, short enough not to linger. */
export const BROWSER_SESSION_COOKIE_MAX_AGE_SECONDS = 6 * 60 * 60; // 6 hours
/** Device token persists across attempts on the same browser, for a reasonable period — not indefinite. */
export const DEVICE_TOKEN_COOKIE_MAX_AGE_SECONDS = 180 * 24 * 60 * 60; // 180 days

export type CookieOptions = {
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: string;
  maxAge: number;
};

/** Secure only outside local development, so local HTTP dev still works. */
function isSecureEnvironment(): boolean {
  return process.env.NODE_ENV === "production";
}

export function browserSessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: isSecureEnvironment(),
    sameSite: "lax",
    path: "/",
    maxAge: BROWSER_SESSION_COOKIE_MAX_AGE_SECONDS,
  };
}

export function deviceTokenCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: isSecureEnvironment(),
    sameSite: "lax",
    path: "/",
    maxAge: DEVICE_TOKEN_COOKIE_MAX_AGE_SECONDS,
  };
}

// ---------------------------------------------------------------------------
// IP prefix derivation — never a raw IP, only a hashed network prefix.
// ---------------------------------------------------------------------------

export type IpPrefixResult = { prefixHash: string; version: "v4" | "v6" } | null;

function ipv4Prefix24(ip: string): string | null {
  const parts = ip.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null;
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

function ipv6Prefix48(ip: string): string | null {
  // Expand common "::" shorthand minimally: take the first 3 groups
  // present before any "::" collapse, which is sufficient for a /48
  // prefix without needing full RFC 5952 expansion.
  const withoutZone = ip.split("%")[0];
  const groups = withoutZone.split(":").filter((g) => g.length > 0);
  if (groups.length < 3) return null;
  return `${groups[0]}:${groups[1]}:${groups[2]}::/48`;
}

/**
 * Derives a coarse, hashed network prefix from a raw IP — /24 for IPv4,
 * /48 for IPv6 — and immediately discards the raw IP. Returns null for
 * anything unparseable rather than guessing. A single prefix CHANGE is
 * intentionally weak evidence on its own (see sessionIntegrity.ts) —
 * mobile networks, institutional Wi-Fi, and VPNs legitimately rotate
 * addresses.
 */
export function deriveIpPrefix(ip: string | null): IpPrefixResult {
  if (!ip) return null;
  const trimmed = ip.trim();
  if (trimmed.includes(":")) {
    const prefix = ipv6Prefix48(trimmed);
    return prefix ? { prefixHash: hmacHash(prefix), version: "v6" } : null;
  }
  const prefix = ipv4Prefix24(trimmed);
  return prefix ? { prefixHash: hmacHash(prefix), version: "v4" } : null;
}

// ---------------------------------------------------------------------------
// User-agent classification — family/OS/device only, never the raw string
// displayed. Reuses the existing lightweight parser from networkEvidence.ts
// rather than a new fingerprinting surface.
// ---------------------------------------------------------------------------

export type UserAgentClassification = {
  browserFamily: string | null;
  operatingSystemFamily: string | null;
  deviceCategory: "mobile" | "tablet" | "desktop" | null;
  userAgentHash: string | null;
};

export function classifyUserAgent(userAgent: string | null | undefined): UserAgentClassification {
  const { browserName, osName, deviceType } = parseUserAgent(userAgent);
  return {
    browserFamily: browserName,
    operatingSystemFamily: osName,
    deviceCategory: deviceType,
    userAgentHash: userAgent ? hmacHash(userAgent) : null,
  };
}

// ---------------------------------------------------------------------------
// Coarse fingerprint — LOW-ENTROPY inputs only. Never canvas/WebGL/audio
// fingerprinting, never font/plugin enumeration, never exact screen
// dimensions. This is deliberately a SUPPORTING signal, never the primary
// binding mechanism (that's the server-issued device token above).
// ---------------------------------------------------------------------------

export type ScreenSizeBucket = "small" | "medium" | "large" | "unknown";

/** Documented thresholds: small < 1024px wide, medium 1024–1919px, large >= 1920px. Bucketed, never exact pixels. */
export function bucketScreenSize(widthPx: number | null | undefined): ScreenSizeBucket {
  if (widthPx == null || !Number.isFinite(widthPx) || widthPx <= 0) return "unknown";
  if (widthPx < 1024) return "small";
  if (widthPx < 1920) return "medium";
  return "large";
}

/** Primary language subtag only (e.g. "en-US,en;q=0.9" -> "en") — never the full Accept-Language header. */
export function normalizeAcceptLanguage(acceptLanguageHeader: string | null | undefined): string | null {
  if (!acceptLanguageHeader) return null;
  const first = acceptLanguageHeader.split(",")[0]?.trim();
  if (!first) return null;
  const primary = first.split(";")[0]?.split("-")[0]?.toLowerCase();
  return primary && /^[a-z]{2,3}$/.test(primary) ? primary : null;
}

export type CoarseFingerprintInput = {
  browserFamily: string | null;
  operatingSystemFamily: string | null;
  deviceCategory: string | null;
  acceptLanguagePrimary: string | null;
  timezone: string | null;
  screenBucket: ScreenSizeBucket;
};

/** Composes the allowed low-entropy inputs into one hashed fingerprint. */
export function computeCoarseFingerprintHash(input: CoarseFingerprintInput): string {
  const canonical = [
    input.browserFamily ?? "?",
    input.operatingSystemFamily ?? "?",
    input.deviceCategory ?? "?",
    input.acceptLanguagePrimary ?? "?",
    input.timezone ?? "?",
    input.screenBucket,
  ].join("|");
  return hmacHash(canonical);
}

// ---------------------------------------------------------------------------
// Camera permission state — validated, unsupported-API-safe.
// ---------------------------------------------------------------------------

export const CAMERA_PERMISSION_STATES = ["granted", "denied", "prompt", "unavailable", "unknown"] as const;
export type CameraPermissionState = (typeof CAMERA_PERMISSION_STATES)[number];

/** Any value outside the known set — including an unsupported Permissions API result — safely becomes "unknown", never treated as a violation. */
export function normalizeCameraPermissionState(value: unknown): CameraPermissionState {
  return typeof value === "string" && (CAMERA_PERMISSION_STATES as readonly string[]).includes(value)
    ? (value as CameraPermissionState)
    : "unknown";
}

// ---------------------------------------------------------------------------
// ExamAttemptSession status
// ---------------------------------------------------------------------------

export const EXAM_ATTEMPT_SESSION_STATUSES = ["ACTIVE", "STALE", "ENDED", "REPLACED"] as const;
export type ExamAttemptSessionStatus = (typeof EXAM_ATTEMPT_SESSION_STATUSES)[number];

/** A session is active only if it's flagged ACTIVE AND was seen within the timeout — see sessionIntegrity.ts for the timeout constant and full classification. */
export function isValidExamAttemptSessionStatus(value: string): value is ExamAttemptSessionStatus {
  return (EXAM_ATTEMPT_SESSION_STATUSES as readonly string[]).includes(value);
}
