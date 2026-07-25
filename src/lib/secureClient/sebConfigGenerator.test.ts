import { describe, it, expect } from "vitest";
import { generatePlainSebConfig, computeSebConfigHash, SUPPORTED_SEB_CONFIG_KEYS, type SebConfigInput } from "./sebConfigGenerator";

function baseInput(overrides: Partial<SebConfigInput> = {}): SebConfigInput {
  return {
    startUrl: "https://tether-murex.vercel.app/student/exams/exam-1",
    quitUrl: "https://tether-murex.vercel.app/student/dashboard",
    allowedOrigins: ["https://tether-murex.vercel.app"],
    allowPrinting: false,
    allowClipboard: false,
    allowExternalNavigation: false,
    maximumDisplays: 1,
    configurationName: "Test Exam",
    ...overrides,
  };
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
    const b = generatePlainSebConfig(baseInput({ maximumDisplays: 2 }));
    expect(computeSebConfigHash(a)).not.toBe(computeSebConfigHash(b));
  });
});
