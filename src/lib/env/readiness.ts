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

/** Aggregate view used for a quick "is this deployment configured" check. */
export function getDeploymentEnvStatus(): EnvGroupStatus & {
  required: EnvGroupStatus;
  lti: EnvGroupStatus;
  ai: EnvGroupStatus;
} {
  const required = getRequiredEnvStatus();
  const lti = getLtiEnvStatus();
  const ai = getAiEnvStatus();

  return {
    checks: [...required.checks, ...lti.checks, ...ai.checks],
    allPresent: required.allPresent && lti.allPresent && ai.allPresent,
    required,
    lti,
    ai,
  };
}
