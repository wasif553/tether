import { describe, it, expect } from "vitest";
import { classifyKeyboardShortcut, type KeyboardInputEvent } from "./keyboardHardeningLogic";

function key(overrides: Partial<KeyboardInputEvent> & { key: string }): KeyboardInputEvent {
  return { control: false, alt: false, shift: false, meta: false, ...overrides };
}

describe("classifyKeyboardShortcut — 21. keyboard shortcuts are blocked as designed", () => {
  it("Alt+F4 is blocked (close window)", () => {
    expect(classifyKeyboardShortcut(key({ key: "F4", alt: true }))).toEqual({ blocked: true, reason: "CLOSE_WINDOW" });
  });
  it("Ctrl+W is blocked (close window)", () => {
    expect(classifyKeyboardShortcut(key({ key: "w", control: true }))).toEqual({ blocked: true, reason: "CLOSE_WINDOW" });
  });
  it("Ctrl+R and F5 are both blocked (reload)", () => {
    expect(classifyKeyboardShortcut(key({ key: "r", control: true }))).toEqual({ blocked: true, reason: "RELOAD" });
    expect(classifyKeyboardShortcut(key({ key: "F5" }))).toEqual({ blocked: true, reason: "RELOAD" });
  });
  it("Ctrl+Shift+I, F12, Ctrl+Shift+J, Ctrl+Shift+C are all blocked (DevTools)", () => {
    expect(classifyKeyboardShortcut(key({ key: "i", control: true, shift: true }))).toEqual({ blocked: true, reason: "DEVTOOLS" });
    expect(classifyKeyboardShortcut(key({ key: "F12" }))).toEqual({ blocked: true, reason: "DEVTOOLS" });
    expect(classifyKeyboardShortcut(key({ key: "j", control: true, shift: true }))).toEqual({ blocked: true, reason: "DEVTOOLS" });
    expect(classifyKeyboardShortcut(key({ key: "c", control: true, shift: true }))).toEqual({ blocked: true, reason: "DEVTOOLS" });
  });
  it("Ctrl+U is blocked (view-source)", () => {
    expect(classifyKeyboardShortcut(key({ key: "u", control: true }))).toEqual({ blocked: true, reason: "VIEW_SOURCE" });
  });
  it("Ctrl+L is blocked (address bar)", () => {
    expect(classifyKeyboardShortcut(key({ key: "l", control: true }))).toEqual({ blocked: true, reason: "ADDRESS_BAR" });
  });
  it("Alt+Left and Alt+Right are blocked (history navigation)", () => {
    expect(classifyKeyboardShortcut(key({ key: "ArrowLeft", alt: true }))).toEqual({ blocked: true, reason: "NAVIGATE_HISTORY" });
    expect(classifyKeyboardShortcut(key({ key: "ArrowRight", alt: true }))).toEqual({ blocked: true, reason: "NAVIGATE_HISTORY" });
  });
  it("Ctrl+N and Ctrl+T are blocked (new window/tab)", () => {
    expect(classifyKeyboardShortcut(key({ key: "n", control: true }))).toEqual({ blocked: true, reason: "NEW_WINDOW_OR_TAB" });
    expect(classifyKeyboardShortcut(key({ key: "t", control: true }))).toEqual({ blocked: true, reason: "NEW_WINDOW_OR_TAB" });
  });
  it("Ctrl+P is blocked (print)", () => {
    expect(classifyKeyboardShortcut(key({ key: "p", control: true }))).toEqual({ blocked: true, reason: "PRINT" });
  });
  it("Ctrl+S is blocked (save page)", () => {
    expect(classifyKeyboardShortcut(key({ key: "s", control: true }))).toEqual({ blocked: true, reason: "SAVE_PAGE" });
  });

  it("ordinary typing keys are never blocked", () => {
    for (const plain of ["a", "Enter", "Backspace", "Tab", " ", "1"]) {
      expect(classifyKeyboardShortcut(key({ key: plain }))).toEqual({ blocked: false });
    }
  });

  it("modifier-free versions of the same letters are never blocked (only the exact shortcut combination is)", () => {
    expect(classifyKeyboardShortcut(key({ key: "w" }))).toEqual({ blocked: false });
    expect(classifyKeyboardShortcut(key({ key: "p" }))).toEqual({ blocked: false });
  });

  it("22. Ctrl+Alt+Delete has no representation here at all — it is intercepted by Windows before any application ever sees it", () => {
    // There is no key value this function could even be called with for
    // the Secure Attention Sequence — asserting the function's own
    // source never references it, as a structural reminder that this is
    // an OS-level limitation, not a missed case.
    expect(classifyKeyboardShortcut.toString()).not.toMatch(/delete/i);
  });
});
