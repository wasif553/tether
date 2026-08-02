/**
 * Tether Windows Lockdown Hardening v1 — server-only environment
 * configuration (Part 12). See docs/tether-windows-lockdown-hardening-v1.md,
 * "Configuration and environment variables".
 *
 * Server-only, pure. Mirrors the single-central-resolver convention
 * already used by tetherAttestationConfig.ts/tetherRecoveryConfig.ts.
 * These are the SECURITY toggles — deliberately resolved server-side and
 * relayed to the Electron client via GET /api/tether/lockdown/policy
 * (never read from Electron's own local environment) so a local install
 * can never silently downgrade its own enforcement — see
 * apps/lockdown/src/lockdownCapabilityRegistry.ts's own
 * LockdownPolicyToggles doc comment for the full rationale. The
 * OPERATIONAL knobs (scan cadence/timeout) are the opposite: those live
 * entirely in apps/lockdown/src/lockdownConfig.ts, read from Electron's
 * own environment, since they're mechanical tuning, not a security
 * decision.
 */

function parseBoolEnv(raw: string | undefined, fallback: boolean): boolean {
  const trimmed = raw?.trim().toLowerCase();
  if (trimmed === "true" || trimmed === "1") return true;
  if (trimmed === "false" || trimmed === "0") return false;
  return fallback;
}

export type LockdownPolicyToggles = {
  blockRemoteControl: boolean;
  blockScreenCaptureTools: boolean;
  blockDebugTools: boolean;
  blockVirtualMachines: boolean;
};

// ---------------------------------------------------------------------------
// TETHER_BLOCK_REMOTE_CONTROL — Part 1/12. Governs every REMOTE_CONTROL-
// category capability (TeamViewer, AnyDesk, RustDesk, Chrome Remote
// Desktop, Remote Desktop client, Quick Assist, Zoom/Teams/Discord, VNC,
// and the inbound Remote Desktop session check). Conservative default
// (true / enforced): remote-access tools are the single clearest,
// lowest-false-positive, highest-severity threat this feature targets —
// see docs/tether-windows-lockdown-hardening-v1.md, "Capability
// registry" for the per-capability false-positive-risk reasoning behind
// this default.
// ---------------------------------------------------------------------------
const DEFAULT_BLOCK_REMOTE_CONTROL = true;

// ---------------------------------------------------------------------------
// TETHER_BLOCK_SCREEN_CAPTURE_TOOLS — governs OBS and other dedicated
// screen-recording software. Conservative default (true): single-purpose
// tools with low false-positive risk.
// ---------------------------------------------------------------------------
const DEFAULT_BLOCK_SCREEN_CAPTURE_TOOLS = true;

// ---------------------------------------------------------------------------
// TETHER_BLOCK_DEBUG_TOOLS — governs Visual Studio, Process
// Explorer/Hacker, and the VS Code debug-adapter signal. Conservative
// default (FALSE / detect-only): developer tooling has the highest
// false-positive risk of any category in this pilot (many CS students
// keep an IDE or debugger open for entirely unrelated coursework) —
// defaulting to block would risk locking out legitimate students during
// the pilot. Terminals (PowerShell/cmd) are never gated by this toggle
// at all — see the TERMINAL capability's own registry entry.
// ---------------------------------------------------------------------------
const DEFAULT_BLOCK_DEBUG_TOOLS = false;

// ---------------------------------------------------------------------------
// TETHER_BLOCK_VIRTUAL_MACHINES — governs Hyper-V console, VMware,
// VirtualBox, Windows Sandbox, and the "Tether itself appears to be
// running inside a VM" indicator. Conservative default (FALSE /
// detect-only): VM/virtualization tooling running on the HOST skews
// toward legitimate unrelated developer use.
// ---------------------------------------------------------------------------
const DEFAULT_BLOCK_VIRTUAL_MACHINES = false;

export function resolveLockdownPolicyToggles(): LockdownPolicyToggles {
  return {
    blockRemoteControl: parseBoolEnv(process.env.TETHER_BLOCK_REMOTE_CONTROL, DEFAULT_BLOCK_REMOTE_CONTROL),
    blockScreenCaptureTools: parseBoolEnv(process.env.TETHER_BLOCK_SCREEN_CAPTURE_TOOLS, DEFAULT_BLOCK_SCREEN_CAPTURE_TOOLS),
    blockDebugTools: parseBoolEnv(process.env.TETHER_BLOCK_DEBUG_TOOLS, DEFAULT_BLOCK_DEBUG_TOOLS),
    blockVirtualMachines: parseBoolEnv(process.env.TETHER_BLOCK_VIRTUAL_MACHINES, DEFAULT_BLOCK_VIRTUAL_MACHINES),
  };
}
