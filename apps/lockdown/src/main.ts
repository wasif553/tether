/**
 * Tether Secure Browser v1 — main process.
 *
 * This is a detection-and-logging client, not a hard-enforcement kiosk.
 * It does not kill processes, block Alt+Tab at the OS level, or trap the
 * student in the window — see apps/lockdown/README.md and
 * docs/lockdown-browser-known-limitations.md in the main repo for the
 * full list of what this does and does not do.
 */
import {
  app,
  BrowserWindow,
  ipcMain,
  session as electronSession,
  safeStorage,
  powerMonitor,
  desktopCapturer,
  screen,
} from "electron";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import Store from "electron-store";
import {
  DEFAULT_SES_BASE_URL,
  DEEP_LINK_PROTOCOLS,
  LOCKDOWN_VERSION,
  USER_AGENT_SUFFIX,
  TETHER_APP_USER_MODEL_ID,
  type ExamContext,
  type QueuedLockdownEvent,
} from "./shared";
import { DisplayEnforcement } from "./displayEnforcement";
import { resolveStartupLoadUrl, parseExamIdFromDeepLinkUrl, findDeepLinkArg, resolveInitialExamIdFromArgv } from "./lockdownStartupRouting";
import { handleDisplayMediaRequest, type ScreenShareSource } from "./screenShareRequestHandler";
import { ensureInstallationKey, getInstallationInfo, signWithInstallationKey, type InstallationKeyStoreSchema } from "./installationKey";
import {
  resolveCombinedDisplayDecision,
  type DisplayDecisionEventType,
  type DisplayBlockingReason,
  type DisplayEnforcementStatus,
  type SecureClientEnforcementState,
} from "./displayEnforcementLogic";
import {
  isDiagnosticsPanelEnabled,
  snapshotsEqualIgnoringTimestamp,
  formatDiagnosticLogLine,
  type TetherDiagnosticsSnapshot,
} from "./tetherDiagnosticsSnapshot";
import { findUnsafeCommandLineSwitch } from "./commandLineSafety";
import { classifyKeyboardShortcut } from "./keyboardHardeningLogic";
import { ProcessDetection } from "./processDetection";
import { RemoteSessionMonitor } from "./remoteSessionMonitor";
import { getWindowsSessionClassification } from "./windowsSessionDetection";
import { LockdownLifecycleManager } from "./lockdownLifecycle";
import { LOCKDOWN_CAPABILITY_REGISTRY, type LockdownPolicyToggles } from "./lockdownCapabilityRegistry";
import { consumeLockdownFault } from "./lockdownFaultInjection";
import { diagnosticLog } from "./diagnosticLog";
import { isWindowUsable, runOnWindowBestEffort } from "./windowLifecycleGuard";
import { performLockdownRestoration, type RestorationController, type RestorationOutcome } from "./lockdownRestorationController";

export const DIAGNOSTIC_LOG_FILE_NAME = "tether-secure-browser-diagnostics.log";

const SES_BASE_URL = process.env.SES_BASE_URL ?? DEFAULT_SES_BASE_URL;

