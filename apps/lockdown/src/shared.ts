/**
 * Constants shared between the main and preload processes. Keeping this
 * in one place avoids the version string / protocol name drifting between
 * the two bundles.
 */

// Corrective pass v1.2.0 — minor bump: fixes the Extend-mode enforcement
// activation bug (debounce was silently dropping policy-driven
// evaluation), adds Windows-native Duplicate/Clone topology detection
// and periodic re-checking, and separates lighting/uncertainty from
// confirmed face-absence in the on-device AI camera integrity check
// (web-app-side; unrelated to this Electron bridge but shipped in the
// same corrective pass). No breaking change to the existing
// window.sesLockdown bridge contract — every prior field/method is
// still present.
export const LOCKDOWN_VERSION = "1.2.0";

// Primary marker for new builds. Older packaged installs may still send
// the legacy `SESLockdown/${version}` suffix — see
// src/lib/lockdownDetection.ts and src/lib/networkEvidence.ts for the
// backward-compatible detection logic that accepts both.
export const USER_AGENT_SUFFIX = `TetherSecureBrowser/${LOCKDOWN_VERSION}`;

export const DEFAULT_SES_BASE_URL = "https://tether-murex.vercel.app";

/**
 * Tether launch/install flow v1 — the branded `tether://` protocol is
 * now primary; `ses://` is preserved for existing pilot installations
 * that haven't updated yet (Requirement 4). Both are registered and
 * handled identically — see registerDeepLinkProtocol/isDeepLinkArg in
 * main.ts.
 */
export const DEEP_LINK_PROTOCOLS = ["tether", "ses"] as const;
export type DeepLinkProtocol = (typeof DEEP_LINK_PROTOCOLS)[number];
export const PRIMARY_DEEP_LINK_PROTOCOL: DeepLinkProtocol = "tether";

/** True for any string beginning with one of the registered deep-link protocols (`tether://...` or `ses://...`). */
export function isDeepLinkArg(value: string): boolean {
  return DEEP_LINK_PROTOCOLS.some((protocol) => value.startsWith(`${protocol}://`));
}

/**
 * Resolves the web app path a deep link should land on — the fix for
 * the confirmed bug where buildLoadUrl always returned `/student`
 * regardless of examId. Landing on the Tether launch page (rather than
 * directly on `/student/exams/[examId]`, which doesn't exist as a route
 * — the app is keyed by submissionId, not examId) lets that page run
 * the full access-check -> acknowledgement -> start -> launch -> consume
 * sequence automatically once inside Tether and authenticated (see
 * src/app/student/exams/[id]/tether-launch/page.tsx in the main repo).
 */
export function buildTetherLaunchPath(examId: string): string {
  return `/student/exams/${examId}/tether-launch`;
}

/**
 * IntegrityEventType values this client may report, restricted to values
 * that already exist on the SES Prisma schema's IntegrityEventType enum
 * (see prisma/schema.prisma in the main repo) — no schema change was
 * needed for v1. Electron-only signals that don't have a closer match
 * are reported as MANUAL_WARNING with the precise origin recorded in
 * metadata.electronEventType.
 */
export type LockdownIntegrityEventType =
  | "WINDOW_BLUR"
  | "WINDOW_FOCUS_RETURN"
  | "FULLSCREEN_EXIT"
  | "MANUAL_WARNING";

export type LockdownEventMetadata = {
  source: "electron-lockdown";
  lockdownVersion: string;
  electronEventType: string;
  platform: string;
  displayCount?: number;
  domain?: string;
  timestamp: string;
  [key: string]: unknown;
};

export type QueuedLockdownEvent = {
  eventType: LockdownIntegrityEventType;
  message: string;
  metadata: LockdownEventMetadata;
  occurredAt: string;
};

export type ExamContext = {
  examId: string | null;
  submissionId: string | null;
};

export type SessionInfo = {
  /** Whether a SES auth session cookie is present — never the cookie value itself. */
  authenticated: boolean;
};
