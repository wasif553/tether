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
// Single Display Requirement v1 — see docs/secure-client-foundation-seb-v1.md,
// "Display requirement". This does NOT claim STANDARD_WEB can reliably
// detect additional, mirrored, or extended displays — see
// isDisplayPolicyCombinationValid below, which is the enforcement
// boundary: SINGLE_DISPLAY_REQUIRED is only ever actually wired into a
// generated SEB configuration (src/lib/secureClient/sebConfigGenerator.ts)
// when that boundary already holds.
// ---------------------------------------------------------------------------

export const DISPLAY_POLICIES = ["UNRESTRICTED", "SINGLE_DISPLAY_REQUIRED"] as const;
export type DisplayPolicy = (typeof DISPLAY_POLICIES)[number];
export function isValidDisplayPolicy(value: string): value is DisplayPolicy {
  return (DISPLAY_POLICIES as readonly string[]).includes(value);
}

/**
 * A lecturer may only select SINGLE_DISPLAY_REQUIRED alongside a delivery
 * mode that actually routes the student through a secure client capable
 * of observing display topology — the two SEB modes, or (Tether
 * launch/install flow v1) the two Tether Secure Browser modes — never
 * STANDARD_WEB or MONITORED_WEB, which have no mechanism to enforce or
 * even reliably observe display topology. UNRESTRICTED is always valid
 * regardless of delivery mode. Called both by the lecturer-settings PATCH
 * route (server-side, authoritative — see src/app/api/exams/[id]/route.ts)
 * and by the lecturer UI (client-side convenience only).
 */
export function isDisplayPolicyCombinationValid(deliveryMode: DeliveryMode, displayPolicy: DisplayPolicy): boolean {
  if (displayPolicy !== "SINGLE_DISPLAY_REQUIRED") return true;
  return (
    deliveryMode === "SEB_REQUIRED" ||
    deliveryMode === "SEB_OPTIONAL" ||
    deliveryMode === "TETHER_CLIENT_REQUIRED" ||
    deliveryMode === "TETHER_CLIENT_OPTIONAL"
  );
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
  /**
   * Single Display Requirement v1 — the lecturer-facing display
   * requirement actually in effect for THIS attempt, frozen at attempt
   * start exactly like every other field here. Never re-derive this from
   * live exam settings after an attempt has started (Part 2/4). Always
   * UNRESTRICTED when deliveryMode is STANDARD_WEB or MONITORED_WEB —
   * see isDisplayPolicyCombinationValid.
   */
  displayPolicy: DisplayPolicy;
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
  displayPolicy: "UNRESTRICTED",
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
  displayPolicy: DisplayPolicy;
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
  /**
   * Hardening pass (Part 4): real SEB client compatibility has not yet
   * been validated against this backend — SEB_OPTIONAL stays behind an
   * explicit experimental flag and is never true in Production. See
   * isSebOptionalAvailable() in src/lib/secureClientAvailability.ts.
   */
  sebOptionalAvailable: boolean;
  /**
   * Even more restrictive than sebOptionalAvailable: also requires the
   * exam's institution to be on an explicit allowlist, and is never true
   * in Production. See isSebRequiredAllowed() in
   * src/lib/secureClientAvailability.ts.
   */
  sebRequiredAvailable: boolean;
};

export const DEFAULT_SECURE_CLIENT_AVAILABILITY: SecureClientAvailability = {
  tetherClientOptionalAvailable: false,
  tetherClientRequiredAvailable: false,
  sebOptionalAvailable: false,
  sebRequiredAvailable: false,
};

/**
 * Resolves the delivery mode actually in effect, downgrading a
 * not-yet-available SEB or Tether mode to STANDARD_WEB rather than
 * silently requiring/offering something the platform cannot yet fulfil —
 * never a client-supplied query parameter can influence this (Part 9).
 */
