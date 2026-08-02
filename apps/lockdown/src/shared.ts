/**
 * Constants shared between the main and preload processes. Keeping this
 * in one place avoids the version string / protocol name drifting between
 * the two bundles.
 */

// Corrective pass v1.2.2 — the physical diagnostic (v1.2.1's own panel
// and log) traced the remaining defect: display detection was already
// correct (Duplicate -> CLONE_OR_DUPLICATE, Extend -> EXTEND), but
// entering an exam via the direct-launch workflow never actually
// established a verified secure-client session, so enforcement never
// activated at all (submissionIdPresent/deliveryMode/etc all stayed
// null/false). Two real defects, both server/page-side, fixed this pass:
// (1) consuming a launch manifest only ever CREATED a session
// (verificationStatus NOT_CHECKED) — nothing in the real flow called
// POST /api/secure-client/sessions/[sessionId]/attestation, the ONLY
// thing that ever transitions a session to VERIFIED, except the dev mock
// client simulator. src/app/student/exams/[id]/tether-launch/page.tsx
// now submits one immediately after a successful consume. (2) the
// dashboard's Start/Continue links, inside Tether, routed through the
// join page / a raw submission link instead of the same /tether-launch
// page a protocol launch uses — now unified via
// examEntryHref/continueEntryHref in src/app/student/page.tsx. Also:
// the fail-closed cover now activates from the CLICK on Start/Continue
// (not just once the exam content page mounts — see
// runLaunchSequence's uncoverOnFailure), and a camera capture/resource
// interruption (Windows Media Foundation "Failed to reserve output
// capture buffer", commonly another app holding the camera) is now
// reported as CAMERA_STREAM_UNAVAILABLE instead of being silently fed
// into person-detection as face absence (see classifyCameraStreamHealth
// in src/lib/cameraIntegrityDetection.ts — web-app-side, unrelated to
// this Electron bridge but shipped in the same corrective pass).
//
// v1.2.1 (previous) — replaced the plain requireSingleDisplay boolean
// with an explicit {active, ready, requireSingleDisplay} contract that
// fails CLOSED for any TETHER_CLIENT_REQUIRED exam, added the dev-only
// diagnostic panel/log (tetherDiagnosticsSnapshot.ts) and the packaging-
// content assertion (verifyPackagedRelease.ts).
// v1.2.0 — fixed the Extend-mode enforcement activation bug (debounce
// was silently dropping policy-driven evaluation), added Windows-native
// Duplicate/Clone topology detection and periodic re-checking.
//
// v1.3.0 — Tether System Check and Exam Readiness v1 (see
// docs/tether-system-check-v1.md): adds four narrowly scoped, read-only
// preload methods (getClientVersion, getOperatingSystemInfo,
// getDisplayTopology, getSecureClientCapabilities) so the new
// /student/system-check page can report genuine native readiness
// signals. Purely additive — no change to contextIsolation,
// nodeIntegration, sandbox, or any existing IPC channel.
//
// v1.4.0 — WITHDRAWN, must never be distributed. Shipped
// attestSystemCheck backed by a SINGLE Ed25519 private key compiled
// into EVERY packaged build (clientAttestationKey.ts, since deleted). A
// security review correctly identified this as a critical flaw: that
// key is extractable from the installer/packaged resources/process
// memory, and one extraction would have compromised every installation
// using it. See docs/tether-system-check-v1.md, "Secure Client
// Attestation v2" for the replacement design and the full writeup of
// why the v1.4.0 design was insecure.
//
// v1.5.0 — Secure Client Attestation v2 (see
// docs/tether-system-check-v1.md, "Secure Client Attestation v2").
// REPLACES v1.4.0's single globally-embedded key with a PER-INSTALLATION
// keypair (installationKey.ts), generated once on first need and
// encrypted at rest via Electron's OS-backed safeStorage — never
// exported through any application API, never sent over IPC to the
// renderer. Adds getInstallationInfo/ensureInstallationKey (public-key-
// only, safe to expose) and signRegistrationProof/attestExamSession
// (purpose-specific signing operations only — no generic "sign this
// data" method exists). attestSystemCheck's shape is unchanged but now
// signs with the per-installation key. Honestly classified as
// SOFTWARE_PROTECTED — real Windows CNG/TPM-backed non-exportable key
// storage was investigated but deliberately not implemented this pass
// (no TPM hardware was available to verify against in this
// environment) — see "Known limitations" in the doc above. Purely
// additive to the bridge surface — no change to contextIsolation,
// nodeIntegration, or sandbox. NEVER DISTRIBUTED — development-only,
// superseded by v1.6.0 below before any real rollout.
//
// v1.6.0 — Wiring installation attestation into real exam sessions (see
// docs/tether-system-check-v1.md, "Wiring installation attestation into
// real exam sessions"). attestExamSession's signed canonical payload
// grows three fields: the secure-client session ID (relayed from the
// server-issued challenge, never chosen by the renderer), a fixed
// comma-joined secure-client-capabilities snapshot (matching
// getSecureClientCapabilities' own four booleans), and a signing
// timestamp — bound into the SAME installation-key signature as the
// existing exam/submission/policy-hash/display facts, so the
// installation independently re-asserts the exact session it is
// attesting for. The server now runs a full 20-point checklist
// (protocol version, purpose, user/installation ownership, ACTIVE status,
// key-protection-level acceptance, fingerprint match, installation
// signature, minimum client version, supported platform, single-display
// policy satisfaction, exam/submission/session/institution/policy-hash
// match, nonce single-use) before a SecureClientSession may receive
// v2-verified status — see verifyExamSessionAttestation in
// tetherAttestationRunner.ts. Whether that verification actually gates
// real exam content access is controlled by TETHER_EXAM_ATTESTATION_MODE
// (LEGACY | DUAL | V2_REQUIRED, safe default LEGACY — see
// tetherAttestationConfig.ts) — under LEGACY this is purely additive
// evidence, exactly like v1.5.0's groundwork was. Still honestly
// SOFTWARE_PROTECTED, still no TPM remote attestation. Multi-device
// support (a student may register up to
// TETHER_MAX_ACTIVE_INSTALLATIONS_PER_USER simultaneously ACTIVE
// installations, default 2) lives entirely server-side — no bridge
// surface change for it. Purely additive to the bridge surface — no
// change to contextIsolation, nodeIntegration, or sandbox. v1.4.0 and
// v1.5.0 were development-only and were never distributed.
// v1.7.0 — Tether Windows Lockdown Hardening v1 (see
// docs/tether-windows-lockdown-hardening-v1.md). Adds a Windows-only
// process-detection service (lockdownCapabilityRegistry.ts /
// processDetection.ts) that scans for known remote-control, debugging,
// virtualization, and screen-capture applications before and during a
// final exam; a remote-session/virtual-machine indicator
// (windowsSessionDetection.ts); a main-owned "close applications before
// continuing" preflight gate and a live during-exam blocking overlay,
// both fail-safe (never trap the student — closing Tether is always
// allowed, and every temporary control is torn down through an
// idempotent restoration lifecycle — lockdownLifecycle.ts); and
// materially strengthened Electron hardening — a permission-request
// allowlist (camera/fullscreen only, everything else denied), denied
// navigation outside the SES origin, denied window.open/downloads,
// packaged-build DevTools prevention, rejected unsafe command-line
// switches (--remote-debugging-port, --inspect, --disable-web-security,
// ...), and blocked browser-chrome keyboard shortcuts
// (keyboardHardeningLogic.ts). Every detection is an integrity SIGNAL
// for lecturer review, never an automatic misconduct conclusion — see
// that doc's "Core principles". No kernel driver, no TPM attestation, no
// permanent Windows-setting change, no blanket process termination.
export const LOCKDOWN_VERSION = "1.7.0";

