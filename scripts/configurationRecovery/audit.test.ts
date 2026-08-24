/**
 * Configuration & Secrets Recovery v1 — audit.ts unit tests. Pure,
 * dependency-free — no filesystem, no process.env, no network. See
 * docs/configuration-and-secrets-recovery-v1.md.
 */
import { describe, expect, it } from "vitest";
import { auditConfigurationRecovery, extractEnvExampleNames, extractBacktickedVarNames } from "./audit";
import { CONFIGURATION_RECOVERY_REGISTER, type ConfigRecoveryEntry } from "./register";

function baseEntry(overrides: Partial<ConfigRecoveryEntry>): ConfigRecoveryEntry {
  return {
    name: "TEST_VAR",
    aliasNames: [],
    category: "OPTIONAL_PRODUCTION_RUNTIME",
    sensitivity: "NON_SECRET",
    environment: "PRODUCTION_AND_PREVIEW",
    runtimeSource: "VERCEL_ENVIRONMENT_VARIABLE",
    recoveryClass: "RECONSTRUCT_CONFIGURATION",
    required: false,
    affectedCapability: "test",
    lossImpact: "test",
    rotationImpact: null,
    recoveryDependency: null,
    templatePresenceExpected: true,
    sourceReference: "test",
    authoritativeRecoverySourceStatus: null,
    ...overrides,
  };
}

describe("extractEnvExampleNames", () => {
  it("extracts plain NAME= lines", () => {
    const names = extractEnvExampleNames("FOO=bar\nBAZ=\n");
    expect(names.has("FOO")).toBe(true);
    expect(names.has("BAZ")).toBe(true);
  });

  it("extracts commented-out # NAME= lines too", () => {
    const names = extractEnvExampleNames("# COMMENTED_OUT=value\n");
    expect(names.has("COMMENTED_OUT")).toBe(true);
  });

  it("never returns a VALUE — only the name is extracted", () => {
    const names = extractEnvExampleNames("SECRET_LOOKING=sk-ant-realvaluehere\n");
    expect(names.has("SECRET_LOOKING")).toBe(true);
    for (const n of names) expect(n).not.toContain("sk-ant");
  });

  it("ignores prose lines that aren't a NAME= declaration", () => {
    const names = extractEnvExampleNames("# This is just an explanatory comment, not a var.\n");
    expect(names.size).toBe(0);
  });
});

describe("extractBacktickedVarNames", () => {
  it("extracts ALL_CAPS backticked identifiers containing an underscore", () => {
    const names = extractBacktickedVarNames("The `DATABASE_URL` variable and the `SOME_OTHER_VAR` too.");
    expect(names.has("DATABASE_URL")).toBe(true);
    expect(names.has("SOME_OTHER_VAR")).toBe(true);
  });

  it("skips short/no-underscore backticked tokens", () => {
    const names = extractBacktickedVarNames("See `foo` and `ABC` for details.");
    expect(names.size).toBe(0);
  });
});

describe("[1] register entries are structurally valid against the real register", () => {
  it("the real CONFIGURATION_RECOVERY_REGISTER passes with zero ERROR findings against the real .env.example", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const repoRoot = path.resolve(__dirname, "..", "..");
    const envExampleContent = await fs.readFile(path.join(repoRoot, ".env.example"), "utf8");
    const result = auditConfigurationRecovery({ register: CONFIGURATION_RECOVERY_REGISTER, envExampleContent });
    const errors = result.findings.filter((f) => f.severity === "ERROR");
    expect(errors, JSON.stringify(errors, null, 2)).toEqual([]);
    expect(result.passed).toBe(true);
  });
});

