/**
 * Tether Windows Lockdown Hardening v1 — Windows process-name adapter
 * (Part 2). Mirrors windowsDisplayTopology.ts's own established pattern
 * exactly (see that module's doc comment for the full rationale for
 * choosing an embedded PowerShell script over a native Node addon in
 * this environment): a small, auditable, fully STATIC script (nothing
 * from the registry, from an IPC payload, or from any other runtime
 * value is ever interpolated into it) written once per app session to a
 * per-user temp path, then invoked repeatedly via `spawn()` with an
 * argv array — never a shell string, so there is no command-injection
 * surface even in principle (Part 16 item 7).
 *
 * Deliberately requests ONLY each process's name (PowerShell's
 * `ProcessName`, which is already extension- and path-free) — never
 * `Path`, `CommandLine`, or any other extended property. This keeps
 * every listed process visible without elevated privileges (reading a
 * process's own name never requires ownership the way reading its full
 * path/command line sometimes does on a locked-down account), and means
 * there is structurally no command-line-argument data for this module
 * to even accidentally collect (Part 2: "never collect command-line
 * arguments unless strictly necessary and privacy-reviewed" — the
 * answer here is simply "never").
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseProcessListOutput, type ProcessListParseResult } from "./processDetectionLogic";
import { consumeLockdownFault } from "./lockdownFaultInjection";

const SCRIPT_PATH = path.join(os.tmpdir(), "tether-secure-browser-process-scan.ps1");

// `@(...)` forces PowerShell to treat the pipeline result as an array
// even when zero or exactly one process matches (a well-known
// ConvertTo-Json gotcha: without it, a single result serializes as a
// bare JSON string, not a one-element array) — see
// parseProcessListOutput's own "must be a JSON array" check.
const POWERSHELL_SCRIPT = String.raw`
@(Get-Process | Select-Object -ExpandProperty ProcessName) | ConvertTo-Json -Compress
`;

let scriptWritten = false;
function ensureScriptWritten(): void {
  if (scriptWritten) return;
  writeFileSync(SCRIPT_PATH, POWERSHELL_SCRIPT, "utf8");
  scriptWritten = true;
}

function isWindows(): boolean {
  return process.platform === "win32";
}

export type WindowsProcessListResult =
  | { ok: true; parseResult: ProcessListParseResult }
  | { ok: false; reason: "not_windows" | "timeout" | "spawn_failed" | "non_zero_exit" };

/**
 * Spawns a single, timeout-bounded PowerShell process listing (Part 2:
 * "apply timeouts" / "avoid unbounded polling" — this function itself
 * never loops or retries; the caller, processDetection.ts, owns the
 * polling cadence). Never rejects — every failure path resolves to a
 * typed, distinguishable result so a caller can tell
 * "detection unavailable" apart from "scanned, found nothing" (Part 2 /
 * Part 3: "do not treat 'unable to inspect processes' as 'no prohibited
 * processes found'").
 */
export async function getWindowsProcessList(timeoutMs: number): Promise<WindowsProcessListResult> {
  // Part 17 — dev/test-only fault injection, checked first so an armed
  // fault always wins regardless of the real platform/environment (lets
  // these three fault kinds be exercised even in CI/non-Windows test
  // runs, exactly like the malformed-output unit tests already do via
  // parseProcessListOutput directly — this additionally proves the
  // service-level plumbing above that boundary handles each one
  // correctly).
  if (consumeLockdownFault("PROCESS_ENUMERATION_TIMEOUT")) return { ok: false, reason: "timeout" };
  if (consumeLockdownFault("PROCESS_ENUMERATION_PERMISSION_DENIED")) return { ok: false, reason: "spawn_failed" };
  if (consumeLockdownFault("PROCESS_ENUMERATION_MALFORMED_OUTPUT")) return { ok: true, parseResult: parseProcessListOutput("not valid json") };

  if (!isWindows()) return { ok: false, reason: "not_windows" };

  try {
    ensureScriptWritten();
  } catch {
    return { ok: false, reason: "spawn_failed" };
  }

  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT_PATH], {
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ ok: false, reason: "timeout" });
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
      // Bounded accumulation — never let a runaway/adversarial stdout
      // stream grow this buffer without limit before the parser's own
      // MAX_PROCESS_NAMES cap ever gets a chance to apply.
      if (stdout.length > 2_000_000) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          child.kill();
          resolve({ ok: false, reason: "non_zero_exit" });
        }
      }
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, reason: "spawn_failed" });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ ok: false, reason: "non_zero_exit" });
        return;
      }
      resolve({ ok: true, parseResult: parseProcessListOutput(stdout) });
    });
  });
}
