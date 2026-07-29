/**
 * Tether launch/install flow — corrective pass v1.2.0. Bounded, dev-only
 * diagnostic logging for tracing the launch -> manifest -> consume ->
 * verified-session -> policy -> display-enforcement pipeline (see the
 * corrective-pass plan, Part 1).
 *
 * Server-side logging is opt-in even outside Production
 * (TETHER_DIAGNOSTIC_LOGGING_ENABLED), since server logs land in shared
 * infrastructure. Client-side logging (inside the Tether Electron
 * renderer) is automatically on in any non-production build (Next.js
 * inlines NODE_ENV client-side) since it only ever reaches the
 * student's own local devtools console — mirrors the existing
 * shouldLogAiCameraDebug gate in src/lib/cameraIntegrityDetection.ts.
 *
 * NEVER logs cookies, signing keys, launch tokens/nonces, full launch
 * URLs, or any other PII — every call site below passes only bounded,
 * already-safe values (booleans, counts, enum-like strings, opaque
 * non-secret database ids).
 */
import { deploymentEnvironment, type DeploymentEnvironment } from "./secureClientAvailability";

export function isServerTetherDiagnosticLoggingEnabled(env: DeploymentEnvironment, envFlag: string | undefined): boolean {
  return env !== "production" && env !== "unknown" && envFlag === "true";
}

export function isClientTetherDiagnosticLoggingEnabled(nodeEnv: string | undefined): boolean {
  return nodeEnv !== "production";
}

/** Server-side (API routes) — opt-in via TETHER_DIAGNOSTIC_LOGGING_ENABLED. */
export function logServerTetherDiagnostic(checkpoint: string, data: Record<string, unknown> = {}): void {
  if (!isServerTetherDiagnosticLoggingEnabled(deploymentEnvironment(), process.env.TETHER_DIAGNOSTIC_LOGGING_ENABLED)) return;
  console.log(`[tether-diagnostic] ${checkpoint}`, data);
}

/** Client-side (inside the Tether Electron renderer or an ordinary browser) — on by default in any non-production build. */
export function logClientTetherDiagnostic(checkpoint: string, data: Record<string, unknown> = {}): void {
  if (typeof window === "undefined") return;
  if (!isClientTetherDiagnosticLoggingEnabled(process.env.NODE_ENV)) return;
  console.log(`[tether-diagnostic] ${checkpoint}`, data);
}
