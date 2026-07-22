/**
 * Screen-share Evidence Mode v1 — pure policy module. See
 * docs/screen-share-evidence-v1.md.
 *
 * Pure, dependency-free, deterministic: no Prisma, no Next.js, no browser
 * APIs. Defines the immutable per-attempt policy snapshot shape
 * (mirroring src/lib/examPolicy.ts / src/lib/aiAssistancePolicy.ts),
 * server-side interval/max-frame bounds, and evidence-capture decisions.
 * This is an INTEGRITY-REVIEW feature, not an automatic cheating
 * detector — nothing here computes or contributes to a misconduct/risk
 * score; see src/lib/secureExam.ts (severityFor) for the (deliberately
 * modest, non-escalating) risk treatment of the lifecycle events this
 * policy gates.
 */
import type { SecureExamSettings } from "@/lib/secureExam";

export const SCREEN_SHARE_POLICY_VERSION = "v1.0";
/** Bumped only if the snapshot's shape changes in a way old snapshots can't be read as. */
export const SCREEN_SHARE_SNAPSHOT_SCHEMA_VERSION = 1;

export type ScreenShareMode = "OFF" | "REQUIRED";

// ---------------------------------------------------------------------------
// Server-side bounds (recommended v1 values from the task spec) — the
// single source of truth other than the matching min/max on the zod
// schema in secureExam.ts. Any client-supplied value outside these is
// clamped, never trusted verbatim.
// ---------------------------------------------------------------------------

export const DEFAULT_EVIDENCE_INTERVAL_SECONDS = 60;
export const MIN_EVIDENCE_INTERVAL_SECONDS = 30;
export const MAX_EVIDENCE_INTERVAL_SECONDS = 300;

export const DEFAULT_MAX_EVIDENCE_FRAMES = 20;
export const HARD_MAX_EVIDENCE_FRAMES = 50;

export function clampScreenShareEvidenceIntervalSeconds(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_EVIDENCE_INTERVAL_SECONDS;
  return Math.min(MAX_EVIDENCE_INTERVAL_SECONDS, Math.max(MIN_EVIDENCE_INTERVAL_SECONDS, Math.round(value)));
}

export function clampScreenShareMaxEvidenceFrames(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_EVIDENCE_FRAMES;
  return Math.min(HARD_MAX_EVIDENCE_FRAMES, Math.max(1, Math.round(value)));
}

// ---------------------------------------------------------------------------
// Policy snapshot
// ---------------------------------------------------------------------------

export type ScreenSharePolicy = {
  schemaVersion: number;
  policyVersion: string;
  mode: ScreenShareMode;
  captureEvidence: boolean;
  evidenceIntervalSeconds: number;
  maxEvidenceFrames: number;
};

export const DISABLED_SCREEN_SHARE_POLICY: ScreenSharePolicy = {
  schemaVersion: SCREEN_SHARE_SNAPSHOT_SCHEMA_VERSION,
  policyVersion: SCREEN_SHARE_POLICY_VERSION,
  mode: "OFF",
  captureEvidence: false,
  evidenceIntervalSeconds: DEFAULT_EVIDENCE_INTERVAL_SECONDS,
  maxEvidenceFrames: 0,
};

export type RelevantScreenShareSettings = Pick<
  SecureExamSettings,
  "screenShareMode" | "screenShareCaptureEvidence" | "screenShareEvidenceIntervalSeconds" | "screenShareMaxEvidenceFrames"
>;

/**
 * Builds the effective policy from CURRENT exam settings. Called once, at
 * attempt start, to produce the immutable snapshot
 * (Submission.screenSharePolicySnapshotJson) — never called again for an
 * in-progress attempt, and never used directly by request-time decisions
 * (those must read the stored snapshot via parseScreenSharePolicy below).
 */
export function buildScreenSharePolicySnapshot(settings: RelevantScreenShareSettings): ScreenSharePolicy {
  return {
    schemaVersion: SCREEN_SHARE_SNAPSHOT_SCHEMA_VERSION,
    policyVersion: SCREEN_SHARE_POLICY_VERSION,
    mode: settings.screenShareMode,
    captureEvidence: settings.screenShareCaptureEvidence,
    evidenceIntervalSeconds: clampScreenShareEvidenceIntervalSeconds(settings.screenShareEvidenceIntervalSeconds),
    maxEvidenceFrames: clampScreenShareMaxEvidenceFrames(settings.screenShareMaxEvidenceFrames),
  };
}

/**
 * Reads back a stored snapshot (Submission.screenSharePolicySnapshotJson).
 * A null/malformed/missing snapshot is ALWAYS treated as OFF — never
 * silently required, and never re-derived from the exam's current
 * (possibly since-changed) settings. This is the one function every
 * request-time decision must go through.
 */
