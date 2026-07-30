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
} from "electron";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import Store from "electron-store";
import {
  DEFAULT_SES_BASE_URL,
  DEEP_LINK_PROTOCOLS,
  LOCKDOWN_VERSION,
  USER_AGENT_SUFFIX,
  isDeepLinkArg,
  buildTetherLaunchPath,
  type ExamContext,
  type QueuedLockdownEvent,
} from "./shared";
import { DisplayEnforcement } from "./displayEnforcement";
import type { DisplayEnforcementEventType, SecureClientEnforcementState } from "./displayEnforcementLogic";
import {
  isDiagnosticsPanelEnabled,
  snapshotsEqualIgnoringTimestamp,
  formatDiagnosticLogLine,
  type TetherDiagnosticsSnapshot,
} from "./tetherDiagnosticsSnapshot";

export const DIAGNOSTIC_LOG_FILE_NAME = "tether-secure-browser-diagnostics.log";

const SES_BASE_URL = process.env.SES_BASE_URL ?? DEFAULT_SES_BASE_URL;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

type StoreSchema = {
  queuedEvents: QueuedLockdownEvent[];
  // Cold-start convenience only (Tether launch/install flow v1): if the
  // OS launches the app via protocol before any window exists yet, and
  // the process is later killed/relaunched mid-login, this lets a fresh
  // launch still resolve back to the exam the student was headed to —
  // never used for authorization, only for choosing which page to load.
  lastExamId: string | null;
};

const store = new Store<StoreSchema>({
  defaults: { queuedEvents: [], lastExamId: null },
});

const displayEnforcement = new DisplayEnforcement({
  onEventType: (eventType: DisplayEnforcementEventType, displayCount: number) => {
    mainWindow?.webContents.send("lockdown:display-enforcement-event", { eventType, displayCount });
  },
  onDiagnosticsChanged: () => maybeEmitDiagnostics(),
});

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
    currentDecision: de.currentDecision === "BLOCKED" ? "BLOCK" : "ALLOW",
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
  mainWindow?.webContents.send("lockdown:diagnostics-snapshot", snapshot);
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
  if (!mainWindow) return false;
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

function emitWarning(text: string) {
  if (!mainWindow) return;
  mainWindow.webContents.send("lockdown:warning", text);
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
  if (mainWindow) {
    mainWindow.webContents.send("lockdown:event-recorded", getQueue().length);
  }
}

function buildLoadUrl(examId: string | null): string {
  // Tether launch/install flow v1 — fixes the confirmed bug where this
  // always returned the dashboard regardless of examId. The web app
  // still keys the exam-taking page by submissionId, not examId (there
  // is no /student/exams/[examId] route) — but the Tether launch page
  // (buildTetherLaunchPath) resolves examId -> the correct submission
  // and exam content automatically, once inside Tether and
  // authenticated (see src/app/student/exams/[id]/tether-launch/page.tsx
  // in the main repo), so the student never has to find it themselves.
  if (examId) {
    store.set("lastExamId", examId);
    return `${SES_BASE_URL}${buildTetherLaunchPath(examId)}`;
  }
  // No examId on this launch — fall back to the last one we know about
  // (cold-start convenience only, e.g. the app was killed and relaunched
  // mid-login), then finally the plain dashboard.
  const lastExamId = store.get("lastExamId", null);
  if (lastExamId) {
    return `${SES_BASE_URL}${buildTetherLaunchPath(lastExamId)}`;
  }
  return `${SES_BASE_URL}/student`;
}

function createWindow(examId: string | null) {
  const preloadPath = path.join(__dirname, "preload.js");

  mainWindow = new BrowserWindow({
    fullscreen: true,
    kiosk: false,
    autoHideMenuBar: true,
    resizable: false,
    alwaysOnTop: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: preloadPath,
    },
  });
  mainWindow.setMenuBarVisibility(false);

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
    mainWindow?.webContents.send("lockdown:content-protection-status", contentProtectionEnabled);
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

  mainWindow.on("closed", () => {
    mainWindow = null;
    displayEnforcement.stop();
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

function registerDeepLinkProtocol() {
  for (const protocol of DEEP_LINK_PROTOCOLS) {
    if (!app.isDefaultProtocolClient(protocol)) {
      app.setAsDefaultProtocolClient(protocol);
    }
  }
}

function parseExamIdFromDeepLink(url: string): string | null {
  try {
    const parsed = new URL(url);
    // Never log the full deep link — it could carry sensitive query
    // params in future versions even though v1 only sends examId.
    return parsed.searchParams.get("examId");
  } catch {
    return null;
  }
}

function handleDeepLink(url: string) {
  const examId = parseExamIdFromDeepLink(url);
  if (mainWindow) {
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
  maybeEmitDiagnostics();
});

ipcMain.handle("lockdown:get-display-count", () => displayEnforcement.getCurrentDisplayCount());

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

app.whenReady().then(() => {
  registerDeepLinkProtocol();
  monitorNetworkRequests();

  // Electron has no single cross-platform "online" event on app — track
  // it from the renderer's online/offline window events instead, relayed
  // via IPC from preload.
  ipcMain.on("lockdown:network-status", (_event, online: boolean) => {
    isOnline = Boolean(online);
    if (isOnline) void flushQueue();
  });

  const initialExamId = parseExamIdFromDeepLink(process.argv.find((a) => isDeepLinkArg(a)) ?? "");
  createWindow(initialExamId);

  app.on("second-instance", (_event, argv) => {
    const deepLinkArg = argv.find((a) => isDeepLinkArg(a));
    if (deepLinkArg) handleDeepLink(deepLinkArg);
    if (mainWindow) {
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
