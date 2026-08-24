/**
 * Configuration & Secrets Recovery v1 — configuration recovery audit
 * logic. See docs/configuration-and-secrets-recovery-v1.md and
 * `npm run config:recovery-audit` (scripts/audit-configuration-recovery.ts).
 *
 * REPOSITORY / STATIC-ANALYSIS ONLY. This module never reads
 * `process.env` for a real deployment value — every function here takes
 * already-loaded FILE CONTENTS (the register array, `.env.example`'s
 * text, `docs/production-environment-register.md`'s text) as plain
 * arguments, so it is directly unit-testable and cannot, even
 * accidentally, contact a real environment. Output is names, categories,
 * statuses, and bounded reason codes only — never a value.
 */
import type { ConfigRecoveryEntry } from "./register";

export type AuditFindingSeverity = "ERROR" | "WARNING" | "INFO";

export type AuditFinding = {
  code: string;
  severity: AuditFindingSeverity;
  entryName: string | null;
  message: string;
};

export type AuditResult = {
  findings: AuditFinding[];
  /** True only when no ERROR-severity finding exists — WARNING/INFO never fail the audit. */
  passed: boolean;
  summary: {
    totalEntries: number;
    byCategory: Record<string, number>;
    activeSecretsWithoutRecoveryClass: number;
    /**
     * CURRENT-STATE TOTALS ONLY — how many register entries currently
     * expect `.env.example` presence, and how many distinct env var NAMES
     * that represents right now. These are NOT a historical "added" or
     * "drift" count: they describe today's register regardless of
     * whether `.env.example` actually satisfies it (see
     * `templateMissingEntryCount`/`templateMissingNameCount` below for
     * that). This audit has no access to Git history and cannot recompute
     * what changed on any particular branch — a historical reconciliation
     * figure (e.g. "13 entries / 16 names added on this branch") belongs
     * in a changelog entry, derived once from that branch's own
     * baseline-vs-feature diff, never re-derived here after the fact.
     *
     * The two numbers can legitimately differ from each other, but only
     * for ONE reason: `aliasNames` holds exclusively genuine alternate /
     * fallback representations of a SINGLE logical configuration value —
     * never independent variables grouped for register brevity (that
     * grouping was a modelling bug, corrected in full — see
     * `register.test.ts`'s `[ALIAS MODEL FIX]` tests, which lock the
     * remaining alias groups against an explicit, individually-verified
     * allowlist). So one logical entry can still expand to more than one
     * documented name when it legitimately supports more than one
     * representation, e.g.:
     *   `LTI_PRIVATE_KEY_B64` / `LTI_PRIVATE_KEY_PATH` / `LTI_PRIVATE_KEY`
     *   `LTI_PUBLIC_KEY_B64` / `LTI_PUBLIC_KEY_PATH` / `LTI_PUBLIC_KEY`
     *   `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL`
     *   `VERCEL_GIT_COMMIT_SHA` / `GIT_COMMIT_SHA`
     * Independent configuration variables (e.g. the four separate
     * `TETHER_BLOCK_*` lockdown toggles) must always have independent
     * register entries and must never be grouped via `aliasNames` merely
     * for brevity.
     */
    templatePresenceExpectedEntryCount: number;
    templatePresenceExpectedNameCount: number;
    /**
     * CURRENT-STATE DRIFT — computed fresh from current state every
     * time, never from Git history; both are expected to reach `0` once
     * `.env.example` is fully reconciled, and are exactly what should be
     * re-checked on every future run of `npm run config:recovery-audit`.
     * The two answer DIFFERENT questions, deliberately kept apart:
     *
     * - `templateMissingEntryCount` — how many LOGICAL entries have NONE
     *   of their supported name/alias forms present in `.env.example`.
     *   This is the functional-completeness question: "is this
     *   configuration item representable at all in the template?" A true
     *   alias group (e.g. the LTI key triples) only needs ONE of its
     *   forms present to satisfy this — that is what aliases are for.
     *
     * - `templateMissingNameCount` — how many INDIVIDUAL env var NAMES,
     *   summed across every `templatePresenceExpected` entry, are simply
     *   absent from `.env.example` — checked independently per name, not
     *   gated on whether a sibling alias happens to be present. Since
     *   `.env.example` is the canonical operator template and this
     *   project's own convention documents every supported alternative
     *   form as its own line (see the LTI key triple, all three of
     *   which appear in the real `.env.example`), a template that
     *   documents `LTI_PRIVATE_KEY_B64` but omits `LTI_PRIVATE_KEY_PATH`/
     *   `LTI_PRIVATE_KEY` has 0 missing ENTRIES (the item is still
     *   functionally representable) but 2 missing NAMES (an incomplete
     *   template) — see `EXPECTED_ENV_NAME_MISSING_FROM_TEMPLATE` below
     *   for the finding this produces.
     */
    templateMissingEntryCount: number;
    templateMissingNameCount: number;
  };
};

