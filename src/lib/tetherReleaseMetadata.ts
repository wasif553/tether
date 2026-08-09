/**
 * Tether Secure Browser — release metadata (pilot operations v1). See
 * docs/tether-release-management.md.
 *
 * The ONE canonical source for "what is the current Windows Tether
 * client release candidate, and can a student actually download it
 * right now" — every student-facing page (`/lockdown-browser`, the
 * tether-launch fallback, system-check) must read this instead of
 * hardcoding a version/filename/URL, so those can never drift apart the
 * way `tether-launch/page.tsx`'s own hardcoded `INSTALLER_DOWNLOAD_URL`
 * already had (a dead `/downloads/...` link with no matching route —
 * see the pilot-operations-readiness audit).
 *
 * Follows this repo's own established env-var + typed-resolver
 * convention (see src/lib/systemCheckConfig.ts's
 * minimumSupportedTetherVersion, and its own doc comment: "Reads
 * process.env exactly once per call, applies safe defaults... Nothing
 * here is exported to any client component"). Server-only.
 *
 * Deliberately does NOT duplicate or override the REAL, security-
 * relevant minimum-supported-version enforcement
 * (systemCheckConfig.ts's minimumSupportedTetherVersion /
 * src/lib/systemCheck/readiness.ts's compareVersions /
 * tetherAttestationRunner.ts's CLIENT_VERSION_UNSUPPORTED check) — this
 * module's own `minimumSupportedVersion` field is that SAME resolver,
 * re-exported for display purposes, never a second source of truth.
 */
import { minimumSupportedTetherVersion } from "@/lib/systemCheckConfig";
import { compareVersions } from "@/lib/systemCheck/readiness";

export const TETHER_RELEASE_STATUSES = ["INTERNAL", "PILOT", "GENERAL_AVAILABILITY"] as const;
export type TetherReleaseStatus = (typeof TETHER_RELEASE_STATUSES)[number];

export type TetherReleaseMetadata = {
  /** The current Windows release candidate version this deployment ships/references. */
  version: string;
  /** The REAL, enforced minimum-supported version — see this module's own doc comment for why this is never a second source of truth. */
  minimumSupportedVersion: string;
  platform: "WINDOWS";
  architecture: "x64";
  installerFilename: string;
  /** null until an operator actually configures a real, published download location — never fabricated. */
  installerUrl: string | null;
  sha256: string;
  releaseStatus: TetherReleaseStatus;
  /** Derived, never an independent flag: true only when installerUrl is actually set. */
  downloadsEnabled: boolean;
  releaseNotesUrl: string | null;
};

// ---------------------------------------------------------------------------
// Current release candidate — the frozen, physically-untouched artifact.
// v1.7.3 — sandboxed-preload hotfix (see apps/lockdown/src/shared.ts's own
// LOCKDOWN_VERSION doc comment for the root cause/fix). Rebuilt via
// `npm run dist:win` in apps/lockdown; SHA-256 below is this rebuild's
// own verified hash, distinct from the v1.7.2 record in
// docs/tether-v1.7.2-pilot-release-readiness.md. Update these three
// constants together, in lockstep with a real rebuilt+reverified
// installer — never edit the hash alone.
// ---------------------------------------------------------------------------
const CURRENT_RELEASE_CANDIDATE_VERSION = "1.7.3";
const CURRENT_INSTALLER_FILENAME = "Tether-Secure-Browser-1.7.3-win-x64.exe";
const CURRENT_INSTALLER_SHA256 = "676504f478f945d04df9bcbad427cc062e99dccf09bc8ea4118decb14bf6f232";

/**
 * No installer URL is configured by default — downloads stay disabled
 * (see `downloadsEnabled`) until an operator sets this to a real,
 * published location. Never a placeholder/GitHub-Release guess: an
 * absent or malformed value always resolves to `null`, never a
 * best-effort string that could render a broken link.
 */