export function parseScreenSharePolicy(raw: unknown): ScreenSharePolicy {
  if (raw == null || typeof raw !== "object") return { ...DISABLED_SCREEN_SHARE_POLICY };
  const obj = raw as Record<string, unknown>;
  const mode = obj.mode === "REQUIRED" ? "REQUIRED" : "OFF";
  if (mode === "OFF") return { ...DISABLED_SCREEN_SHARE_POLICY };
  const captureEvidence = obj.captureEvidence === true;
  return {
    schemaVersion: typeof obj.schemaVersion === "number" ? obj.schemaVersion : SCREEN_SHARE_SNAPSHOT_SCHEMA_VERSION,
    policyVersion: typeof obj.policyVersion === "string" ? obj.policyVersion : SCREEN_SHARE_POLICY_VERSION,
    mode,
    captureEvidence,
    evidenceIntervalSeconds: clampScreenShareEvidenceIntervalSeconds(
      typeof obj.evidenceIntervalSeconds === "number" ? obj.evidenceIntervalSeconds : DEFAULT_EVIDENCE_INTERVAL_SECONDS,
    ),
    maxEvidenceFrames: captureEvidence
      ? clampScreenShareMaxEvidenceFrames(
          typeof obj.maxEvidenceFrames === "number" ? obj.maxEvidenceFrames : DEFAULT_MAX_EVIDENCE_FRAMES,
        )
      : 0,
  };
}

export function isScreenShareRequired(policy: Pick<ScreenSharePolicy, "mode">): boolean {
  return policy.mode === "REQUIRED";
}

export function isScreenShareEvidenceEnabled(
  policy: Pick<ScreenSharePolicy, "mode" | "captureEvidence">,
): boolean {
  return policy.mode === "REQUIRED" && policy.captureEvidence === true;
}

// ---------------------------------------------------------------------------
// Evidence-frame limits and pacing
// ---------------------------------------------------------------------------

export function hasReachedMaxEvidenceFrames(
  framesAlreadyCaptured: number,
  policy: Pick<ScreenSharePolicy, "maxEvidenceFrames">,
): boolean {
  return framesAlreadyCaptured >= policy.maxEvidenceFrames;
}

/**
 * True if enough time has passed since the last capture for a NEW
 * periodic capture to be due. Used client-side to schedule captures and
 * server-side as a defensive minimum-gap check (Part: "avoid duplicate
 * captures within a short time window") — independent of, and in
 * addition to, the request-rate limiter below.
 */
export function isEvidenceCaptureDue(
  lastCapturedAtMs: number | null,
  nowMs: number,
  policy: Pick<ScreenSharePolicy, "evidenceIntervalSeconds">,
): boolean {
  if (lastCapturedAtMs == null) return true;
  return nowMs - lastCapturedAtMs >= policy.evidenceIntervalSeconds * 1000;
}

/**
 * A hard minimum gap BELOW the configured interval that server-side
 * upload requests may never beat, regardless of what the client claims
 * its capture schedule is — deliberately a fraction of the configured
 * interval (never lower than a few seconds) so a genuine
 * interruption-triggered capture shortly after a periodic one is not
 * incorrectly rejected, while a burst of rapid duplicate/replayed
 * requests still is.
 */
export function minServerCaptureGapMs(policy: Pick<ScreenSharePolicy, "evidenceIntervalSeconds">): number {
  return Math.max(5_000, Math.floor((policy.evidenceIntervalSeconds * 1000) / 4));
}

export function isWithinMinCaptureGap(lastCapturedAtMs: number | null, nowMs: number, policy: Pick<ScreenSharePolicy, "evidenceIntervalSeconds">): boolean {
  if (lastCapturedAtMs == null) return false;
  return nowMs - lastCapturedAtMs < minServerCaptureGapMs(policy);
}

// ---------------------------------------------------------------------------
// Upload rate limiting — same minimal, DB-timestamp-driven sliding-window
// pattern as src/lib/aiAssistancePolicy.ts's isWithinRateLimit (no
// dedicated rate-limiting utility exists elsewhere in this repo to reuse).
// ---------------------------------------------------------------------------

export const SCREEN_EVIDENCE_RATE_LIMIT_MAX_REQUESTS = 3;
export const SCREEN_EVIDENCE_RATE_LIMIT_WINDOW_MS = 20_000;

export function isWithinScreenEvidenceRateLimit(
  recentUploadTimestampsMs: number[],
  nowMs: number,
  maxRequests: number = SCREEN_EVIDENCE_RATE_LIMIT_MAX_REQUESTS,
  windowMs: number = SCREEN_EVIDENCE_RATE_LIMIT_WINDOW_MS,
): boolean {
  const cutoff = nowMs - windowMs;
  const withinWindow = recentUploadTimestampsMs.filter((t) => t >= cutoff);
  return withinWindow.length < maxRequests;
}

// ---------------------------------------------------------------------------
// Interruption capture triggers (Part — "event-triggered evidence frames
// around meaningful screen-share interruptions")
// ---------------------------------------------------------------------------

export type ScreenShareCaptureTrigger = "PERIODIC" | "INTERRUPTION" | "RESTORATION";

export const SCREEN_SHARE_CAPTURE_TRIGGERS: readonly ScreenShareCaptureTrigger[] = [
  "PERIODIC",
  "INTERRUPTION",
  "RESTORATION",
];

export function isValidScreenShareCaptureTrigger(value: string): value is ScreenShareCaptureTrigger {
  return (SCREEN_SHARE_CAPTURE_TRIGGERS as readonly string[]).includes(value);
}