/** Extracts every `NAME=` (optionally commented-out, e.g. `# NAME=value`) variable name declared in an `.env.example`-shaped file's text. Value-blind by construction — only ever returns the NAME portion. */
export function extractEnvExampleNames(envExampleContent: string): Set<string> {
  const names = new Set<string>();
  for (const line of envExampleContent.split("\n")) {
    const match = line.match(/^#?\s*([A-Z][A-Z0-9_]*)\s*=/);
    if (match) names.add(match[1]);
  }
  return names;
}

/** Returns just the value portion (never logged/echoed by the CLI — see audit-configuration-recovery.ts) for a given declared name, or null if not found. Used only to classify whether it looks like a safe placeholder, never printed. */
function findEnvExampleValue(envExampleContent: string, name: string): string | null {
  for (const line of envExampleContent.split("\n")) {
    const match = line.match(/^#?\s*([A-Z][A-Z0-9_]*)\s*=(.*)$/);
    if (match && match[1] === name) return match[2].trim();
  }
  return null;
}

const SAFE_PLACEHOLDER_VALUE_PATTERN = /localhost|example\.(com|org|edu)|user:password|your[-_]|replace_?me|<[^>]+>|^""$/i;

/** Extracts every backtick-wrapped ALL_CAPS token from a markdown document's text — used to cross-check this register against `docs/production-environment-register.md`'s own independent enumeration, so drift between the two is surfaced rather than silently accumulating. */
export function extractBacktickedVarNames(markdownContent: string): Set<string> {
  const names = new Set<string>();
  const pattern = /`([A-Z][A-Z0-9_]*)`/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdownContent)) !== null) {
    // A handful of backticked tokens in that document are code
    // identifiers/status codes, not env var names — filter to names that
    // look like env vars (contain at least one underscore or are a
    // well-known short one) to reduce false positives; a false negative
    // here just means one fewer cross-check, never a false ERROR.
    if (match[1].includes("_") && match[1].length > 3) names.add(match[1]);
  }
  return names;
}

/**
 * The full static audit. Never contacts a real environment — `register`
 * is the in-repo array, `envExampleContent` and
 * `productionEnvironmentRegisterDocContent` are file contents the CALLER
 * already read from disk (see audit-configuration-recovery.ts).
 */
