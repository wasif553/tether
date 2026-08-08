import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getRequiredEnvStatus,
  getLtiEnvStatus,
  getAiEnvStatus,
  getDeploymentEnvStatus,
  getSecureLaunchSigningEnvStatus,
  getEvidenceStorageEnvStatus,
  detectDangerousEnvCombinations,
} from "./readiness";

const ENV_KEYS = [
  "DATABASE_URL",
  "AUTH_SECRET",
  "APP_URL",
  "LTI_PRIVATE_KEY",
  "LTI_PUBLIC_KEY",
  "LTI_PRIVATE_KEY_B64",
  "LTI_PUBLIC_KEY_B64",
  "LTI_PRIVATE_KEY_PATH",
  "LTI_PUBLIC_KEY_PATH",
  "LTI_CLIENT_ID",
  "LTI_DEPLOYMENT_ID",
  "LTI_PLATFORM_ISSUER",
  "LTI_PLATFORM_OIDC_AUTH",
  "LTI_PLATFORM_JWKS",
  "LTI_TOKEN_ENDPOINT",
  "ANTHROPIC_API_KEY",
  "TETHER_SECURE_CLIENT_SIGNING_PRIVATE_KEY",
  "TETHER_SECURE_CLIENT_SIGNING_PUBLIC_KEY",
  "TETHER_SECURE_CLIENT_SIGNING_KEY_ID",
  "EVIDENCE_STORAGE_PROVIDER",
  "EVIDENCE_STORAGE_BUCKET",
  "TETHER_MOCK_SECURE_CLIENT_ENABLED",
  "TETHER_SECURE_CLIENT_BYPASS_ENABLED",
];

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function clearAll() {
  for (const key of ENV_KEYS) delete process.env[key];
}

describe("getRequiredEnvStatus", () => {
  it("reports allPresent=false when a required var is missing", () => {
    clearAll();
    const status = getRequiredEnvStatus();
    expect(status.allPresent).toBe(false);
    expect(status.checks.every((c) => !c.present)).toBe(true);
  });

  it("reports allPresent=true when all required vars are set, and never returns the value", () => {
    clearAll();
    process.env.DATABASE_URL = "postgres://secret-stuff";
    process.env.AUTH_SECRET = "super-secret-value";
    process.env.APP_URL = "http://localhost:3001";

    const status = getRequiredEnvStatus();
    expect(status.allPresent).toBe(true);
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("secret-stuff");
    expect(serialized).not.toContain("super-secret-value");
  });
});

describe("getLtiEnvStatus", () => {
  it("flags missing LTI keys individually", () => {
    clearAll();
    process.env.LTI_PRIVATE_KEY = "pem-data";
    const status = getLtiEnvStatus();
    expect(status.allPresent).toBe(false);
    const privateKeyCheck = status.checks.find((c) => c.key === "LTI_PRIVATE_KEY_B64");
    const publicKeyCheck = status.checks.find((c) => c.key === "LTI_PUBLIC_KEY_B64");
    expect(privateKeyCheck?.present).toBe(true);
    expect(publicKeyCheck?.present).toBe(false);
  });
});

describe("getAiEnvStatus", () => {
  it("is not present when ANTHROPIC_API_KEY is unset", () => {
    clearAll();
    const status = getAiEnvStatus();
    expect(status.allPresent).toBe(false);
  });

  it("is present when ANTHROPIC_API_KEY is set", () => {
    clearAll();
    process.env.ANTHROPIC_API_KEY = "sk-ant-fake";
    const status = getAiEnvStatus();
    expect(status.allPresent).toBe(true);
  });
});

describe("getDeploymentEnvStatus", () => {
  it("aggregates required, lti, and ai groups", () => {
    clearAll();
    process.env.DATABASE_URL = "x";
    process.env.AUTH_SECRET = "x";
    process.env.APP_URL = "x";

    const status = getDeploymentEnvStatus();
    expect(status.required.allPresent).toBe(true);
    expect(status.lti.allPresent).toBe(false);
    expect(status.ai.allPresent).toBe(false);
    expect(status.allPresent).toBe(false);
  });

  it("includes secureLaunchSigning and evidenceStorage groups", () => {
    clearAll();
    const status = getDeploymentEnvStatus();
    expect(status.secureLaunchSigning.allPresent).toBe(false);
    expect(status.evidenceStorage.allPresent).toBe(false);
  });
});

describe("getSecureLaunchSigningEnvStatus", () => {
  it("is present only when both private and public keys are set", () => {
    clearAll();
    process.env.TETHER_SECURE_CLIENT_SIGNING_PRIVATE_KEY = "priv";
    expect(getSecureLaunchSigningEnvStatus().allPresent).toBe(false);
    process.env.TETHER_SECURE_CLIENT_SIGNING_PUBLIC_KEY = "pub";
    expect(getSecureLaunchSigningEnvStatus().allPresent).toBe(true);
  });

  it("never returns the actual key value", () => {
    clearAll();
    process.env.TETHER_SECURE_CLIENT_SIGNING_PRIVATE_KEY = "TOP-SECRET-PEM-DATA";
    const serialized = JSON.stringify(getSecureLaunchSigningEnvStatus());
    expect(serialized).not.toContain("TOP-SECRET-PEM-DATA");
  });
});