export function resolveEffectiveDeliveryMode(mode: DeliveryMode, availability: SecureClientAvailability): DeliveryMode {
  if (mode === "SEB_OPTIONAL" && !availability.sebOptionalAvailable) return "STANDARD_WEB";
  if (mode === "SEB_REQUIRED" && !availability.sebRequiredAvailable) return "STANDARD_WEB";
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

  // Single Display Requirement v1 — re-validated here (not just trusted
  // from the PATCH-time check in src/app/api/exams/[id]/route.ts) against
  // the EFFECTIVE (already-downgraded) deliveryMode, so a SEB_REQUIRED
  // exam whose availability got downgraded to STANDARD_WEB (see
  // resolveEffectiveDeliveryMode above) can never freeze a
  // SINGLE_DISPLAY_REQUIRED snapshot it can't actually enforce.
  const displayPolicy: DisplayPolicy = isDisplayPolicyCombinationValid(deliveryMode, settings.displayPolicy) ? settings.displayPolicy : "UNRESTRICTED";
  const singleDisplayRequired = displayPolicy === "SINGLE_DISPLAY_REQUIRED";

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
    requireDisplayCheck: settings.requireDisplayCheck || singleDisplayRequired,
    maximumDisplays: singleDisplayRequired ? 1 : clampMaximumDisplays(settings.secureClientMaximumDisplays),
    displayPolicy,
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
  // Re-derived from the stored deliveryMode (never trusted as an
  // independent stored value) — the same tamper-safety pattern as
  // restrictiveDefault above: a hand-edited/corrupted stored snapshot
  // claiming SINGLE_DISPLAY_REQUIRED for a mode that can't enforce it
  // (e.g. MONITORED_WEB) is always read back as UNRESTRICTED.
  const storedDisplayPolicy = typeof obj.displayPolicy === "string" && isValidDisplayPolicy(obj.displayPolicy) ? obj.displayPolicy : "UNRESTRICTED";
  const displayPolicy: DisplayPolicy = isDisplayPolicyCombinationValid(deliveryMode, storedDisplayPolicy) ? storedDisplayPolicy : "UNRESTRICTED";
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
    requireDisplayCheck: obj.requireDisplayCheck === true || displayPolicy === "SINGLE_DISPLAY_REQUIRED",
    maximumDisplays:
      displayPolicy === "SINGLE_DISPLAY_REQUIRED"
        ? 1
        : clampMaximumDisplays(typeof obj.maximumDisplays === "number" ? obj.maximumDisplays : DEFAULT_MAXIMUM_DISPLAYS),
    displayPolicy,
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

// ---------------------------------------------------------------------------
// Single Display Requirement v1 — student-facing status. See
// docs/secure-client-foundation-seb-v1.md, "Display requirement" and
// Part 5 (student preflight). This is purely a MESSAGING helper — it
// never queries or guesses at real display state (there is no
// trustworthy browser signal for that; see the prohibition list in
// docs/secure-client-foundation-seb-v1.md). It only describes what is
// (or isn't) being enforced, from the immutable per-attempt snapshot.
// ---------------------------------------------------------------------------

export const DISPLAY_REQUIREMENT_STATUSES = ["NOT_APPLICABLE", "ENFORCED_BY_SECURE_CLIENT", "NOT_ENFORCEABLE_STANDARD_WEB"] as const;
export type DisplayRequirementStatus = (typeof DISPLAY_REQUIREMENT_STATUSES)[number];

export type DisplayRequirementInfo = {
  displayPolicy: DisplayPolicy;
  status: DisplayRequirementStatus;
  title: string | null;
  instruction: string | null;
};

/**
 * Describes the display requirement for student-facing UI/API responses.
 * Never claims STANDARD_WEB enforces anything — the NOT_ENFORCEABLE_STANDARD_WEB
 * branch below is defensive (isDisplayPolicyCombinationValid and the
 * snapshot builder/parser already prevent SINGLE_DISPLAY_REQUIRED from
 * ever coexisting with a non-SEB delivery mode), never something a
 * caller needs to construct a fake PASS/FAIL check result for.
 */
export function describeDisplayRequirement(policy: Pick<SecureClientPolicy, "deliveryMode" | "displayPolicy">): DisplayRequirementInfo {
  if (policy.displayPolicy !== "SINGLE_DISPLAY_REQUIRED") {
    return { displayPolicy: policy.displayPolicy, status: "NOT_APPLICABLE", title: null, instruction: null };
  }
  if (
    policy.deliveryMode === "SEB_REQUIRED" ||
    policy.deliveryMode === "SEB_OPTIONAL" ||
    policy.deliveryMode === "TETHER_CLIENT_REQUIRED" ||
    policy.deliveryMode === "TETHER_CLIENT_OPTIONAL"
  ) {
    return {
      displayPolicy: policy.displayPolicy,
      status: "ENFORCED_BY_SECURE_CLIENT",
      title: "Single display required",
      instruction: "Disconnect additional monitors, projectors, televisions and wireless displays before starting the exam.",
    };
  }
  return {
    displayPolicy: policy.displayPolicy,
    status: "NOT_ENFORCEABLE_STANDARD_WEB",
    title: "Single display required",
    instruction: "Not enforceable in standard web mode.",
  };
}

// ---------------------------------------------------------------------------
// Single Display Requirement v1 — lecturer-facing availability gating.
// Fixes a contradiction in the lecturer exam-settings UI: the "Single
// display required" control must never invite a lecturer into a state
// that isDisplayPolicyCombinationValid (and the PATCH route) will reject.
// It is gated on the SAME SecureClientAvailability booleans already used
// to disable the SEB_OPTIONAL/SEB_REQUIRED delivery-mode radios (Part 4/9
// of the Secure Client Foundation hardening pass) — never a separate,
// possibly-divergent source of truth.
// ---------------------------------------------------------------------------

export const DISPLAY_REQUIREMENT_UNAVAILABLE_TITLE = "Single-display enforcement unavailable";
/**
 * Deliberately does NOT restate "this setting requires a display-aware
 * exam client" — that general capability limitation belongs in the
 * always-visible explanatory text next to the radios (see the lecturer
 * exam page), not here. Repeating it in both places was the duplicated-
 * explanation UX bug this fix removes; this message states only the
 * institution/environment-specific fact the general text can't know.
 *
 * Corrective pass, lecturer availability fix — generalised from "Safe
 * Exam Browser is not enabled..." to cover BOTH exam clients that can
 * actually observe display topology (Tether Secure Browser is the
 * first-party, generally-available one; Safe Exam Browser remains an
 * experimental, allowlisted option) — this message must never claim SEB
 * specifically when Tether is the one that's actually unavailable, or
 * vice versa.
 */
export const DISPLAY_REQUIREMENT_UNAVAILABLE_MESSAGE = "Tether Secure Browser or Safe Exam Browser is not enabled for this institution or environment.";
export const DISPLAY_REQUIREMENT_STORED_BUT_UNAVAILABLE_MESSAGE =
  "Single display required is already saved for this exam, but no display-aware exam client (Tether Secure Browser or Safe Exam Browser) is currently enabled for this institution or environment. This setting cannot be changed or re-saved until access is restored.";

/**
 * INFO: an ordinary, non-blocking fact — UNRESTRICTED remains selected
 * and saving is unaffected, so this must never render as a red error.
 * LOCKED: a stored SINGLE_DISPLAY_REQUIRED policy that can't currently be
 * changed or re-saved — still not a validation error the lecturer caused,
 * but stronger than a passive info note since both controls are frozen.
 */
export type DisplayRequirementNoticeTone = "INFO" | "LOCKED";

export type DisplayRequirementNotice = { title: string; message: string; tone: DisplayRequirementNoticeTone };

export type DisplayRequirementUiState = {
  kind: "AVAILABLE" | "UNAVAILABLE" | "STORED_BUT_UNAVAILABLE";
  /** Whether the "No display restriction" (UNRESTRICTED) radio may be selected. */
  unrestrictedDisabled: boolean;
  /** Whether the "Single display required" radio may be selected. */
  singleDisplayRequiredDisabled: boolean;
  notice: DisplayRequirementNotice | null;
};

/**
 * Decides how the lecturer's display-requirement radios should render,
 * given the authoritative SEB availability result and the DISPLAY POLICY
 * CURRENTLY STORED on the exam (not the lecturer's unsaved draft — this
 * must stay correct even if the lecturer has since toggled a radio
 * locally). `storedDisplayPolicy` distinguishes the two unavailable
 * cases:
 *  - UNAVAILABLE: SEB unavailable, nothing stored to protect. Only
 *    "Single display required" is disabled — Standard web + "No display
 *    restriction" remains a fully valid, selectable, saveable
 *    configuration, so that radio (and saving) must stay enabled.
 *  - STORED_BUT_UNAVAILABLE: SEB unavailable, but SINGLE_DISPLAY_REQUIRED
 *    is already saved from when SEB was available. Both radios are
 *    locked read-only — never silently erased or downgraded, and never
 *    editable back to UNRESTRICTED through this control while SEB is
 *    down, either — so the lecturer sees exactly what's enforced.
 */
export function resolveDisplayRequirementUiState(params: {
  storedDisplayPolicy: DisplayPolicy;
  sebOptionalAvailable: boolean;
  sebRequiredAvailable: boolean;
  /** Lecturer availability fix — Tether Secure Browser is the first-party client and is generally available; must gate this control exactly like the SEB booleans always have, never leave it stuck showing "unavailable" while Tether is actually selectable. */
  tetherClientRequiredAvailable: boolean;
  tetherClientOptionalAvailable: boolean;
}): DisplayRequirementUiState {
  const secureClientAvailable =
    params.sebOptionalAvailable || params.sebRequiredAvailable || params.tetherClientRequiredAvailable || params.tetherClientOptionalAvailable;
  if (secureClientAvailable) {
    return { kind: "AVAILABLE", unrestrictedDisabled: false, singleDisplayRequiredDisabled: false, notice: null };
  }
  if (params.storedDisplayPolicy === "SINGLE_DISPLAY_REQUIRED") {
    return {
      kind: "STORED_BUT_UNAVAILABLE",
      unrestrictedDisabled: true,
      singleDisplayRequiredDisabled: true,
      notice: { title: DISPLAY_REQUIREMENT_UNAVAILABLE_TITLE, message: DISPLAY_REQUIREMENT_STORED_BUT_UNAVAILABLE_MESSAGE, tone: "LOCKED" },
    };
  }
  return {
    kind: "UNAVAILABLE",
    unrestrictedDisabled: false,
    singleDisplayRequiredDisabled: true,
    notice: { title: DISPLAY_REQUIREMENT_UNAVAILABLE_TITLE, message: DISPLAY_REQUIREMENT_UNAVAILABLE_MESSAGE, tone: "INFO" },
  };
}

/**
 * When a lecturer turns on "Single display required" while the draft
 * delivery mode is not already SEB_REQUIRED/SEB_OPTIONAL, picks the
 * delivery mode to switch to: SEB_REQUIRED is preferred when available,
 * falling back to SEB_OPTIONAL as the only other mode
 * isDisplayPolicyCombinationValid accepts. Returns `changed: false` (and
 * echoes the current mode back) both when no switch is needed and — as a
 * defensive fallback that should be unreachable because the calling UI
 * disables the control in this case (see resolveDisplayRequirementUiState)
 * — when neither SEB mode is available.
 */
/**
 * Lecturer availability fix — preference order when auto-switching:
 * TETHER_CLIENT_REQUIRED first (Tether Secure Browser is the first-party
 * production client and the primary Tether workflow — SEB is not),
 * then SEB_REQUIRED, then the two OPTIONAL modes, matching "prefer
 * REQUIRED (stronger guarantee, matching Single display required's own
 * strictness) and prefer Tether over SEB within the same tier."
 */
export function resolveDeliveryModeForSingleDisplayRequired(params: {
  currentDeliveryMode: DeliveryMode;
  sebOptionalAvailable: boolean;
  sebRequiredAvailable: boolean;
  tetherClientRequiredAvailable: boolean;
  tetherClientOptionalAvailable: boolean;
}): { deliveryMode: DeliveryMode; changed: boolean } {
  if (isDisplayPolicyCombinationValid(params.currentDeliveryMode, "SINGLE_DISPLAY_REQUIRED")) {
    return { deliveryMode: params.currentDeliveryMode, changed: false };
  }
  if (params.tetherClientRequiredAvailable) return { deliveryMode: "TETHER_CLIENT_REQUIRED", changed: true };
  if (params.sebRequiredAvailable) return { deliveryMode: "SEB_REQUIRED", changed: true };
  if (params.tetherClientOptionalAvailable) return { deliveryMode: "TETHER_CLIENT_OPTIONAL", changed: true };
  if (params.sebOptionalAvailable) return { deliveryMode: "SEB_OPTIONAL", changed: true };
  return { deliveryMode: params.currentDeliveryMode, changed: false };
}

/**
 * Single source of truth for whether the lecturer's current draft
 * (deliveryMode, displayPolicy) must be blocked from saving because of
 * SINGLE_DISPLAY_REQUIRED — combining the base combination rule
 * (isDisplayPolicyCombinationValid, which alone already blocks e.g.
 * STANDARD_WEB regardless of availability — including if the disabled
 * radio were bypassed via manipulated client state) with the
 * availability-gating rule this fix adds (a valid SEB_REQUIRED/
 * SEB_OPTIONAL combination that has since lost SEB availability). Used by
 * both the lecturer UI's pre-save guard and is safe to reuse server-side;
 * either way the PATCH route's own isDisplayPolicyCombinationValid check
 * remains the final authority (Part 7 — server-side validation retained).
 */
export function isDisplayPolicySaveBlocked(params: {
  deliveryMode: DeliveryMode;
  displayPolicy: DisplayPolicy;
  sebOptionalAvailable: boolean;
  sebRequiredAvailable: boolean;
  tetherClientRequiredAvailable: boolean;
  tetherClientOptionalAvailable: boolean;
}): boolean {
  if (params.displayPolicy !== "SINGLE_DISPLAY_REQUIRED") return false;
  if (!isDisplayPolicyCombinationValid(params.deliveryMode, params.displayPolicy)) return true;
  return !params.sebOptionalAvailable && !params.sebRequiredAvailable && !params.tetherClientRequiredAvailable && !params.tetherClientOptionalAvailable;
}
