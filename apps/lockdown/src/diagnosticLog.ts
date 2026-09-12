/**
 * Tether Secure Browser — corrective pass v1.2.0. Bounded, dev-only
 * diagnostic logging for the display-enforcement pipeline (see the
 * corrective-pass plan, Part 1). On by default in any unpacked/dev run
 * (`!app.isPackaged`); in a packaged build it additionally requires the
 * explicit `TETHER_DIAGNOSTIC_LOGGING=true` environment variable, so a
 * distributed installer never logs by default. NEVER logs cookies,
 * signing keys, launch tokens, full URLs, or PII — every call site
 * passes only bounded, already-safe values (booleans, counts, enum-like
 * strings, opaque non-secret ids).
 *
 * Windows Hardening v1.8.0 physical-test diagnosis follow-up — a
 * packaged, no-console Electron app previously had nowhere for
 * console.log output to actually go during a real physical test (no
 * attached terminal, packaged DevTools disabled). This function now ALSO
 * best-effort appends the same line to an on-disk file
 * (userData/tether-secure-browser-native-diagnostics.log) whenever
 * logging is enabled, so the exact keyboard-hardening-helper handshake
 * sequence (spawn/pipe/HELLO/ARM/ARMED/hook-installed, or exactly where
 * it stopped) is inspectable after the fact. Purely additive: the
 * console.log call, its gating, and every existing call site are
 * unchanged. The file write is wrapped in its own try/catch — a
 * disk/path failure (including a test's mocked `app` missing getPath)
 * must never throw or change this function's behaviour.
 */
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

export const NATIVE_DIAGNOSTIC_LOG_FILE_NAME = "tether-secure-browser-native-diagnostics.log";

export function shouldLogDiagnostic(isPackaged: boolean, envFlag: string | undefined): boolean {
  return !isPackaged || envFlag === "true";
}

export function diagnosticLog(checkpoint: string, data: Record<string, unknown> = {}): void {
  if (!shouldLogDiagnostic(app.isPackaged, process.env.TETHER_DIAGNOSTIC_LOGGING)) return;
  // eslint-disable-next-line no-console
  console.log(`[tether-diagnostic] ${checkpoint}`, data);
  try {
    const logPath = path.join(app.getPath("userData"), NATIVE_DIAGNOSTIC_LOG_FILE_NAME);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${new Date().toISOString()} [tether-diagnostic] ${checkpoint} ${JSON.stringify(data)}\n`, "utf8");
  } catch {
    // Best-effort only — a disk/path failure (or, in tests, a mocked
    // `app` with no getPath) must never throw or otherwise change this
    // function's behaviour beyond skipping the file write.
  }
}
