import { describe, it, expect, afterEach, vi } from "vitest";
import { resolveLockdownPolicyToggles } from "./tetherLockdownConfig";

describe("resolveLockdownPolicyToggles — Part 12 conservative pilot-safe defaults", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults match the documented conservative posture", () => {
    vi.stubEnv("TETHER_BLOCK_REMOTE_CONTROL", undefined);
    vi.stubEnv("TETHER_BLOCK_SCREEN_CAPTURE_TOOLS", undefined);
    vi.stubEnv("TETHER_BLOCK_DEBUG_TOOLS", undefined);
    vi.stubEnv("TETHER_BLOCK_VIRTUAL_MACHINES", undefined);
    expect(resolveLockdownPolicyToggles()).toEqual({
      blockRemoteControl: true,
      blockScreenCaptureTools: true,
      blockDebugTools: false,
      blockVirtualMachines: false,
    });
  });

  it("respects an explicit true/false override for each toggle", () => {
    vi.stubEnv("TETHER_BLOCK_REMOTE_CONTROL", "false");
    vi.stubEnv("TETHER_BLOCK_DEBUG_TOOLS", "true");
    const toggles = resolveLockdownPolicyToggles();
    expect(toggles.blockRemoteControl).toBe(false);
    expect(toggles.blockDebugTools).toBe(true);
  });

  it("accepts 1/0 as well as true/false", () => {
    vi.stubEnv("TETHER_BLOCK_VIRTUAL_MACHINES", "1");
    expect(resolveLockdownPolicyToggles().blockVirtualMachines).toBe(true);
  });

  it("falls back to the documented default on a malformed value", () => {
    vi.stubEnv("TETHER_BLOCK_SCREEN_CAPTURE_TOOLS", "not-a-boolean");
    expect(resolveLockdownPolicyToggles().blockScreenCaptureTools).toBe(true);
  });
});
