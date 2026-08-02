import { describe, it, expect, afterEach } from "vitest";
import { getWindowsProcessList } from "./windowsProcessList";
import { armLockdownFault, clearAllLockdownFaults } from "./lockdownFaultInjection";

// Part 17 — proves the fault-injection wiring inside getWindowsProcessList
// itself (not just the standalone module), without ever spawning a real
// PowerShell process — every armed fault short-circuits before the
// platform check, so this is safe to run on any CI platform.
describe("getWindowsProcessList — Part 17 fault injection wiring", () => {
  afterEach(() => {
    clearAllLockdownFaults();
  });

  it("PROCESS_ENUMERATION_TIMEOUT short-circuits to a timeout result", async () => {
    armLockdownFault("PROCESS_ENUMERATION_TIMEOUT");
    expect(await getWindowsProcessList(5_000)).toEqual({ ok: false, reason: "timeout" });
  });

  it("PROCESS_ENUMERATION_PERMISSION_DENIED short-circuits to a spawn_failed result", async () => {
    armLockdownFault("PROCESS_ENUMERATION_PERMISSION_DENIED");
    expect(await getWindowsProcessList(5_000)).toEqual({ ok: false, reason: "spawn_failed" });
  });

  it("5/6. PROCESS_ENUMERATION_MALFORMED_OUTPUT short-circuits to a parse failure, never a clean empty result", async () => {
    armLockdownFault("PROCESS_ENUMERATION_MALFORMED_OUTPUT");
    const result = await getWindowsProcessList(5_000);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.parseResult).toEqual({ ok: false, reason: "parse_failed" });
  });

  it("each fault is one-shot — a second call after consuming it is unaffected (falls through to the real not_windows/spawn path in this test environment)", async () => {
    armLockdownFault("PROCESS_ENUMERATION_TIMEOUT");
    await getWindowsProcessList(5_000);
    const second = await getWindowsProcessList(5_000);
    expect(second).not.toEqual({ ok: false, reason: "timeout" });
  });
});
