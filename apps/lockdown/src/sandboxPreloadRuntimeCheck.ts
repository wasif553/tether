/**
 * v1.7.3 sandboxed-preload hotfix — RUNTIME regression check (as opposed
 * to verifyPreloadBundle.ts's static/build-time text scan). Loads the
 * REAL, actually-built dist/preload.js (never a mock or a re-derived
 * stand-in) into a real Electron BrowserWindow configured EXACTLY like
 * production's (see main.ts: `sandbox: true, contextIsolation: true,
 * nodeIntegration: false`), and proves the full chain the v1.7.2 P0 broke
 * silently in the middle of:
 *
 *   renderer window.sesLockdown.getDisplayCount()
 *     -> preload's ipcRenderer.invoke("lockdown:get-display-count")
 *       -> a REAL ipcMain.handle("lockdown:get-display-count", ...)
 *         -> the REAL compiled DisplayEnforcement.getCurrentDisplayCount()
 *           -> screen.getAllDisplays().length
 *
 * This is intentionally NOT a vitest test: creating a real
 * app/BrowserWindow requires actually running inside the Electron
 * runtime, which plain-Node `vitest run` cannot do (Electron's `app`
 * module only exists when the process was launched via the `electron`
 * binary). Run directly with `npm run verify:sandbox-preload` (which
 * shells out to `electron dist/sandboxPreloadRuntimeCheck.js`) as part of
 * the pre-packaging validation checklist — never wired into `npm test`.
 *
 * Prints one JSON result line and exits 0 on success / 1 on any failure
 * (missing bridge, wrong types, invoke failure, non-positive-integer
 * result, or any preload-error event) — the exit code is what a CI/build
 * step should gate on, not string-matching stdout.
 */
import { app, BrowserWindow, ipcMain, screen } from "electron";
import path from "node:path";
import { DisplayEnforcement } from "./displayEnforcement";

type BridgeShape = { typeofSesLockdown: string; typeofGetDisplayCount: string };

async function main(): Promise<void> {
  await app.whenReady();

  // The REAL production IPC handler, backed by the REAL compiled
  // DisplayEnforcement class (see main.ts line ~776) — not a
  // reimplementation, so this check exercises the same code the packaged
  // app runs, end to end.
  const displayEnforcement = new DisplayEnforcement();
  ipcMain.handle("lockdown:get-display-count", () => displayEnforcement.getCurrentDisplayCount());

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  const preloadErrors: Array<{ message: string }> = [];
  win.webContents.on("preload-error", (_event, _preloadPath, error) => {
    preloadErrors.push({ message: error?.message ?? String(error) });
  });

  await win.loadURL("data:text/html,<html><body>sandbox-preload-runtime-check</body></html>");

  const bridgeShape = (await win.webContents.executeJavaScript(`
    (() => {
      const typeofSesLockdown = typeof window.sesLockdown;
      const typeofGetDisplayCount =
        typeofSesLockdown === "object" && window.sesLockdown !== null
          ? typeof window.sesLockdown.getDisplayCount
          : "n/a (sesLockdown missing)";
      return { typeofSesLockdown, typeofGetDisplayCount };
    })();
  `)) as BridgeShape;

  const failures: string[] = [];
  if (preloadErrors.length > 0) {
    failures.push(`preload-error event(s) fired — the preload script failed to load/execute: ${JSON.stringify(preloadErrors)}`);
  }
  if (bridgeShape.typeofSesLockdown !== "object") {
    failures.push(`typeof window.sesLockdown was "${bridgeShape.typeofSesLockdown}", expected "object"`);
  }
  if (bridgeShape.typeofGetDisplayCount !== "function") {
    failures.push(`typeof window.sesLockdown.getDisplayCount was "${bridgeShape.typeofGetDisplayCount}", expected "function"`);
  }

  let displayCount: unknown = null;
  let invokeError: string | null = null;
  if (failures.length === 0) {
    try {
      displayCount = await win.webContents.executeJavaScript(`window.sesLockdown.getDisplayCount()`);
    } catch (err) {
      invokeError = err instanceof Error ? err.message : String(err);
    }
    if (invokeError) {
      failures.push(`window.sesLockdown.getDisplayCount() invocation failed: ${invokeError}`);
    } else if (!(typeof displayCount === "number" && Number.isInteger(displayCount) && displayCount > 0)) {
      failures.push(`window.sesLockdown.getDisplayCount() did not resolve to a valid positive integer, got: ${JSON.stringify(displayCount)}`);
    }
  }

  // Independent cross-check via Electron's own screen module directly —
  // not itself part of the pass/fail gate (the real bridge round-trip
  // above is authoritative), just a sanity signal in the report.
  const electronOwnDisplayCount = screen.getAllDisplays().length;

  const result = {
    ok: failures.length === 0,
    failures,
    typeofSesLockdown: bridgeShape.typeofSesLockdown,
    typeofGetDisplayCount: bridgeShape.typeofGetDisplayCount,
    displayCount,
    electronOwnDisplayCount,
    preloadErrors,
    preloadPath: path.join(__dirname, "preload.js"),
  };

  // eslint-disable-next-line no-console
  console.log("SANDBOX_PRELOAD_RUNTIME_CHECK_RESULT_START");
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
  // eslint-disable-next-line no-console
  console.log("SANDBOX_PRELOAD_RUNTIME_CHECK_RESULT_END");

  app.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.log("SANDBOX_PRELOAD_RUNTIME_CHECK_RESULT_START");
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ok: false, failures: [err instanceof Error ? (err.stack ?? err.message) : String(err)] }, null, 2));
  // eslint-disable-next-line no-console
  console.log("SANDBOX_PRELOAD_RUNTIME_CHECK_RESULT_END");
  app.exit(1);
});
