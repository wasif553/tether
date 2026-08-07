/**
 * Tether screen-sharing fix v1 — main-process display-media request
 * handling. Deliberately free of any Electron import (only `import type`,
 * erased at compile time) so this runs under plain vitest/node — main.ts
 * is the thin Electron-touching glue that calls handleDisplayMediaRequest
 * and registers it via `session.setDisplayMediaRequestHandler`.
 *
 * ROOT CAUSE (see A1 investigation): Chromium requires a session-level
 * `setDisplayMediaRequestHandler` to be registered before
 * `navigator.mediaDevices.getDisplayMedia()` can ever succeed in any
 * Electron BrowserWindow — without one, every request is denied
 * automatically and the renderer's getDisplayMedia() promise rejects.
 * apps/lockdown never registered one, in this branch OR in v1.7.1 OR in
 * any earlier version (confirmed via `git log -S"setDisplayMediaRequestHandler"`
 * across the app's entire history) — this is not a regression introduced
 * by the mid-exam remote-session/display-enforcement work; screen sharing
 * inside the packaged Tether window has never been able to succeed.
 *
 * Preserves the Entire-Screen security contract structurally, not just by
 * convention: `desktopCapturer.getSources` is only ever queried with
 * `types: ["screen"]` (never `"window"`), so this handler is physically
 * incapable of handing back an application-window source — no additional
 * filtering step could be bypassed or misconfigured to accept one. The
 * existing renderer-side `evaluateDisplaySurface`/`NOT_MONITOR_REJECTED`
 * check (src/lib/screenShareLifecycle.ts, unchanged) remains as a second,
 * independent layer of defense for any future/other capture path.
 */

/** The bounded subset of Electron.DesktopCapturerSource this module needs — never the NativeImage thumbnail (no captured pixels ever pass through this module). */
export type ScreenShareSource = { id: string; name: string; display_id: string };

export type ScreenShareRequestStreams = { video?: ScreenShareSource };

export type ScreenShareDiagnosticLogger = (checkpoint: string, data?: Record<string, unknown>) => void;

/**
 * Picks which "screen" source to hand back when more than one physical
 * display is attached. Prefers the source whose `display_id` matches the
 * current primary display (the common single-exam-display case is
 * already enforced separately by displayEnforcement.ts's
 * SINGLE_DISPLAY_REQUIRED policy, so in practice this is almost always
 * the only source present); falls back to the first available screen
 * source otherwise. Returns null only when no screen source exists at
 * all (Electron/OS could not enumerate any display for capture).
 */
export function selectEntireScreenSource(sources: ScreenShareSource[], primaryDisplayId: string): ScreenShareSource | null {
  if (sources.length === 0) return null;
  return sources.find((s) => s.display_id === primaryDisplayId) ?? sources[0];
}

/**
 * The actual `session.setDisplayMediaRequestHandler` handler body, with
 * every Electron-touching dependency injected so it's directly testable.
 * Never rejects/throws past its own boundary — a `getScreenSources`
 * failure or an empty source list both resolve to `callback({})`, which
 * Electron/Chromium surfaces to the renderer as a clean getDisplayMedia()
 * rejection (NotFoundError-shaped), never an unhandled main-process
 * exception that could crash Tether.
 */
export async function handleDisplayMediaRequest(
  getScreenSources: () => Promise<ScreenShareSource[]>,
  getPrimaryDisplayId: () => string,
  callback: (streams: ScreenShareRequestStreams) => void,
  log: ScreenShareDiagnosticLogger,
): Promise<void> {
  log("screenShare: display-media request received");
  let sources: ScreenShareSource[];
  try {
    sources = await getScreenSources();
  } catch (err) {
    log("screenShare: desktopCapturer.getSources failed", { message: err instanceof Error ? err.message : String(err) });
    callback({});
    return;
  }
  log("screenShare: desktopCapturer sources", { screenSourceCount: sources.length });

  const selected = selectEntireScreenSource(sources, getPrimaryDisplayId());
  if (!selected) {
    log("screenShare: no screen source available");
    callback({});
    return;
  }
  log("screenShare: source selected", { sourceType: "screen", matchedPrimaryDisplay: selected.display_id === getPrimaryDisplayId() });
  callback({ video: selected });
}
