import { describe, it, expect } from "vitest";
import { generatePlainSebConfig, computeSebConfigHash, SUPPORTED_SEB_CONFIG_KEYS, SINGLE_DISPLAY_MAX_COUNT, type SebConfigInput } from "./sebConfigGenerator";

function baseInput(overrides: Partial<SebConfigInput> = {}): SebConfigInput {
  return {
    startUrl: "https://tether-murex.vercel.app/student/exams/exam-1",
    quitUrl: "https://tether-murex.vercel.app/student/dashboard",
    allowedOrigins: ["https://tether-murex.vercel.app"],
    allowPrinting: false,
    allowClipboard: false,
    allowExternalNavigation: false,
    singleDisplayRequired: false,
    configurationName: "Test Exam",
    ...overrides,
  };
}

function extractKeyValue(config: string, key: string): string | null {
  const match = config.match(new RegExp(`<key>${key}</key>\\s*<(\\w+)>([^<]*)</\\1>`));
  return match ? match[2] : null;
}

/** True if `key` is immediately followed (across whitespace) by a self-closing `<false/>` or `<true/>` boolean tag. */
function keyHasBooleanValue(config: string, key: string, value: boolean): boolean {
  return new RegExp(`<key>${key}</key>\\s*<${value ? "true" : "false"}/>`).test(config);
}