// Tether Windows Lockdown Hardening v1, Part 7 — "disable insecure debug
// ports" / "reject unsafe command-line switches". Checked before
// anything else in this process (including the single-instance lock) —
// refuses to continue at all rather than silently stripping the switch,
// since Chromium may have already begun acting on some of these before
// any of this process's own code runs.
const unsafeSwitch = findUnsafeCommandLineSwitch(process.argv);
if (unsafeSwitch) {
  // eslint-disable-next-line no-console
  console.error(`Tether Secure Browser refused to start: unsafe command-line switch "${unsafeSwitch}" was present.`);
  app.exit(1);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// Windows taskbar icon fix v1.7.1 — must be set before the first
// BrowserWindow is created for Windows to group/pin this app under its
// own stable identity rather than falling back to a generic one derived
// from the .exe path. Reuses electron-builder.yml's existing `appId`
// (see TETHER_APP_USER_MODEL_ID's own doc comment in shared.ts) rather
// than inventing a second identifier. No-op on non-Windows platforms.
app.setAppUserModelId(TETHER_APP_USER_MODEL_ID);

// Windows taskbar icon fix v1.7.1 — a single relative-to-__dirname path
// that resolves correctly in both dev (`npm start`, __dirname is
// apps/lockdown/dist) and packaged (__dirname is resources/app/dist)
// builds, since electron-builder.yml's `files` now bundles
// assets/icon.ico at the same relative location it already has at dev
// time. Never an absolute local-machine path. Used as the BrowserWindow
// icon below — on Windows this is what the taskbar/Alt-Tab UI shows
// while running unpackaged (a packaged build gets its icon from the .exe
// resource itself, embedded by electron-builder via `win.icon`).
const LOCKDOWN_ICON_PATH = path.join(__dirname, "..", "assets", "icon.ico");

type StoreSchema = InstallationKeyStoreSchema & {
  queuedEvents: QueuedLockdownEvent[];
};

const store = new Store<StoreSchema>({
  defaults: { queuedEvents: [], installationKey: null },
});

const displayEnforcement = new DisplayEnforcement({
  onEventType: (eventType: NonNullable<DisplayDecisionEventType>, displayCount: number) => {
    runOnWindowBestEffort(mainWindow, (window) => window.webContents.send("lockdown:display-enforcement-event", { eventType, displayCount }));
  },
  // v1.7.6 — Native Display State Bridge. Separate from onEventType above
  // (which only ever fires for integrity-event reporting); this pushes
  // the bounded {state, reason, displayCount} the exam page's own
  // display-violation modal renders from, replacing the old trapping
  // BrowserWindow overlay.
  onDisplayStateChanged: (status: DisplayEnforcementStatus) => {
    runOnWindowBestEffort(mainWindow, (window) => window.webContents.send("lockdown:display-enforcement-state-changed", status));
  },
  onDiagnosticsChanged: () => maybeEmitDiagnostics(),
});

// Tether Windows Lockdown Hardening v1, Part 2/4 — capability transitions
// are relayed to the hosted page (never uploaded directly by main — main
// has no DB access and no authenticated session of its own), exactly
// like display-enforcement events. The page looks up the transitioning
// capability's category/display name from ITS OWN copy of the bounded,
// public capability metadata it already received via
// lockdown:get-lockdown-capability-info, and reports the outcome through
// the existing integrity-events / new lockdown audit-event routes with
// its own authenticated fetch.
const processDetection = new ProcessDetection({
  onCapabilityTransition: (capabilityId, effectiveAction, phase, detectedAtMsForClear) => {
    runOnWindowBestEffort(mainWindow, (window) =>
      window.webContents.send("lockdown:capability-transition", { capabilityId, effectiveAction, phase, detectedAtMsForClear: detectedAtMsForClear ?? null }),
    );
  },
  onScanUnavailable: (reason) => {
    runOnWindowBestEffort(mainWindow, (window) => window.webContents.send("lockdown:scan-unavailable", { reason }));
    reportAuditFactBestEffort("TETHER_LOCKDOWN_DETECTION_SERVICE_FAILURE", { reason });
  },
});

// Tether mid-exam remote-session monitoring v1 — extends the
// REMOTE_DESKTOP_SESSION capability from a preflight-only, one-shot check
// (lockdown:get-remote-session-status below) to continuous polling while
// an exam is ACTIVE. Relayed to the page over its own dedicated channel
// (not the generic capability-transition one above) so the richer,
// remote-session-specific metadata the page needs to record (session
// classification, previous/current state, check confidence) doesn't have
// to be squeezed into the generic payload shape. See
// remoteSessionMonitor.ts / remoteSessionMonitorLogic.ts.
const remoteSessionMonitor = new RemoteSessionMonitor({
  onTransition: (transition, effectiveAction, detectedAtMsForClear) => {
    runOnWindowBestEffort(mainWindow, (window) =>
      window.webContents.send("lockdown:remote-session-monitor-event", {
        kind: transition.kind,
        effectiveAction,
        previousState: "previousState" in transition ? transition.previousState : null,
        currentState: "currentState" in transition ? transition.currentState : null,
        detectedAtMsForClear: detectedAtMsForClear ?? null,
        classification: {
          isRemoteSession: transition.classification.isRemoteSession,
          remoteSessionSignalSource: transition.classification.remoteSessionSignalSource,
          isLikelyVirtualMachine: transition.classification.isLikelyVirtualMachine,
          vmSignatureMatched: transition.classification.vmSignatureMatched,
        },
      }),
    );
  },
});

// Tether Windows Lockdown Hardening v1, Part 10 — the idempotent
// restoration lifecycle. Tether never modifies any permanent OS-level
// setting, so every registered action here is pure in-process teardown
// (hide overlays, stop polling, clear enforcement flags) — see
// lockdownLifecycle.ts's own doc comment for why that makes restore()
// inherently safe to call any number of times, from any trigger.
const lockdownLifecycle = new LockdownLifecycleManager(() => consumeLockdownFault("RESTORATION_FAILURE"));
lockdownLifecycle.registerRestoreAction("processDetection.setExamActive(false)", () => processDetection.setExamActive(false));
lockdownLifecycle.registerRestoreAction("remoteSessionMonitor.setExamActive(false)", () => remoteSessionMonitor.setExamActive(false));
lockdownLifecycle.registerRestoreAction("displayEnforcement.setEnforcementState(inactive)", () =>
  displayEnforcement.setEnforcementState({ active: false, ready: false, requireSingleDisplay: false }),
);

// Destroyed-window crash fix v1.7.1 — restoreLockdownControls delegates
// the actual orchestration to performLockdownRestoration
// (lockdownRestorationController.ts), which is Electron-decoupled and
// directly unit tested. getWindow always re-reads the current mainWindow
// reference (never a stale closure captured at registration time), so
// this stays correct across the window being replaced/nulled between
// calls.
const restorationController: RestorationController<BrowserWindow> = {
  getWindow: () => mainWindow,
  reportAuditFact: (window, action, metadata) => reportAuditFactToWindow(window, action, metadata),
  sendResult: (window, outcome: RestorationOutcome) => window.webContents.send("lockdown:restoration-result", outcome),
  diagnosticLog: (message, data) => diagnosticLog(message, data),
};

function restoreLockdownControls(trigger: string): void {
  performLockdownRestoration(lockdownLifecycle, restorationController, trigger);
}

let mainWindow: BrowserWindow | null = null;
let examContext: ExamContext = { examId: null, submissionId: null };
let isOnline = true;

// Corrective pass v1.2.1, Tasks A/B — a temporary, explicit, local-only
// diagnostic surface. Never activates from anything Vercel controls: this
// flag lives entirely in the LOCAL Electron process's own environment,
// checked once at startup, never fetched from or influenced by the
// hosted web app in any way.
const diagnosticsPanelEnabled = isDiagnosticsPanelEnabled(process.env.TETHER_SECURE_CLIENT_DIAGNOSTICS_ENABLED);

type PageReportedDiagnosticContext = {
  submissionIdPresent: boolean;
  verifiedSecureClientSession: boolean;
  deliveryMode: string | null;
  displayPolicy: string | null;
  requireDisplayCheck: boolean | null;
  maximumDisplays: number | null;
};

let pageReportedContext: PageReportedDiagnosticContext = {
  submissionIdPresent: false,
  verifiedSecureClientSession: false,
  deliveryMode: null,
  displayPolicy: null,
  requireDisplayCheck: null,
  maximumDisplays: null,
};

let lastEmittedDiagnosticsSnapshot: TetherDiagnosticsSnapshot | null = null;

function diagnosticLogFilePath(): string {
  return path.join(app.getPath("userData"), DIAGNOSTIC_LOG_FILE_NAME);
}

function buildCurrentDiagnosticsSnapshot(): TetherDiagnosticsSnapshot {
  const de = displayEnforcement.getDiagnosticsSnapshot();
  return {
    browserVersion: LOCKDOWN_VERSION,
    submissionIdPresent: pageReportedContext.submissionIdPresent,
    tetherBrowserDetected: true,
    verifiedSecureClientSession: pageReportedContext.verifiedSecureClientSession,
    deliveryMode: pageReportedContext.deliveryMode,
    displayPolicy: pageReportedContext.displayPolicy,
    requireDisplayCheck: pageReportedContext.requireDisplayCheck,
    maximumDisplays: pageReportedContext.maximumDisplays,
    electronDisplayCount: de.electronDisplayCount,
    windowsTopologyClassification: de.windowsTopologyClassification,
    activeWindowsTargetCount: de.activeWindowsTargetCount,
    enforcementEnabled: de.enforcementState.active,
    enforcementReady: de.enforcementState.ready,
    requireSingleDisplay: de.enforcementState.requireSingleDisplay,
    currentDecision: de.currentDecision === "BLOCKED" ? "BLOCK" : "ALLOW",
    blockingReason: de.blockingReason,
    overlayVisible: de.overlayVisible,
    lastDisplayCheckAt: de.lastDisplayCheckAt,
    lastErrorCode: de.lastErrorCode,
  };
}

/**
 * Task A/B shared emit path — pushes the current snapshot to the
 * diagnostic panel (if one is listening) and appends one line to the
 * on-disk log, but ONLY when something other than the timestamp actually
 * changed (Task B: "one line only when state changes, not every polling
 * cycle" — the periodic 2s recheck in displayEnforcement.ts would
 * otherwise call this every tick). No-ops entirely when diagnostics are
 * not enabled — this must add zero overhead and zero disk writes for a
 * real exam attempt.
 */
function maybeEmitDiagnostics(): void {
  if (!diagnosticsPanelEnabled) return;
  const snapshot = buildCurrentDiagnosticsSnapshot();
  if (lastEmittedDiagnosticsSnapshot && snapshotsEqualIgnoringTimestamp(lastEmittedDiagnosticsSnapshot, snapshot)) return;
  lastEmittedDiagnosticsSnapshot = snapshot;
  runOnWindowBestEffort(mainWindow, (window) => window.webContents.send("lockdown:diagnostics-snapshot", snapshot));
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.appendFileSync(diagnosticLogFilePath(), `${formatDiagnosticLogLine(snapshot)}\n`, "utf8");
  } catch {
    // Best-effort only — a disk/log failure must never block or crash the exam window.
  }
}

