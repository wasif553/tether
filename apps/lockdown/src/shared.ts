/**
 * Constants shared between the main and preload processes. Keeping this
 * in one place avoids the version string / protocol name drifting between
 * the two bundles.
 */

export const LOCKDOWN_VERSION = "1.0.0";

export const USER_AGENT_SUFFIX = `SESLockdown/${LOCKDOWN_VERSION}`;

export const DEFAULT_SES_BASE_URL = "https://tether-murex.vercel.app";

export const DEEP_LINK_PROTOCOL = "ses";

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
