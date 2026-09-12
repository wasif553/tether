/**
 * Tether Windows Hardening v1.8.0, Phase A+B — Electron-touching adapter
 * around the native keyboard-hardening helper process. Owns: spawning
 * the helper, the named-pipe CLIENT connection to it, the ARM/DISARM/
 * heartbeat protocol, bounded degraded-recovery, and a main-owned
 * blocking overlay while recovery is in progress — mirroring
 * RemoteSessionMonitor's own shape (spawn/poll/overlay class wrapping a
 * pure decision module) so this stays architecturally consistent with
 * the rest of this package.
 *
 * All actual state-machine decisions are delegated to the pure
 * keyboardHardeningRecoveryLogic.ts module; this class only owns the
 * Electron/Node-specific mechanics (child_process, net.Socket, timers).
 *
 * --- Why the HELPER is the named-pipe SERVER, and Electron the CLIENT ---
 * .NET's `NamedPipeServerStream` accepts an explicit `PipeSecurity`
 * restricting the pipe to the current Windows user's own SID — Node's
 * plain `net.createServer().listen(path)` has no equivalent option, so
 * making Electron the server would leave the pipe's ACL at whatever
 * Windows' default is. Making the (native, ACL-capable) helper the
 * server and Electron the client gets the "accessible only to the
 * current user/session where practical" requirement for free, while
 * still leaving Electron fully in charge of the helper's lifecycle
 * (spawns it, can kill it, decides when to connect/reconnect) — nothing
 * about which side listens changes who OWNS the process.
 *
 * --- Security model ---
 * - Per-launch random pipe name (32 hex chars — effectively unguessable)
 *   AND a per-launch random HELLO token, generated fresh by THIS class
 *   for every arm attempt, passed to the helper only via its own
 *   argv (never over the pipe itself, so a connection that never
 *   completes the HELLO handshake learns nothing).
 * - The first message on a freshly-connected socket MUST be a HELLO
 *   whose token matches, within HELLO_TIMEOUT_MS — anything else
 *   (wrong token, wrong message type, malformed line, timeout) destroys
 *   the connection immediately and counts as an arm failure.
 * - Exactly the nine bounded message types in
 *   keyboardHardeningHelperProtocol.ts are ever sent or accepted — no
 *   generic command/file/JSON-RPC passthrough of any kind.
 * - The renderer never sees this manager or the pipe at all — it only
 *   ever observes the eventual success/failure of
 *   lockdown:activate-secure-exam-lockdown and (for degraded recovery)
 *   the same kind of bounded, non-secret status a blocking overlay
 *   already implies elsewhere in this package.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import {
  parseInboundKeyboardHelperMessage,
  serializeOutboundKeyboardHelperMessage,
  isExpectedHelperToken,
  type KeyboardHelperInboundMessage,
} from "./keyboardHardeningHelperProtocol";
import {
  nextKeyboardHardeningState,
  isContentBlockedByHardeningState,
  hasExhaustedRecoveryAttempts,
  isHelperLossHarmless,
  INITIAL_KEYBOARD_HARDENING_STATE,
  type KeyboardHardeningMachineState,
  type KeyboardHardeningState,
} from "./keyboardHardeningRecoveryLogic";
import { resolveKeyboardHelperArmTimeoutSeconds, resolveKeyboardHelperHeartbeatIntervalSeconds } from "./lockdownConfig";
import { diagnosticLog } from "./diagnosticLog";

const HELLO_TIMEOUT_MS = 3_000;
const DISARM_ACK_TIMEOUT_MS = 2_000;
/** Bounded misses before a lost PONG is treated as a genuinely lost heartbeat — avoids false recovery from one delayed event-loop tick. */
const MAX_CONSECUTIVE_HEARTBEAT_MISSES = 2;