// Primary marker for new builds. Older packaged installs may still send
// the legacy `SESLockdown/${version}` suffix — see
// src/lib/lockdownDetection.ts and src/lib/networkEvidence.ts for the
// backward-compatible detection logic that accepts both.
export const USER_AGENT_SUFFIX = `TetherSecureBrowser/${LOCKDOWN_VERSION}`;

export const DEFAULT_SES_BASE_URL = "https://tether-murex.vercel.app";

/**
 * Tether launch/install flow v1 — the branded `tether://` protocol is
 * now primary; `ses://` is preserved for existing pilot installations
 * that haven't updated yet (Requirement 4). Both are registered and
 * handled identically — see registerDeepLinkProtocol/isDeepLinkArg in
 * main.ts.
 */
export const DEEP_LINK_PROTOCOLS = ["tether", "ses"] as const;
export type DeepLinkProtocol = (typeof DEEP_LINK_PROTOCOLS)[number];
export const PRIMARY_DEEP_LINK_PROTOCOL: DeepLinkProtocol = "tether";

/** True for any string beginning with one of the registered deep-link protocols (`tether://...` or `ses://...`). */
export function isDeepLinkArg(value: string): boolean {
  return DEEP_LINK_PROTOCOLS.some((protocol) => value.startsWith(`${protocol}://`));
}