function isValidEnforcementState(value: unknown): value is SecureClientEnforcementState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.active === "boolean" && typeof v.ready === "boolean" && typeof v.requireSingleDisplay === "boolean";
}

function isValidDiagnosticContext(value: unknown): value is PageReportedDiagnosticContext {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.submissionIdPresent === "boolean" &&
    typeof v.verifiedSecureClientSession === "boolean" &&
    (v.deliveryMode === null || typeof v.deliveryMode === "string") &&
    (v.displayPolicy === null || typeof v.displayPolicy === "string") &&
    (v.requireDisplayCheck === null || typeof v.requireDisplayCheck === "boolean") &&
    (v.maximumDisplays === null || typeof v.maximumDisplays === "number")
  );
}

function isValidPolicyToggles(value: unknown): value is LockdownPolicyToggles {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.blockRemoteControl === "boolean" &&
    typeof v.blockScreenCaptureTools === "boolean" &&
    typeof v.blockDebugTools === "boolean" &&
    typeof v.blockVirtualMachines === "boolean"
  );
}

function getQueue(): QueuedLockdownEvent[] {
  return store.get("queuedEvents", []);
}

function setQueue(events: QueuedLockdownEvent[]) {
  store.set("queuedEvents", events);
}

function enqueueEvent(event: QueuedLockdownEvent) {
  const queue = getQueue();
  queue.push(event);
  setQueue(queue);
  void flushQueue();
}

/**
 * Uploads queued events to /api/submissions/[submissionId]/integrity-events
 * using the BrowserWindow's own session (and thus its cookies) — this
 * relies entirely on the student's existing SES login in this window; v1
 * does not invent a separate token flow. Events stay queued until a
 * submissionId is known, the app is online, and the upload succeeds.
 */
async function flushQueue() {
  if (!examContext.submissionId || !isOnline || !mainWindow) return;

  const queue = getQueue();
  if (queue.length === 0) return;

  const remaining: QueuedLockdownEvent[] = [];
  for (const event of queue) {
    const ok = await uploadEvent(examContext.submissionId, event);
    if (!ok) remaining.push(event);
  }
  setQueue(remaining);
}

async function uploadEvent(submissionId: string, event: QueuedLockdownEvent): Promise<boolean> {
  if (!isWindowUsable(mainWindow)) return false;
  try {
    const severity = event.eventType === "FULLSCREEN_EXIT" ? "MEDIUM" : "INFO";
    const result = await mainWindow.webContents.executeJavaScript(
      `fetch(${JSON.stringify(`${SES_BASE_URL}/api/submissions/${submissionId}/integrity-events`)}, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(${JSON.stringify({
          eventType: event.eventType,
          severity,
          message: event.message,
          metadata: event.metadata,
          occurredAt: event.occurredAt,
        })}),
      }).then((r) => r.ok).catch(() => false)`,
    );
    return Boolean(result);
  } catch {
    return false;
  }
}

/**
 * Tether Windows Lockdown Hardening v1, Part 11 — PlatformAuditLog-only
 * facts (never IntegrityEvent). Reuses the exact same "run a fetch
 * inside the page's own authenticated context" trick as uploadEvent
 * above, POSTing straight to the new /api/tether/lockdown/audit-event
 * route — never queued/retried (Part 11's facts are individually
 * low-stakes technical/operational records; a lost one under a genuine
 * network outage is acceptable and never blocks or delays anything the
 * student is doing, unlike the queued IntegrityEvent path which exists
 * specifically to survive an offline gap).
 */
/**
 * Destroyed-window crash fix v1.7.1 — the actual send, extracted so both
 * reportAuditFactBestEffort (below) and restorationController (used by
 * performLockdownRestoration) can share it. Callers are responsible for
 * only invoking this with a window that isWindowUsable() has just
 * confirmed; runOnWindowBestEffort provides that guarantee plus a
 * try/catch around the call itself for the narrow check-then-call race.
 */
function reportAuditFactToWindow(window: BrowserWindow, action: string, metadata: Record<string, unknown>): void {
  const body: Record<string, unknown> = { action, metadata };
  if (examContext.submissionId) body.submissionId = examContext.submissionId;
  else if (examContext.examId) body.examId = examContext.examId;
  window.webContents
    .executeJavaScript(
      `fetch(${JSON.stringify(`${SES_BASE_URL}/api/tether/lockdown/audit-event`)}, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(${JSON.stringify(body)}),
      }).catch(() => {})`,
    )
    .catch(() => {});
}

function reportAuditFactBestEffort(action: string, metadata: Record<string, unknown>): void {
  runOnWindowBestEffort(mainWindow, (window) => reportAuditFactToWindow(window, action, metadata));
}

function emitWarning(text: string) {
  runOnWindowBestEffort(mainWindow, (window) => window.webContents.send("lockdown:warning", text));
}

function recordEvent(
  eventType: QueuedLockdownEvent["eventType"],
  message: string,
  electronEventType: string,
  extraMetadata: Record<string, unknown> = {},
) {
  const event: QueuedLockdownEvent = {
    eventType,
    message,
    occurredAt: new Date().toISOString(),
    metadata: {
      source: "electron-lockdown",
      lockdownVersion: LOCKDOWN_VERSION,
      electronEventType,
      platform: process.platform,
      timestamp: new Date().toISOString(),
      ...extraMetadata,
    },
  };
  enqueueEvent(event);
  runOnWindowBestEffort(mainWindow, (window) => window.webContents.send("lockdown:event-recorded", getQueue().length));
}

/**
 * Startup/deep-link routing fix — see lockdownStartupRouting.ts's own doc
 * comment for the confirmed bug this replaces (a normal launch used to
 * silently reopen whatever exam a previous deep link had visited, via a
 * persisted `lastExamId` store fallback that is now removed entirely).
 * The web app still keys the exam-taking page by submissionId, not
 * examId (there is no /student/exams/[examId] route) — but the Tether
 * launch page (buildTetherLaunchPath) resolves examId -> the correct
 * submission and exam content automatically, once inside Tether and
 * authenticated (see src/app/student/exams/[id]/tether-launch/page.tsx in
 * the main repo), so the student never has to find it themselves.
 */
function buildLoadUrl(examId: string | null): string {
  return resolveStartupLoadUrl(examId, SES_BASE_URL);
}