describe("[2] required register entries appear in .env.example where appropriate", () => {
  it("flags MISSING_FROM_ENV_EXAMPLE for a templatePresenceExpected entry absent from the template", () => {
    const register = [baseEntry({ name: "MISSING_ONE", templatePresenceExpected: true })];
    const result = auditConfigurationRecovery({ register, envExampleContent: "" });
    expect(result.passed).toBe(false);
    expect(result.findings.some((f) => f.code === "MISSING_FROM_ENV_EXAMPLE" && f.entryName === "MISSING_ONE")).toBe(true);
  });

  it("does not flag when the entry (or an alias) is present", () => {
    const register = [baseEntry({ name: "PRESENT_ONE", aliasNames: ["PRESENT_ONE_ALT"], templatePresenceExpected: true })];
    const result = auditConfigurationRecovery({ register, envExampleContent: "PRESENT_ONE_ALT=\n" });
    expect(result.findings.some((f) => f.code === "MISSING_FROM_ENV_EXAMPLE")).toBe(false);
  });
});

describe("[9] FUTURE_NOT_PROVISIONED items must not appear in the template", () => {
  it("flags FUTURE_ITEM_PRESENT_IN_TEMPLATE if a future item is accidentally added", () => {
    const register = [baseEntry({ name: "ARCHIVE_TEST", category: "FUTURE_NOT_PROVISIONED", recoveryClass: "FUTURE_NOT_PROVISIONED", templatePresenceExpected: false })];
    const result = auditConfigurationRecovery({ register, envExampleContent: "ARCHIVE_TEST=\n" });
    expect(result.passed).toBe(false);
    expect(result.findings.some((f) => f.code === "FUTURE_ITEM_PRESENT_IN_TEMPLATE")).toBe(true);
  });

  it("flags FUTURE_ITEM_MARKED_REQUIRED if a future item is marked required", () => {
    const register = [baseEntry({ name: "ARCHIVE_TEST2", category: "FUTURE_NOT_PROVISIONED", recoveryClass: "FUTURE_NOT_PROVISIONED", templatePresenceExpected: false, required: true })];
    const result = auditConfigurationRecovery({ register, envExampleContent: "" });
    expect(result.findings.some((f) => f.code === "FUTURE_ITEM_MARKED_REQUIRED")).toBe(true);
  });
});

describe("[12] active secrets must have a recovery class and recovery source status", () => {
  it("flags ACTIVE_SECRET_MISSING_RECOVERY_CLASS", () => {
    const register = [baseEntry({ name: "SECRET_NO_CLASS", sensitivity: "SECRET", category: "ACTIVE_PRODUCTION_RUNTIME", recoveryClass: null, templatePresenceExpected: false })];
    const result = auditConfigurationRecovery({ register, envExampleContent: "" });
    expect(result.findings.some((f) => f.code === "ACTIVE_SECRET_MISSING_RECOVERY_CLASS")).toBe(true);
  });

  it("flags ACTIVE_SECRET_MISSING_RECOVERY_SOURCE_STATUS", () => {
    const register = [baseEntry({ name: "SECRET_NO_SOURCE", sensitivity: "SECRET", category: "ACTIVE_PRODUCTION_RUNTIME", recoveryClass: "ROTATE_OR_REISSUE", authoritativeRecoverySourceStatus: null, templatePresenceExpected: false })];
    const result = auditConfigurationRecovery({ register, envExampleContent: "" });
    expect(result.findings.some((f) => f.code === "ACTIVE_SECRET_MISSING_RECOVERY_SOURCE_STATUS")).toBe(true);
  });

  it("does not flag a BOOTSTRAP_ONLY secret for missing recovery source status", () => {
    const register = [baseEntry({ name: "BOOTSTRAP_SECRET", sensitivity: "SECRET", category: "OPERATOR_MAINTENANCE_ONLY", recoveryClass: "BOOTSTRAP_ONLY", authoritativeRecoverySourceStatus: null, templatePresenceExpected: false })];
    const result = auditConfigurationRecovery({ register, envExampleContent: "" });
    expect(result.findings.some((f) => f.code === "ACTIVE_SECRET_MISSING_RECOVERY_SOURCE_STATUS")).toBe(false);
  });
});

