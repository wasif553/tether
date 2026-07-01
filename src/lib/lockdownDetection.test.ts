import { afterEach, describe, expect, it, vi } from "vitest";
import { isRunningInLockdownBrowser, getLockdownVersion } from "./lockdownDetection";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isRunningInLockdownBrowser", () => {
  it("returns false when window is undefined (server-side)", () => {
    expect(isRunningInLockdownBrowser()).toBe(false);
  });

  it("returns false in a normal browser with no lockdown bridge or user agent marker", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (normal browser)" });
    expect(isRunningInLockdownBrowser()).toBe(false);
  });

  it("returns true when window.sesLockdown exists", () => {
    vi.stubGlobal("window", { sesLockdown: { version: "1.0.0" } });
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (normal browser)" });
    expect(isRunningInLockdownBrowser()).toBe(true);
  });

  it("returns true when the user agent contains the TetherSecureBrowser marker", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 TetherSecureBrowser/1.0.0" });
    expect(isRunningInLockdownBrowser()).toBe(true);
  });

  it("returns true when the user agent contains the legacy SESLockdown marker", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 SESLockdown/1.0.0" });
    expect(isRunningInLockdownBrowser()).toBe(true);
  });
});

describe("getLockdownVersion", () => {
  it("returns null when window is undefined", () => {
    expect(getLockdownVersion()).toBeNull();
  });

  it("prefers window.sesLockdown.version when present", () => {
    vi.stubGlobal("window", { sesLockdown: { version: "1.2.3" } });
    vi.stubGlobal("navigator", { userAgent: "SESLockdown/9.9.9" });
    expect(getLockdownVersion()).toBe("1.2.3");
  });

  it("falls back to parsing TetherSecureBrowser from the user agent when no bridge is present", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 TetherSecureBrowser/1.0.0" });
    expect(getLockdownVersion()).toBe("1.0.0");
  });

  it("falls back to parsing the legacy SESLockdown marker from the user agent", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 SESLockdown/1.0.0" });
    expect(getLockdownVersion()).toBe("1.0.0");
  });

  it("returns null when neither the bridge nor the user agent marker is present", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (normal browser)" });
    expect(getLockdownVersion()).toBeNull();
  });
});
