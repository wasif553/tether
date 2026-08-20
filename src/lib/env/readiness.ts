/**
 * Presence-only environment checks for pilot readiness and deployment
 * health surfaces. These functions NEVER return the value of a secret —
 * only whether it is set — so they're safe to expose through an API
 * response or a lecturer-facing dashboard.
 */

export type EnvCheck = {
  key: string;
  label: string;
  present: boolean;
};

export type EnvGroupStatus = {
  checks: EnvCheck[];
  allPresent: boolean;
};

function check(key: string, label: string): EnvCheck {
  const value = process.env[key];
  return { key, label, present: typeof value === "string" && value.length > 0 };
}

/** True if any of the given env vars is set — used for keys that can be supplied via multiple sources (raw PEM, base64, or a local file path). */
function checkAny(keys: string[], label: string): EnvCheck {
  const present = keys.some((k) => {
    const value = process.env[k];
    return typeof value === "string" && value.length > 0;
  });
  return { key: keys[0], label, present };
}

function group(checks: EnvCheck[]): EnvGroupStatus {
  return { checks, allPresent: checks.every((c) => c.present) };
}

/** Core variables required for the standalone app to function at all. */
export function getRequiredEnvStatus(): EnvGroupStatus {
  return group([
    check("DATABASE_URL", "Database connection string"),
    check("AUTH_SECRET", "NextAuth session signing secret"),
    check("APP_URL", "Public base URL of the app"),
  ]);
}

/** Variables needed for the Canvas LTI 1.3 / AGS integration. */
export function getLtiEnvStatus(): EnvGroupStatus {
  return group([
    checkAny(
      ["LTI_PRIVATE_KEY_B64", "LTI_PRIVATE_KEY_PATH", "LTI_PRIVATE_KEY"],
      "LTI signing private key",
    ),
    checkAny(
      ["LTI_PUBLIC_KEY_B64", "LTI_PUBLIC_KEY_PATH", "LTI_PUBLIC_KEY"],
      "LTI signing public key",
    ),
    check("LTI_CLIENT_ID", "Canvas Developer Key client ID"),
    check("LTI_DEPLOYMENT_ID", "Canvas deployment ID"),
    check("LTI_PLATFORM_ISSUER", "Canvas platform issuer"),
    check("LTI_PLATFORM_OIDC_AUTH", "Canvas OIDC authorize URL"),
    check("LTI_PLATFORM_JWKS", "Canvas JWKS URL"),
    check("LTI_TOKEN_ENDPOINT", "Canvas AGS token endpoint"),
  ]);
}

/** Variables needed for AI question generation and essay marking. */
export function getAiEnvStatus(): EnvGroupStatus {
  return group([check("ANTHROPIC_API_KEY", "Anthropic API key")]);
}

/**
 * Production administration hardening v1, Part I/J — see
 * docs/production-environment-register.md. Secure-launch signing keys —
 * core to Tether, not optional (a deployment that intends to support
 * Tether at all needs these; an institution running standalone-web-only
 * exams does not use this path, but its absence should still be visible
 * rather than silently discovered at the first real launch attempt).
 */
export function getSecureLaunchSigningEnvStatus(): EnvGroupStatus {
  return group([
    check("TETHER_SECURE_CLIENT_SIGNING_PRIVATE_KEY", "Secure-launch signing private key"),
    check("TETHER_SECURE_CLIENT_SIGNING_PUBLIC_KEY", "Secure-launch signing public key"),
  ]);
}

/** Variables needed for evidence (screen/camera) storage outside local development. */
export function getEvidenceStorageEnvStatus(): EnvGroupStatus {
  return group([
    check("EVIDENCE_STORAGE_PROVIDER", "Evidence storage provider"),
    check("EVIDENCE_STORAGE_BUCKET", "Evidence storage bucket name"),
  ]);
}

/**
 * Cryptography audit v1, P1 fix. Both of these HMAC secrets previously
 * had no readiness visibility at all — a gap the audit specifically
 * flagged, since every other secret in this module already had one.
 * Presence/shape-only, matching the rest of this file's contract: never
 * returns or logs the value.
 */
export function getSessionBindingEnvStatus(): EnvGroupStatus {
  return group([check("EXAM_BINDING_HMAC_SECRET", "Exam session-binding HMAC secret")]);
}

export function getNetworkEvidenceEnvStatus(): EnvGroupStatus {
  return group([check("NETWORK_EVIDENCE_SALT", "Network evidence IP-hash salt")]);
}

