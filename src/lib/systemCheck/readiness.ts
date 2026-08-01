/**
 * Tether System Check and Exam Readiness v1 — pure readiness/aggregation
 * module. See docs/tether-system-check-v1.md.
 *
 * Dependency-free and deterministic: no Prisma, no Next.js, no browser or
 * Electron APIs. Every UI surface and API route that needs to compute an
 * overall readiness status, evaluate a single check's result, or decide
 * whether a final examination may proceed MUST go through the functions
 * here — never re-implement this logic inline (Part: "Do not duplicate
 * readiness calculation in multiple UI components").
 *
 * This is a technical-readiness feature, not an integrity/misconduct
 * feature: every result is one of PASS / WARNING / BLOCKED / NOT_CHECKED,
 * and no function in this file ever returns or implies an accusation.
 */

// ---------------------------------------------------------------------------
// Result model
// ---------------------------------------------------------------------------

export const CHECK_RESULT_STATES = ["PASS", "WARNING", "BLOCKED", "NOT_CHECKED"] as const;
export type CheckResultState = (typeof CHECK_RESULT_STATES)[number];
export function isValidCheckResultState(value: string): value is CheckResultState {
  return (CHECK_RESULT_STATES as readonly string[]).includes(value);
}

export const OVERALL_STATES = ["READY", "READY_WITH_WARNINGS", "NOT_READY"] as const;
export type OverallState = (typeof OVERALL_STATES)[number];
export function isValidOverallState(value: string): value is OverallState {
  return (OVERALL_STATES as readonly string[]).includes(value);
}

export const SYSTEM_CHECK_IDS = [
  "authentication",
  "secureClient",
  "clientVersion",
  "operatingSystem",
  "displayTopology",
  "camera",
  "microphone",
  "network",
  "clock",
  "bridge",
] as const;
export type SystemCheckId = (typeof SYSTEM_CHECK_IDS)[number];
export function isValidSystemCheckId(value: string): value is SystemCheckId {
  return (SYSTEM_CHECK_IDS as readonly string[]).includes(value);
}

/**
 * Camera and microphone are deliberately NOT required: many exams never
 * enable camera/microphone integrity evidence at all (see
 * docs/on-device-ai-integrity-detection-v1.md), so a student whose
 * upcoming exam doesn't use either must still be able to reach READY.
 * Every other check reflects something every Tether-delivered final exam
 * genuinely depends on.
 */
export const REQUIRED_CHECK_IDS: ReadonlySet<SystemCheckId> = new Set([
  "authentication",
  "secureClient",
  "clientVersion",
  "operatingSystem",
  "displayTopology",
  "network",
  "clock",
  "bridge",
]);
export const OPTIONAL_CHECK_IDS: ReadonlySet<SystemCheckId> = new Set(["camera", "microphone"]);

export function isRequiredCheck(id: SystemCheckId): boolean {
  return REQUIRED_CHECK_IDS.has(id);
}

/**
 * Checks that can only ever be genuinely established from inside Tether
 * Secure Browser — a plain browser can never produce anything but
 * NOT_CHECKED for these (Part 3: "show native checks as 'Not checked'").
 * All four are also REQUIRED, which is what guarantees an ordinary
 * browser can never reach READY (Part 3: "ordinary Chrome/Edge must
 * never produce a fully ready result") — see computeOverallStatus.
 */
export const TETHER_ONLY_CHECK_IDS: ReadonlySet<SystemCheckId> = new Set(["secureClient", "clientVersion", "displayTopology", "bridge"]);

export type CheckResult = {
  status: CheckResultState;
  /** A short machine-readable reason code (e.g. "PERMISSION_DENIED") — never freeform, never a stack trace. */
  reasonCode?: string | null;
};

export type SystemCheckResults = Partial<Record<SystemCheckId, CheckResult>>;

/**
 * Central deterministic readiness aggregation — the ONLY place overall
 * status is computed. "Warnings must not conceal a blocked required
 * check": a BLOCKED or missing (NOT_CHECKED) required check always wins
 * over any WARNING, regardless of ordering.
 */