export function auditConfigurationRecovery(params: { register: readonly ConfigRecoveryEntry[]; envExampleContent: string; productionEnvironmentRegisterDocContent?: string }): AuditResult {
  const findings: AuditFinding[] = [];
  const envExampleNames = extractEnvExampleNames(params.envExampleContent);

  const byCategory: Record<string, number> = {};
  let activeSecretsWithoutRecoveryClass = 0;
  let templateMissingEntryCount = 0;
  let templateMissingNameCount = 0;

  for (const entry of params.register) {
    byCategory[entry.category] = (byCategory[entry.category] ?? 0) + 1;

    // Template presence expectation.
    const allNamesForEntry = [entry.name, ...entry.aliasNames];
    const missingNamesForEntry = allNamesForEntry.filter((n) => !envExampleNames.has(n));
    const anyPresentInTemplate = missingNamesForEntry.length < allNamesForEntry.length;
    if (entry.templatePresenceExpected) {
      if (!anyPresentInTemplate) {
        // Fully missing: one clear entry-level finding, not one per name
        // (see this file's own AuditResult doc comment on
        // templateMissingEntryCount vs templateMissingNameCount).
        findings.push({ code: "MISSING_FROM_ENV_EXAMPLE", severity: "ERROR", entryName: entry.name, message: `"${entry.name}" (or one of its documented alias forms) is expected in .env.example but was not found.` });
        templateMissingEntryCount += 1;
        templateMissingNameCount += allNamesForEntry.length;
      } else if (missingNamesForEntry.length > 0) {
        // Partially missing: the logical entry IS represented (at least
        // one supported form is present), but this project's own
        // convention documents every supported alternative form as its
        // own line — surface each individually-absent form as its own,
        // lower-severity finding, never duplicating the entry-level one
        // above (which does not apply here since the entry itself is
        // satisfied).
        templateMissingNameCount += missingNamesForEntry.length;
        for (const missingName of missingNamesForEntry) {
          findings.push({ code: "EXPECTED_ENV_NAME_MISSING_FROM_TEMPLATE", severity: "WARNING", entryName: entry.name, message: `"${missingName}" is a documented alternative form of "${entry.name}" and is expected in .env.example, but only some of that entry's supported forms are present — "${entry.name}" itself is still satisfied (at least one supported form exists), so this is a template-completeness gap, not a functional one.` });
        }
      }
    }
    if (!entry.templatePresenceExpected && entry.category === "FUTURE_NOT_PROVISIONED" && anyPresentInTemplate) {
      findings.push({ code: "FUTURE_ITEM_PRESENT_IN_TEMPLATE", severity: "ERROR", entryName: entry.name, message: `"${entry.name}" is FUTURE_NOT_PROVISIONED but appears in .env.example — a not-yet-provisioned item must not be added to the template merely because its architecture exists.` });
    }

    // Blank/safe-synthetic value check for SECRET entries actually present in the template.
    if (entry.sensitivity === "SECRET" && envExampleNames.has(entry.name)) {
      const value = findEnvExampleValue(params.envExampleContent, entry.name);
      if (value && value.length > 0 && !SAFE_PLACEHOLDER_VALUE_PATTERN.test(value)) {
        findings.push({ code: "SECRET_TEMPLATE_VALUE_NOT_OBVIOUSLY_SAFE", severity: "WARNING", entryName: entry.name, message: `"${entry.name}" has a non-blank .env.example value that doesn't match a recognised safe-placeholder shape — confirm by inspection (this audit never prints the value itself) that it is synthetic, not real.` });
      }
    }

    // Active secret must have a recovery class.
    const isActiveCategory = entry.category === "ACTIVE_PRODUCTION_RUNTIME" || entry.category === "OPTIONAL_PRODUCTION_RUNTIME" || entry.category === "OPERATOR_MAINTENANCE_ONLY";
    if (entry.sensitivity === "SECRET" && isActiveCategory && entry.recoveryClass === null) {
      activeSecretsWithoutRecoveryClass += 1;
      findings.push({ code: "ACTIVE_SECRET_MISSING_RECOVERY_CLASS", severity: "ERROR", entryName: entry.name, message: `"${entry.name}" is an active secret with no recoveryClass assigned.` });
    }

    // Active secret must identify authoritative recovery source status.
    if (entry.sensitivity === "SECRET" && isActiveCategory && entry.recoveryClass !== null && entry.recoveryClass !== "BOOTSTRAP_ONLY" && entry.authoritativeRecoverySourceStatus === null) {
      findings.push({ code: "ACTIVE_SECRET_MISSING_RECOVERY_SOURCE_STATUS", severity: "ERROR", entryName: entry.name, message: `"${entry.name}" is an active, non-bootstrap secret with no authoritativeRecoverySourceStatus.` });
    }

    // FUTURE_NOT_PROVISIONED must never be required.
    if (entry.category === "FUTURE_NOT_PROVISIONED" && entry.required) {
      findings.push({ code: "FUTURE_ITEM_MARKED_REQUIRED", severity: "ERROR", entryName: entry.name, message: `"${entry.name}" is FUTURE_NOT_PROVISIONED but marked required — a not-yet-provisioned item can never be required.` });
    }
  }

  // Cross-check against docs/production-environment-register.md's own independent enumeration, if supplied — surfaces naming drift without renaming anything.
  if (params.productionEnvironmentRegisterDocContent) {
    const docNames = extractBacktickedVarNames(params.productionEnvironmentRegisterDocContent);
    const registerNamesAndAliases = new Set(params.register.flatMap((e) => [e.name, ...e.aliasNames]));
    for (const docName of docNames) {
      if (!registerNamesAndAliases.has(docName)) {
        findings.push({ code: "NAME_IN_OTHER_REGISTER_NOT_IN_RECOVERY_REGISTER", severity: "INFO", entryName: docName, message: `"${docName}" appears in docs/production-environment-register.md but has no entry in the configuration recovery register — review whether it needs one (informational: that document also references some non-variable identifiers, so not every hit is a real gap).` });
      }
    }
  }

  const templatePresenceExpectedEntries = params.register.filter((e) => e.templatePresenceExpected);
  const templatePresenceExpectedEntryCount = templatePresenceExpectedEntries.length;
  const templatePresenceExpectedNameCount = templatePresenceExpectedEntries.reduce((sum, e) => sum + 1 + e.aliasNames.length, 0);

  const passed = findings.every((f) => f.severity !== "ERROR");
  return {
    findings,
    passed,
    summary: { totalEntries: params.register.length, byCategory, activeSecretsWithoutRecoveryClass, templatePresenceExpectedEntryCount, templatePresenceExpectedNameCount, templateMissingEntryCount, templateMissingNameCount },
  };
}
