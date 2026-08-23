/**
 * Retention Execution Safety and Privacy Correction v1 — see
 * docs/privacy-and-evidence-retention-v1.md, Section 20/27 and
 * docs/evidence-retention-operations-v1.md.
 *
 * Static regression guard over documentation content (mirrors
 * src/lib/pilotUiTerminology.test.ts's own pattern: read real files on
 * disk, normalise line-wrapping, assert on substrings/regex). Locks in
 * the three corrections from this pass so a future doc edit can't
 * silently reintroduce a stale/inaccurate claim:
 *   [9]  session binding is not described as optional/off-by-default;
 *   [10] operations docs use scoped destructive command examples;
 *   [11] partial-deletion/retry wording matches actual runner behaviour.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

describe("[9] session binding is not described as optional/off-by-default", () => {
  const content = read("docs/privacy-and-evidence-retention-v1.md").replace(/\s+/g, " ");

  it("the off-by-default optional-feature list no longer includes session binding", () => {
    // The corrected Section 6 sentence lists these optional features —
    // session binding must not appear inside it.
    const optionalListMatch = content.match(/Every \*\*optional monitoring feature\*\* \([^)]*\)/);
    expect(optionalListMatch).not.toBeNull();
    expect(optionalListMatch![0]).not.toMatch(/session binding/i);
  });

  it("explicitly states session binding is a baseline mechanism, not optional", () => {
    expect(content).toMatch(/session binding is not in this optional list/i);
    expect(content).toMatch(/baseline session-integrity\/security mechanism/i);
  });

  it("Section 12 also states session binding is baseline, not lecturer-enabled", () => {
    expect(content).toMatch(/is not lecturer-enabled and is not listed among the off-by-default/i);
  });

  it("retains the accurate privacy-minimised description (hashes only, coarse fingerprinting, no raw IP)", () => {
    expect(content).toMatch(/HMAC-hashed/i);
    expect(content).toMatch(/coarse device-profile fingerprint/i);
    expect(content).toMatch(/No raw IP is ever stored by this feature/i);
    expect(content).toMatch(/human reviewer/i);
    expect(content).toMatch(/does not make an automatic misconduct determination/i);
  });
});

describe("[10] operations docs use scoped destructive command examples", () => {
  const opsContent = read("docs/evidence-retention-operations-v1.md");
  const planContent = read("docs/tether-evidence-retention-plan.md");

  it("evidence-retention-operations-v1.md's destruction-execution example is scoped", () => {
    expect(opsContent).toMatch(/npm run evidence:retention -- --execute --institution-id <institution-id> --retention-days <approved-days>/);
  });

  it("evidence-retention-operations-v1.md does not recommend a bare, unscoped --execute command", () => {
    // A bare "npm run evidence:retention -- --execute" with nothing else on
    // the line would be the unscoped, now-rejected form.
    const bareExecuteLines = opsContent.split("\n").filter((line) => /npm run evidence:retention -- --execute\s*$/.test(line.trim()));
    expect(bareExecuteLines).toEqual([]);
  });

  it("tether-evidence-retention-plan.md's usage examples are scoped for --execute", () => {
    expect(planContent).toMatch(/npm run evidence:retention -- --execute --institution-id <institution-id> --retention-days 180/);
    expect(planContent).toMatch(/There is no unscoped\/deployment-wide `--execute` command/i);
  });

  it("both docs describe --execute as requiring institution-id and retention-days", () => {
    for (const content of [opsContent, planContent]) {
      const normalised = content.replace(/\s+/g, " ");
      expect(normalised).toMatch(/--institution-id/);
      expect(normalised).toMatch(/--retention-days/);
      expect(normalised).toMatch(/required|requires/i);
    }
  });
});

describe("[11] partial-deletion/retry wording matches actual runner behaviour", () => {
  const opsContent = read("docs/evidence-retention-operations-v1.md").replace(/\s+/g, " ");

  it("no longer claims a deletion failure never leaves a half-deleted state", () => {
    expect(opsContent).not.toMatch(/a failure never leaves a "half-deleted" state/i);
  });

  it("explicitly describes the storage-deleted/DB-row-remaining partial state as retryable", () => {
    expect(opsContent).toMatch(/this \*\*is\*\* a partial physical deletion/i);
    expect(opsContent).toMatch(/\*\*safely retryable\*\*/i);
    expect(opsContent).toMatch(/delete-of-missing-key as success/i);
  });

  it("still confirms the DB row and its audit record are never split from each other", () => {
    expect(opsContent).toMatch(/never split from each other/i);
  });
});