function createWindow(examId: string | null) {
  const preloadPath = path.join(__dirname, "preload.js");

  mainWindow = new BrowserWindow({
    fullscreen: true,
    kiosk: false,
    autoHideMenuBar: true,
    resizable: false,
    alwaysOnTop: false,
    icon: LOCKDOWN_ICON_PATH,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // Pre-merge audit finding (C.6) — the previous mechanism only
      // reactively closed the DevTools window AFTER it had already
      // opened (see the packaged-only listener further below), which is
      // weaker than actually preventing it: Electron's own
      // webPreferences.devTools:false guarantee makes
      // webContents.openDevTools() (menu, shortcut, IPC, or a direct
      // webContents-API call) a genuine no-op — that window is never
      // created at all in a packaged build. The reactive listener below
      // is kept as a defensive backstop regardless. Dev builds
      // (`npm start`) keep devTools:true so the team can still debug
      // Tether itself (C.7).
      devTools: !app.isPackaged,
      preload: preloadPath,
    },
  });
  mainWindow.setMenuBarVisibility(false);

  // Tether Windows Lockdown Hardening v1, Part 7 — permission ALLOWLIST
  // (never a blanket deny): camera is required by Camera Monitoring v1
  // for camera-required exams, fullscreen is required by the exam's own
  // fullscreen policy. Every other permission (geolocation, notifications,
  // MIDI, HID, serial, USB, clipboard-read, display-capture outside the
  // approved flow, ...) is denied.
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media" || permission === "fullscreen");
  });

  // URGENT screen-sharing fix — Chromium requires this handler to be
  // registered before navigator.mediaDevices.getDisplayMedia() can ever
  // succeed in this (or any) BrowserWindow's session; setPermissionRequestHandler
  // above governs getUserMedia() (camera/mic) only, a separate contract.
  // Registered on THIS window's own session (this app never uses a custom
  // partition, so this is always the default session) every time
  // createWindow() runs, so it is present for every window this app ever
  // creates and survives in-window navigation (Home -> tether-launch ->
  // secure exam all share the same webContents/session — Electron's
  // display-media handler is a session-level registration, not tied to
  // any one loaded page). See screenShareRequestHandler.ts for the actual
  // (independently unit-tested) source-selection logic and A1's
  // investigation notes for why this was missing in every prior version,
  // not only this branch.
  mainWindow.webContents.session.setDisplayMediaRequestHandler((_request, callback) => {
    void handleDisplayMediaRequest(
      () => desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } }),
      () => String(screen.getPrimaryDisplay().id),
      (streams) => callback(streams.video ? { video: streams.video } : {}),
      diagnosticLog,
    );
  });

  // Part 7 — deny window.open() / target=_blank for every flow; this app
  // has no legitimate use for a second window.
  mainWindow.webContents.setWindowOpenHandler(() => {
    reportAuditFactBestEffort("TETHER_LOCKDOWN_WINDOW_OPEN_DENIED", {});
    return { action: "deny" };
  });

  // Part 7/8 — deny navigation to anything outside the configured SES
  // origin (also the structural fix for drag/drop of external files/URLs
  // and file:// escapes, both of which surface as a will-navigate
  // attempt to a non-SES origin).
  mainWindow.webContents.on("will-navigate", (event, url) => {
    let denied = false;
    try {
      if (new URL(url).origin !== new URL(SES_BASE_URL).origin) denied = true;
    } catch {
      denied = true;
    }
    if (denied) {
      event.preventDefault();
      reportAuditFactBestEffort("TETHER_LOCKDOWN_NAVIGATION_DENIED", {});
    }
  });

  // Part 7 — prevent DevTools in packaged production builds only (a
  // development build run via `npm start` still needs it for the
  // team's own debugging). Keyboard-shortcut blocking below is
  // unconditional in both cases.
  if (app.isPackaged) {
    // Destroyed-window crash fix v1.7.1 audit — no isWindowUsable guard
    // needed here: this listener runs synchronously in response to
    // devtools-opened on this exact webContents, so it cannot have been
    // destroyed by the time this callback executes.
    mainWindow.webContents.on("devtools-opened", () => {
      mainWindow?.webContents.closeDevTools();
      recordEvent("DEBUGGING_TOOL_DETECTED", "Developer tools were opened.", "devtools-opened");
    });
  }

  // Part 8 — browser-chrome keyboard shortcuts. Ctrl+Alt+Delete is
  // deliberately absent — see keyboardHardeningLogic.ts's own doc
  // comment for why no application can intercept it at all.
  //
  // Pre-merge audit finding (D.1) — this previously blocked
  // unconditionally for the whole lifetime of the Tether window
  // (dashboard, login, tether-launch, and even after an exam had
  // already been submitted and restored), not only while an exam's
  // lockdown restrictions are actually ACTIVE. That over-broad scope
  // violated the "detection plus controlled remediation over aggressive
  // system modification" principle — e.g. Alt+F4 was unusable even
  // outside any exam — and DID NOT self-correct after restoration.
  // Gating on lockdownLifecycle's own ACTIVE state (set by
  // lockdown:set-secure-client-enforcement-state when the page reports
  // active:true, cleared the moment restoreLockdownControls runs) makes
  // this exactly track the same window Part 4/10 already use for
  // process-detection polling and the restoration lifecycle — D.2
  // ("normal computer behaviour returns after restoration") now holds
  // for keyboard shortcuts too, and D.4 (Ctrl+R/F5 cannot destroy
  // unsaved drafts) is unaffected since ACTIVE is exactly the window
  // during which unsaved drafts can exist.
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (lockdownLifecycle.getState() !== "ACTIVE") return;
    const decision = classifyKeyboardShortcut({ key: input.key, control: input.control, alt: input.alt, shift: input.shift, meta: input.meta });
    if (decision.blocked) {
      event.preventDefault();
      recordEvent("KEYBOARD_SHORTCUT_BLOCKED", "A blocked keyboard shortcut was pressed.", "keyboard-shortcut-blocked", { shortcutReason: decision.reason });
    }
  });

  processDetection.attachTargetWindow(mainWindow);
  remoteSessionMonitor.attachTargetWindow(mainWindow);
  lockdownLifecycle.prepare();

  // Best-effort only — does not guarantee screenshots/recordings are
  // blocked on every platform. Never claim otherwise in product copy.
  let contentProtectionEnabled = false;
  try {
    mainWindow.setContentProtection(true);
    contentProtectionEnabled = true;
  } catch {
    contentProtectionEnabled = false;
  }

  mainWindow.webContents.setUserAgent(`${mainWindow.webContents.getUserAgent()} ${USER_AGENT_SUFFIX}`);

  mainWindow.webContents.once("did-finish-load", () => {
    runOnWindowBestEffort(mainWindow, (window) => window.webContents.send("lockdown:content-protection-status", contentProtectionEnabled));
  });

  // Tether launch/install flow v1 — live for the whole session (not
  // gated on did-finish-load), replacing the old one-shot
  // checkDisplays()/MANUAL_WARNING check. Starts inactive
  // ({active:false} — harmless on the dashboard/login/tether-launch
  // pages, which never call setSecureClientEnforcementState) until the
  // exam page itself opts in on mount via
  // window.sesLockdown.setSecureClientEnforcementState({active:true,...})
  // — see displayEnforcementLogic.ts's SecureClientEnforcementState doc
  // comment (corrective pass v1.2.1, Task C).
  displayEnforcement.start(mainWindow);

  mainWindow.on("blur", () => {
    recordEvent("WINDOW_BLUR", "The lockdown browser window lost focus.", "window-blur");
    emitWarning("Secure exam mode: window focus changed. This has been recorded.");
  });
  mainWindow.on("focus", () => {
    recordEvent("WINDOW_FOCUS_RETURN", "The lockdown browser window regained focus.", "window-focus");
  });

  mainWindow.on("enter-full-screen", () => {
    // No warning needed — this is the expected state.
  });
  mainWindow.on("leave-full-screen", () => {
    recordEvent("FULLSCREEN_EXIT", "Fullscreen was exited.", "fullscreen-exit");
    emitWarning("Secure exam mode: fullscreen was exited. This has been recorded.");
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFullScreen()) {
        mainWindow.setFullScreen(true);
      }
    }, 1500);
  });

  mainWindow.on("minimize", () => {
    recordEvent("WINDOW_BLUR", "The lockdown browser window was minimized.", "window-minimize");
    emitWarning("Secure exam mode: window focus changed. This has been recorded.");
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isMinimized()) {
        mainWindow.restore();
      }
    }, 2000);
  });

  mainWindow.loadURL(buildLoadUrl(examId));

  // Part 10 — a renderer crash (distinct from the whole app quitting) is
  // main-owned and must never depend on the page's own JS being
  // responsive to clean up after itself.
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    diagnosticLog("renderer process gone", { reason: details.reason });
    restoreLockdownControls(`render-process-gone:${details.reason}`);
  });

  mainWindow.on("closed", () => {
    restoreLockdownControls("window-closed");
    mainWindow = null;
    displayEnforcement.stop();
    processDetection.stop();
    remoteSessionMonitor.stop();
  });
}