export function computeOverallStatus(results: SystemCheckResults): OverallState {
  let anyRequiredBlockedOrMissing = false;
  let anyWarning = false;

  for (const id of SYSTEM_CHECK_IDS) {
    const status = results[id]?.status ?? "NOT_CHECKED";
    if (isRequiredCheck(id)) {
      if (status === "BLOCKED" || status === "NOT_CHECKED") {
        anyRequiredBlockedOrMissing = true;
      } else if (status === "WARNING") {
        anyWarning = true;
      }
    } else {
      // An optional check's own failure is a readiness caveat, not a
      // blocker — camera/microphone not being ready never prevents READY
      // on its own, but it must still be visible as a warning.
      if (status === "BLOCKED" || status === "WARNING") anyWarning = true;
    }
  }

  if (anyRequiredBlockedOrMissing) return "NOT_READY";
  if (anyWarning) return "READY_WITH_WARNINGS";
  return "READY";
}

// ---------------------------------------------------------------------------
// Semantic client-version comparison (Check C)
// ---------------------------------------------------------------------------

/** Parses a dotted numeric version ("1.3.0") into a comparable tuple. Non-numeric/missing segments are treated as 0. */
function parseVersionParts(version: string): number[] | null {
  const trimmed = version.trim();
  if (!/^\d+(\.\d+)*$/.test(trimmed)) return null;
  return trimmed.split(".").map((part) => parseInt(part, 10));
}

/** -1 if a < b, 0 if equal, 1 if a > b. Missing trailing segments compare as 0 ("1.3" === "1.3.0"). */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersionParts(a) ?? [];
  const pb = parseVersionParts(b) ?? [];
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

export type ClientVersionEvaluation = { status: CheckResultState; reasonCode: string };

/**
 * An unsupported client must never be marked ready (BLOCKED). A reported
 * version this parser cannot understand is treated as a WARNING, not an
 * outright block — it may just be a reporting glitch, not a genuinely
 * incompatible client, and the student should be told to update/retry
 * rather than being hard-stopped by a parsing edge case.
 */
export function evaluateClientVersion(reportedVersion: string | null, minimumVersion: string): ClientVersionEvaluation {
  if (!reportedVersion) return { status: "NOT_CHECKED", reasonCode: "VERSION_UNKNOWN" };
  if (parseVersionParts(reportedVersion) === null) return { status: "WARNING", reasonCode: "VERSION_UNRECOGNISED" };
  return compareVersions(reportedVersion, minimumVersion) < 0
    ? { status: "BLOCKED", reasonCode: "VERSION_UNSUPPORTED" }
    : { status: "PASS", reasonCode: "VERSION_SUPPORTED" };
}

// ---------------------------------------------------------------------------
// Operating system (Check D) — only Windows is supported in v1. Never
// claims macOS, Chromebook, Linux, or iPad support.
// ---------------------------------------------------------------------------

export function evaluateOperatingSystem(platform: string | null): { status: CheckResultState; reasonCode: string } {
  if (!platform) return { status: "NOT_CHECKED", reasonCode: "OS_UNKNOWN" };
  const normalised = platform.toLowerCase();
  if (normalised === "win32" || normalised === "windows") return { status: "PASS", reasonCode: "WINDOWS_SUPPORTED" };
  return { status: "BLOCKED", reasonCode: "OS_UNSUPPORTED" };
}

// ---------------------------------------------------------------------------
// Display topology (Check E) — mirrors
// apps/lockdown/src/windowsDisplayTopologyClassifier.ts's classification
// values (kept as plain strings here rather than a cross-package import,
// since apps/lockdown is a separate compiled package from this Next.js
// app; the Electron preload reports the same string values over the wire).
// ---------------------------------------------------------------------------

export const DISPLAY_TOPOLOGY_CLASSIFICATIONS = [
  "INTERNAL_ONLY",
  "EXTERNAL_ONLY",
  "EXTEND",
  "CLONE_OR_DUPLICATE",
  "MULTIPLE_ACTIVE_TARGETS",
  "UNKNOWN",
  "ERROR",
] as const;
export type DisplayTopologyClassification = (typeof DISPLAY_TOPOLOGY_CLASSIFICATIONS)[number];
export function isValidDisplayTopologyClassification(value: string): value is DisplayTopologyClassification {
  return (DISPLAY_TOPOLOGY_CLASSIFICATIONS as readonly string[]).includes(value);
}