describe("[5] sensitive .env.example entries should use blank/safe synthetic values", () => {
  it("warns on a non-blank secret value that doesn't match a safe-placeholder shape", () => {
    const register = [baseEntry({ name: "SUSPICIOUS_SECRET", sensitivity: "SECRET", templatePresenceExpected: true, authoritativeRecoverySourceStatus: "NOT_YET_SELECTED" })];
    const result = auditConfigurationRecovery({ register, envExampleContent: "SUSPICIOUS_SECRET=abc123notasafepattern\n" });
    expect(result.findings.some((f) => f.code === "SECRET_TEMPLATE_VALUE_NOT_OBVIOUSLY_SAFE")).toBe(true);
    // A WARNING never fails the audit by itself.
    expect(result.passed).toBe(true);
  });

  it("does not warn on a blank secret value", () => {
    const register = [baseEntry({ name: "BLANK_SECRET", sensitivity: "SECRET", templatePresenceExpected: true, authoritativeRecoverySourceStatus: "NOT_YET_SELECTED" })];
    const result = auditConfigurationRecovery({ register, envExampleContent: "BLANK_SECRET=\n" });
    expect(result.findings.some((f) => f.code === "SECRET_TEMPLATE_VALUE_NOT_OBVIOUSLY_SAFE")).toBe(false);
  });

  it("does not warn on a recognised safe-placeholder shape (e.g. localhost connection string)", () => {
    const register = [baseEntry({ name: "PLACEHOLDER_SECRET", sensitivity: "SECRET", templatePresenceExpected: true, authoritativeRecoverySourceStatus: "NOT_YET_SELECTED" })];
    const result = auditConfigurationRecovery({ register, envExampleContent: 'PLACEHOLDER_SECRET="postgresql://user:password@localhost:5432/db"\n' });
    expect(result.findings.some((f) => f.code === "SECRET_TEMPLATE_VALUE_NOT_OBVIOUSLY_SAFE")).toBe(false);
  });
});

describe("[3][4] this audit tool never reads process.env for a real value — pure function of its inputs only", () => {
  it("auditConfigurationRecovery's own source never ACCESSES process.env (doc-comment mentions of the phrase are fine — only a real `process.env.NAME` property read would be a violation)", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const auditSource = await fs.readFile(path.join(__dirname, "audit.ts"), "utf8");
    expect(auditSource).not.toMatch(/process\.env\.[A-Za-z]/);
  });

  it("the CLI entrypoint script itself never ACCESSES process.env for a real deployment value (process.exitCode is fine — it's process's own exit-code property, not process.env)", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const cliSource = await fs.readFile(path.join(__dirname, "..", "audit-configuration-recovery.ts"), "utf8");
    expect(cliSource).not.toMatch(/process\.env\.[A-Za-z]/);
  });

  it("[4] audit output is names/status/severity only — the AuditFinding type has no value-shaped field", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const auditSource = await fs.readFile(path.join(__dirname, "audit.ts"), "utf8");
    const typeBlock = auditSource.match(/export type AuditFinding = \{[\s\S]*?\};/)![0];
    expect(typeBlock).not.toMatch(/\bvalue\s*:/);
  });
});

describe("naming-drift cross-check (informational only, never blocking)", () => {
  it("surfaces a name present in the other doc but absent from the register as INFO, not ERROR", () => {
    const register = [baseEntry({ name: "SOMETHING_ELSE", templatePresenceExpected: false })];
    const result = auditConfigurationRecovery({ register, envExampleContent: "", productionEnvironmentRegisterDocContent: "See `A_DRIFTED_VARIABLE_NAME` for details." });
    const finding = result.findings.find((f) => f.code === "NAME_IN_OTHER_REGISTER_NOT_IN_RECOVERY_REGISTER");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("INFO");
    expect(result.passed).toBe(true);
  });

  it("is skipped entirely when no cross-check document is supplied", () => {
    const register = [baseEntry({ name: "SOMETHING_ELSE", templatePresenceExpected: false })];
    const result = auditConfigurationRecovery({ register, envExampleContent: "" });
    expect(result.findings.some((f) => f.code === "NAME_IN_OTHER_REGISTER_NOT_IN_RECOVERY_REGISTER")).toBe(false);
  });
});
