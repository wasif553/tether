/**
 * Destroyed-window crash fix v1.7.1.
 *
 * Electron throws synchronously — never a rejected promise — when a
 * BrowserWindow/webContents method is called after the window has already
 * been destroyed (e.g. TypeError: Object has been destroyed). A trailing
 * `.catch(() => {})` on the return value cannot catch that: the call
 * throws before any promise is ever created. Every main-process call site
 * that might run during or after window shutdown must check usability
 * first through isWindowUsable, and any call still made must be wrapped in
 * a real try/catch (see runOnWindowBestEffort below) to cover the narrow
 * race between the check and the call.
 */
export interface DestroyableWindowLike {
  isDestroyed(): boolean;
  webContents: { isDestroyed(): boolean } | null | undefined;
}

export function isWindowUsable<T extends DestroyableWindowLike>(window: T | null | undefined): window is T {
  if (!window) return false;
  if (window.isDestroyed()) return false;
  if (!window.webContents) return false;
  if (window.webContents.isDestroyed()) return false;
  return true;
}

/**
 * Runs `action` only when `window` is usable, and never lets a failure
 * inside `action` escape — a destroyed-object race between the usability
 * check and the call, a thrown error from send/executeJavaScript, or any
 * other failure of an optional operation. Only use this for genuinely
 * best-effort work; critical work must never be expressed as `action`
 * here, since a skip or a caught failure is silent by design.
 */
export function runOnWindowBestEffort<T extends DestroyableWindowLike>(
  window: T | null | undefined,
  action: (window: T) => void,
): void {
  if (!isWindowUsable(window)) return;
  try {
    action(window);
  } catch {
    // Best-effort only — see file doc comment above.
  }
}