/**
 * Resolves the web app path a deep link should land on — the fix for
 * the confirmed bug where buildLoadUrl always returned `/student`
 * regardless of examId. Landing on the Tether launch page (rather than
 * directly on `/student/exams/[examId]`, which doesn't exist as a route
 * — the app is keyed by submissionId, not examId) lets that page run
 * the full access-check -> acknowledgement -> start -> launch -> consume
 * sequence automatically once inside Tether and authenticated (see
 * src/app/student/exams/[id]/tether-launch/page.tsx in the main repo).
 */
export function buildTetherLaunchPath(examId: string): string {
  return `/student/exams/${examId}/tether-launch`;
}

/**
 * IntegrityEventType values this client may report, restricted to values
 * that already exist on the SES Prisma schema's IntegrityEventType enum
 * (see prisma/schema.prisma in the main repo) — no schema change was
 * needed for v1. Electron-only signals that don't have a closer match
 * are reported as MANUAL_WARNING with the precise origin recorded in
 * metadata.electronEventType.
 */
export type LockdownIntegrityEventType =
  | "WINDOW_BLUR"
  | "WINDOW_FOCUS_RETURN"
  | "FULLSCREEN_EXIT"
  | "MANUAL_WARNING"
  // Tether Windows Lockdown Hardening v1 — main-observed signals (never
  // page-reported, so these are never added to preload.ts's
  // ALLOWED_LOG_EVENT_TYPES renderer-input allow-list). Process-
  // detection capability transitions (REMOTE_CONTROL_SOFTWARE_DETECTED
  // etc.) are deliberately NOT reported through this queue — they are
  // relayed to the hosted page via a dedicated IPC event instead, and
  // the page itself calls the integrity-events route with its own
  // authenticated fetch, exactly like display-enforcement events already
  // do — see main.ts's onCapabilityTransition wiring.
  | "KEYBOARD_SHORTCUT_BLOCKED"
  | "DEBUGGING_TOOL_DETECTED";

export type LockdownEventMetadata = {
  source: "electron-lockdown";
  lockdownVersion: string;
  electronEventType: string;
  platform: string;
  displayCount?: number;
  domain?: string;
  timestamp: string;
  [key: string]: unknown;
};

export type QueuedLockdownEvent = {
  eventType: LockdownIntegrityEventType;
  message: string;
  metadata: LockdownEventMetadata;
  occurredAt: string;
};

export type ExamContext = {
  examId: string | null;
  submissionId: string | null;
};

export type SessionInfo = {
  /** Whether a SES auth session cookie is present — never the cookie value itself. */
  authenticated: boolean;
};