function resolveInstallerUrl(): string | null {
  const raw = process.env.TETHER_INSTALLER_DOWNLOAD_URL;
  if (!raw || raw.trim().length === 0) return null;
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Safe default: INTERNAL. This release candidate has NOT completed
 * physical acceptance (see docs/tether-v1.7.2-pilot-release-readiness.md
 * — 9 P0 requirements still NEEDS PHYSICAL CONFIRMATION as of this
 * module's introduction), so it must never silently present itself as
 * PILOT or GENERAL_AVAILABILITY. An operator promotes this explicitly,
 * once ready, via TETHER_RELEASE_STATUS.
 */
function resolveReleaseStatus(): TetherReleaseStatus {
  const raw = process.env.TETHER_RELEASE_STATUS;
  if (raw === "PILOT" || raw === "GENERAL_AVAILABILITY") return raw;
  return "INTERNAL";
}

function resolveReleaseNotesUrl(): string | null {
  const raw = process.env.TETHER_RELEASE_NOTES_URL;
  if (!raw || raw.trim().length === 0) return null;
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/** The one function every student-facing distribution/version surface should call. */
export function resolveTetherReleaseMetadata(): TetherReleaseMetadata {
  const installerUrl = resolveInstallerUrl();
  return {
    version: CURRENT_RELEASE_CANDIDATE_VERSION,
    minimumSupportedVersion: minimumSupportedTetherVersion(),
    platform: "WINDOWS",
    architecture: "x64",
    installerFilename: CURRENT_INSTALLER_FILENAME,
    installerUrl,
    sha256: CURRENT_INSTALLER_SHA256,
    releaseStatus: resolveReleaseStatus(),
    downloadsEnabled: installerUrl != null,
    releaseNotesUrl: resolveReleaseNotesUrl(),
  };
}

// ---------------------------------------------------------------------------
// User-facing compatibility model (Part D) — a purely informational,
// non-security-enforcing classification for student-facing messaging.
// The REAL access-gating enforcement remains exactly where it already
// is (tetherAttestationRunner.ts's CLIENT_VERSION_UNSUPPORTED check,
// System Check's evaluateClientVersion) — this function is never
// consulted by either. Its one job is to prevent the specific failure
// mode Part D calls out: a student told "update required" with no
// approved installer anywhere to actually get.
// ---------------------------------------------------------------------------

export const TETHER_COMPATIBILITY_STATES = ["SUPPORTED", "OUTDATED_BUT_ALLOWED", "UPDATE_REQUIRED", "UNKNOWN"] as const;
export type TetherCompatibilityState = (typeof TETHER_COMPATIBILITY_STATES)[number];

/**
 * `reportedVersion` — the student's Tether client version, if known
 * (e.g. from `window.sesLockdown.version`); null when unavailable.
 * `downloadsEnabled` — from `resolveTetherReleaseMetadata()`, passed
 * explicitly rather than re-resolved here so this stays a pure,
 * directly-testable function.
 *
 * Never returns UPDATE_REQUIRED unless downloadsEnabled is true — this
 * is the one invariant that makes an "impossible update loop"
 * structurally unreachable: a student can never be told to update to a
 * version that isn't actually downloadable anywhere.
 */
export function resolveTetherCompatibilityState(params: {
  reportedVersion: string | null;
  minimumSupportedVersion: string;
  downloadsEnabled: boolean;
}): TetherCompatibilityState {
  if (!params.reportedVersion || params.reportedVersion.trim().length === 0) return "UNKNOWN";
  const cmp = compareVersions(params.reportedVersion, params.minimumSupportedVersion);
  if (cmp >= 0) return "SUPPORTED";
  return params.downloadsEnabled ? "UPDATE_REQUIRED" : "OUTDATED_BUT_ALLOWED";
}

const COMPATIBILITY_STATE_COPY: Record<TetherCompatibilityState, string> = {
  SUPPORTED: "Your Tether version is supported.",
  OUTDATED_BUT_ALLOWED: "A newer Tether version is available.",
  UPDATE_REQUIRED: "This examination requires a newer supported version of Tether.",
  UNKNOWN: "Your Tether version could not be determined.",
};

/** The one place this exact approved copy lives — never re-typed at a call site. */
export function tetherCompatibilityStateCopy(state: TetherCompatibilityState): string {
  return COMPATIBILITY_STATE_COPY[state];
}