describe("getEvidenceStorageEnvStatus", () => {
  it("is present only when both provider and bucket are set", () => {
    clearAll();
    process.env.EVIDENCE_STORAGE_PROVIDER = "supabase_storage";
    expect(getEvidenceStorageEnvStatus().allPresent).toBe(false);
    process.env.EVIDENCE_STORAGE_BUCKET = "evidence";
    expect(getEvidenceStorageEnvStatus().allPresent).toBe(true);
  });
});

describe("GET /api/readiness — Canvas/LTI must never gate standalone Tether readiness", () => {
  it("the route source reports ltiKeysConfigured/aiKeyConfigured as independent fields, never ANDed into secureLaunchSigningConfigured/evidenceStorageConfigured/databaseConnected", async () => {
    // Static, source-level check (mirrors the established pattern in
    // pilotUiTerminology.test.ts) — deliberately does not invoke the
    // route itself (it touches Prisma, requiring a DB). Production
    // administration hardening v1, Part J: "Do NOT make Canvas/LTI
    // failure mark standalone Tether unavailable."
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(path.join(process.cwd(), "src/app/api/readiness/route.ts"), "utf8");
    expect(source).toContain("ltiKeysConfigured: lti.allPresent");
    expect(source).toContain("secureLaunchSigningConfigured: secureLaunchSigning.allPresent");
    // The combined getDeploymentEnvStatus().allPresent aggregate (which
    // DOES fold lti/ai into one boolean) must never be imported/used by
    // this route — only the independent per-group functions.
    expect(source).not.toMatch(/getDeploymentEnvStatus/);
  });
});

describe("detectDangerousEnvCombinations", () => {
  it("flags a missing APP_URL only in production, never in preview/local-development/unknown", () => {
    clearAll();
    expect(detectDangerousEnvCombinations("production").some((f) => f.code === "PRODUCTION_ORIGIN_MISSING")).toBe(true);
    expect(detectDangerousEnvCombinations("preview").some((f) => f.code === "PRODUCTION_ORIGIN_MISSING")).toBe(false);
    expect(detectDangerousEnvCombinations("local-development").some((f) => f.code === "PRODUCTION_ORIGIN_MISSING")).toBe(false);
  });

  it("flags a signing key id with no matching keys, regardless of environment", () => {
    clearAll();
    process.env.TETHER_SECURE_CLIENT_SIGNING_KEY_ID = "prod-key-1";
    const findings = detectDangerousEnvCombinations("local-development");
    expect(findings.some((f) => f.code === "SIGNING_KEY_ID_WITHOUT_MATCHING_KEYS")).toBe(true);
  });

  it("never flags a signing key id when both matching keys are present", () => {
    clearAll();
    process.env.TETHER_SECURE_CLIENT_SIGNING_KEY_ID = "prod-key-1";
    process.env.TETHER_SECURE_CLIENT_SIGNING_PRIVATE_KEY = "priv";
    process.env.TETHER_SECURE_CLIENT_SIGNING_PUBLIC_KEY = "pub";
    const findings = detectDangerousEnvCombinations("production");
    expect(findings.some((f) => f.code === "SIGNING_KEY_ID_WITHOUT_MATCHING_KEYS")).toBe(false);
  });

  it("flags TETHER_MOCK_SECURE_CLIENT_ENABLED=true only in production", () => {
    clearAll();
    process.env.TETHER_MOCK_SECURE_CLIENT_ENABLED = "true";
    expect(detectDangerousEnvCombinations("production").some((f) => f.code === "MOCK_SECURE_CLIENT_ENABLED_IN_PRODUCTION")).toBe(true);
    expect(detectDangerousEnvCombinations("local-development").some((f) => f.code === "MOCK_SECURE_CLIENT_ENABLED_IN_PRODUCTION")).toBe(false);
  });

  it("flags TETHER_SECURE_CLIENT_BYPASS_ENABLED=true only in production", () => {
    clearAll();
    process.env.TETHER_SECURE_CLIENT_BYPASS_ENABLED = "true";
    expect(detectDangerousEnvCombinations("production").some((f) => f.code === "SECURE_CLIENT_BYPASS_ENABLED_IN_PRODUCTION")).toBe(true);
    expect(detectDangerousEnvCombinations("preview").some((f) => f.code === "SECURE_CLIENT_BYPASS_ENABLED_IN_PRODUCTION")).toBe(false);
  });

  it("returns an empty array, never null/undefined, for a clean production config", () => {
    clearAll();
    process.env.APP_URL = "https://example.edu";
    const findings = detectDangerousEnvCombinations("production");
    expect(findings).toEqual([]);
  });

  it("every finding is a bounded reason code + severity — never a raw secret or free-form message with interpolated env values", () => {
    clearAll();
    process.env.TETHER_SECURE_CLIENT_SIGNING_KEY_ID = "prod-key-1";
    const findings = detectDangerousEnvCombinations("production");
    for (const finding of findings) {
      expect(finding).toHaveProperty("code");
      expect(finding).toHaveProperty("severity");
      expect(finding).toHaveProperty("detail");
      expect(JSON.stringify(finding)).not.toContain("prod-key-1");
    }
  });
});
