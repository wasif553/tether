/**
 * Tether Secure Client Foundation + Safe Exam Browser Compatibility v1 —
 * pure policy module. See docs/secure-client-foundation-seb-v1.md.
 *
 * Pure, dependency-free, deterministic: no Prisma, no Next.js, no browser
 * APIs. Defines the delivery-mode enum, the immutable per-attempt policy
 * snapshot shape (mirroring src/lib/screenSharePolicy.ts /
 * src/lib/answerProvenancePolicy.ts), and server-side bounds. THIS IS AN
 * INTEGRITY-REVIEW / COMPATIBILITY feature — "cheat-resistant", never
 * "cheat-proof" or "impossible to bypass". The web examination platform
 * remains fully functional without SEB or a future Tether client:
 * deliveryMode defaults to STANDARD_WEB everywhere, and every downstream
 * check is skipped entirely unless a lecturer explicitly opts an exam
 * into a stronger mode.
 */

export const SECURE_CLIENT_POLICY_VERSION = "v1.0";
/** Bumped only if the snapshot's shape changes in a way old snapshots can't be read as. */
export const SECURE_CLIENT_SNAPSHOT_SCHEMA_VERSION = 1;

export const DELIVERY_MODES = [
  "STANDARD_WEB",
  "MONITORED_WEB",
  "SEB_OPTIONAL",
  "SEB_REQUIRED",
  "TETHER_CLIENT_OPTIONAL",
  "TETHER_CLIENT_REQUIRED",
] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];
export function isValidDeliveryMode(value: string): value is DeliveryMode {
  return (DELIVERY_MODES as readonly string[]).includes(value);
}

/** Delivery modes that require an active, verified secure-client session (SEB or Tether) before an attempt may start. */
export const SECURE_CLIENT_REQUIRED_MODES: ReadonlySet<DeliveryMode> = new Set(["SEB_REQUIRED", "TETHER_CLIENT_REQUIRED"]);
/** Delivery modes where a secure client is offered but ordinary web start remains available. */
export const SECURE_CLIENT_OPTIONAL_MODES: ReadonlySet<DeliveryMode> = new Set(["SEB_OPTIONAL", "TETHER_CLIENT_OPTIONAL"]);

export function deliveryModeRequiresSecureClient(mode: DeliveryMode): boolean {
  return SECURE_CLIENT_REQUIRED_MODES.has(mode);
}
export function deliveryModeOffersSecureClient(mode: DeliveryMode): boolean {
  return SECURE_CLIENT_REQUIRED_MODES.has(mode) || SECURE_CLIENT_OPTIONAL_MODES.has(mode);
}

