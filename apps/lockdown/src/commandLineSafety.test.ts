import { describe, it, expect } from "vitest";
import { findUnsafeCommandLineSwitch } from "./commandLineSafety";

describe("findUnsafeCommandLineSwitch", () => {
  it("returns null for an ordinary launch (no switches, or only the deep-link arg)", () => {
    expect(findUnsafeCommandLineSwitch(["electron.exe"])).toBeNull();
    expect(findUnsafeCommandLineSwitch(["electron.exe", "tether://launch?examId=abc"])).toBeNull();
  });

  it("detects --remote-debugging-port with and without a value", () => {
    expect(findUnsafeCommandLineSwitch(["electron.exe", "--remote-debugging-port=9222"])).toBe("--remote-debugging-port=9222");
    expect(findUnsafeCommandLineSwitch(["electron.exe", "--remote-debugging-port"])).toBe("--remote-debugging-port");
  });

  it("detects --inspect and --inspect-brk", () => {
    expect(findUnsafeCommandLineSwitch(["electron.exe", "--inspect=9229"])).toBe("--inspect=9229");
    expect(findUnsafeCommandLineSwitch(["electron.exe", "--inspect-brk"])).toBe("--inspect-brk");
  });

  it("detects --disable-web-security and --ignore-certificate-errors", () => {
    expect(findUnsafeCommandLineSwitch(["electron.exe", "--disable-web-security"])).toBe("--disable-web-security");
    expect(findUnsafeCommandLineSwitch(["electron.exe", "--ignore-certificate-errors"])).toBe("--ignore-certificate-errors");
  });

  it("is case-insensitive", () => {
    expect(findUnsafeCommandLineSwitch(["electron.exe", "--REMOTE-DEBUGGING-PORT=9222"])).toBe("--REMOTE-DEBUGGING-PORT=9222");
  });

  it("never matches a switch that merely CONTAINS an unsafe prefix as a substring, not a real prefix", () => {
    expect(findUnsafeCommandLineSwitch(["electron.exe", "--my-inspect-tool=1"])).toBeNull();
  });

  it("matches on the exact switch name or name=value boundary only, never a bare substring — a different switch that merely starts with the same letters is not flagged", () => {
    expect(findUnsafeCommandLineSwitch(["electron.exe", "--inspector-panel"])).toBeNull();
  });
});
