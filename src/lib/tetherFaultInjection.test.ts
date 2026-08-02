import { describe, expect, it } from "vitest";
import { armFault, consumeFault, clearAllFaults, FAULT_KINDS } from "./tetherFaultInjection";

/**
 * Part 17 — deterministic development/test-only fault injection. This
 * project's default vitest environment is plain Node (no `window`), so
 * these functions are safe no-ops here — exactly matching what a
 * server-side render or a Production build sees (isEnabled() requires
 * BOTH NODE_ENV !== "production" AND a defined `window`). Real
 * arm/consume round-tripping requires a browser `window` and is a
 * documented manual/E2E concern (see docs/tether-secure-resume-recovery-v1.md,
 * "Manual crash/network physical test plan"); what's verified here is
 * the safety guarantee that matters for every OTHER test in this suite:
 * importing/calling this module can never affect a DB-backed test's
 * outcome.
 */
describe("tetherFaultInjection — safe no-op outside a browser (Part 17)", () => {
  it("every fault kind is a distinct, non-empty string", () => {
    expect(new Set(FAULT_KINDS).size).toBe(FAULT_KINDS.length);
    for (const kind of FAULT_KINDS) expect(kind.length).toBeGreaterThan(0);
  });

  it("armFault/consumeFault/clearAllFaults never throw without a browser window", () => {
    expect(() => armFault("AUTOSAVE_TIMEOUT")).not.toThrow();
    expect(consumeFault("AUTOSAVE_TIMEOUT")).toBe(false);
    expect(() => clearAllFaults()).not.toThrow();
  });
});