/** Aggregate view used for a quick "is this deployment configured" check. */
export function getDeploymentEnvStatus(): EnvGroupStatus & {
  required: EnvGroupStatus;
  lti: EnvGroupStatus;
  ai: EnvGroupStatus;
  secureLaunchSigning: EnvGroupStatus;
  evidenceStorage: EnvGroupStatus;
  sessionBinding: EnvGroupStatus;
  networkEvidence: EnvGroupStatus;
} {
  const required = getRequiredEnvStatus();
  const lti = getLtiEnvStatus();
  const ai = getAiEnvStatus();
  const secureLaunchSigning = getSecureLaunchSigningEnvStatus();
  const evidenceStorage = getEvidenceStorageEnvStatus();
  const sessionBinding = getSessionBindingEnvStatus();
  const networkEvidence = getNetworkEvidenceEnvStatus();

  return {
    checks: [
      ...required.checks,
      ...lti.checks,
      ...ai.checks,
      ...secureLaunchSigning.checks,
      ...evidenceStorage.checks,
      ...sessionBinding.checks,
      ...networkEvidence.checks,
    ],
    allPresent: required.allPresent && lti.allPresent && ai.allPresent,
    required,
    lti,
    ai,
    secureLaunchSigning,
    evidenceStorage,
    sessionBinding,
    networkEvidence,
  };
}

export type DangerousEnvCombination = { code: string; severity: "HIGH" | "MEDIUM"; detail: string };

/**
 * Detects specific, genuinely-checkable misconfiguration COMBINATIONS —
 * never just a single missing value (that's what the presence checks
 * above are for). Two of the combinations named in the Part I audit
 * request are deliberately NOT checked here because they are already
 * structurally impossible by construction, not merely unlikely:
 *   - "download enabled without URL": resolveTetherReleaseMetadata()'s
 *     own `downloadsEnabled` field is DERIVED as `installerUrl != null`
 *     (src/lib/tetherReleaseMetadata.ts) — there is no code path that can
 *     produce downloadsEnabled:true with a null installerUrl.
 *   - "update required with unavailable download":
 *     resolveTetherCompatibilityState() never returns UPDATE_REQUIRED
 *     unless downloadsEnabled is true (see that function's own doc
 *     comment and its dedicated property-style test in
 *     tetherReleaseMetadata.test.ts) — the "impossible update loop" this
 *     combination describes is already prevented by that invariant.
 * Never returns a secret value — only bounded reason codes/booleans.
 */
export function detectDangerousEnvCombinations(deploymentEnv: "production" | "preview" | "local-development" | "unknown"): DangerousEnvCombination[] {
  const findings: DangerousEnvCombination[] = [];
  const isProduction = deploymentEnv === "production";

  if (isProduction && !(process.env.APP_URL && process.env.APP_URL.trim().length > 0)) {
    findings.push({ code: "PRODUCTION_ORIGIN_MISSING", severity: "HIGH", detail: "APP_URL is unset in a production deployment — canonical-origin validation and absolute links will misbehave." });
  }

  const keyId = process.env.TETHER_SECURE_CLIENT_SIGNING_KEY_ID;
  const hasPrivateKey = Boolean(process.env.TETHER_SECURE_CLIENT_SIGNING_PRIVATE_KEY);
  const hasPublicKey = Boolean(process.env.TETHER_SECURE_CLIENT_SIGNING_PUBLIC_KEY);
  if (keyId && keyId.trim().length > 0 && (!hasPrivateKey || !hasPublicKey)) {
    findings.push({ code: "SIGNING_KEY_ID_WITHOUT_MATCHING_KEYS", severity: "HIGH", detail: "TETHER_SECURE_CLIENT_SIGNING_KEY_ID is set but the matching private and/or public key env var is missing — secure-launch signing/verification will fail closed." });
  }

  if (isProduction && process.env.TETHER_MOCK_SECURE_CLIENT_ENABLED === "true") {
    findings.push({ code: "MOCK_SECURE_CLIENT_ENABLED_IN_PRODUCTION", severity: "HIGH", detail: "TETHER_MOCK_SECURE_CLIENT_ENABLED=true in a production deployment — the mock (non-cryptographic) secure-client path must never be reachable in production." });
  }

  if (isProduction && process.env.TETHER_SECURE_CLIENT_BYPASS_ENABLED === "true") {
    findings.push({ code: "SECURE_CLIENT_BYPASS_ENABLED_IN_PRODUCTION", severity: "HIGH", detail: "TETHER_SECURE_CLIENT_BYPASS_ENABLED=true in a production deployment — the developer bypass for TETHER_CLIENT_REQUIRED exams must never be reachable in production." });
  }

  return findings;
}
