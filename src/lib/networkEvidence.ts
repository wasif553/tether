/**
 * Academic Integrity Network Evidence v1 — helpers for capturing IP
 * address, approximate IP-based location, and browser/device metadata
 * at exam open and final submission. Evidence-only: never blocks a
 * student, never auto-determines misconduct. See
 * docs/network-evidence-and-ip-location.md.
 */

import crypto from "crypto";
import { geolocateIp } from "./ipGeolocation";
import { prisma } from "./prisma";

// ── IP extraction ────────────────────────────────────────────────────────────

const PRIVATE_IP_RE =
  /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|::1$|fc|fd|fe80)/i;

/** Returns true if the IP looks like a private/loopback address. */
function isPrivateIp(ip: string): boolean {
  return PRIVATE_IP_RE.test(ip.trim());
}

/**
 * Extracts the most-likely client IP from request headers. Trusts
 * x-forwarded-for, x-real-ip, and cf-connecting-ip (Cloudflare). If
 * x-forwarded-for contains multiple values the first public IP is used
 * (leftmost = original client in correctly configured proxies). Returns
 * null if no usable IP can be found — callers must handle null safely.
 *
 * Never logs the result.
 */
export function getClientIpFromRequest(req: Request): string | null {
  // Cloudflare always rewrites this to the true client IP.
  const cfIp = req.headers.get("cf-connecting-ip");
  if (cfIp && cfIp.trim()) return cfIp.trim();

  // x-forwarded-for may be a comma-separated list; take first public IP.
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    for (const part of xff.split(",")) {
      const candidate = part.trim();
      if (candidate && !isPrivateIp(candidate)) return candidate;
    }
  }

  // x-real-ip is set by nginx reverse proxies.
  const realIp = req.headers.get("x-real-ip");
  if (realIp && realIp.trim() && !isPrivateIp(realIp.trim())) {
    return realIp.trim();
  }

  return null;
}

/**
 * Hashes an IP address with a server-side salt (NETWORK_EVIDENCE_SALT
 * env var) for pseudonymisation. Falls back to a process-local random
 * salt if the env var is absent, so hashes are consistent within a
 * server process but not across restarts. This is intentional for the
 * pilot — a configurable persistent salt can be added later.
 */
const _fallbackSalt = crypto.randomBytes(16).toString("hex");
function hashIp(ip: string): string {
  const salt = process.env.NETWORK_EVIDENCE_SALT ?? _fallbackSalt;
  return crypto.createHmac("sha256", salt).update(ip).digest("hex");
}

// ── User-agent parsing ───────────────────────────────────────────────────────

export type ParsedUserAgent = {
  browserName: string | null;
  osName: string | null;
  deviceType: "mobile" | "tablet" | "desktop" | null;
};

/**
 * Lightweight UA parsing — no heavy npm dependency. Covers the major
 * browser/OS combinations seen in academic settings. Returns nulls for
 * anything unrecognised rather than crashing.
 */
export function parseUserAgent(ua: string | null | undefined): ParsedUserAgent {
  if (!ua) return { browserName: null, osName: null, deviceType: null };

  const browserName =
    /Edg\//.test(ua)
      ? "Edge"
      : /OPR\/|Opera/.test(ua)
        ? "Opera"
        : /Chrome\//.test(ua) && !/Chromium/.test(ua)
          ? "Chrome"
          : /Chromium/.test(ua)
            ? "Chromium"
            : /Firefox\//.test(ua)
              ? "Firefox"
              : /Safari\//.test(ua) && !/Chrome/.test(ua)
                ? "Safari"
                : /TetherSecureBrowser|SESLockdown/.test(ua)
                  ? "Tether Secure Browser"
                  : null;

  // iPhone/iPad must be checked before Mac OS X — iOS UA strings contain
  // "like Mac OS X" which would otherwise match the macOS branch first.
  const osName =
    /Windows/.test(ua)
      ? "Windows"
      : /iPhone|iPad|iPod/.test(ua)
        ? "iOS"
        : /Android/.test(ua)
          ? "Android"
          : /Mac OS X|macOS/.test(ua)
            ? "macOS"
            : /ChromeOS|CrOS/.test(ua)
              ? "ChromeOS"
              : /Linux/.test(ua)
                ? "Linux"
                : null;

  const deviceType: ParsedUserAgent["deviceType"] =
    /iPhone|iPod|Android.*Mobile|Mobile.*Android/.test(ua)
      ? "mobile"
      : /iPad|Android(?!.*Mobile)/.test(ua)
        ? "tablet"
        : "desktop";

  return { browserName, osName, deviceType };
}

// ── Evidence record creation ─────────────────────────────────────────────────

export type NetworkEvidenceSource = "EXAM_START" | "EXAM_SUBMIT";

type CreateNetworkEvidenceOptions = {
  req: Request;
  submissionId: string;
  examId: string;
  studentId: string;
  institutionId: string;
  source: NetworkEvidenceSource;
  /** IP from the previous EXAM_START record; set only for EXAM_SUBMIT. */
  priorIp?: string | null;
  /** Country from the previous EXAM_START record; set only for EXAM_SUBMIT. */
  priorCountry?: string | null;
};

/**
 * Captures and persists one NetworkEvidence row. Never throws — if
 * anything fails (geolocation timeout, DB write error) the exam
 * start/submit continues normally. The returned row id can be ignored
 * by callers.
 */
export async function captureNetworkEvidence(
  opts: CreateNetworkEvidenceOptions,
): Promise<string | null> {
  try {
    const ua = opts.req.headers.get("user-agent") ?? null;
    const { browserName, osName, deviceType } = parseUserAgent(ua);
    const ip = getClientIpFromRequest(opts.req);
    const ipHash = ip ? hashIp(ip) : null;

    const geo = await geolocateIp(ip);

    const networkChanged =
      opts.source === "EXAM_SUBMIT" &&
      !!opts.priorIp &&
      !!ip &&
      opts.priorIp !== ip;

    const row = await prisma.networkEvidence.create({
      data: {
        submissionId: opts.submissionId,
        examId: opts.examId,
        studentId: opts.studentId,
        institutionId: opts.institutionId,
        source: opts.source,
        ipAddress: ip,
        ipHash,
        userAgent: ua,
        browserName,
        osName,
        deviceType,
        country: geo.country,
        region: geo.region,
        city: geo.city,
        timezone: geo.timezone,
        locationAccuracy: geo.locationAccuracy,
        vpnOrProxySignal: geo.vpnOrProxySignal,
        networkChanged,
        metadata: geo.metadata as object | undefined,
      },
    });

    return row.id;
  } catch {
    // Evidence capture must never break exam flow.
    return null;
  }
}

// ── Review signal ─────────────────────────────────────────────────────────────

export type NetworkReviewSignal = "Normal" | "Needs review" | "High review signal";

export function networkReviewSignal(
  startEvidence: { country: string | null; ipAddress: string | null } | null,
  submitEvidence: { country: string | null; ipAddress: string | null; networkChanged: boolean } | null,
): NetworkReviewSignal {
  if (!startEvidence || !submitEvidence) return "Normal";
  if (
    startEvidence.country &&
    submitEvidence.country &&
    startEvidence.country !== submitEvidence.country
  ) {
    return "High review signal";
  }
  if (submitEvidence.networkChanged) return "Needs review";
  return "Normal";
}
