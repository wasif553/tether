/**
 * Tether Windows Lockdown Hardening v1 — keyboard and escape controls
 * (Part 8). Pure decision logic over Electron's `before-input-event`
 * payload shape ({key, control, alt, shift, meta}) — main.ts is the
 * only caller, wiring this into `webContents.on("before-input-event")`
 * and calling `event.preventDefault()` when this returns a match.
 *
 * Ctrl+Alt+Delete is deliberately NOT handled here at all — Windows'
 * Secure Attention Sequence is intercepted by the OS itself before any
 * user-mode application (Electron included) ever receives the
 * keystroke; there is no `before-input-event` for it to block, and no
 * Windows-supported way for an ordinary application to intercept it
 * even with keyboard hooks. See
 * docs/tether-windows-lockdown-hardening-v1.md, "Ctrl+Alt+Delete
 * limitation" (Part 16 item 22).
 */

export type KeyboardInputEvent = {
  key: string;
  control: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
};

export type BlockedShortcutReason =
  | "CLOSE_WINDOW"
  | "RELOAD"
  | "DEVTOOLS"
  | "VIEW_SOURCE"
  | "NAVIGATE_HISTORY"
  | "NEW_WINDOW_OR_TAB"
  | "PRINT"
  | "SAVE_PAGE"
  | "ADDRESS_BAR";

export type KeyboardShortcutDecision = { blocked: true; reason: BlockedShortcutReason } | { blocked: false };

/**
 * Every shortcut below is genuinely Electron/Chromium-level browser
 * chrome behaviour Tether has no legitimate reason to allow inside an
 * exam window — none of them are ever needed to answer exam questions.
 * `key` values match Electron's own normalized `input.key` strings
 * exactly (case-sensitive for letters — Electron reports the lowercase
 * physical key regardless of Shift state, with `shift` reported
 * separately).
 */
export function classifyKeyboardShortcut(input: KeyboardInputEvent): KeyboardShortcutDecision {
  const { key, control, alt, shift, meta } = input;
  const ctrlOrMeta = control || meta; // meta (Cmd) has no meaning on Windows, but harmless to also catch defensively.

  // Alt+F4 — close window.
  if (alt && !ctrlOrMeta && !shift && key === "F4") return { blocked: true, reason: "CLOSE_WINDOW" };
  // Ctrl+W — close tab/window.
  if (ctrlOrMeta && !alt && !shift && key.toLowerCase() === "w") return { blocked: true, reason: "CLOSE_WINDOW" };
  // Ctrl+R / F5 — reload.
  if (((ctrlOrMeta && !alt && key.toLowerCase() === "r") || (!ctrlOrMeta && !alt && key === "F5")) ) return { blocked: true, reason: "RELOAD" };
  // Ctrl+Shift+I, F12, Ctrl+Shift+J, Ctrl+Shift+C — DevTools.
  if (ctrlOrMeta && shift && !alt && ["i", "j", "c"].includes(key.toLowerCase())) return { blocked: true, reason: "DEVTOOLS" };
  if (!ctrlOrMeta && !alt && !shift && key === "F12") return { blocked: true, reason: "DEVTOOLS" };
  // Ctrl+U — view source.
  if (ctrlOrMeta && !alt && !shift && key.toLowerCase() === "u") return { blocked: true, reason: "VIEW_SOURCE" };
  // Ctrl+L — address bar.
  if (ctrlOrMeta && !alt && !shift && key.toLowerCase() === "l") return { blocked: true, reason: "ADDRESS_BAR" };
  // Alt+Left / Alt+Right — back/forward history navigation.
  if (alt && !ctrlOrMeta && !shift && (key === "ArrowLeft" || key === "ArrowRight")) return { blocked: true, reason: "NAVIGATE_HISTORY" };
  // Ctrl+N / Ctrl+T — new window/tab.
  if (ctrlOrMeta && !alt && !shift && ["n", "t"].includes(key.toLowerCase())) return { blocked: true, reason: "NEW_WINDOW_OR_TAB" };
  // Ctrl+P — print.
  if (ctrlOrMeta && !alt && !shift && key.toLowerCase() === "p") return { blocked: true, reason: "PRINT" };
  // Ctrl+S — save page.
  if (ctrlOrMeta && !alt && !shift && key.toLowerCase() === "s") return { blocked: true, reason: "SAVE_PAGE" };

  return { blocked: false };
}