/** Single display passes; duplicate/extend block; unknown/error must never silently pass (fail closed). */
export function evaluateDisplayTopology(classification: DisplayTopologyClassification | null): { status: CheckResultState; reasonCode: string } {
  if (classification === null) return { status: "NOT_CHECKED", reasonCode: "TOPOLOGY_NOT_CHECKED" };
  if (classification === "INTERNAL_ONLY" || classification === "EXTERNAL_ONLY") {
    return { status: "PASS", reasonCode: "SINGLE_DISPLAY" };
  }
  if (classification === "EXTEND") return { status: "BLOCKED", reasonCode: "EXTENDED_DISPLAY" };
  if (classification === "CLONE_OR_DUPLICATE") return { status: "BLOCKED", reasonCode: "DUPLICATED_DISPLAY" };
  if (classification === "MULTIPLE_ACTIVE_TARGETS") return { status: "BLOCKED", reasonCode: "MULTIPLE_DISPLAYS" };
  // ERROR / UNKNOWN — authoritative topology could not be established.
  return { status: "BLOCKED", reasonCode: "TOPOLOGY_UNKNOWN" };
}

// ---------------------------------------------------------------------------
// Camera / microphone (Checks F/G) — classification only; never converts a
// stream failure into a person-visibility judgement (that concept doesn't
// exist anywhere in this module).
// ---------------------------------------------------------------------------

export const MEDIA_ERROR_CLASSES = ["PERMISSION_DENIED", "NO_DEVICE", "DEVICE_BUSY", "STREAM_UNAVAILABLE", "UNKNOWN_ERROR"] as const;
export type MediaErrorClass = (typeof MEDIA_ERROR_CLASSES)[number];

/** Maps a getUserMedia DOMException name to a plain-language error class. Unrecognised names fail safe to STREAM_UNAVAILABLE, never silently treated as success. */
export function classifyGetUserMediaError(errorName: string | null): MediaErrorClass | null {
  if (!errorName) return null;
  switch (errorName) {
    case "NotAllowedError":
    case "SecurityError":
    case "PermissionDeniedError":
      return "PERMISSION_DENIED";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "NO_DEVICE";
    case "NotReadableError":
    case "TrackStartError":
      return "DEVICE_BUSY";
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
    case "AbortError":
      return "STREAM_UNAVAILABLE";
    default:
      return "UNKNOWN_ERROR";
  }
}

export type CameraFrameQuality = "ok" | "blocked" | "dark";

export type CameraCheckEvaluation = { status: CheckResultState; reasonCode: string };

/**
 * A failed/unavailable stream is always STREAM_UNAVAILABLE-shaped — it is
 * NEVER converted into "no person visible" (Part F: "Do not convert
 * stream failure into 'no person visible'"). Frame-quality classification
 * (dark/blocked) reuses the exact same thresholds as the live exam-time
 * camera integrity module (see src/lib/cameraIntegrityDetection.ts) but
 * this module never runs person detection — it only confirms the stream
 * itself is operational.
 */
export function evaluateCameraCheck(params: {
  errorClass: MediaErrorClass | null;
  streamProducedFrame: boolean;
  frameQuality: CameraFrameQuality | null;
}): CameraCheckEvaluation {
  if (params.errorClass === "PERMISSION_DENIED") return { status: "BLOCKED", reasonCode: "PERMISSION_DENIED" };
  if (params.errorClass === "NO_DEVICE") return { status: "BLOCKED", reasonCode: "NO_DEVICE" };
  if (params.errorClass === "DEVICE_BUSY") return { status: "BLOCKED", reasonCode: "DEVICE_BUSY" };
  if (params.errorClass === "STREAM_UNAVAILABLE" || params.errorClass === "UNKNOWN_ERROR") {
    return { status: "BLOCKED", reasonCode: "STREAM_UNAVAILABLE" };
  }
  if (!params.streamProducedFrame) return { status: "BLOCKED", reasonCode: "STREAM_UNAVAILABLE" };
  if (params.frameQuality === "dark") return { status: "WARNING", reasonCode: "LIGHTING_TOO_LOW" };
  if (params.frameQuality === "blocked") return { status: "WARNING", reasonCode: "VISIBILITY_UNCERTAIN" };
  return { status: "PASS", reasonCode: "OPERATIONAL" };
}

