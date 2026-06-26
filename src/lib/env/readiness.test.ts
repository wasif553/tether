import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getRequiredEnvStatus,
  getLtiEnvStatus,
  getAiEnvStatus,
  getDeploymentEnvStatus,
} from "./readiness";

const ENV_KEYS = [
  "DATABASE_URL",
  "AUTH_SECRET",
  "APP_URL",
  "LTI_PRIVATE_KEY",
  "LTI_PUBLIC_KEY",
  "LTI_CLIENT_ID",
  "LTI_DEPLOYMENT_ID",
  "LTI_PLATFORM_ISSUER",
  "LTI_PLATFORM_OIDC_AUTH",
  "LTI_PLATFORM_JWKS",
  "LTI_TOKEN_ENDPOINT",
  "ANTHROPIC_API_KEY",
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
    const privateKeyCheck = status.checks.find((c) => c.key === "LTI_PRIVATE_KEY");
    const publicKeyCheck = status.checks.find((c) => c.key === "LTI_PUBLIC_KEY");
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
});
