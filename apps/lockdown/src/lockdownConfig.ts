/**
 * Tether Windows Lockdown Hardening v1 — operational tuning
 * configuration (Part 12). Pure, dependency-free.
 *
 * Only the OPERATIONAL knobs (scan cadence/timeout) live here, read from
 * this process's own environment — exactly like SES_BASE_URL in
 * shared.ts, effectively fixed at the shipped default for every
 * packaged install (a desktop app has no central per-institution env var
 * mechanism the way the hosted web app does). The SECURITY toggles
 * (TETHER_BLOCK_REMOTE_CONTROL / _SCREEN_CAPTURE_TOOLS / _DEBUG_TOOLS /
 * _VIRTUAL_MACHINES) are deliberately NOT read here — those are resolved
 * server-side (src/lib/tetherLockdownConfig.ts in the main web app) and
 * relayed to this process via IPC by the hosted page, exactly like
 * setSecureClientEnforcementState already does for display enforcement
 * — a local install must never be able to silently downgrade its own
 * enforcement by setting its own environment variable. See
 * lockdownCapabilityRegistry.ts's own LockdownPolicyToggles doc comment.
 */

function clampIntEnv(raw: string | undefined, min: number, max: number, fallback: number): number {
  const trimmed = raw?.trim();
  const parsed = trimmed ? Number(trimmed) : NaN;
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

// ---------------------------------------------------------------------------
// TETHER_PROCESS_SCAN_INTERVAL_SECONDS — Part 2/4/12. How often the
// background process scan runs while an exam is active (and, at a
// faster cadence — see TETHER_LOCKDOWN_RECHECK_SECONDS below — while a
// BLOCK_DURING_EXAM capability is actively showing its overlay).
// Conservative default (20s): frequent enough that a newly-opened
// remote-control tool is caught promptly, infrequent enough that
// spawning a PowerShell process (see processDetection.ts) never
// meaningfully competes with the exam itself for CPU. Clamped to
// [10, 120] seconds.
// ---------------------------------------------------------------------------
const DEFAULT_PROCESS_SCAN_INTERVAL_SECONDS = 20;
const MIN_PROCESS_SCAN_INTERVAL_SECONDS = 10;
const MAX_PROCESS_SCAN_INTERVAL_SECONDS = 120;

export function resolveProcessScanIntervalSeconds(): number {
  return clampIntEnv(process.env.TETHER_PROCESS_SCAN_INTERVAL_SECONDS, MIN_PROCESS_SCAN_INTERVAL_SECONDS, MAX_PROCESS_SCAN_INTERVAL_SECONDS, DEFAULT_PROCESS_SCAN_INTERVAL_SECONDS);
}

// ---------------------------------------------------------------------------
// TETHER_PROCESS_SCAN_TIMEOUT_SECONDS — Part 2. The bound on a single
// process-enumeration spawn (Get-Process) before it is treated as
// PROCESS_INSPECTION_UNAVAILABLE for that tick — never left to hang
// indefinitely (Part 2: "apply timeouts"). Conservative default (5s):
// comfortably above the ~1s typical PowerShell cold-start overhead this
// codebase has already measured for a similar spawn
// (windowsDisplayTopology.ts), short enough that a genuinely stuck
// PowerShell process cannot silently freeze detection for the rest of
// the exam. Clamped to [2, 15] seconds.
// ---------------------------------------------------------------------------
const DEFAULT_PROCESS_SCAN_TIMEOUT_SECONDS = 5;
const MIN_PROCESS_SCAN_TIMEOUT_SECONDS = 2;
const MAX_PROCESS_SCAN_TIMEOUT_SECONDS = 15;

export function resolveProcessScanTimeoutSeconds(): number {
  return clampIntEnv(process.env.TETHER_PROCESS_SCAN_TIMEOUT_SECONDS, MIN_PROCESS_SCAN_TIMEOUT_SECONDS, MAX_PROCESS_SCAN_TIMEOUT_SECONDS, DEFAULT_PROCESS_SCAN_TIMEOUT_SECONDS);
}

// ---------------------------------------------------------------------------
// TETHER_LOCKDOWN_RECHECK_SECONDS — Part 4/12. Once a BLOCK_DURING_EXAM
// capability is actively covering exam content, this is the FASTER
// recheck cadence used instead of the general
// TETHER_PROCESS_SCAN_INTERVAL_SECONDS — so a student who has already
// closed the offending application is not left staring at the blocking
// overlay for up to a full scan interval. Conservative default (5s):
// fast enough to feel responsive, still comfortably above the scan
// timeout so a slow scan can always complete before the next one is
// due. Clamped to [2, 30] seconds.
// ---------------------------------------------------------------------------
const DEFAULT_LOCKDOWN_RECHECK_SECONDS = 5;
const MIN_LOCKDOWN_RECHECK_SECONDS = 2;
const MAX_LOCKDOWN_RECHECK_SECONDS = 30;

export function resolveLockdownRecheckSeconds(): number {
  return clampIntEnv(process.env.TETHER_LOCKDOWN_RECHECK_SECONDS, MIN_LOCKDOWN_RECHECK_SECONDS, MAX_LOCKDOWN_RECHECK_SECONDS, DEFAULT_LOCKDOWN_RECHECK_SECONDS);
}

// ---------------------------------------------------------------------------
// TETHER_REMOTE_SESSION_MONITOR_INTERVAL_SECONDS — mid-exam remote-session
// monitoring v1. How often the Windows-session classification check
// (windowsSessionDetection.ts) is re-run while an exam is ACTIVE, extending
// what was previously a preflight-only check into continuous monitoring.
// Deliberately slower than TETHER_PROCESS_SCAN_INTERVAL_SECONDS's 20s
// default: each poll spawns a PowerShell process running an inline C#
// Add-Type block (heavier per-poll cost than a plain Get-Process
// enumeration), and a remote-session state change is not something that
// needs sub-20-second responsiveness the way a newly-launched blocking
// application does. Conservative default (30s), clamped to [15, 300]
// seconds so an institution can tighten or relax cadence without either
// starving the exam session of CPU or leaving a real transition
// undetected for many minutes.
// ---------------------------------------------------------------------------
const DEFAULT_REMOTE_SESSION_MONITOR_INTERVAL_SECONDS = 30;
const MIN_REMOTE_SESSION_MONITOR_INTERVAL_SECONDS = 15;
const MAX_REMOTE_SESSION_MONITOR_INTERVAL_SECONDS = 300;

export function resolveRemoteSessionMonitorIntervalSeconds(): number {
  return clampIntEnv(
    process.env.TETHER_REMOTE_SESSION_MONITOR_INTERVAL_SECONDS,
    MIN_REMOTE_SESSION_MONITOR_INTERVAL_SECONDS,
    MAX_REMOTE_SESSION_MONITOR_INTERVAL_SECONDS,
    DEFAULT_REMOTE_SESSION_MONITOR_INTERVAL_SECONDS,
  );
}
