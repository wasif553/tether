/**
 * Windows Hardening v1.8.0 — physical-test IPC/handshake investigation.
 *
 * "Much higher value than more pure protocol tests" (per the task this
 * fixes): spawns the REAL, PUBLISHED TetherKeyboardHelper.exe — not a
 * mock, not the in-memory PipeServer class — exactly the way
 * keyboardHookHelperManager.ts does (same argv shape, same spawn options,
 * same random pipe-name/token generation), and drives it through the real
 * named-pipe protocol using the SAME wire-framing functions production
 * uses (keyboardHardeningHelperProtocol.ts), never a hand-rolled
 * reimplementation of the framing.
 *
 * This is what actually caught the confirmed root cause of the physical
 * "never gets past helper spawn" failure: BuildCurrentUserOnlyPipeSecurity
 * in PipeServer.cs added an explicit Deny-Everyone ACE alongside the
 * Allow-current-user ACE. .NET's PipeSecurity canonicalizes a DACL's ACE
 * order on write (all explicit Deny ACEs before all explicit Allow ACEs,
 * regardless of call order) — confirmed via
 * `security.GetSecurityDescriptorSddlForm(...)`, which produced
 * "D:(D;;0x1f019f;;;WD)(A;;0x1f019f;;;<user-SID>)". Windows evaluates a
 * DACL in order and stops at the first ACE matching any SID in the
 * connecting token; "Everyone" (WD) is present in every token, including
 * the pipe-owning user's own, so the Deny-Everyone ACE matched first for
 * EVERY connect attempt — including the legitimate same-user Electron
 * client — before the Allow ACE further down the list was ever reached.
 * No amount of unit-testing the pure protocol/state-machine modules could
 * have caught this: it is a property of the real, published single-file
 * .exe's actual Windows ACL behaviour, only observable by really spawning
 * it and really trying to connect.
 *
 * Requires an actual win-x64 Windows host with the helper already
 * published to native-helper/bin/win-x64/TetherKeyboardHelper.exe (`npm
 * run build:helper`) — skips itself (never fails the suite) when either
 * precondition isn't met, e.g. on non-Windows CI or before a helper build.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { serializeOutboundKeyboardHelperMessage, parseInboundKeyboardHelperMessage, type KeyboardHelperInboundMessage } from "./keyboardHardeningHelperProtocol";

const HELPER_EXE_PATH = path.join(__dirname, "..", "native-helper", "bin", "win-x64", "TetherKeyboardHelper.exe");
const canRun = process.platform === "win32" && fs.existsSync(HELPER_EXE_PATH);

/** Thin real-pipe client harness — uses the SAME protocol framing functions production uses; only the connection retry/message-collection plumbing below is test-only. */
class RealHelperTestClient {
  child: ChildProcess;
  private socket: net.Socket | null = null;
  private buffer = "";
  private received: KeyboardHelperInboundMessage[] = [];

  constructor(
    public pipeName: string,
    public token: string,
  ) {
    this.child = spawn(HELPER_EXE_PATH, ["--pipe", pipeName, "--token", token, "--parent-pid", String(process.pid)], {
      windowsHide: true,
      stdio: "ignore",
    });
  }

  async connectWithRetry(deadlineMs: number): Promise<void> {
    const startedAt = Date.now();
    for (;;) {
      if (Date.now() - startedAt > deadlineMs) throw new Error("connect deadline exceeded");
      const connected = await new Promise<boolean>((resolve) => {
        const s = net.connect(this.pipeName);
        const onErr = () => {
          s.removeAllListeners();
          s.destroy();
          resolve(false);
        };
        s.once("error", onErr);
        s.once("connect", () => {
          s.removeListener("error", onErr);
          this.socket = s;
          s.on("data", (chunk) => this.onData(chunk));
          resolve(true);
        });
      });
      if (connected) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let idx: number;
    // eslint-disable-next-line no-cond-assign
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      const message = parseInboundKeyboardHelperMessage(line);
      if (message) this.received.push(message);
    }
  }

  send(message: Parameters<typeof serializeOutboundKeyboardHelperMessage>[0]): void {
    this.socket!.write(serializeOutboundKeyboardHelperMessage(message));
  }

  async waitFor(type: KeyboardHelperInboundMessage["type"], timeoutMs = 3000): Promise<KeyboardHelperInboundMessage> {
    const startedAt = Date.now();
    for (;;) {
      const found = this.received.find((m) => m.type === type);
      if (found) return found;
      if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${type}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  destroy(): void {
    this.socket?.destroy();
    if (!this.child.killed) this.child.kill();
  }
}

describe.skipIf(!canRun)("real published TetherKeyboardHelper.exe — packaged integration", () => {
  let client: RealHelperTestClient | null = null;

  afterEach(() => {
    client?.destroy();
    client = null;
  });

  it("completes HELLO -> ARM -> ARMED -> PING/PONG -> DISARM -> DISARMED -> SHUTDOWN against the real .exe over a real named pipe", async () => {
    const pipeName = `\\\\.\\pipe\\tether-lockdown-test-${randomBytes(16).toString("hex")}`;
    const token = randomBytes(24).toString("hex");
    client = new RealHelperTestClient(pipeName, token);

    await client.connectWithRetry(8_000);

    client.send({ type: "HELLO", token });
    const hello = await client.waitFor("HELLO");
    expect(hello).toEqual({ type: "HELLO", token });

    client.send({ type: "ARM" });
    const armed = await client.waitFor("ARMED");
    expect(armed).toEqual({ type: "ARMED" });

    client.send({ type: "PING" });
    await client.waitFor("PONG");

    client.send({ type: "DISARM" });
    await client.waitFor("DISARMED");

    client.send({ type: "SHUTDOWN" });
    await new Promise<void>((resolve) => {
      if (client!.child.exitCode !== null) return resolve();
      client!.child.once("exit", () => resolve());
    });
    expect(client.child.exitCode).toBe(0);
  }, 20_000);
});