describe("generatePlainSebConfig", () => {
  it("produces a well-formed XML plist containing the start and quit URLs", () => {
    const config = generatePlainSebConfig(baseInput());
    expect(config).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(config).toContain("<plist version=\"1.0\">");
    expect(config).toContain("https://tether-murex.vercel.app/student/exams/exam-1");
    expect(config).toContain("https://tether-murex.vercel.app/student/dashboard");
  });

  it("is fully deterministic — identical input produces byte-identical output", () => {
    const input = baseInput();
    expect(generatePlainSebConfig(input)).toBe(generatePlainSebConfig(input));
  });

  it("XML-escapes special characters in URLs rather than injecting raw markup", () => {
    const config = generatePlainSebConfig(baseInput({ startUrl: "https://example.test/?a=1&b=2" }));
    expect(config).toContain("&amp;");
    expect(config).not.toContain("?a=1&b=2");
  });

  it("reflects allowPrinting and allowExternalNavigation as boolean plist values", () => {
    const printingOn = generatePlainSebConfig(baseInput({ allowPrinting: true }));
    const printingOff = generatePlainSebConfig(baseInput({ allowPrinting: false }));
    expect(printingOn).not.toBe(printingOff);
  });

  it("never writes a top-level key outside the documented SUPPORTED_SEB_CONFIG_KEYS allowlist", () => {
    // URLFilterRules entries are dicts with their own well-known keys
    // (active/regex/expression/action) — a different, documented
    // namespace nested inside the URLFilterRules array value, not a
    // top-level plist key, so they're allowed here alongside the
    // top-level allowlist.
    const urlFilterRuleKeys = ["active", "regex", "expression", "action"];
    const config = generatePlainSebConfig(baseInput());
    const keyMatches = [...config.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
    for (const key of keyMatches) {
      expect([...SUPPORTED_SEB_CONFIG_KEYS, ...urlFilterRuleKeys]).toContain(key);
    }
  });
});

describe("computeSebConfigHash", () => {
  it("is deterministic and stable across regenerations of the same input", () => {
    const config = generatePlainSebConfig(baseInput());
    expect(computeSebConfigHash(config)).toBe(computeSebConfigHash(config));
  });

  it("changes when the generated config changes", () => {
    const a = generatePlainSebConfig(baseInput());
    const b = generatePlainSebConfig(baseInput({ singleDisplayRequired: true }));
    expect(computeSebConfigHash(a)).not.toBe(computeSebConfigHash(b));
  });
});

// ---------------------------------------------------------------------------
// Single Display Requirement v1 — see docs/secure-client-foundation-seb-v1.md,
// "Display requirement". allowedDisplaysMaxNumber is the verified,
// official SEB config key (see the source comment above
// SINGLE_DISPLAY_MAX_COUNT in sebConfigGenerator.ts for the citations) —
// these tests only confirm this generator wires it correctly; they do
// not (and cannot) confirm real Safe Exam Browser actually enforces it —
// see the manual real-device checklist in
// docs/secure-client-foundation-seb-v1.md.
// ---------------------------------------------------------------------------

describe("single display requirement", () => {
  it("UNRESTRICTED (singleDisplayRequired: false) omits both allowDisplayMirroring and allowedDisplaysMaxNumber", () => {
    const config = generatePlainSebConfig(baseInput({ singleDisplayRequired: false }));
    expect(config).not.toContain("allowDisplayMirroring");
    expect(config).not.toContain("allowedDisplaysMaxNumber");
  });

  it("SINGLE_DISPLAY_REQUIRED sets both verified official keys: allowDisplayMirroring=false and allowedDisplaysMaxNumber=1", () => {
    const config = generatePlainSebConfig(baseInput({ singleDisplayRequired: true }));
    expect(keyHasBooleanValue(config, "allowDisplayMirroring", false)).toBe(true);
    expect(config).toContain("<key>allowedDisplaysMaxNumber</key>");
    expect(extractKeyValue(config, "allowedDisplaysMaxNumber")).toBe(String(SINGLE_DISPLAY_MAX_COUNT));
    expect(SINGLE_DISPLAY_MAX_COUNT).toBe(1);
  });

  it("never writes allowedDisplayBuiltin — the policy requires one active display, not specifically the built-in display", () => {
    const config = generatePlainSebConfig(baseInput({ singleDisplayRequired: true }));
    expect(config).not.toContain("allowedDisplayBuiltin");
  });

  it("never writes an unverified/guessed key name such as maxDisplays or allowExternalScreen", () => {
    const config = generatePlainSebConfig(baseInput({ singleDisplayRequired: true }));
    expect(config).not.toContain("maxDisplays");
    expect(config).not.toContain("allowExternalScreen");
  });

  it("remains deterministic with singleDisplayRequired set", () => {
    const input = baseInput({ singleDisplayRequired: true });
    expect(generatePlainSebConfig(input)).toBe(generatePlainSebConfig(input));
  });

  it("only ever writes a key from the documented allowlist, with or without the display restriction", () => {
    const urlFilterRuleKeys = ["active", "regex", "expression", "action"];
    for (const singleDisplayRequired of [true, false]) {
      const config = generatePlainSebConfig(baseInput({ singleDisplayRequired }));
      const keyMatches = [...config.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
      for (const key of keyMatches) {
        expect([...SUPPORTED_SEB_CONFIG_KEYS, ...urlFilterRuleKeys]).toContain(key);
      }
    }
  });

  it("no private or encrypted key material (Browser Exam Key, Config Key, signing keys) ever appears in the generated output", () => {
    const config = generatePlainSebConfig(baseInput({ singleDisplayRequired: true }));
    expect(config).not.toMatch(/browserExamKey/i);
    expect(config).not.toMatch(/configKey/i);
    expect(config).not.toMatch(/signingKey/i);
    expect(config).not.toMatch(/rawKeyCiphertext/i);
    expect(config).not.toMatch(/-----BEGIN/);
  });

  it("existing Browser Exam Key / Config Key related behaviour is unaffected — this generator never touches key material at all, with or without the display restriction", () => {
    // The SEB config generator never accepts or emits Browser Exam Key /
    // Config Key values in the first place (those are validated
    // separately via header/JS-API round-trip — see sebBrowserExamKey.ts)
    // — toggling singleDisplayRequired must not introduce any such field.
    const withDisplay = generatePlainSebConfig(baseInput({ singleDisplayRequired: true }));
    const withoutDisplay = generatePlainSebConfig(baseInput({ singleDisplayRequired: false }));
    for (const config of [withDisplay, withoutDisplay]) {
      expect(config).not.toContain("BrowserExamKey");
      expect(config).not.toContain("ConfigKey");
    }
  });
});
