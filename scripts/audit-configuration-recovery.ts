#!/usr/bin/env -S npx tsx
/**
 * `npm run config:recovery-audit`
 *
 * See docs/configuration-and-secrets-recovery-v1.md for the full
 * operator explanation. This tool is REPOSITORY / STATIC-ANALYSIS ONLY —
 * it reads the canonical register (scripts/configurationRecovery/register.ts),
 * `.env.example`, and `docs/production-environment-register.md` from
 * disk, and nothing else. It NEVER reads `process.env` for a real
 * deployment value, never contacts Production, never contacts any
 * Supabase/Vercel API, and never prints a value — only variable NAMES,
 * categories, statuses, and bounded finding codes.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { CONFIGURATION_RECOVERY_REGISTER } from "./configurationRecovery/register";
import { auditConfigurationRecovery, type AuditFinding } from "./configurationRecovery/audit";

function log(message: string): void {
  console.log(`[config:recovery-audit] ${message}`);
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(__dirname, "..");
  const envExampleContent = await fs.readFile(path.join(repoRoot, ".env.example"), "utf8");
  let productionEnvironmentRegisterDocContent: string | undefined;
  try {
    productionEnvironmentRegisterDocContent = await fs.readFile(path.join(repoRoot, "docs", "production-environment-register.md"), "utf8");
  } catch {
    productionEnvironmentRegisterDocContent = undefined;
  }

  const result = auditConfigurationRecovery({
    register: CONFIGURATION_RECOVERY_REGISTER,
    envExampleContent,
    productionEnvironmentRegisterDocContent,
  });

  log(`Register entries: ${result.summary.totalEntries}`);
  log(`Expected template entries (current total): ${result.summary.templatePresenceExpectedEntryCount}`);
  log(`Expected template names (current total): ${result.summary.templatePresenceExpectedNameCount} (a few entries represent more than one independently-toggleable name via aliasNames — see AuditResult's own doc comment)`);
  log(`Missing expected template entries (current): ${result.summary.templateMissingEntryCount}`);
  log(`Missing expected template names (current): ${result.summary.templateMissingNameCount}`);
  log("By category:");
  for (const [category, count] of Object.entries(result.summary.byCategory).sort()) {
    log(`  ${category}: ${count}`);
  }
  log("");

  const bySeverity: Record<AuditFinding["severity"], AuditFinding[]> = { ERROR: [], WARNING: [], INFO: [] };
  for (const finding of result.findings) bySeverity[finding.severity].push(finding);

  for (const severity of ["ERROR", "WARNING", "INFO"] as const) {
    const list = bySeverity[severity];
    if (list.length === 0) continue;
    log(`${severity} (${list.length}):`);
    for (const finding of list) {
      log(`  [${finding.code}]${finding.entryName ? ` ${finding.entryName}:` : ""} ${finding.message}`);
    }
    log("");
  }

  if (result.passed) {
    log(`config:recovery-audit PASSED — ${bySeverity.ERROR.length} errors, ${bySeverity.WARNING.length} warnings, ${bySeverity.INFO.length} informational.`);
    process.exitCode = 0;
  } else {
    log(`config:recovery-audit FAILED — ${bySeverity.ERROR.length} error(s) must be resolved.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  log(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
