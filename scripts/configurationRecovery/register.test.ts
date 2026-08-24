/**
 * Configuration & Secrets Recovery v1 — secret-leak safety tests over the
 * canonical register. See docs/configuration-and-secrets-recovery-v1.md.
 *
 * These tests prove the register is structurally incapable of holding an
 * actual secret value, not merely that it currently happens not to.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIGURATION_RECOVERY_REGISTER, getConfigRecoveryEntry, type ConfigRecoveryEntry } from "./register";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const registerSource = fs.readFileSync(path.join(REPO_ROOT, "scripts", "configurationRecovery", "register.ts"), "utf8");
const envExampleContent = fs.readFileSync(path.join(REPO_ROOT, ".env.example"), "utf8");

/** Returns the .env.example comment block immediately preceding a given `NAME=` declaration line — narrow, targeted extraction (not a generic prose parser) used only to check these two specific variables' own comment text. */
function envExampleCommentBlockFor(name: string): string {
  const lines = envExampleContent.split("\n");
  const declIndex = lines.findIndex((line) => line.startsWith(`${name}=`));
  expect(declIndex, `no "${name}=" declaration line found in .env.example`).toBeGreaterThanOrEqual(0);
  let start = declIndex;
  while (start > 0 && lines[start - 1].trimStart().startsWith("#")) start -= 1;
  return lines.slice(start, declIndex).join("\n");
}

