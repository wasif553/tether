/**
 * Tether Windows Lockdown Hardening v1 — Electron hardening (Part 7):
 * "disable insecure debug ports" / "reject unsafe command-line
 * switches". Pure, testable in isolation from Electron's own `app`
 * object — main.ts calls `findUnsafeCommandLineSwitch(process.argv)`
 * once, at startup, before `app.whenReady()`.
 */

// Prefixes only (never exact-match a bare token) — Electron/Chromium
// switches are always passed as --name or --name=value.
const UNSAFE_SWITCH_PREFIXES = [
  "--remote-debugging-port",
  "--remote-debugging-pipe",
  "--remote-debugging-address",
  "--inspect",
  "--inspect-brk",
  "--js-flags",
  "--disable-web-security",
  "--allow-running-insecure-content",
  "--ignore-certificate-errors",
  "--disable-site-isolation-trials",
  "--allow-file-access-from-files",
];

export function findUnsafeCommandLineSwitch(argv: readonly string[]): string | null {
  for (const arg of argv) {
    const lower = arg.toLowerCase();
    for (const prefix of UNSAFE_SWITCH_PREFIXES) {
      if (lower === prefix || lower.startsWith(`${prefix}=`)) return arg;
    }
  }
  return null;
}
