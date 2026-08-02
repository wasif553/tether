/**
 * Tether Secure Exam Recovery and Resilient Autosave v1 — environment
 * configuration. See docs/tether-secure-resume-recovery-v1.md,
 * "Configuration and environment variables".
 *
 * Server-only, pure (no Prisma, no Next.js). Every resolver here reads
 * process.env exactly once per call, with a conservative, safe default
 * that can never lock a student out of a working attempt or silently
 * grant more trust than intended. Mirrors the single-central-resolver
 * convention already used by src/lib/tetherAttestationConfig.ts and the
 * clamp*Seconds() family in src/lib/secureClientPolicy.ts.
 */
import {
  DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
  MIN_HEARTBEAT_INTERVAL_SECONDS,
  MAX_HEARTBEAT_INTERVAL_SECONDS,
} from "@/lib/secureClientPolicy";

function clampIntEnv(raw: string | undefined, min: number, max: number, fallback: number): number {
  const trimmed = raw?.trim();
  const parsed = trimmed ? Number(trimmed) : NaN;
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

// ---------------------------------------------------------------------------
// TETHER_OFFLINE_CONTINUE_MINUTES — Part 4/6. How long a student may keep
// answering (with Tether restrictions/display/camera enforcement still
// fully active — see docs, "Network interruption") after their secure-
// client session's heartbeat goes overdue, before the server stops
// trusting the existing verified session and requires a fresh
// crash/relaunch-style recovery (see resolveTrustedTetherVerification and
// resolveRecoveryState in src/lib/tetherRecovery.ts). Conservative default
// (10 minutes): long enough to survive a real Wi-Fi drop or a brief
// laptop-sleep without penalising the student, short enough that a
// genuinely crashed/killed Tether process cannot silently keep granting
// access to exam content on the strength of a verification that happened
// long before. Clamped to [2, 30] minutes against a malformed value.
// ---------------------------------------------------------------------------
const DEFAULT_OFFLINE_CONTINUE_MINUTES = 10;
const MIN_OFFLINE_CONTINUE_MINUTES = 2;
const MAX_OFFLINE_CONTINUE_MINUTES = 30;

export function resolveOfflineContinueMinutes(): number {
  return clampIntEnv(process.env.TETHER_OFFLINE_CONTINUE_MINUTES, MIN_OFFLINE_CONTINUE_MINUTES, MAX_OFFLINE_CONTINUE_MINUTES, DEFAULT_OFFLINE_CONTINUE_MINUTES);
}

export function resolveOfflineContinueMs(): number {
  return resolveOfflineContinueMinutes() * 60_000;
}

// ---------------------------------------------------------------------------
// TETHER_AUTOSAVE_RETRY_MAX_SECONDS — Part 4. The ceiling of the client's
// own bounded-exponential-backoff autosave retry loop (see
// src/lib/pendingSaveQueue.ts) — purely a client-side pacing hint the
// server documents and exposes for consistency; the server itself never
// rejects a save for arriving "too late" on this basis (the deadline/
// finalisation checks already in the answers/submit routes are the real
// authority on whether a save is still accepted at all). Conservative
// default (60s): frequent enough that a reconnecting student's queued
// answers land promptly, capped low enough to avoid a request storm
// against a recovering server. Clamped to [10, 300] seconds.
// ---------------------------------------------------------------------------
const DEFAULT_AUTOSAVE_RETRY_MAX_SECONDS = 60;
const MIN_AUTOSAVE_RETRY_MAX_SECONDS = 10;
const MAX_AUTOSAVE_RETRY_MAX_SECONDS = 300;

export function resolveAutosaveRetryMaxSeconds(): number {
  return clampIntEnv(
    process.env.TETHER_AUTOSAVE_RETRY_MAX_SECONDS,
    MIN_AUTOSAVE_RETRY_MAX_SECONDS,
    MAX_AUTOSAVE_RETRY_MAX_SECONDS,
    DEFAULT_AUTOSAVE_RETRY_MAX_SECONDS,
  );
}

// ---------------------------------------------------------------------------
// TETHER_PENDING_SAVE_RETENTION_HOURS — Part 3/15. How long an unsent,
// locally-queued answer draft may remain in the client's bounded local
// queue (IndexedDB) before it is treated as stale and discarded — see
// src/lib/pendingSaveQueue.ts. This is a client-side retention/privacy
// bound (Part 15: "pending answers must be removed after ... retention
// expiry"), not something the server enforces directly. Conservative
// default (72h / 3 days): comfortably survives a weekend outage without
// keeping a student's draft answers on a shared/lab machine indefinitely.
// Clamped to [1, 168] hours (1 hour to 1 week).
// ---------------------------------------------------------------------------
const DEFAULT_PENDING_SAVE_RETENTION_HOURS = 72;
const MIN_PENDING_SAVE_RETENTION_HOURS = 1;
const MAX_PENDING_SAVE_RETENTION_HOURS = 168;

export function resolvePendingSaveRetentionHours(): number {
  return clampIntEnv(
    process.env.TETHER_PENDING_SAVE_RETENTION_HOURS,
    MIN_PENDING_SAVE_RETENTION_HOURS,
    MAX_PENDING_SAVE_RETENTION_HOURS,
    DEFAULT_PENDING_SAVE_RETENTION_HOURS,
  );
}

// ---------------------------------------------------------------------------
// TETHER_HEARTBEAT_INTERVAL_SECONDS — Part 5. The DEFAULT heartbeat cadence
// suggested to a client when no per-exam policy is yet known (e.g. before
// a submission/secureClientPolicySnapshotJson has loaded). The real,
// authoritative interval for an in-progress attempt is always the
// per-attempt frozen `secureClientHeartbeatIntervalSeconds` inside that
// attempt's own secureClientPolicySnapshotJson (see
// src/lib/secureClientPolicy.ts, already configurable per exam in
// [15, 120] seconds) — this env var never overrides that once an attempt
// has started. Reuses the exact same bounds/default as that existing
// per-exam setting so the two can never silently disagree in spirit.
// ---------------------------------------------------------------------------
export function resolveHeartbeatIntervalSecondsDefault(): number {
  return clampIntEnv(process.env.TETHER_HEARTBEAT_INTERVAL_SECONDS, MIN_HEARTBEAT_INTERVAL_SECONDS, MAX_HEARTBEAT_INTERVAL_SECONDS, DEFAULT_HEARTBEAT_INTERVAL_SECONDS);
}
