/**
 * Retention Execution Safety and Privacy Correction v1 — see
 * docs/privacy-and-evidence-retention-v1.md, Section 20.
 *
 * Unit-level tests over the pure argument parser/gate only — no
 * database, no child process spawned. Mirrors
 * scripts/releaseValidation/dbSafetyGuard.test.ts's own pattern.
 */
import { describe, expect, it } from "vitest";
import { checkExecuteSafety, isPositiveIntegerDays, parseEvidenceRetentionArgs } from "./cliArgs";

describe("parseEvidenceRetentionArgs", () => {
  it("defaults to dry run with no retentionDays/institutionId when no flags are passed", () => {
    const parsed = parseEvidenceRetentionArgs([]);
    expect(parsed).toEqual({ execute: false, retentionDays: undefined, institutionId: undefined });
  });

  it("[4] accepts --institution-id for a dry run", () => {
    const parsed = parseEvidenceRetentionArgs(["--institution-id", "inst-123"]);
    expect(parsed.execute).toBe(false);
    expect(parsed.institutionId).toBe("inst-123");
  });

  it("[7] parses --execute with both --institution-id and --retention-days", () => {
    const parsed = parseEvidenceRetentionArgs(["--execute", "--institution-id", "inst-123", "--retention-days", "180"]);
    expect(parsed.execute).toBe(true);
    expect(parsed.institutionId).toBe("inst-123");
    expect(parsed.retentionDays).toBe(180);
  });

  it("ignores a non-positive or non-numeric --retention-days value (leaves it undefined)", () => {
    expect(parseEvidenceRetentionArgs(["--retention-days", "0"]).retentionDays).toBeUndefined();
    expect(parseEvidenceRetentionArgs(["--retention-days", "-5"]).retentionDays).toBeUndefined();
    expect(parseEvidenceRetentionArgs(["--retention-days", "not-a-number"]).retentionDays).toBeUndefined();
  });

  describe("[TETHER_RETENTION_INTEGER_GUARD_FINAL_FIX] --retention-days must be a whole positive integer", () => {
    it("[1] accepts 1", () => {
      expect(parseEvidenceRetentionArgs(["--retention-days", "1"]).retentionDays).toBe(1);
    });

    it("[2] accepts 180", () => {
      expect(parseEvidenceRetentionArgs(["--retention-days", "180"]).retentionDays).toBe(180);
    });

    it("[3] rejects 1.5 (leaves retentionDays undefined)", () => {
      expect(parseEvidenceRetentionArgs(["--retention-days", "1.5"]).retentionDays).toBeUndefined();
    });

    it("[4] rejects 0.1 (leaves retentionDays undefined)", () => {
      expect(parseEvidenceRetentionArgs(["--retention-days", "0.1"]).retentionDays).toBeUndefined();
    });

    it("rejects 180.25 (leaves retentionDays undefined)", () => {
      expect(parseEvidenceRetentionArgs(["--retention-days", "180.25"]).retentionDays).toBeUndefined();
    });

    it("[5] rejects zero (leaves retentionDays undefined)", () => {
      expect(parseEvidenceRetentionArgs(["--retention-days", "0"]).retentionDays).toBeUndefined();
    });

    it("[6] rejects negative values (leaves retentionDays undefined)", () => {
      expect(parseEvidenceRetentionArgs(["--retention-days", "-5"]).retentionDays).toBeUndefined();
      expect(parseEvidenceRetentionArgs(["--retention-days", "-1.5"]).retentionDays).toBeUndefined();
    });

    it("[7] rejects malformed values (leaves retentionDays undefined)", () => {
      expect(parseEvidenceRetentionArgs(["--retention-days", "not-a-number"]).retentionDays).toBeUndefined();
      expect(parseEvidenceRetentionArgs(["--retention-days", "Infinity"]).retentionDays).toBeUndefined();
      expect(parseEvidenceRetentionArgs(["--retention-days", "NaN"]).retentionDays).toBeUndefined();
      expect(parseEvidenceRetentionArgs(["--retention-days", ""]).retentionDays).toBeUndefined();
    });
  });

  it("ignores an empty/whitespace-only --institution-id value (leaves it undefined)", () => {
    expect(parseEvidenceRetentionArgs(["--institution-id", ""]).institutionId).toBeUndefined();
    expect(parseEvidenceRetentionArgs(["--institution-id", "  "]).institutionId).toBeUndefined();
  });
});