const OVERLAY_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #111827; color: #f9fafb; }
  body {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    font-family: system-ui, sans-serif; text-align: center; padding: 24px; box-sizing: border-box;
  }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p { font-size: 14px; color: #d1d5db; margin: 0 0 8px; max-width: 480px; }
</style>
</head>
<body>
  <h1>Reconnecting secure exam controls</h1>
  <p>A Windows-level security control was temporarily interrupted. Please wait while it is restored. This has been recorded.</p>
</body>
</html>`;

const RECOVERY_FAILED_OVERLAY_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #111827; color: #f9fafb; }
  body {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    font-family: system-ui, sans-serif; text-align: center; padding: 24px; box-sizing: border-box;
  }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p { font-size: 14px; color: #d1d5db; margin: 0 0 8px; max-width: 480px; }
</style>
</head>
<body>
  <h1>Secure exam controls could not be restored</h1>
  <p>Your answers and exam session remain safe. Please contact your invigilator or exam support, or close and relaunch Tether to continue.</p>
</body>
</html>`;

export type KeyboardHookHelperCallbacks = {
  /** Fired the moment heartbeat is lost while ARMED — never fired for a harmless precheck-time loss (see isHelperLossHarmless). Caller should record a security/integrity signal (never "cheating"/misconduct) — never call the ordinary full lockdown restore here. */
  onHardeningDegraded?: () => void;
  /** Fired once a bounded recovery attempt succeeds and content may be uncovered again. */
  onHardeningRecovered?: () => void;
  /** Fired once every bounded recovery attempt has failed — content must stay blocked; caller must NOT silently resume the exam. */
  onHardeningRecoveryFailed?: () => void;
};

export type ArmResult = { ok: true } | { ok: false; reason: string };

/** Resolves the packaged/dev path to the native helper executable. */
function resolveHelperExecutablePath(): string {
  // Packaged build: helper ships alongside dist/ under resources/app/dist
  // (see electron-builder.yml's `files` — the helper's build output
  // directory is included the same way assets/icon.ico already is).
  // Dev/unpackaged run: __dirname is apps/lockdown/dist, the helper's
  // own build output sits at apps/lockdown/native-helper/bin/win-x64.
  return path.join(__dirname, "..", "native-helper", "bin", "win-x64", "TetherKeyboardHelper.exe");
}

export class KeyboardHookHelperManager {
  private readonly callbacks: KeyboardHookHelperCallbacks;
  private machineState: KeyboardHardeningMachineState = INITIAL_KEYBOARD_HARDENING_STATE;
  private child: ChildProcess | null = null;
  private socket: net.Socket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private consecutiveHeartbeatMisses = 0;
  private awaitingPong = false;
  private overlayWindow: BrowserWindow | null = null;
  private targetWindow: BrowserWindow | null = null;
  private inFlightArm: Promise<ArmResult> | null = null;

  constructor(callbacks: KeyboardHookHelperCallbacks = {}) {
    this.callbacks = callbacks;
  }

  attachTargetWindow(window: BrowserWindow): void {
    this.targetWindow = window;
  }

  getState(): KeyboardHardeningState {
    return this.machineState.state;
  }

  /**
   * The ONE entry point that arms the helper — called by main.ts's
   * lockdown:activate-secure-exam-lockdown handler, and ONLY after every
   * fresh precheck (process, remote-session, display) has already
   * passed. Never called from lockdown:set-secure-client-enforcement-state
   * or lockdown:set-lockdown-exam-active — those legacy/partial paths
   * must never independently arm this mechanism.
   *
   * Resolves only once the helper has genuinely confirmed the hook is
   * installed (ARMED) — a caller MUST NOT treat activation as
   * successful, or transition the native lifecycle to ACTIVE, before
   * this resolves `{ok:true}`.
   */
  async ensureArmedForActivation(): Promise<ArmResult> {
    if (this.inFlightArm) return this.inFlightArm;
    this.inFlightArm = this.armOnce();
    try {
      return await this.inFlightArm;
    } finally {
      this.inFlightArm = null;
    }
  }

  private async armOnce(): Promise<ArmResult> {
    this.machineState = nextKeyboardHardeningState(this.machineState, "ARM_REQUESTED");
    const result = await this.spawnConnectAndArm();
    if (result.ok) {
      this.machineState = nextKeyboardHardeningState(this.machineState, "ARM_SUCCEEDED");
      this.startHeartbeat();
    } else {
      this.machineState = nextKeyboardHardeningState(this.machineState, "ARM_FAILED");
      this.teardownConnectionAndProcess();
    }
    return result;
  }

  /** Spawns a fresh helper process, connects to its named pipe, completes the HELLO handshake, sends ARM, and awaits ARMED/ARM_FAILED — all bounded by resolveKeyboardHelperArmTimeoutSeconds(). */
  private async spawnConnectAndArm(): Promise<ArmResult> {
    const pipeName = `\\\\.\\pipe\\tether-lockdown-${randomBytes(16).toString("hex")}`;
    const token = randomBytes(24).toString("hex");
    const armTimeoutMs = resolveKeyboardHelperArmTimeoutSeconds() * 1_000;
    const helperPath = resolveHelperExecutablePath();

    // Physical-test diagnosis follow-up — logged BEFORE spawn so the pipe
    // name (a random, non-secret identifier — never the token) and the
    // resolved executable path are on record even if spawn itself fails.
    diagnosticLog("keyboardHookHelperManager: spawn attempt starting", { pipeName, helperPath });

    let child: ChildProcess;
    try {
      child = spawn(helperPath, ["--pipe", pipeName, "--token", token, "--parent-pid", String(process.pid)], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch (err) {
      diagnosticLog("keyboardHookHelperManager: spawn failed", { error: err instanceof Error ? err.message : String(err) });
      return { ok: false, reason: "HELPER_SPAWN_FAILED" };
    }
    this.child = child;
    // Physical-test diagnosis follow-up — "keyboard-helper spawned pid=...",
    // the first of the required evidence lines. See diagnosticLog.ts's own
    // doc comment: this is best-effort persisted to
    // userData/tether-secure-browser-native-diagnostics.log whenever
    // logging is enabled (dev, or TETHER_DIAGNOSTIC_LOGGING=true in a
    // packaged build), never on by default in a shipped install.
    diagnosticLog("keyboardHookHelperManager: helper spawned", { pid: child.pid ?? null });

    // Diagnostic-wording cleanup (post physical-test validation) — this
    // "exit" listener stays attached for the lifetime of `child`, which
    // outlives the arm race itself: it also fires for a perfectly normal
    // post-ARM exit (e.g. an ordinary disarm/teardown, long after ARMED
    // was already returned to the caller). `handshakeSucceeded` is the
    // one thing that distinguishes "died before we ever got ARMED" from
    // "this was already armed and is exiting now" so the log line never
    // claims a handshake failure that didn't happen. Never affects the
    // actual ArmResult/recovery decision — by the time a post-ARM exit
    // fires here, the race this promise belongs to has already settled.
    let handshakeSucceeded = false;
    const earlyExit = new Promise<ArmResult>((resolve) => {
      child.once("exit", (code, signal) => {
        if (handshakeSucceeded) {
          diagnosticLog("keyboardHookHelperManager: keyboard helper exited", { code: code ?? null, signal: signal ?? null });
        } else {
          diagnosticLog("keyboardHookHelperManager: helper exited before handshake completed", { code: code ?? null, signal: signal ?? null });
        }
        resolve({ ok: false, reason: `HELPER_EXITED_EARLY:${code ?? "unknown"}` });
      });
      child.once("error", (err) => {
        diagnosticLog("keyboardHookHelperManager: helper process error", { error: err.message });
        resolve({ ok: false, reason: `HELPER_SPAWN_ERROR:${err.message}` });
      });
    });

    const connectAndHandshake = this.connectWithRetry(pipeName, token, armTimeoutMs).then((result) => {
      if (result.ok) handshakeSucceeded = true;
      return result;
    });

    return Promise.race([connectAndHandshake, earlyExit]);
  }

  /** Retries net.connect at a short fixed interval until the helper's pipe server exists (bounded by deadlineMs) or the deadline passes. */
  private connectWithRetry(pipeName: string, token: string, deadlineMs: number): Promise<ArmResult> {
    const startedAtMs = Date.now();
    const RETRY_DELAY_MS = 150;
    let attemptNumber = 0;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: ArmResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const attempt = () => {
        if (settled) return;
        attemptNumber += 1;
        const elapsedMs = Date.now() - startedAtMs;
        if (elapsedMs > deadlineMs) {
          diagnosticLog("keyboardHookHelperManager: connect retry deadline exceeded", {
            attemptNumber,
            elapsedMs,
            helperAlive: this.child != null && this.child.exitCode == null && !this.child.killed,
            helperExitCode: this.child?.exitCode ?? null,
          });
          finish({ ok: false, reason: "HELPER_START_TIMEOUT" });
          return;
        }
        diagnosticLog("keyboardHookHelperManager: connect attempt", { attemptNumber, elapsedMs });
        const socket = net.connect(pipeName);
        const onConnectError = (err: Error & { code?: string }) => {
          diagnosticLog("keyboardHookHelperManager: connect attempt failed", {
            attemptNumber,
            elapsedMs: Date.now() - startedAtMs,
            errorCode: err.code ?? null,
            errorMessage: err.message,
            helperAlive: this.child != null && this.child.exitCode == null && !this.child.killed,
          });
          socket.removeAllListeners();
          socket.destroy();
          setTimeout(attempt, RETRY_DELAY_MS);
        };
        socket.once("error", onConnectError);
        socket.once("connect", () => {
          socket.removeListener("error", onConnectError);
          diagnosticLog("keyboardHookHelperManager: pipe connected", { attemptNumber, elapsedMs: Date.now() - startedAtMs });
          this.completeHandshake(socket, token, deadlineMs - (Date.now() - startedAtMs)).then(finish);
        });
      };
      attempt();
    });
  }

  /** Sends HELLO, expects a matching HELLO back, then sends ARM and awaits ARMED/ARM_FAILED — all within remainingMs. */
  private completeHandshake(socket: net.Socket, token: string, remainingMs: number): Promise<ArmResult> {
    return new Promise((resolve) => {
      let settled = false;
      let helloConfirmed = false;
      let buffer = "";

      const finish = (result: ArmResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        socket.removeListener("data", onData);
        socket.removeListener("close", onClose);
        socket.removeListener("error", onError);
        if (!result.ok) {
          socket.destroy();
        } else {
          this.socket = socket;
          socket.removeAllListeners("data");
          socket.on("data", (chunk) => this.onSocketData(chunk));
          socket.on("close", () => this.onSocketClosedUnexpectedly());
          socket.on("error", () => {
            /* handled via close */
          });
        }
        resolve(result);
      };

      const onError = () => finish({ ok: false, reason: "HELPER_CONNECTION_ERROR" });
      const onClose = () => finish({ ok: false, reason: "HELPER_CONNECTION_CLOSED" });
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let newlineIndex: number;
        // eslint-disable-next-line no-cond-assign
        while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          const message = parseInboundKeyboardHelperMessage(line);
          if (!message) continue; // malformed/unexpected line — ignored, never rejected as a fatal error mid-handshake

          if (!helloConfirmed) {
            if (message.type === "HELLO" && isExpectedHelperToken(message.token, token)) {
              helloConfirmed = true;
              diagnosticLog("keyboardHookHelperManager: HELLO accepted", {});
              socket.write(serializeOutboundKeyboardHelperMessage({ type: "ARM" }));
              diagnosticLog("keyboardHookHelperManager: ARM sent", {});
            } else {
              finish({ ok: false, reason: "HELPER_HANDSHAKE_INVALID" });
            }
            continue;
          }
          if (message.type === "ARMED") {
            diagnosticLog("keyboardHookHelperManager: ARMED received", {});
            finish({ ok: true });
          } else if (message.type === "ARM_FAILED") {
            diagnosticLog("keyboardHookHelperManager: ARM_FAILED received", { reason: message.reason });
            finish({ ok: false, reason: `HELPER_ARM_FAILED:${message.reason}` });
          }
          // Any other message type here is stale/unexpected for this phase and is silently ignored.
        }
      };

      const timeoutHandle = setTimeout(() => finish({ ok: false, reason: "HELPER_HANDSHAKE_TIMEOUT" }), Math.max(1, remainingMs));
      socket.on("data", onData);
      socket.once("close", onClose);
      socket.once("error", onError);
      socket.write(serializeOutboundKeyboardHelperMessage({ type: "HELLO", token }));
    });
  }

  /** Post-handshake data handler — only PONG/DISARMED are meaningful once ARMED; anything else (including a stray HELLO/ARMED replay) is ignored, never re-processed as a new handshake. */
  private dataBuffer = "";
  private onSocketData(chunk: Buffer): void {
    this.dataBuffer += chunk.toString("utf8");
    let newlineIndex: number;
    // eslint-disable-next-line no-cond-assign
    while ((newlineIndex = this.dataBuffer.indexOf("\n")) >= 0) {
      const line = this.dataBuffer.slice(0, newlineIndex);
      this.dataBuffer = this.dataBuffer.slice(newlineIndex + 1);
      const message = parseInboundKeyboardHelperMessage(line);
      if (!message) continue;
      this.handlePostArmMessage(message);
    }
  }

  private handlePostArmMessage(message: KeyboardHelperInboundMessage): void {
    if (message.type === "PONG") {
      this.awaitingPong = false;
      this.consecutiveHeartbeatMisses = 0;
      return;
    }
    // DISARMED/ARMED/ARM_FAILED/HELLO arriving here are stale relative to
    // the current phase (e.g. a delayed message from a superseded
    // connection) — recognized-but-irrelevant, never acted on twice.
  }

  private onSocketClosedUnexpectedly(): void {
    if (this.socket) this.socket = null;
    if (this.machineState.state === "ARMED") {
      this.declareHeartbeatLost();
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeatTimer();
    this.consecutiveHeartbeatMisses = 0;
    this.awaitingPong = false;
    const intervalMs = resolveKeyboardHelperHeartbeatIntervalSeconds() * 1_000;
    this.heartbeatTimer = setInterval(() => this.heartbeatTick(), intervalMs);
  }

  private stopHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private heartbeatTick(): void {
    if (!this.socket || this.machineState.state !== "ARMED") return;
    if (this.awaitingPong) {
      this.consecutiveHeartbeatMisses += 1;
      if (this.consecutiveHeartbeatMisses > MAX_CONSECUTIVE_HEARTBEAT_MISSES) {
        this.declareHeartbeatLost();
        return;
      }
    }
    this.awaitingPong = true;
    try {
      this.socket.write(serializeOutboundKeyboardHelperMessage({ type: "PING" }));
    } catch {
      this.declareHeartbeatLost();
    }
  }

  /**
   * Entered from ARMED only. This is the CRITICAL CORRECTION path — it
   * must NEVER call anything resembling the ordinary full lockdown
   * restore. Display enforcement, remote-session monitoring, and
   * process detection are untouched here; only THIS mechanism's own
   * state moves to RECOVERING, exam content is covered by this class's
   * own overlay, and a bounded restart-and-rearm sequence begins.
   */
  private declareHeartbeatLost(): void {
    if (this.machineState.state !== "ARMED") return;
    this.stopHeartbeatTimer();
    this.teardownConnectionAndProcess();
    this.machineState = nextKeyboardHardeningState(this.machineState, "HEARTBEAT_LOST");
    this.showOverlay(OVERLAY_HTML);
    try {
      this.callbacks.onHardeningDegraded?.();
    } catch {
      // A reporting callback failure must never abort recovery — mirrors
      // every other best-effort callback invocation in this package.
    }
    void this.attemptBoundedRecovery();
  }

  private async attemptBoundedRecovery(): Promise<void> {
    while (this.machineState.state === "RECOVERING" && !hasExhaustedRecoveryAttempts(this.machineState)) {
      const result = await this.spawnConnectAndArm();
      if (result.ok) {
        this.machineState = nextKeyboardHardeningState(this.machineState, "RECOVERY_ATTEMPT_SUCCEEDED");
        this.startHeartbeat();
        this.hideOverlay();
        try {
          this.callbacks.onHardeningRecovered?.();
        } catch {
          // best-effort
        }
        return;
      }
      this.teardownConnectionAndProcess();
      this.machineState = nextKeyboardHardeningState(this.machineState, "RECOVERY_ATTEMPT_FAILED");
      diagnosticLog("keyboardHookHelperManager: recovery attempt failed", { reason: result.reason, attemptsUsed: this.machineState.recoveryAttemptsUsed });
    }
    if (this.machineState.state === "RECOVERING") {
      this.machineState = nextKeyboardHardeningState(this.machineState, "RECOVERY_ATTEMPTS_EXHAUSTED");
      this.showOverlay(RECOVERY_FAILED_OVERLAY_HTML);
      try {
        this.callbacks.onHardeningRecoveryFailed?.();
      } catch {
        // best-effort
      }
    }
  }

  /** True while exam content must stay covered/blocked — main.ts consults this to decide whether the exam window itself should also refuse further interaction. */
  isContentBlocked(): boolean {
    return isContentBlockedByHardeningState(this.machineState.state);
  }

  /** True when losing the helper right now would be harmless (precheck/not-yet-armed/already-disarmed) — used so a stray socket-close before activation never records a spurious signal. */
  isCurrentLossHarmless(): boolean {
    return isHelperLossHarmless(this.machineState.state);
  }

  /**
   * The ONLY path that ever cleanly disarms — registered as a
   * lockdownLifecycle restore action (main.ts), so it only ever runs as
   * part of the authoritative restoration/finalization flow, exactly
   * like displayEnforcement/processDetection/remoteSessionMonitor's own
   * teardown. Idempotent and safe to call from IDLE/DISARMED (a no-op).
   */
  disarm(): void {
    this.stopHeartbeatTimer();
    this.hideOverlay();
    const socket = this.socket;
    if (socket && !socket.destroyed) {
      try {
        socket.write(serializeOutboundKeyboardHelperMessage({ type: "DISARM" }));
      } catch {
        // best-effort — the process kill below guarantees teardown regardless.
      }
      const disarmDeadline = setTimeout(() => this.teardownConnectionAndProcess(), DISARM_ACK_TIMEOUT_MS);
      socket.once("data", (chunk: Buffer) => {
        const line = chunk.toString("utf8").split("\n")[0] ?? "";
        const message = parseInboundKeyboardHelperMessage(line);
        if (message?.type === "DISARMED") {
          clearTimeout(disarmDeadline);
          this.teardownConnectionAndProcess();
        }
      });
    } else {
      this.teardownConnectionAndProcess();
    }
    this.machineState = nextKeyboardHardeningState(this.machineState, "DISARM_REQUESTED");
  }

  private teardownConnectionAndProcess(): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    if (this.child && !this.child.killed) {
      try {
        this.child.kill();
      } catch {
        // best-effort — the helper's own parent-liveness watch (see the
        // native helper source) is the guaranteed fail-safe backstop if
        // this kill somehow does not take effect.
      }
    }
    this.child = null;
    this.dataBuffer = "";
  }

  private showOverlay(html: string): void {
    if (!this.targetWindow || this.targetWindow.isDestroyed()) return;
    this.hideOverlay();
    const bounds = this.targetWindow.getBounds();
    const overlay = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      frame: false,
      alwaysOnTop: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      skipTaskbar: true,
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    overlay.setAlwaysOnTop(true, "screen-saver");
    overlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    overlay.on("closed", () => {
      if (this.overlayWindow === overlay) this.overlayWindow = null;
    });
    this.overlayWindow = overlay;
  }

  private hideOverlay(): void {
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      this.overlayWindow.close();
    }
    this.overlayWindow = null;
  }

  getStatusSnapshot(): { state: KeyboardHardeningState; recoveryAttemptsUsed: number; overlayVisible: boolean; helperExecutablePath: string; appPackaged: boolean } {
    return {
      state: this.machineState.state,
      recoveryAttemptsUsed: this.machineState.recoveryAttemptsUsed,
      overlayVisible: Boolean(this.overlayWindow && !this.overlayWindow.isDestroyed()),
      helperExecutablePath: resolveHelperExecutablePath(),
      appPackaged: app.isPackaged,
    };
  }
}
