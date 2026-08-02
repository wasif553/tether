import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { armLockdownFault, consumeLockdownFault, clearAllLockdownFaults, LOCKDOWN_FAULT_KINDS } from "./lockdownFaultInjection";

describe("lockdownFaultInjection — Part 17 dev/test-only fault injection", () => {
  afterEach(() => {
    clearAllLockdownFaults();
    vi.unstubAllEnvs();
  });

  it("consumeLockdownFault is false when never armed", () => {
    expect(consumeLockdownFault("PROCESS_ENUMERATION_TIMEOUT")).toBe(false);
  });

  it("arming a fault makes the next consume return true exactly once", () => {
    armLockdownFault("PROCESS_ENUMERATION_TIMEOUT");
    expect(consumeLockdownFault("PROCESS_ENUMERATION_TIMEOUT")).toBe(true);
    expect(consumeLockdownFault("PROCESS_ENUMERATION_TIMEOUT")).toBe(false);
  });

  it("covers all seven required fault kinds", () => {
    expect(LOCKDOWN_FAULT_KINDS).toEqual([
      "PROCESS_ENUMERATION_TIMEOUT",
      "PROCESS_ENUMERATION_PERMISSION_DENIED",
      "PROCESS_ENUMERATION_MALFORMED_OUTPUT",
      "PROHIBITED_PROCESS_APPEARS",
      "PROHIBITED_PROCESS_DISAPPEARS",
      "RESTORATION_FAILURE",
      "IPC_TIMEOUT",
    ]);
  });

  it("arming one kind never affects another", () => {
    armLockdownFault("RESTORATION_FAILURE");
    expect(consumeLockdownFault("IPC_TIMEOUT")).toBe(false);
    expect(consumeLockdownFault("RESTORATION_FAILURE")).toBe(true);
  });

  it("clearAllLockdownFaults clears every armed fault", () => {
    armLockdownFault("PROCESS_ENUMERATION_TIMEOUT");
    armLockdownFault("RESTORATION_FAILURE");
    clearAllLockdownFaults();
    expect(consumeLockdownFault("PROCESS_ENUMERATION_TIMEOUT")).toBe(false);
    expect(consumeLockdownFault("RESTORATION_FAILURE")).toBe(false);
  });

  it("never exposed in a production environment — armLockdownFault/consumeLockdownFault are no-ops when NODE_ENV=production", () => {
    vi.stubEnv("NODE_ENV", "production");
    armLockdownFault("PROCESS_ENUMERATION_TIMEOUT");
    expect(consumeLockdownFault("PROCESS_ENUMERATION_TIMEOUT")).toBe(false);
  });
});