/**
 * Logs the domain of external (non-SES) requests for evidence purposes.
 * Does not cancel/block any request in v1 — see
 * docs/lockdown-browser-known-limitations.md.
 */
function monitorNetworkRequests() {
  const sesHost = new URL(SES_BASE_URL).host;
  electronSession.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    try {
      const url = new URL(details.url);
      if (url.host !== sesHost) {
        recordEvent(
          "MANUAL_WARNING",
          "A request to a non-SES domain was observed.",
          "external-network-request",
          { domain: url.host },
        );
      }
    } catch {
      // Malformed URL — ignore, never block.
    }
    callback({});
  });
}

/**
 * Tether Windows Lockdown Hardening v1, Part 7/9 — deny every download by
 * default (session-level, so it covers any window this app ever
 * creates, including the overlay windows). File-upload question types
 * are unaffected — they submit via fetch/XHR from inside the page, never
 * through Electron's download mechanism at all.
 */
function blockDownloads() {
  electronSession.defaultSession.on("will-download", (event, item) => {
    event.preventDefault();
    reportAuditFactBestEffort("TETHER_LOCKDOWN_DOWNLOAD_DENIED", { fileName: item.getFilename().slice(0, 100) });
  });
}

/**
 * Part 2 — "after Windows resume/unlock". powerMonitor is a
 * process-global singleton (not tied to any one window), registered
 * once at app start.
 */
function registerPowerMonitorRescan() {
  powerMonitor.on("resume", () => processDetection.forceRescan());
  powerMonitor.on("unlock-screen", () => processDetection.forceRescan());
}

function registerDeepLinkProtocol() {
  for (const protocol of DEEP_LINK_PROTOCOLS) {
    if (!app.isDefaultProtocolClient(protocol)) {
      app.setAsDefaultProtocolClient(protocol);
    }
  }
}

function handleDeepLink(url: string) {
  // Never log the full deep link — it could carry sensitive query params
  // in future versions even though v1 only sends examId.
  const examId = parseExamIdFromDeepLinkUrl(url);
  if (isWindowUsable(mainWindow)) {
    mainWindow.loadURL(buildLoadUrl(examId));
  } else {
    createWindow(examId);
  }
}

ipcMain.on("lockdown:set-context", (_event, context: ExamContext) => {
  if (typeof context?.examId !== "string" && context?.examId !== null) return;
  if (typeof context?.submissionId !== "string" && context?.submissionId !== null) return;
  examContext = { examId: context.examId, submissionId: context.submissionId };
  void flushQueue();
});

ipcMain.on(
  "lockdown:log-event",
  (_event, payload: { eventType: string; metadata?: Record<string, unknown> }) => {
    const allowed = ["WINDOW_BLUR", "WINDOW_FOCUS_RETURN", "FULLSCREEN_EXIT", "MANUAL_WARNING"];
    if (typeof payload?.eventType !== "string" || !allowed.includes(payload.eventType)) return;
    recordEvent(
      payload.eventType as QueuedLockdownEvent["eventType"],
      "An integrity signal was reported by the SES web page.",
      "page-reported",
      typeof payload.metadata === "object" && payload.metadata !== null ? payload.metadata : {},
    );
  },
);

// Destroyed-window crash fix v1.7.1 audit — no isWindowUsable guard
// needed here: this handler is invoked synchronously by the renderer's
// own IPC call, so mainWindow.webContents is necessarily alive at the
// point this function starts running (the only await is after that
// access completes).
ipcMain.handle("lockdown:get-session-info", async () => {
  if (!mainWindow) return { authenticated: false };
  const cookies = await mainWindow.webContents.session.cookies.get({ url: SES_BASE_URL });
  const authenticated = cookies.some((c) => c.name.toLowerCase().includes("session-token"));
  return { authenticated };
});

// Corrective pass v1.2.1, Task C — the hosted page tells main the full
// {active, ready, requireSingleDisplay} state (main has no policy
// awareness of its own — see displayEnforcement.ts doc comment).
// Reporting the resulting events back to the server stays page-driven
// (the page already has an authenticated fetch); only the blocking
// overlay itself is main-owned.
ipcMain.on("lockdown:set-secure-client-enforcement-state", (_event, state: unknown) => {
  if (!isValidEnforcementState(state)) return;
  displayEnforcement.setEnforcementState(state);
  if (state.active) lockdownLifecycle.activate();
  maybeEmitDiagnostics();
});

// v1.7.5 P0 — the narrow, read-only counterpart to the setter above. The
// exam content page uses this to distinguish "I just arrived via the
// Phase 2 handoff, native lockdown is already ACTIVE+READY — preserve
// it" from "native lockdown was never established in this process (a
// direct load, reload, or Tether restart) — a secure reactivation
// handshake is required before any content is shown". This is the SAME
// live state setSecureClientEnforcementState itself writes and
// displayEnforcement's own overlay decision reads — never a second,
// independently-tracked copy that could drift from it. Deliberately
// returns only {active, ready, requireSingleDisplay} — no topology,
// overlay, or diagnostic detail — so the page can never treat this as
// anything more than the one narrow signal it needs.
ipcMain.handle("lockdown:get-secure-client-enforcement-state", () => displayEnforcement.getDiagnosticsSnapshot().enforcementState);

