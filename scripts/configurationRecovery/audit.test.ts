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

describe("[1][2] current-state TOTAL metrics — templatePresenceExpectedEntryCount/NameCount describe TODAY's register, regardless of .env.example's actual state", () => {
  it("[1] templatePresenceExpectedEntryCount counts every templatePresenceExpected entry, even against an EMPTY template", () => {
    const register = [baseEntry({ name: "SOLO_TOGGLE", templatePresenceExpected: true }), baseEntry({ name: "NOT_EXPECTED", templatePresenceExpected: false })];
    const result = auditConfigurationRecovery({ register, envExampleContent: "" });
    expect(result.summary.templatePresenceExpectedEntryCount).toBe(1);
  });

  it("[2] templatePresenceExpectedNameCount counts every represented name (entry + aliases) for templatePresenceExpected entries, even against an EMPTY template", () => {
    const register = [baseEntry({ name: "GROUPED_TOGGLE_A", aliasNames: ["GROUPED_TOGGLE_B", "GROUPED_TOGGLE_C"], templatePresenceExpected: true }), baseEntry({ name: "SOLO_TOGGLE", templatePresenceExpected: true })];
    const result = auditConfigurationRecovery({ register, envExampleContent: "" });
    // Both totals are unchanged by an empty template — they describe the
    // register's own current expectations, not .env.example's current
    // satisfaction of them (that is templateMissing*Count, tested below).
    expect(result.summary.templatePresenceExpectedEntryCount).toBe(2);
    expect(result.summary.templatePresenceExpectedNameCount).toBe(4);
  });

  it("the real register's own current totals: entry count and name count differ by exactly the number of extra grouped-alias names among templatePresenceExpected entries", () => {
    const expectedEntries = CONFIGURATION_RECOVERY_REGISTER.filter((e) => e.templatePresenceExpected);
    const expectedNameCount = expectedEntries.reduce((sum, e) => sum + 1 + e.aliasNames.length, 0);
    const result = auditConfigurationRecovery({ register: CONFIGURATION_RECOVERY_REGISTER, envExampleContent: "" });
    expect(result.summary.templatePresenceExpectedEntryCount).toBe(expectedEntries.length);
    expect(result.summary.templatePresenceExpectedNameCount).toBe(expectedNameCount);
    // Documents the known discrepancy source directly, rather than a
    // prose number that could silently go stale: TETHER_BLOCK_DEBUG_TOOLS
    // alone contributes 3 extra names (4 total) beyond its own 1 entry.
    const blockToggles = expectedEntries.find((e) => e.name === "TETHER_BLOCK_DEBUG_TOOLS");
    expect(blockToggles?.aliasNames.length).toBe(3);
  });

  it("[6] audit output never describes these totals as historical 'added' or 'drift' counts", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const auditSource = await fs.readFile(path.join(__dirname, "audit.ts"), "utf8");
    const cliSource = await fs.readFile(path.join(__dirname, "..", "audit-configuration-recovery.ts"), "utf8");
    // The CLI's own log lines for the TOTAL metrics must say "current
    // total", never "added"/"missing"/"drift" (those words belong only
    // to the separate templateMissing*Count lines, checked elsewhere).
    expect(cliSource).toMatch(/Expected template entries \(current total\)/);
    expect(cliSource).toMatch(/Expected template names \(current total\)/);
    expect(auditSource).toMatch(/CURRENT-STATE TOTALS ONLY/);
    expect(auditSource).toMatch(/NOT a historical "added" or/);
  });
});

describe("[3][4][5] current-state DRIFT metrics — templateMissingEntryCount/NameCount, computed fresh from current state, never Git history", () => {
  it("[3][4] both reach 0 against the real, fully-reconciled .env.example", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const repoRoot = path.resolve(__dirname, "..", "..");
    const envExampleContent = await fs.readFile(path.join(repoRoot, ".env.example"), "utf8");
    const result = auditConfigurationRecovery({ register: CONFIGURATION_RECOVERY_REGISTER, envExampleContent });
    expect(result.summary.templateMissingEntryCount).toBe(0);
    expect(result.summary.templateMissingNameCount).toBe(0);
  });

  it("[5] a synthetic missing entry increments both current missing counts", () => {
    const register = [baseEntry({ name: "PRESENT_ONE", templatePresenceExpected: true }), baseEntry({ name: "MISSING_ONE", aliasNames: ["MISSING_ONE_ALT"], templatePresenceExpected: true })];
    const result = auditConfigurationRecovery({ register, envExampleContent: "PRESENT_ONE=\n" });
    expect(result.summary.templateMissingEntryCount).toBe(1);
    // MISSING_ONE represents 2 names (itself + its one alias) — both count as missing since neither is present.
    expect(result.summary.templateMissingNameCount).toBe(2);
  });

  it("a fully-satisfied template (including via an alias, not just the canonical name) reports zero missing", () => {
    const register = [baseEntry({ name: "PRESENT_VIA_ALIAS", aliasNames: ["PRESENT_VIA_ALIAS_ALT"], templatePresenceExpected: true })];
    const result = auditConfigurationRecovery({ register, envExampleContent: "PRESENT_VIA_ALIAS_ALT=\n" });
    expect(result.summary.templateMissingEntryCount).toBe(0);
    expect(result.summary.templateMissingNameCount).toBe(0);
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
