/**
 * SES Lockdown Browser v1 — main process.
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
  screen,
  ipcMain,
  session as electronSession,
} from "electron";
import path from "node:path";
import Store from "electron-store";
import {
  DEFAULT_SES_BASE_URL,
  DEEP_LINK_PROTOCOL,
  LOCKDOWN_VERSION,
  USER_AGENT_SUFFIX,
  type ExamContext,
  type QueuedLockdownEvent,
} from "./shared";

const SES_BASE_URL = process.env.SES_BASE_URL ?? DEFAULT_SES_BASE_URL;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

type StoreSchema = {
  queuedEvents: QueuedLockdownEvent[];
};

const store = new Store<StoreSchema>({
  defaults: { queuedEvents: [] },
});

let mainWindow: BrowserWindow | null = null;
let examContext: ExamContext = { examId: null, submissionId: null };
let isOnline = true;

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
  // The deployed SES web app keys the student exam page by submissionId,
  // not examId (a student starts an exam via POST /api/exams/[id]/start,
  // which returns the submission). There is no /student/exams/[examId]
  // route. v1 adapts the deep link by landing on the dashboard — the
  // student still completes the start-exam click there themselves; this
  // is a deliberate adaptation to the real app routes, documented in
  // apps/lockdown/README.md.
  if (examId) {
    return `${SES_BASE_URL}/student`;
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
    checkDisplays();
  });

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
  });
}

function checkDisplays() {
  const displays = screen.getAllDisplays();
  if (displays.length > 1) {
    recordEvent(
      "MANUAL_WARNING",
      "Multiple displays were detected at exam launch.",
      "multiple-displays-detected",
      { displayCount: displays.length },
    );
    emitWarning("Secure exam mode: multiple displays detected. This has been recorded.");
  }
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
  if (!app.isDefaultProtocolClient(DEEP_LINK_PROTOCOL)) {
    app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL);
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

  const initialExamId = parseExamIdFromDeepLink(process.argv.find((a) => a.startsWith(`${DEEP_LINK_PROTOCOL}://`)) ?? "");
  createWindow(initialExamId);

  app.on("second-instance", (_event, argv) => {
    const deepLinkArg = argv.find((a) => a.startsWith(`${DEEP_LINK_PROTOCOL}://`));
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