ipcMain.handle("lockdown:get-display-count", () => displayEnforcement.getCurrentDisplayCount());

// v1.7.6 — Native Display State Bridge, read-only initial query. Lets the
// exam page's display-violation modal pick up an ALREADY-active violation
// immediately on mount/reload, instead of only ever learning about state
// changes going forward (the lockdown:display-enforcement-state-changed
// push, wired from displayEnforcement's onDisplayStateChanged callback
// near the top of this file, only ever fires on the NEXT transition).
//
// Pre-commit audit fix (PR #26) — calls getFreshDisplayEnforcementStatus()
// (awaits/reuses a real evaluation, serialized with any already-in-flight
// one) rather than a plain cached read: an already-BLOCKED native state
// that predates this renderer mounting could otherwise never be observed,
// since live pushes are deduplicated against the last status and a state
// that stays BLOCKED unchanged may never fire another one.
ipcMain.handle("lockdown:get-display-enforcement-status", () => displayEnforcement.getFreshDisplayEnforcementStatus());

// Tether System Check and Exam Readiness v1 — see
// docs/tether-system-check-v1.md. Four narrowly scoped, read-only
// readiness methods. None expose shell execution, filesystem access,
// arbitrary IPC, environment-variable dumps, process lists, or secrets —
// each handler below returns only the specific bounded value named.
ipcMain.handle("lockdown:get-client-version", () => LOCKDOWN_VERSION);

ipcMain.handle("lockdown:get-os-info", () => ({
  platform: process.platform,
  release: os.release(),
}));

ipcMain.handle("lockdown:get-display-topology", () => displayEnforcement.getOnDemandDisplayTopology());

ipcMain.handle("lockdown:get-secure-client-capabilities", () => ({
  getClientVersion: true,
  getOperatingSystemInfo: true,
  getDisplayTopology: true,
  getSecureClientCapabilities: true,
}));

// Secure Client Attestation v2 — see docs/tether-system-check-v1.md,
// "Per-installation key" / "Genuine client attestation", and
// installationKey.ts's own doc comment. REPLACES the removed v1 design
// (a single globally-embedded private key). Every fact signed below is
// gathered by THIS main process itself (never trusted from an IPC
// argument the renderer supplies) — the renderer only ever hands in the
// server-issued nonce (and, for exam sessions, the exam/submission/
// policy-hash values ALREADY bound into the server-signed challenge it
// received). The exact canonical string formats below MUST match
// buildSystemCheckAttestationCanonicalString /
// buildExamSessionAttestationCanonicalString in the main web app's
// src/lib/secureClient/tetherAttestation.ts — kept as independently
// reviewable copies rather than a cross-package import, since
// apps/lockdown is a separate compiled package.
function buildSystemCheckAttestationCanonicalString(params: { nonce: string; installationPublicKeyFingerprint: string; clientVersion: string; platform: string; displayTopologyClassification: string }): string {
  return ["TETHER_ATTESTATION_V2", "SYSTEM_CHECK", params.nonce, params.installationPublicKeyFingerprint, params.clientVersion, params.platform, params.displayTopologyClassification].join("|");
}

function buildExamSessionAttestationCanonicalString(params: {
  nonce: string;
  installationPublicKeyFingerprint: string;
  clientVersion: string;
  platform: string;
  displayTopologyClassification: string;
  displayCount: number;
  examId: string;
  submissionId: string;
  policyHash: string;
  secureClientSessionId: string;
  capabilities: string;
  timestamp: string;
}): string {
  return [
    "TETHER_ATTESTATION_V2",
    "EXAM_SESSION",
    params.nonce,
    params.installationPublicKeyFingerprint,
    params.clientVersion,
    params.platform,
    params.displayTopologyClassification,
    String(params.displayCount),
    params.examId,
    params.submissionId,
    params.policyHash,
    params.secureClientSessionId,
    params.capabilities,
    params.timestamp,
  ].join("|");
}

// A fixed, comma-joined snapshot of the same four secure-client-capability
// booleans lockdown:get-secure-client-capabilities reports — never
// free-form JSON, always this exact bounded shape. Kept as a standalone
// function (rather than reusing the IPC handler's own literal) so both
// call sites are provably in lockstep.
function secureClientCapabilitiesSnapshot(): string {
  return "1,1,1,1";
}

function computePublicKeyFingerprint(publicKeyPem: string): string {
  return crypto.createHash("sha256").update(publicKeyPem.trim(), "utf8").digest("hex");
}

ipcMain.handle("lockdown:get-installation-info", () => getInstallationInfo(store));

ipcMain.handle("lockdown:ensure-installation-key", () => ensureInstallationKey(store, safeStorage));

// Registration proof-of-possession — signs ONLY the server-issued
// registration-challenge nonce, nothing else. A narrowly scoped,
// purpose-specific operation, not a generic signing primitive.
ipcMain.handle("lockdown:sign-registration-proof", (_event, nonce: unknown) => {
  if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > 512) return null;
  const signature = signWithInstallationKey(store, safeStorage, nonce);
  if (!signature) return null;
  const info = getInstallationInfo(store);
  return { signature, publicKey: info.publicKey, keyAlgorithm: info.keyAlgorithm, keyProtectionLevel: info.keyProtectionLevel };
});

ipcMain.handle("lockdown:attest-system-check", async (_event, nonce: unknown) => {
  if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > 512) return null;
  const info = getInstallationInfo(store);
  if (!info.hasKey || !info.publicKey) return null;
  const clientVersion = LOCKDOWN_VERSION;
  const platform = process.platform;
  const topology = await displayEnforcement.getOnDemandDisplayTopology();
  const displayTopologyClassification = topology.classification;
  const installationPublicKeyFingerprint = computePublicKeyFingerprint(info.publicKey);
  const canonicalString = buildSystemCheckAttestationCanonicalString({ nonce, installationPublicKeyFingerprint, clientVersion, platform, displayTopologyClassification });
  const signature = signWithInstallationKey(store, safeStorage, canonicalString);
  if (!signature) return null;
  return { signature, clientVersion, platform, displayTopologyClassification };
});