export type MicrophoneCheckEvaluation = { status: CheckResultState; reasonCode: string };

export function evaluateMicrophoneCheck(params: { errorClass: MediaErrorClass | null; streamStarted: boolean }): MicrophoneCheckEvaluation {
  if (params.errorClass === "PERMISSION_DENIED") return { status: "BLOCKED", reasonCode: "PERMISSION_DENIED" };
  if (params.errorClass === "NO_DEVICE") return { status: "BLOCKED", reasonCode: "NO_DEVICE" };
  if (params.errorClass === "DEVICE_BUSY") return { status: "BLOCKED", reasonCode: "DEVICE_BUSY" };
  if (params.errorClass === "STREAM_UNAVAILABLE" || params.errorClass === "UNKNOWN_ERROR") {
    return { status: "BLOCKED", reasonCode: "STREAM_UNAVAILABLE" };
  }
  if (!params.streamStarted) return { status: "BLOCKED", reasonCode: "STREAM_UNAVAILABLE" };
  return { status: "PASS", reasonCode: "OPERATIONAL" };
}

// ---------------------------------------------------------------------------
// Network/connectivity (Check H) — warning thresholds, never a bandwidth
// or "guaranteed exam experience" claim.
// ---------------------------------------------------------------------------

export const DEFAULT_LATENCY_WARN_MS = 800;
export const DEFAULT_LATENCY_BLOCK_MS = 5_000;

export type NetworkCheckEvaluation = { status: CheckResultState; reasonCode: string };

export function evaluateNetworkCheck(params: {
  allEndpointsReachable: boolean;
  approxLatencyMs: number | null;
  warnThresholdMs?: number;
  blockThresholdMs?: number;
}): NetworkCheckEvaluation {
  if (!params.allEndpointsReachable) return { status: "BLOCKED", reasonCode: "ENDPOINT_UNREACHABLE" };
  const warnThreshold = params.warnThresholdMs ?? DEFAULT_LATENCY_WARN_MS;
  const blockThreshold = params.blockThresholdMs ?? DEFAULT_LATENCY_BLOCK_MS;
  if (params.approxLatencyMs == null) return { status: "WARNING", reasonCode: "LATENCY_UNKNOWN" };
  if (params.approxLatencyMs >= blockThreshold) return { status: "BLOCKED", reasonCode: "LATENCY_VERY_HIGH" };
  if (params.approxLatencyMs >= warnThreshold) return { status: "WARNING", reasonCode: "LATENCY_HIGH" };
  return { status: "PASS", reasonCode: "OPERATIONAL" };
}

// ---------------------------------------------------------------------------
// Clock difference (Check I) — block only when the difference would
// genuinely invalidate a secure launch/session token. Default block
// threshold is kept comfortably inside DEFAULT_SECURE_LAUNCH_TOKEN_TTL_SECONDS
// (see src/lib/secureClientPolicy.ts) so a BLOCKED clock result means a
// real launch would actually fail, not merely "slightly off".
// ---------------------------------------------------------------------------

export const DEFAULT_CLOCK_WARN_MS = 60_000;
export const DEFAULT_CLOCK_BLOCK_MS = 240_000;

export function evaluateClockDifference(
  clientTimeMs: number,
  serverTimeMs: number,
  warnThresholdMs: number = DEFAULT_CLOCK_WARN_MS,
  blockThresholdMs: number = DEFAULT_CLOCK_BLOCK_MS,
): { status: CheckResultState; reasonCode: string; differenceMs: number } {
  const differenceMs = Math.abs(clientTimeMs - serverTimeMs);
  if (differenceMs >= blockThresholdMs) return { status: "BLOCKED", reasonCode: "CLOCK_DIFFERENCE_SEVERE", differenceMs };
  if (differenceMs >= warnThresholdMs) return { status: "WARNING", reasonCode: "CLOCK_DIFFERENCE_MATERIAL", differenceMs };
  return { status: "PASS", reasonCode: "CLOCK_ALIGNED", differenceMs };
}