export const CLIENT_TYPES = ["SAFE_EXAM_BROWSER", "TETHER_SECURE_CLIENT", "MOCK_TETHER_CLIENT"] as const;
export type ClientType = (typeof CLIENT_TYPES)[number];
export function isValidClientType(value: string): value is ClientType {
  return (CLIENT_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Server-side hard bounds (Part 1) — the single source of truth. Any
// lecturer- or client-supplied value outside these is clamped, never
// trusted verbatim.
// ---------------------------------------------------------------------------

export const DEFAULT_SECURE_LAUNCH_TOKEN_TTL_SECONDS = 300;
export const MIN_SECURE_LAUNCH_TOKEN_TTL_SECONDS = 60;
export const MAX_SECURE_LAUNCH_TOKEN_TTL_SECONDS = 900;

export const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 30;
export const MIN_HEARTBEAT_INTERVAL_SECONDS = 15;
export const MAX_HEARTBEAT_INTERVAL_SECONDS = 120;

export const DEFAULT_HEARTBEAT_GRACE_SECONDS = 90;
export const MIN_HEARTBEAT_GRACE_SECONDS = 30;
export const MAX_HEARTBEAT_GRACE_SECONDS = 300;

export const DEFAULT_MAXIMUM_DISPLAYS = 1;
export const MIN_MAXIMUM_DISPLAYS = 1;
export const MAX_MAXIMUM_DISPLAYS = 3;

export const DEFAULT_CLIENT_EVENT_RETENTION_DAYS = 180;
export const MIN_CLIENT_EVENT_RETENTION_DAYS = 30;
export const MAX_CLIENT_EVENT_RETENTION_DAYS = 730;

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export const clampSecureLaunchTokenTtlSeconds = (v: number) =>
  clampInt(v, MIN_SECURE_LAUNCH_TOKEN_TTL_SECONDS, MAX_SECURE_LAUNCH_TOKEN_TTL_SECONDS, DEFAULT_SECURE_LAUNCH_TOKEN_TTL_SECONDS);
export const clampHeartbeatIntervalSeconds = (v: number) =>
  clampInt(v, MIN_HEARTBEAT_INTERVAL_SECONDS, MAX_HEARTBEAT_INTERVAL_SECONDS, DEFAULT_HEARTBEAT_INTERVAL_SECONDS);
export const clampHeartbeatGraceSeconds = (v: number) =>
  clampInt(v, MIN_HEARTBEAT_GRACE_SECONDS, MAX_HEARTBEAT_GRACE_SECONDS, DEFAULT_HEARTBEAT_GRACE_SECONDS);
export const clampMaximumDisplays = (v: number) => clampInt(v, MIN_MAXIMUM_DISPLAYS, MAX_MAXIMUM_DISPLAYS, DEFAULT_MAXIMUM_DISPLAYS);
export const clampClientEventRetentionDays = (v: number) =>
  clampInt(v, MIN_CLIENT_EVENT_RETENTION_DAYS, MAX_CLIENT_EVENT_RETENTION_DAYS, DEFAULT_CLIENT_EVENT_RETENTION_DAYS);

// ---------------------------------------------------------------------------
// Policy snapshot (Part 1/2)
// ---------------------------------------------------------------------------

export type SecureClientPolicy = {
  schemaVersion: number;
  policyVersion: string;
  deliveryMode: DeliveryMode;
  allowedClientTypes: ClientType[];
  requireVerifiedClient: boolean;
  allowedSebPlatforms: string[];
  allowedSebVersions: string[];
  requireSebBrowserExamKey: boolean;
  requireSebConfigKey: boolean;
  allowSebHeaderValidation: boolean;
  allowSebJavascriptApiValidation: boolean;
  secureLaunchTokenTtlSeconds: number;
  heartbeatIntervalSeconds: number;
  heartbeatGraceSeconds: number;
  requireDisplayCheck: boolean;
  maximumDisplays: number;
  requireRemoteSessionCheck: boolean;
  requireVirtualMachineCheck: boolean;
  requireProcessCheck: boolean;
  requireCaptureProtectionCheck: boolean;
  allowClipboard: boolean;
  allowPrinting: boolean;
  allowExternalNavigation: boolean;
  allowApplicationSwitching: boolean;
  allowRecovery: boolean;
  clientEventRetentionDays: number;
  studentPreflightRequired: boolean;
  lecturerOverrideAllowed: boolean;
  /** ISO-8601 timestamp this snapshot was built — part of the immutable record itself, not just implied by Submission.createdAt. */
  createdAt: string;
};

/** STANDARD_WEB baseline — fully permissive, nothing required. This is the "web platform remains fully functional" default. */
export const DISABLED_SECURE_CLIENT_POLICY: SecureClientPolicy = {
  schemaVersion: SECURE_CLIENT_SNAPSHOT_SCHEMA_VERSION,
  policyVersion: SECURE_CLIENT_POLICY_VERSION,
  deliveryMode: "STANDARD_WEB",
  allowedClientTypes: [],
  requireVerifiedClient: false,
  allowedSebPlatforms: [],
  allowedSebVersions: [],
  requireSebBrowserExamKey: false,
  requireSebConfigKey: false,
  allowSebHeaderValidation: true,
  allowSebJavascriptApiValidation: true,
  secureLaunchTokenTtlSeconds: DEFAULT_SECURE_LAUNCH_TOKEN_TTL_SECONDS,
  heartbeatIntervalSeconds: DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
  heartbeatGraceSeconds: DEFAULT_HEARTBEAT_GRACE_SECONDS,
  requireDisplayCheck: false,
  maximumDisplays: DEFAULT_MAXIMUM_DISPLAYS,
  requireRemoteSessionCheck: false,
  requireVirtualMachineCheck: false,
  requireProcessCheck: false,
  requireCaptureProtectionCheck: false,
  allowClipboard: true,
  allowPrinting: true,
  allowExternalNavigation: true,
  allowApplicationSwitching: true,
  allowRecovery: true,
  clientEventRetentionDays: DEFAULT_CLIENT_EVENT_RETENTION_DAYS,
  studentPreflightRequired: false,
  lecturerOverrideAllowed: true,
  createdAt: new Date(0).toISOString(),
};

export type RelevantSecureClientSettings = {
  deliveryMode: DeliveryMode;
  allowedSebPlatforms: string[];
  allowedSebVersions: string[];
  requireSebBrowserExamKey: boolean;
  requireSebConfigKey: boolean;
  allowSebHeaderValidation: boolean;
  allowSebJavascriptApiValidation: boolean;
  secureLaunchTokenTtlSeconds: number;
  secureClientHeartbeatIntervalSeconds: number;
  secureClientHeartbeatGraceSeconds: number;
  requireDisplayCheck: boolean;
  secureClientMaximumDisplays: number;
  requireRemoteSessionCheck: boolean;
  requireVirtualMachineCheck: boolean;
  requireProcessCheck: boolean;
  requireCaptureProtectionCheck: boolean;
  /** Existing exam-policy value this feature derives allowClipboard from — see secureExam.ts blockCopyPaste. */
  blockCopyPaste: boolean;
  secureClientAllowPrinting: boolean;
  secureClientAllowExternalNavigation: boolean;
  secureClientAllowApplicationSwitching: boolean;
  secureClientAllowRecovery: boolean;
  secureClientEventRetentionDays: number;
  secureClientLecturerOverrideAllowed: boolean;
};

export type SecureClientAvailability = {
  /** Internal feature flag — TETHER_CLIENT_OPTIONAL is visible only behind this. Never true in Production by default (Part 1/9). */
  tetherClientOptionalAvailable: boolean;
  /** TETHER_CLIENT_REQUIRED cannot be selected for real exams until a signed production client exists — always false until that ships. */
  tetherClientRequiredAvailable: boolean;
};

export const DEFAULT_SECURE_CLIENT_AVAILABILITY: SecureClientAvailability = {
  tetherClientOptionalAvailable: false,
  tetherClientRequiredAvailable: false,
};

/**
 * Resolves the delivery mode actually in effect, downgrading a
 * not-yet-available Tether mode to STANDARD_WEB rather than silently
 * requiring something the platform cannot yet fulfil — never a
 * client-supplied query parameter can influence this (Part 9).
 */
export function resolveEffectiveDeliveryMode(mode: DeliveryMode, availability: SecureClientAvailability): DeliveryMode {
  if (mode === "TETHER_CLIENT_OPTIONAL" && !availability.tetherClientOptionalAvailable) return "STANDARD_WEB";
  if (mode === "TETHER_CLIENT_REQUIRED" && !availability.tetherClientRequiredAvailable) return "STANDARD_WEB";
  return mode;
}

function defaultAllowedClientTypesFor(mode: DeliveryMode): ClientType[] {
  if (mode === "SEB_OPTIONAL" || mode === "SEB_REQUIRED") return ["SAFE_EXAM_BROWSER"];
  if (mode === "TETHER_CLIENT_OPTIONAL" || mode === "TETHER_CLIENT_REQUIRED") return ["TETHER_SECURE_CLIENT"];
  return [];
}

/**
 * Builds the effective policy from CURRENT exam settings. Called once, at
 * attempt start, to produce the immutable snapshot
 * (Submission.secureClientPolicySnapshotJson) — never called again for an
 * in-progress attempt; request-time decisions must read the stored
 * snapshot via parseSecureClientPolicy below.
 */
export function buildSecureClientPolicySnapshot(
  settings: RelevantSecureClientSettings,
  availability: SecureClientAvailability = DEFAULT_SECURE_CLIENT_AVAILABILITY,
  builtAt: Date = new Date(),
): SecureClientPolicy {
  const deliveryMode = resolveEffectiveDeliveryMode(settings.deliveryMode, availability);
  if (deliveryMode === "STANDARD_WEB") {
    return { ...DISABLED_SECURE_CLIENT_POLICY, createdAt: builtAt.toISOString() };
  }

  const requiresSecureClient = deliveryModeRequiresSecureClient(deliveryMode);
  const offersSecureClient = deliveryModeOffersSecureClient(deliveryMode);
  // Secure-client modes are more restrictive by default (Part 1 —
  // "false for secure-client modes") — a lecturer's explicit permissive
  // choice is still honoured, this only supplies the conservative default
  // when the setting itself hasn't been reasoned about for this mode.
  const restrictiveDefault = requiresSecureClient;

  return {
    schemaVersion: SECURE_CLIENT_SNAPSHOT_SCHEMA_VERSION,
    policyVersion: SECURE_CLIENT_POLICY_VERSION,
    deliveryMode,
    allowedClientTypes: offersSecureClient ? defaultAllowedClientTypesFor(deliveryMode) : [],
    requireVerifiedClient: requiresSecureClient,
    allowedSebPlatforms: [...settings.allowedSebPlatforms],
    allowedSebVersions: [...settings.allowedSebVersions],
    requireSebBrowserExamKey: settings.requireSebBrowserExamKey,
    requireSebConfigKey: settings.requireSebConfigKey,
    allowSebHeaderValidation: settings.allowSebHeaderValidation,
    allowSebJavascriptApiValidation: settings.allowSebJavascriptApiValidation,
    secureLaunchTokenTtlSeconds: clampSecureLaunchTokenTtlSeconds(settings.secureLaunchTokenTtlSeconds),
    heartbeatIntervalSeconds: clampHeartbeatIntervalSeconds(settings.secureClientHeartbeatIntervalSeconds),
    heartbeatGraceSeconds: clampHeartbeatGraceSeconds(settings.secureClientHeartbeatGraceSeconds),
    requireDisplayCheck: settings.requireDisplayCheck,
    maximumDisplays: clampMaximumDisplays(settings.secureClientMaximumDisplays),
    requireRemoteSessionCheck: settings.requireRemoteSessionCheck,
    requireVirtualMachineCheck: settings.requireVirtualMachineCheck,
    requireProcessCheck: settings.requireProcessCheck,
    requireCaptureProtectionCheck: settings.requireCaptureProtectionCheck,
    allowClipboard: !settings.blockCopyPaste,
    allowPrinting: restrictiveDefault ? false : settings.secureClientAllowPrinting,
    allowExternalNavigation: restrictiveDefault ? false : settings.secureClientAllowExternalNavigation,
    allowApplicationSwitching: restrictiveDefault ? false : settings.secureClientAllowApplicationSwitching,
    allowRecovery: settings.secureClientAllowRecovery,
    clientEventRetentionDays: clampClientEventRetentionDays(settings.secureClientEventRetentionDays),
    studentPreflightRequired: requiresSecureClient,
    lecturerOverrideAllowed: settings.secureClientLecturerOverrideAllowed,
    createdAt: builtAt.toISOString(),
  };
}

/**
 * Reads back a stored snapshot
 * (Submission.secureClientPolicySnapshotJson). A null/malformed/missing
 * snapshot ALWAYS means legacy behaviour / STANDARD_WEB — never silently
 * secure-client-required, and never re-derived from the exam's current
 * (possibly since-changed) settings. This is the one function every
 * request-time decision must go through. Existing in-progress attempts
 * at deploy time (null snapshot) can never retroactively become
 * secure-client-required.
 */
export function parseSecureClientPolicy(raw: unknown): SecureClientPolicy {
  if (raw == null || typeof raw !== "object") return { ...DISABLED_SECURE_CLIENT_POLICY };
  const obj = raw as Record<string, unknown>;
  const deliveryMode: DeliveryMode = typeof obj.deliveryMode === "string" && isValidDeliveryMode(obj.deliveryMode) ? obj.deliveryMode : "STANDARD_WEB";
  if (deliveryMode === "STANDARD_WEB") return { ...DISABLED_SECURE_CLIENT_POLICY };

  const requiresSecureClient = deliveryModeRequiresSecureClient(deliveryMode);
  const restrictiveDefault = requiresSecureClient;
  const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const clientTypeArray = (v: unknown): ClientType[] =>
    Array.isArray(v) ? v.filter((x): x is ClientType => typeof x === "string" && isValidClientType(x)) : [];

  return {
    schemaVersion: typeof obj.schemaVersion === "number" ? obj.schemaVersion : SECURE_CLIENT_SNAPSHOT_SCHEMA_VERSION,
    policyVersion: typeof obj.policyVersion === "string" ? obj.policyVersion : SECURE_CLIENT_POLICY_VERSION,
    deliveryMode,
    allowedClientTypes: clientTypeArray(obj.allowedClientTypes),
    requireVerifiedClient: obj.requireVerifiedClient === true,
    allowedSebPlatforms: strArray(obj.allowedSebPlatforms),
    allowedSebVersions: strArray(obj.allowedSebVersions),
    requireSebBrowserExamKey: obj.requireSebBrowserExamKey === true,
    requireSebConfigKey: obj.requireSebConfigKey === true,
    allowSebHeaderValidation: obj.allowSebHeaderValidation !== false,
    allowSebJavascriptApiValidation: obj.allowSebJavascriptApiValidation !== false,
    secureLaunchTokenTtlSeconds: clampSecureLaunchTokenTtlSeconds(
      typeof obj.secureLaunchTokenTtlSeconds === "number" ? obj.secureLaunchTokenTtlSeconds : DEFAULT_SECURE_LAUNCH_TOKEN_TTL_SECONDS,
    ),
    heartbeatIntervalSeconds: clampHeartbeatIntervalSeconds(
      typeof obj.heartbeatIntervalSeconds === "number" ? obj.heartbeatIntervalSeconds : DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
    ),
    heartbeatGraceSeconds: clampHeartbeatGraceSeconds(
      typeof obj.heartbeatGraceSeconds === "number" ? obj.heartbeatGraceSeconds : DEFAULT_HEARTBEAT_GRACE_SECONDS,
    ),
    requireDisplayCheck: obj.requireDisplayCheck === true,
    maximumDisplays: clampMaximumDisplays(typeof obj.maximumDisplays === "number" ? obj.maximumDisplays : DEFAULT_MAXIMUM_DISPLAYS),
    requireRemoteSessionCheck: obj.requireRemoteSessionCheck === true,
    requireVirtualMachineCheck: obj.requireVirtualMachineCheck === true,
    requireProcessCheck: obj.requireProcessCheck === true,
    requireCaptureProtectionCheck: obj.requireCaptureProtectionCheck === true,
    allowClipboard: obj.allowClipboard !== false,
    allowPrinting: restrictiveDefault ? obj.allowPrinting === true : obj.allowPrinting !== false,
    allowExternalNavigation: restrictiveDefault ? obj.allowExternalNavigation === true : obj.allowExternalNavigation !== false,
    allowApplicationSwitching: restrictiveDefault ? obj.allowApplicationSwitching === true : obj.allowApplicationSwitching !== false,
    allowRecovery: obj.allowRecovery !== false,
    clientEventRetentionDays: clampClientEventRetentionDays(
      typeof obj.clientEventRetentionDays === "number" ? obj.clientEventRetentionDays : DEFAULT_CLIENT_EVENT_RETENTION_DAYS,
    ),
    studentPreflightRequired: requiresSecureClient,
    lecturerOverrideAllowed: obj.lecturerOverrideAllowed !== false,
    createdAt: typeof obj.createdAt === "string" ? obj.createdAt : new Date(0).toISOString(),
  };
}

export function isSecureClientDeliveryEnabled(policy: Pick<SecureClientPolicy, "deliveryMode">): boolean {
  return policy.deliveryMode !== "STANDARD_WEB";
}
export function isSecureClientRequired(policy: Pick<SecureClientPolicy, "deliveryMode">): boolean {
  return deliveryModeRequiresSecureClient(policy.deliveryMode);
}
export function isSecureClientOffered(policy: Pick<SecureClientPolicy, "deliveryMode">): boolean {
  return deliveryModeOffersSecureClient(policy.deliveryMode);
}