// EXAM_SESSION attestation — see docs/tether-system-check-v1.md, "Wiring
// installation attestation into real exam sessions". The renderer relays
// examId/submissionId/policyHash/secureClientSessionId straight out of
// the server-signed challenge it received (never chosen by the renderer
// itself) — main does not re-verify those against a local copy of the
// challenge (it has none; only the server holds the private signing key
// needed to have issued a genuine one), but every one of them is bound
// into THIS signature, and the SERVER independently re-checks each field
// against its own challenge and the real SecureClientSession/Submission
// rows before accepting anything (tetherAttestationRunner.ts). Native
// facts (clientVersion, platform, displayTopologyClassification,
// displayCount, capabilities, timestamp) are always gathered by main
// itself — never accepted from the payload.
ipcMain.handle("lockdown:attest-exam-session", async (_event, payload: unknown) => {
  if (typeof payload !== "object" || payload === null) return null;
  const { nonce, examId, submissionId, policyHash, secureClientSessionId } = payload as Record<string, unknown>;
  if (
    typeof nonce !== "string" || nonce.length === 0 || nonce.length > 512 ||
    typeof examId !== "string" || examId.length === 0 ||
    typeof submissionId !== "string" || submissionId.length === 0 ||
    typeof policyHash !== "string" || policyHash.length === 0 ||
    typeof secureClientSessionId !== "string" || secureClientSessionId.length === 0
  ) {
    return null;
  }
  const info = getInstallationInfo(store);
  if (!info.hasKey || !info.publicKey) return null;
  const clientVersion = LOCKDOWN_VERSION;
  const platform = process.platform;
  const topology = await displayEnforcement.getOnDemandDisplayTopology();
  const displayTopologyClassification = topology.classification;
  const displayCount = displayEnforcement.getCurrentDisplayCount();
  const capabilities = secureClientCapabilitiesSnapshot();
  const timestamp = new Date().toISOString();
  const installationPublicKeyFingerprint = computePublicKeyFingerprint(info.publicKey);
  const canonicalString = buildExamSessionAttestationCanonicalString({
    nonce,
    installationPublicKeyFingerprint,
    clientVersion,
    platform,
    displayTopologyClassification,
    displayCount,
    examId,
    submissionId,
    policyHash,
    secureClientSessionId,
    capabilities,
    timestamp,
  });
  const signature = signWithInstallationKey(store, safeStorage, canonicalString);
  if (!signature) return null;
  return { signature, clientVersion, platform, displayTopologyClassification, displayCount, capabilities, timestamp };
});

// Tasks A/B — the hosted page reports the bounded, non-secret policy
// context it knows (deliveryMode, displayPolicy, requireDisplayCheck,
// maximumDisplays, submissionId presence, verified-session boolean) so
// the diagnostic panel/log can show the full picture without main ever
// fetching or trusting policy on its own.
ipcMain.on("lockdown:report-diagnostic-context", (_event, context: unknown) => {
  if (!isValidDiagnosticContext(context)) return;
  pageReportedContext = context;
  maybeEmitDiagnostics();
});

ipcMain.handle("lockdown:get-diagnostics-enabled", () => diagnosticsPanelEnabled);
ipcMain.handle("lockdown:get-diagnostics-snapshot", () => buildCurrentDiagnosticsSnapshot());

// ---------------------------------------------------------------------------
// Tether Windows Lockdown Hardening v1 — process detection, remote-session
// detection, and lifecycle IPC surface. Every handler below returns only
// bounded, non-secret data (capability ids/categories/display names —
// never raw process names, paths, or command-line arguments) — see
// processDetection.ts / lockdownCapabilityRegistry.ts's own doc comments.
// ---------------------------------------------------------------------------

/** Part 12 — set by the hosted page, itself server-resolved via GET /api/tether/lockdown/policy. Never read from this process's own environment — see lockdownCapabilityRegistry.ts's LockdownPolicyToggles doc comment. */
ipcMain.on("lockdown:set-lockdown-policy-toggles", (_event, toggles: unknown) => {
  if (!isValidPolicyToggles(toggles)) return;
  processDetection.setPolicyToggles(toggles);
  remoteSessionMonitor.setPolicyToggles(toggles);
});

/** Part 3 — one-shot preflight scan; the page calls this before allowing a final exam to start. */
ipcMain.handle("lockdown:run-preflight-scan", async () => {
  // Part 17 — dev/test-only fault injection: the externally observable
  // effect of a genuine IPC timeout (the renderer's ipcRenderer.invoke
  // call never resolving in time) is indistinguishable from "detection
  // unavailable" from the caller's point of view — modeled the same way
  // here, deterministically, rather than actually hanging this handler.
  if (consumeLockdownFault("IPC_TIMEOUT")) return { state: "UNAVAILABLE", reason: "TIMEOUT" };
  return processDetection.runPreflightScan();
});

/** Part 4 — starts/stops the background during-exam poll. Also starts/stops the mid-exam remote-session monitor (see remoteSessionMonitor.ts) — the same ACTIVE-lifecycle signal now drives both. */
ipcMain.on("lockdown:set-lockdown-exam-active", (_event, active: unknown) => {
  if (typeof active !== "boolean") return;
  processDetection.setExamActive(active);
  remoteSessionMonitor.setExamActive(active);
});

/** Part 5 — remote-session/VM classification, on demand. */
ipcMain.handle("lockdown:get-remote-session-status", async () => getWindowsSessionClassification());

// ---------------------------------------------------------------------------
// v1.7.4 pre-exam readiness — the single narrow IPC handshake that proves
// native lockdown has actually reached its intended ACTIVE state before
// the hosted page is allowed to call the server activation endpoint
// (POST /api/submissions/[id]/activate) and reveal Question 1. See
// docs/tether-secure-launch-verification-investigation.md, Part C/E of
// the preflight-lifecycle investigation this implements.
//
// Deliberately NOT a generic ipcRenderer passthrough: takes only the two
// booleans the page's own already-authoritative (server-derived) policy
// snapshot carries (requireSingleDisplay, requireRemoteSessionCheck),
// and returns only a bounded, narrow result — never a raw process list,
// window handle, or anything else a compromised/modified page could use
// beyond "was activation successful, and if not, which single reason".
//
// Runs FRESH checks (never reuses a value cached from the earlier
// PRE-EXAM READINESS preflight) — this is what closes the race where
// TeamViewer/a second display appears in the gap between the calm
// preflight screen and the student clicking "Begin examination": process
// detection reuses processDetection.runPreflightScan() (the exact same
// one-shot scan the preflight screen itself uses), and the display check
// reuses displayEnforcement.getOnDemandDisplayTopology() (a READ-ONLY,
// side-effect-free native topology query — deliberately not
// evaluateNowAndGetDecision() here, so a fresh check that FAILS never
// flips the overlay on while the student is still on the tether-launch
// page; the overlay only ever appears once enforcement is actually
// activated below, after every fresh check has already passed).
//
// Only once EVERY fresh check is clean does this activate the real,
// live, continuous native controls atomically: display enforcement
// (ready:true, so any FUTURE change is caught immediately), process
// detection's during-exam poll, and remote-session monitoring — the same
// three mechanisms lockdown:set-secure-client-enforcement-state /
// lockdown:set-lockdown-exam-active activate separately today, now
// started together, synchronously with this one IPC call, so the hosted
// page can `await` a guarantee they are live before it ever navigates to
// exam content (previously: setLockdownExamActive(true) fired
// fire-and-forget at the same instant the display cover lifted, with no
// way for the page to know the FIRST process scan had actually
// completed).
// ---------------------------------------------------------------------------