// ---------------------------------------------------------------------------
// Local secure-client bridge (Check J) — confirms the four narrowly
// scoped, read-only preload methods this feature adds are actually
// present. Never itself a security boundary (contextIsolation/
// nodeIntegration are packaging-time guarantees, not something this
// runtime check can verify) — only a readiness signal that the
// installed build is new enough to expose them at all.
// ---------------------------------------------------------------------------

export type BridgeCapabilities = {
  getClientVersion: boolean;
  getOperatingSystemInfo: boolean;
  getDisplayTopology: boolean;
  getSecureClientCapabilities: boolean;
};

export function evaluateBridgeCapabilities(capabilities: BridgeCapabilities | null): { status: CheckResultState; reasonCode: string } {
  if (!capabilities) return { status: "NOT_CHECKED", reasonCode: "BRIDGE_NOT_CHECKED" };
  const allPresent = capabilities.getClientVersion && capabilities.getOperatingSystemInfo && capabilities.getDisplayTopology && capabilities.getSecureClientCapabilities;
  return allPresent ? { status: "PASS", reasonCode: "BRIDGE_AVAILABLE" } : { status: "BLOCKED", reasonCode: "BRIDGE_INCOMPLETE" };
}

/** Minimum time between two stored runs for the same student — prevents a fast client retry loop from flooding the table (mirrors HEARTBEAT_DEDUPE_WINDOW_MS in session-heartbeat/route.ts). */
export const MIN_RUN_INTERVAL_MS = 5_000;

// ---------------------------------------------------------------------------
// Expiry (freshness)
// ---------------------------------------------------------------------------

export function computeExpiresAtMs(checkedAtMs: number, validityHours: number): number {
  return checkedAtMs + Math.max(0, validityHours) * 60 * 60 * 1000;
}

export function isRunExpired(expiresAtMs: number, nowMs: number): boolean {
  return nowMs >= expiresAtMs;
}

// ---------------------------------------------------------------------------
// Mode configuration (OFF / WARN / REQUIRE)
// ---------------------------------------------------------------------------

export const SYSTEM_CHECK_MODES = ["OFF", "WARN", "REQUIRE"] as const;
export type SystemCheckMode = (typeof SYSTEM_CHECK_MODES)[number];

/** Missing or malformed configuration must never accidentally block all students — always falls back to WARN. */
export function resolveSystemCheckMode(raw: string | undefined | null): SystemCheckMode {
  if (raw === "OFF" || raw === "WARN" || raw === "REQUIRE") return raw;
  return "WARN";
}

// ---------------------------------------------------------------------------
// Final-examination gate — the ONLY place that decides whether a stored
// readiness record permits proceeding into the Tether launch flow. This
// NEVER authorizes exam content by itself; it only decides whether the
// student may proceed to the (unchanged) real launch/attestation flow,
// which always runs again regardless of this gate's outcome.
// ---------------------------------------------------------------------------

export type FinalExamGateInput = {
  mode: SystemCheckMode;
  isFinalExamination: boolean;
  latestRun: { overallStatus: OverallState; expiresAtMs: number } | null;
  nowMs: number;
};

export type FinalExamGateResult =
  | { allowed: true }
  | { allowed: false; reason: "SYSTEM_CHECK_REQUIRED" | "SYSTEM_CHECK_EXPIRED" | "SYSTEM_CHECK_NOT_READY" };

export function evaluateFinalExamSystemCheckGate(input: FinalExamGateInput): FinalExamGateResult {
  // OFF and WARN never block continuation; non-final assessments are
  // never in scope for this gate at all, in any mode.
  if (input.mode !== "REQUIRE" || !input.isFinalExamination) return { allowed: true };
  if (!input.latestRun) return { allowed: false, reason: "SYSTEM_CHECK_REQUIRED" };
  if (isRunExpired(input.latestRun.expiresAtMs, input.nowMs)) return { allowed: false, reason: "SYSTEM_CHECK_EXPIRED" };
  if (input.latestRun.overallStatus === "NOT_READY") return { allowed: false, reason: "SYSTEM_CHECK_NOT_READY" };
  // READY or READY_WITH_WARNINGS are both permitted in REQUIRE mode.
  return { allowed: true };
}