describe("checkExecuteSafety", () => {
  it("always passes for a dry run (execute: false), regardless of other args", () => {
    expect(checkExecuteSafety({ execute: false })).toEqual({ ok: true });
    expect(checkExecuteSafety({ execute: false, institutionId: "all" })).toEqual({ ok: true });
  });

  it("[5] fails closed when --execute is supplied without --institution-id", () => {
    const result = checkExecuteSafety({ execute: true, retentionDays: 180 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/--institution-id/);
      expect(result.reason).toMatch(/deployment-wide/i);
    }
  });

  it("[6] fails closed when --execute is supplied without --retention-days", () => {
    const result = checkExecuteSafety({ execute: true, institutionId: "inst-123" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/--retention-days/);
    }
  });

  it("fails closed when --execute is supplied with neither required argument", () => {
    const result = checkExecuteSafety({ execute: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/--institution-id/);
      expect(result.reason).toMatch(/--retention-days/);
    }
  });

  it('[8] rejects --institution-id "all" for --execute — no deployment-wide destructive path remains', () => {
    const result = checkExecuteSafety({ execute: true, institutionId: "all", retentionDays: 180 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/"all"/);
      expect(result.reason).toMatch(/deployment-wide/i);
    }
  });

  it('rejects --institution-id "ALL" case-insensitively', () => {
    const result = checkExecuteSafety({ execute: true, institutionId: "ALL", retentionDays: 180 });
    expect(result.ok).toBe(false);
  });

  it("[7] passes when --execute is supplied with both a specific --institution-id and a positive --retention-days", () => {
    const result = checkExecuteSafety({ execute: true, institutionId: "inst-123", retentionDays: 180 });
    expect(result).toEqual({ ok: true });
  });

  it("[TETHER_RETENTION_INTEGER_GUARD_FINAL_FIX 11] a decimal --retention-days never reaches checkExecuteSafety as a value — parseEvidenceRetentionArgs already dropped it, so --execute fails closed exactly like a missing flag", () => {
    // End-to-end through the real parser: "--retention-days 1.5" is
    // rejected at parse time (retentionDays stays undefined), so the
    // execute-safety gate reports it as missing, not as "1.5 accepted".
    const parsed = parseEvidenceRetentionArgs(["--execute", "--institution-id", "inst-123", "--retention-days", "1.5"]);
    expect(parsed.retentionDays).toBeUndefined();
    const result = checkExecuteSafety(parsed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/--retention-days/);
  });
});

describe("[TETHER_RETENTION_INTEGER_GUARD_FINAL_FIX] isPositiveIntegerDays", () => {
  it("[1][2] accepts whole positive integers", () => {
    expect(isPositiveIntegerDays(1)).toBe(true);
    expect(isPositiveIntegerDays(180)).toBe(true);
  });

  it("[3][4] rejects non-integer (decimal) values", () => {
    expect(isPositiveIntegerDays(1.5)).toBe(false);
    expect(isPositiveIntegerDays(0.1)).toBe(false);
    expect(isPositiveIntegerDays(180.25)).toBe(false);
  });

  it("[5] rejects zero", () => {
    expect(isPositiveIntegerDays(0)).toBe(false);
  });

  it("[6] rejects negative values", () => {
    expect(isPositiveIntegerDays(-5)).toBe(false);
    expect(isPositiveIntegerDays(-0.5)).toBe(false);
  });

  it("[7] rejects NaN and Infinity", () => {
    expect(isPositiveIntegerDays(NaN)).toBe(false);
    expect(isPositiveIntegerDays(Infinity)).toBe(false);
    expect(isPositiveIntegerDays(-Infinity)).toBe(false);
  });
});