export type SecureExamLockdownActivationParams = {
  requireSingleDisplay: boolean;
  requireRemoteSessionCheck: boolean;
};

export type SecureExamLockdownActivationFailureReason =
  | "INVALID_PARAMS"
  | "PROHIBITED_APPLICATION"
  | "PROCESS_CHECK_UNAVAILABLE"
  | "REMOTE_SESSION_DETECTED"
  | "REMOTE_SESSION_CHECK_UNAVAILABLE"
  | DisplayBlockingReason;

export type SecureExamLockdownActivationResult =
  | { ok: true; displayDecision: "OK"; processDecision: "CLEAN" }
  | { ok: false; reason: SecureExamLockdownActivationFailureReason; matchedCapabilityIds?: string[] };

function isValidSecureExamLockdownActivationParams(value: unknown): value is SecureExamLockdownActivationParams {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.requireSingleDisplay === "boolean" && typeof v.requireRemoteSessionCheck === "boolean";
}

ipcMain.handle("lockdown:activate-secure-exam-lockdown", async (_event, rawParams: unknown): Promise<SecureExamLockdownActivationResult> => {
  if (!isValidSecureExamLockdownActivationParams(rawParams)) return { ok: false, reason: "INVALID_PARAMS" };
  const params = rawParams;

  // Part 17 — dev/test-only fault injection, same modeling as
  // lockdown:run-preflight-scan above: an IPC timeout is indistinguishable
  // from "detection unavailable" to the caller.
  if (consumeLockdownFault("IPC_TIMEOUT")) return { ok: false, reason: "PROCESS_CHECK_UNAVAILABLE" };

  const scan = await processDetection.runPreflightScan();
  if (scan.state === "BLOCKED") return { ok: false, reason: "PROHIBITED_APPLICATION", matchedCapabilityIds: scan.matchedCapabilityIds };
  if (scan.state === "UNAVAILABLE") return { ok: false, reason: "PROCESS_CHECK_UNAVAILABLE" };

  if (params.requireRemoteSessionCheck) {
    const remoteSession = await getWindowsSessionClassification();
    if (!remoteSession || remoteSession.remoteSessionSignalSource === "UNAVAILABLE") {
      return { ok: false, reason: "REMOTE_SESSION_CHECK_UNAVAILABLE" };
    }
    if (remoteSession.isRemoteSession) return { ok: false, reason: "REMOTE_SESSION_DETECTED" };
  }

  if (params.requireSingleDisplay) {
    const topology = await displayEnforcement.getOnDemandDisplayTopology();
    const decision = resolveCombinedDisplayDecision(topology.electronDisplayCount, true, topology.classification);
    if (decision.state === "BLOCKED") return { ok: false, reason: decision.reason };
  }

  // Every fresh check passed — activate the real, live native controls
  // atomically. displayEnforcement's own evaluate() (triggered by
  // setEnforcementState below) will immediately re-derive the same OK
  // decision this handler just confirmed — no overlay should appear from
  // this call.
  displayEnforcement.setEnforcementState({ active: true, ready: true, requireSingleDisplay: params.requireSingleDisplay });
  processDetection.setExamActive(true);
  remoteSessionMonitor.setExamActive(true);
  lockdownLifecycle.activate();
  maybeEmitDiagnostics();

  return { ok: true, displayDecision: "OK", processDecision: "CLEAN" };
});

/** Part 10 — the page calls this at every normal-exit/failure point (successful submission, lecturer-authorised exit, failed launch, failed attestation, blocked preflight) — see restoreLockdownControls's own doc comment; also fires automatically on window close / renderer crash / app quit regardless. */
ipcMain.on("lockdown:restore-lockdown-controls", (_event, trigger: unknown) => {
  restoreLockdownControls(typeof trigger === "string" ? trigger.slice(0, 100) : "page-requested");
});

ipcMain.handle("lockdown:get-lockdown-lifecycle-state", () => lockdownLifecycle.getState());

/** Bounded, public capability metadata (id/category/displayName only — never executable names, detection methods, or internal notes) so the page can render a human-readable list from the capability ids main reports over lockdown:capability-transition. */
ipcMain.handle("lockdown:get-lockdown-capability-info", () =>
  LOCKDOWN_CAPABILITY_REGISTRY.map((c) => ({ id: c.id, category: c.category, displayName: c.displayName })),
);

/** Best-effort audit fact relay for facts the PAGE itself observes (preflight blocked shown to student, student closed an application before content opened) — see reportAuditFactBestEffort's own doc comment for why main uses the same mechanism for its own facts. Validated against the same fixed allow-list server-side by the audit-event route itself; this handler only bounds the shape before relaying. */
ipcMain.on("lockdown:report-lockdown-audit-fact", (_event, payload: unknown) => {
  if (typeof payload !== "object" || payload === null) return;
  const { action, metadata } = payload as Record<string, unknown>;
  if (typeof action !== "string" || action.length === 0 || action.length > 100) return;
  reportAuditFactBestEffort(action, typeof metadata === "object" && metadata !== null ? (metadata as Record<string, unknown>) : {});
});

app.whenReady().then(() => {
  registerDeepLinkProtocol();
  monitorNetworkRequests();
  blockDownloads();
  registerPowerMonitorRescan();

  // Electron has no single cross-platform "online" event on app — track
  // it from the renderer's online/offline window events instead, relayed
  // via IPC from preload.
  ipcMain.on("lockdown:network-status", (_event, online: boolean) => {
    isOnline = Boolean(online);
    if (isOnline) void flushQueue();
  });

  // No deep-link argv on this launch (normal Start Menu/desktop
  // shortcut/exe launch) -> initialExamId is null -> createWindow loads
  // Home/Dashboard (see buildLoadUrl/resolveStartupLoadUrl) — never a
  // previous exam, since no persisted fallback is consulted.
  const initialExamId = resolveInitialExamIdFromArgv(process.argv);
  createWindow(initialExamId);

  app.on("second-instance", (_event, argv) => {
    // A second-instance activation with NO deep link (e.g. the student
    // double-clicks the desktop shortcut again while Tether is already
    // running) must only focus the existing window, never navigate it —
    // it must not reopen or reuse whatever exam was previously open.
    const deepLinkArg = findDeepLinkArg(argv);
    if (deepLinkArg) handleDeepLink(deepLinkArg);
    if (isWindowUsable(mainWindow)) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on("open-url", (_event, url) => {
    handleDeepLink(url);
  });
});

app.on("window-all-closed", () => {
  // v1 never traps the student — closing the window is always allowed.
  app.quit();
});

// Part 10 — covers a clean app exit and Windows shutdown/restart signals
// alike (Electron fires before-quit for both) — idempotent with the
// "closed" handler's own restoreLockdownControls call above (calling it
// twice for the same exit is safe by construction — see
// lockdownLifecycle.ts).
app.on("before-quit", () => {
  restoreLockdownControls("before-quit");
});
