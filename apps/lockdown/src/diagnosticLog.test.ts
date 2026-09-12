import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Windows Hardening v1.8.0 physical-test diagnosis follow-up — the
 * file-persistence half of diagnosticLog(), added so a packaged,
 * no-console physical test run leaves inspectable evidence of exactly
 * how far the keyboard-hardening handshake got. shouldLogDiagnostic's
 * own gating logic is unchanged and still exercised transitively here.
 */

let tempUserDataDir: string;

vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return false;
    },
    getPath: (name: string) => (name === "userData" ? tempUserDataDir : os.tmpdir()),
  },
}));

describe("diagnosticLog — file persistence", () => {
  beforeEach(() => {
    tempUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tether-diagnosticlog-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempUserDataDir, { recursive: true, force: true });
  });

  it("appends a line to userData/tether-secure-browser-native-diagnostics.log containing the checkpoint and data when logging is enabled", async () => {
    const { diagnosticLog, NATIVE_DIAGNOSTIC_LOG_FILE_NAME } = await import("./diagnosticLog");
    diagnosticLog("keyboardHookHelperManager: helper spawned", { pid: 4242 });

    const logPath = path.join(tempUserDataDir, NATIVE_DIAGNOSTIC_LOG_FILE_NAME);
    expect(fs.existsSync(logPath)).toBe(true);
    const content = fs.readFileSync(logPath, "utf8");
    expect(content).toContain("keyboardHookHelperManager: helper spawned");
    expect(content).toContain('"pid":4242');
  });

  it("appends multiple checkpoints across calls, each on its own line, in call order", async () => {
    const { diagnosticLog, NATIVE_DIAGNOSTIC_LOG_FILE_NAME } = await import("./diagnosticLog");
    diagnosticLog("keyboardHookHelperManager: pipe connected", {});
    diagnosticLog("keyboardHookHelperManager: HELLO accepted", {});
    diagnosticLog("keyboardHookHelperManager: ARM sent", {});

    const logPath = path.join(tempUserDataDir, NATIVE_DIAGNOSTIC_LOG_FILE_NAME);
    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("pipe connected");
    expect(lines[1]).toContain("HELLO accepted");
    expect(lines[2]).toContain("ARM sent");
  });

  it("never throws even if the file write fails (e.g. app.getPath itself throws) — console.log-only behaviour is preserved", async () => {
    vi.resetModules();
    vi.doMock("electron", () => ({
      app: {
        isPackaged: false,
        getPath: () => {
          throw new Error("simulated getPath failure");
        },
      },
    }));
    const { diagnosticLog } = await import("./diagnosticLog");
    expect(() => diagnosticLog("some checkpoint", {})).not.toThrow();
  });
});
