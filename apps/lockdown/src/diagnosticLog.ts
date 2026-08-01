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
 */
import { app } from "electron";

export function shouldLogDiagnostic(isPackaged: boolean, envFlag: string | undefined): boolean {
  return !isPackaged || envFlag === "true";
}

export function diagnosticLog(checkpoint: string, data: Record<string, unknown> = {}): void {
  if (!shouldLogDiagnostic(app.isPackaged, process.env.TETHER_DIAGNOSTIC_LOGGING)) return;
  // eslint-disable-next-line no-console
  console.log(`[tether-diagnostic] ${checkpoint}`, data);
}