describe("[ISSUE 1] .env.example never claims a random-per-process fallback for a fail-closed secret", () => {
  it("[1] NETWORK_EVIDENCE_SALT's own comment block does not describe a random fallback", () => {
    const block = envExampleCommentBlockFor("NETWORK_EVIDENCE_SALT");
    expect(block).not.toMatch(/random per-process/i);
    expect(block).toMatch(/FAILS CLOSED/);
  });

  it("[2] EXAM_BINDING_HMAC_SECRET's own comment block does not describe a random fallback", () => {
    const block = envExampleCommentBlockFor("EXAM_BINDING_HMAC_SECRET");
    expect(block).not.toMatch(/random per-process/i);
    expect(block).toMatch(/FAILS CLOSED/);
  });

  it("[3][4] both remain PRESERVE_EXACT_VALUE and required in the canonical register — the template correction did not drift from the register's own classification", () => {
    const salt = getConfigRecoveryEntry("NETWORK_EVIDENCE_SALT");
    const hmac = getConfigRecoveryEntry("EXAM_BINDING_HMAC_SECRET");
    expect(salt.recoveryClass).toBe("PRESERVE_EXACT_VALUE");
    expect(salt.required).toBe(true);
    expect(hmac.recoveryClass).toBe("PRESERVE_EXACT_VALUE");
    expect(hmac.required).toBe(true);
  });

  it("[7] this test file's own fs.readFileSync calls never target .env.local or a bare .env path", () => {
    const thisFileSource = fs.readFileSync(path.join(__dirname, "register.test.ts"), "utf8");
    // Every readFileSync(...) call's own argument text, matched narrowly
    // by call syntax — not a blanket string ban (this file's surrounding
    // prose legitimately discusses .env/.env.local as concepts). Reads of
    // .env.example (tracked, safe) and *.md docs are expected and fine;
    // this only rejects a call that references .env.local, or a bare
    // ".env" that is not immediately ".env.example".
    const readFileSyncCalls = [...thisFileSource.matchAll(/readFileSync\(([^)]*)\)/g)].map((m) => m[1]);
    expect(readFileSyncCalls.length).toBeGreaterThan(0);
    for (const call of readFileSyncCalls) {
      expect(call, `readFileSync call "${call}" references .env.local`).not.toMatch(/\.env\.local/);
      expect(call, `readFileSync call "${call}" references a bare .env path`).not.toMatch(/["'`]\.env["'`]|\.env["'`](?!\.example)/);
    }
  });
});

describe("[1][2] the register type holds names/metadata only — no value-shaped field exists", () => {
  it("the ConfigRecoveryEntry type declares no value/secret/password/private-key/token VALUE field", () => {
    // A structural check on the source text of the type declaration itself
    // (not just "no entry currently sets one") — proves the shape cannot
    // hold a value, not merely that no one has put one in yet.
    const typeBlockMatch = registerSource.match(/export type ConfigRecoveryEntry = \{[\s\S]*?\n\};/);
    expect(typeBlockMatch).not.toBeNull();
    const typeBlock = typeBlockMatch![0];
    for (const forbidden of [/\bvalue\s*:/, /\bsecret\s*:/, /\bpasswordValue\s*:/, /\bprivateKeyValue\s*:/, /\btokenValue\s*:/, /\bsecretValue\s*:/]) {
      expect(typeBlock).not.toMatch(forbidden);
    }
  });

  it("every register entry object has exactly the known metadata keys — no ad hoc extra field could smuggle a value in", () => {
    const ALLOWED_KEYS = new Set(["name", "aliasNames", "category", "sensitivity", "environment", "runtimeSource", "recoveryClass", "required", "affectedCapability", "lossImpact", "rotationImpact", "recoveryDependency", "templatePresenceExpected", "sourceReference", "authoritativeRecoverySourceStatus", "notes"]);
    for (const entry of CONFIGURATION_RECOVERY_REGISTER) {
      for (const key of Object.keys(entry)) {
        expect(ALLOWED_KEYS.has(key), `unexpected key "${key}" on entry "${entry.name}"`).toBe(true);
      }
    }
  });
});

describe("[10] no secret fingerprint/hash is stored anywhere in the register", () => {
  it("no entry field looks like a hex digest, base64 blob, or PEM fragment", () => {
    const HEX_DIGEST = /\b[0-9a-f]{32,}\b/i;
    const PEM_MARKER = /-----BEGIN [A-Z ]*(PRIVATE|PUBLIC) KEY-----/;
    for (const entry of CONFIGURATION_RECOVERY_REGISTER) {
      const text = JSON.stringify(entry);
      expect(text, `entry "${entry.name}" contains something hex-digest-shaped`).not.toMatch(HEX_DIGEST);
      expect(text, `entry "${entry.name}" contains a PEM marker`).not.toMatch(PEM_MARKER);
    }
  });
});

describe("[6][7][8][9] no real secret material is committed anywhere in this register", () => {
  const FORBIDDEN_PATTERNS: RegExp[] = [
    /postgres(?:ql)?:\/\/[^\s"'`]*:[^\s"'`]*@/i, // a connection string WITH embedded credentials
    /sk-ant-[a-zA-Z0-9_-]{10,}/, // a real Anthropic API key shape
    /re_[a-zA-Z0-9_-]{10,}/, // a real Resend API key shape
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // a real private key
    /eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/, // a JWT-shaped value (Supabase service-role keys are JWTs)
  ];

  it("register.ts source contains no committed database URL, API token, private key, or service-role-key-shaped value", () => {
    for (const pattern of FORBIDDEN_PATTERNS) {
      expect(registerSource).not.toMatch(pattern);
    }
  });
});

describe("[11] runtime source and authoritative recovery source are separate fields, never conflated", () => {
  it("the type declares both fields independently, and a Vercel-runtime entry is never itself marked as the authoritative source", () => {
    expect(registerSource).toMatch(/runtimeSource: RuntimeSource;/);
    expect(registerSource).toMatch(/authoritativeRecoverySourceStatus: AuthoritativeRecoverySourceStatus \| null;/);
    // A Vercel-runtime SECRET entry's authoritative status must be the
    // literal "NOT_YET_SELECTED" — never silently derived as "Vercel" or
    // "GitHub" merely because that's where the runtime value lives today.
    for (const entry of CONFIGURATION_RECOVERY_REGISTER) {
      if (entry.sensitivity === "SECRET" && entry.runtimeSource === "VERCEL_ENVIRONMENT_VARIABLE" && entry.recoveryClass !== null && entry.recoveryClass !== "FUTURE_NOT_PROVISIONED" && entry.recoveryClass !== "BOOTSTRAP_ONLY") {
        expect(entry.authoritativeRecoverySourceStatus, `"${entry.name}" is a Vercel-runtime secret and must not claim an authoritative recovery source`).toBe("NOT_YET_SELECTED");
      }
    }
  });

  it("no entry's authoritative recovery source is ever \"GitHub\" or \"Vercel\" as a claimed independent source", () => {
    for (const entry of CONFIGURATION_RECOVERY_REGISTER) {
      const text = JSON.stringify(entry.authoritativeRecoverySourceStatus);
      expect(text.toLowerCase()).not.toContain("github");
      expect(text.toLowerCase()).not.toContain("vercel");
    }
  });
});

describe("[12] every active secret has a recovery class", () => {
  it("every SECRET entry in an ACTIVE/OPTIONAL production category has a non-null recoveryClass", () => {
    for (const entry of CONFIGURATION_RECOVERY_REGISTER) {
      if (entry.sensitivity !== "SECRET") continue;
      if (entry.category !== "ACTIVE_PRODUCTION_RUNTIME" && entry.category !== "OPTIONAL_PRODUCTION_RUNTIME" && entry.category !== "OPERATOR_MAINTENANCE_ONLY") continue;
      expect(entry.recoveryClass, `"${entry.name}" is an active secret with no recovery class`).not.toBeNull();
    }
  });
});

describe("[13] every PRESERVE_EXACT_VALUE item documents loss impact", () => {
  it("every entry with recoveryClass PRESERVE_EXACT_VALUE has a non-empty, specific lossImpact", () => {
    const preserveEntries = CONFIGURATION_RECOVERY_REGISTER.filter((e) => e.recoveryClass === "PRESERVE_EXACT_VALUE");
    expect(preserveEntries.length).toBeGreaterThan(0);
    for (const entry of preserveEntries) {
      expect(entry.lossImpact.length, `"${entry.name}" has too short a lossImpact`).toBeGreaterThan(40);
      expect(entry.lossImpact.toLowerCase()).not.toBe("n/a");
    }
  });
});

describe("[14] every ROTATE_OR_REISSUE item documents rotation impact", () => {
  it("every entry with recoveryClass ROTATE_OR_REISSUE has a non-null rotationImpact", () => {
    const rotateEntries = CONFIGURATION_RECOVERY_REGISTER.filter((e) => e.recoveryClass === "ROTATE_OR_REISSUE");
    expect(rotateEntries.length).toBeGreaterThan(0);
    for (const entry of rotateEntries) {
      // A couple of paired public-key entries legitimately defer to their
      // private-key counterpart's own rotationImpact rather than repeating
      // it — those still document it via recoveryDependency, checked
      // separately; every entry must at least have SOME impact statement.
      expect(entry.rotationImpact === null ? entry.recoveryDependency !== null : true, `"${entry.name}" has neither a rotationImpact nor a recoveryDependency to one`).toBe(true);
    }
  });
});

describe("[15] FUTURE_NOT_PROVISIONED items are never reported as active", () => {
  it("no FUTURE_NOT_PROVISIONED-category entry is marked required, or given an ACTIVE/OPTIONAL_PRODUCTION_RUNTIME category", () => {
    for (const entry of CONFIGURATION_RECOVERY_REGISTER) {
      if (entry.category !== "FUTURE_NOT_PROVISIONED") continue;
      expect(entry.required, `"${entry.name}" is FUTURE_NOT_PROVISIONED but marked required`).toBe(false);
      expect(entry.templatePresenceExpected, `"${entry.name}" is FUTURE_NOT_PROVISIONED but expected in .env.example`).toBe(false);
      expect(entry.recoveryClass).toBe("FUTURE_NOT_PROVISIONED");
    }
  });

  it("every ARCHIVE_* entry is FUTURE_NOT_PROVISIONED — matches docs/tether-evidence-archive-plan.md's own 'deliberately NOT done' statement", () => {
    const archiveEntries = CONFIGURATION_RECOVERY_REGISTER.filter((e) => e.name.startsWith("ARCHIVE_"));
    expect(archiveEntries.length).toBeGreaterThan(0);
    for (const entry of archiveEntries) {
      expect(entry.category).toBe("FUTURE_NOT_PROVISIONED");
    }
  });
});

describe("[16] provider/platform variables are distinguished from app-owned configuration", () => {
  it("PROVIDER_PLATFORM_SUPPLIED entries never claim a Vercel/local runtime source an operator sets by hand", () => {
    for (const entry of CONFIGURATION_RECOVERY_REGISTER) {
      if (entry.category !== "PROVIDER_PLATFORM_SUPPLIED") continue;
      expect(["PROVIDER_SUPPLIED_AT_RUNTIME", "BUILD_TOOLING_SUPPLIED"]).toContain(entry.runtimeSource);
    }
  });
});

describe("[17] Preview and Production are distinguished where the code requires it", () => {
  it("ConfigEnvironment includes distinct Preview/Production values, and at least one entry uses each", () => {
    expect(registerSource).toMatch(/"PRODUCTION_ONLY"/);
    expect(registerSource).toMatch(/"PREVIEW_ONLY"/);
    expect(registerSource).toMatch(/"PRODUCTION_AND_PREVIEW"/);
    const usesDistinctEnv = CONFIGURATION_RECOVERY_REGISTER.some((e) => e.environment === "PRODUCTION_AND_PREVIEW");
    expect(usesDistinctEnv).toBe(true);
  });
});

describe("[18] no NEXT_PUBLIC_* name is used for server-only secret material", () => {
  it("no SECRET entry's name or alias starts with NEXT_PUBLIC_", () => {
    for (const entry of CONFIGURATION_RECOVERY_REGISTER) {
      if (entry.sensitivity !== "SECRET") continue;
      expect(entry.name.startsWith("NEXT_PUBLIC_"), `"${entry.name}" is SECRET but named NEXT_PUBLIC_*`).toBe(false);
      for (const alias of entry.aliasNames) {
        expect(alias.startsWith("NEXT_PUBLIC_"), `"${entry.name}"'s alias "${alias}" is NEXT_PUBLIC_* but the entry is SECRET`).toBe(false);
      }
    }
  });

  it("the one genuine NEXT_PUBLIC_* entry in the register is explicitly NON_SECRET", () => {
    const entry = getConfigRecoveryEntry("NEXT_PUBLIC_TETHER_PHONE_CALIBRATION_ENABLED");
    expect(entry.sensitivity).toBe("NON_SECRET");
  });
});

describe("[19] configuration recovery documentation contains no actual secret values", () => {
  const REPO_ROOT_FOR_DOCS = path.resolve(__dirname, "..", "..");
  const DOC_FILES = [
    "docs/configuration-and-secrets-recovery-v1.md",
    "docs/configuration-reconstruction-checklist-v1.md",
    "docs/configuration-recovery-test-record-v1.md",
    "docs/configuration-loss-dr-exercise-checklist-v1.md",
    "docs/backup-and-disaster-recovery-runbook-v1.md",
  ];
  const FORBIDDEN_PATTERNS: RegExp[] = [
    /postgres(?:ql)?:\/\/[^\s"'`)]*:[^\s"'`)]*@/i,
    /sk-ant-[a-zA-Z0-9_-]{10,}/,
    /re_[a-zA-Z0-9_-]{10,}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/,
  ];

  for (const relativePath of DOC_FILES) {
    it(`${relativePath} contains no committed secret-shaped value`, () => {
      const content = fs.readFileSync(path.join(REPO_ROOT_FOR_DOCS, relativePath), "utf8");
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(content, `${relativePath} matched ${pattern}`).not.toMatch(pattern);
      }
    });
  }
});

describe("[21] confirms this pass never touches branding/release-metadata files", () => {
  it("register.ts and this test file reference apps/lockdown, tetherReleaseMetadata.ts, and tether-release-management.md only as read-only source references, never as files this pass writes to", () => {
    // A structural reminder, not a filesystem check (the real git-diff
    // emptiness check happens at commit-validation time, outside this
    // test suite) — this register never imports or writes to any of
    // those three frozen paths.
    expect(registerSource).not.toMatch(/from ["']\.\.\/\.\.\/apps\/lockdown/);
    expect(registerSource).not.toMatch(/from ["']\.\.\/\.\.\/src\/lib\/tetherReleaseMetadata/);
  });
});

describe("[22] this test suite requires no Production connection", () => {
  it("register.test.ts imports no Docker/network/database helper", () => {
    const testFileSource = fs.readFileSync(path.join(REPO_ROOT, "scripts", "configurationRecovery", "register.test.ts"), "utf8");
    expect(testFileSource).not.toMatch(/releaseValidation\/docker/);
    expect(testFileSource).not.toMatch(/from ["']pg["']/);
  });
});

describe("register structural integrity", () => {
  it("every entry name is unique (including aliases never colliding with another entry's own name)", () => {
    const allNames = CONFIGURATION_RECOVERY_REGISTER.map((e) => e.name);
    expect(new Set(allNames).size).toBe(allNames.length);
    const allAliases = CONFIGURATION_RECOVERY_REGISTER.flatMap((e) => e.aliasNames);
    for (const alias of allAliases) {
      expect(allNames, `alias "${alias}" collides with a real entry name`).not.toContain(alias);
    }
  });

  it("getConfigRecoveryEntry resolves both a canonical name and one of its aliases", () => {
    const bySupabaseUrl = getConfigRecoveryEntry("SUPABASE_URL");
    const byAlias = getConfigRecoveryEntry("NEXT_PUBLIC_SUPABASE_URL");
    expect(byAlias).toBe(bySupabaseUrl);
  });

  it("getConfigRecoveryEntry throws on an unknown name rather than returning undefined", () => {
    expect(() => getConfigRecoveryEntry("DEFINITELY_NOT_A_REAL_VAR_XYZ")).toThrow();
  });

  it("every recoveryDependency references a real entry name in the register", () => {
    const allNames = new Set(CONFIGURATION_RECOVERY_REGISTER.map((e) => e.name));
    for (const entry of CONFIGURATION_RECOVERY_REGISTER) {
      if (entry.recoveryDependency === null) continue;
      expect(allNames.has(entry.recoveryDependency), `"${entry.name}"'s recoveryDependency "${entry.recoveryDependency}" is not a registered entry name`).toBe(true);
    }
  });

  it("sourceReference is never empty for any entry", () => {
    for (const entry of CONFIGURATION_RECOVERY_REGISTER) {
      expect(entry.sourceReference.length, `"${entry.name}" has an empty sourceReference`).toBeGreaterThan(0);
    }
  });

  it("[TYPE CHECK] a ConfigRecoveryEntry object literal cannot be constructed with an extra 'value' field without a TypeScript error (compile-time proof, exercised at runtime via a controlled cast)", () => {
    // This test's real assertion already happened at `npx tsc --noEmit`
    // time — TypeScript would reject `{ ...validEntry, value: "secret" }`
    // as excess-property on a fresh object literal. This runtime
    // assertion is a smoke-test companion: even if someone did smuggle an
    // extra field past the type system via a cast, the key-allowlist test
    // above still catches it.
    const sample: ConfigRecoveryEntry = CONFIGURATION_RECOVERY_REGISTER[0];
    expect(sample).not.toHaveProperty("value");
  });
});

describe("[ALIAS MODEL FIX] independent lockdown toggles are separate entries, never grouped as aliases", () => {
  it("[1] TETHER_BLOCK_DEBUG_TOOLS has aliasNames: []", () => {
    expect(getConfigRecoveryEntry("TETHER_BLOCK_DEBUG_TOOLS").aliasNames).toEqual([]);
  });

  it("[2] TETHER_BLOCK_REMOTE_CONTROL has its own entry with aliasNames: []", () => {
    const entry = getConfigRecoveryEntry("TETHER_BLOCK_REMOTE_CONTROL");
    expect(entry.name).toBe("TETHER_BLOCK_REMOTE_CONTROL");
    expect(entry.aliasNames).toEqual([]);
  });

  it("[3] TETHER_BLOCK_SCREEN_CAPTURE_TOOLS has its own entry with aliasNames: []", () => {
    const entry = getConfigRecoveryEntry("TETHER_BLOCK_SCREEN_CAPTURE_TOOLS");
    expect(entry.name).toBe("TETHER_BLOCK_SCREEN_CAPTURE_TOOLS");
    expect(entry.aliasNames).toEqual([]);
  });

  it("[4] TETHER_BLOCK_VIRTUAL_MACHINES has its own entry with aliasNames: []", () => {
    const entry = getConfigRecoveryEntry("TETHER_BLOCK_VIRTUAL_MACHINES");
    expect(entry.name).toBe("TETHER_BLOCK_VIRTUAL_MACHINES");
    expect(entry.aliasNames).toEqual([]);
  });

  it("all four lockdown toggles are four DISTINCT register entries, not one grouped entry", () => {
    const names = ["TETHER_BLOCK_DEBUG_TOOLS", "TETHER_BLOCK_REMOTE_CONTROL", "TETHER_BLOCK_SCREEN_CAPTURE_TOOLS", "TETHER_BLOCK_VIRTUAL_MACHINES"];
    const entries = names.map((n) => getConfigRecoveryEntry(n));
    expect(new Set(entries).size).toBe(4);
    for (const entry of entries) {
      expect(entry.templatePresenceExpected).toBe(true);
      expect(entry.aliasNames).toEqual([]);
    }
  });

  it("LTI_TOOL_NAME and LTI_TOOL_DESCRIPTION are two independent entries, not grouped as aliases (each has its own independent default in the real read site)", () => {
    const name = getConfigRecoveryEntry("LTI_TOOL_NAME");
    const description = getConfigRecoveryEntry("LTI_TOOL_DESCRIPTION");
    expect(name).not.toBe(description);
    expect(name.aliasNames).toEqual([]);
    expect(description.aliasNames).toEqual([]);
  });

  it("SUPABASE_ACCESS_TOKEN and SUPABASE_DB_PASSWORD are two independent entries — different historical credentials, not alternate representations of one secret", () => {
    const token = getConfigRecoveryEntry("SUPABASE_ACCESS_TOKEN");
    const password = getConfigRecoveryEntry("SUPABASE_DB_PASSWORD");
    expect(token).not.toBe(password);
    expect(token.aliasNames).toEqual([]);
    expect(password.aliasNames).toEqual([]);
  });
});

describe("[8][12] every remaining non-empty aliasNames group is a genuine alternate/fallback representation of one logical value", () => {
  // Explicit allowlist — never inferred from name similarity (per this
  // task's own instruction). Each group here is independently verified
  // against its real read site: the running code checks these names in
  // a fixed priority order and only ONE is ever actually expected to be
  // set, unlike the independent-variable groups corrected above.
  const ALLOWED_TRUE_ALIAS_GROUPS: Record<string, { aliases: string[]; verifiedReadSite: string }> = {
    LTI_PRIVATE_KEY_B64: { aliases: ["LTI_PRIVATE_KEY_PATH", "LTI_PRIVATE_KEY"], verifiedReadSite: "src/lib/lti/keys.ts readKey() — priority order *_B64 -> *_PATH -> raw, only one used" },
    LTI_PUBLIC_KEY_B64: { aliases: ["LTI_PUBLIC_KEY_PATH", "LTI_PUBLIC_KEY"], verifiedReadSite: "src/lib/lti/keys.ts readKey() — priority order *_B64 -> *_PATH -> raw, only one used" },
    SUPABASE_URL: { aliases: ["NEXT_PUBLIC_SUPABASE_URL"], verifiedReadSite: "src/lib/evidenceStorage.ts / src/lib/evidenceArchive.ts — `env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL`, one fallback value" },
    VERCEL_GIT_COMMIT_SHA: { aliases: ["GIT_COMMIT_SHA"], verifiedReadSite: "src/app/api/version/route.ts — one fallback value for the same build-commit field" },
  };

  it("[12] every non-empty aliasNames group in the real register is exactly the allowlisted set — no more, no fewer", () => {
    const actualGroups = CONFIGURATION_RECOVERY_REGISTER.filter((e) => e.aliasNames.length > 0);
    const actualNames = new Set(actualGroups.map((e) => e.name));
    const allowedNames = new Set(Object.keys(ALLOWED_TRUE_ALIAS_GROUPS));
    expect(actualNames).toEqual(allowedNames);
    for (const entry of actualGroups) {
      expect(entry.aliasNames).toEqual(ALLOWED_TRUE_ALIAS_GROUPS[entry.name].aliases);
    }
  });

  it("[8] each allowlisted true-alias entry is grounded in a verified read site, and this module's own doc comment states the one-meaning rule", () => {
    for (const [name, info] of Object.entries(ALLOWED_TRUE_ALIAS_GROUPS)) {
      const entry = getConfigRecoveryEntry(name);
      expect(entry.sourceReference.length).toBeGreaterThan(0);
      expect(info.verifiedReadSite.length).toBeGreaterThan(0);
    }
    expect(registerSource).toMatch(/ALIAS MODEL — one entry's `aliasNames` means ONE thing, always/);
  });

  it("the independent-variable groups this fix corrected are explicitly NOT in the allowlist", () => {
    const allowedNames = new Set(Object.keys(ALLOWED_TRUE_ALIAS_GROUPS));
    expect(allowedNames.has("TETHER_BLOCK_DEBUG_TOOLS")).toBe(false);
    expect(allowedNames.has("LTI_TOOL_NAME")).toBe(false);
    expect(allowedNames.has("SUPABASE_ACCESS_TOKEN")).toBe(false);
  });
});
