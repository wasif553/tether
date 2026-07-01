# Lockdown Browser — Known Limitations (v1)

The Electron Lockdown Browser (`apps/lockdown`) is a **native lockdown
client** that provides **detection and evidence logging** with **soft
enforcement** — it is not, and should never be described as, a
cheat-proof or guaranteed-prevention tool.

## What v1 is

- A detection-and-logging desktop client that watches for OS/window
  -level integrity signals (window blur/focus, fullscreen exit, window
  minimize, multiple displays, external network requests) while a
  student takes an exam in it.
- Soft enforcement: it shows non-blocking warnings and re-enters
  fullscreen/restores the window after a short delay, but never traps
  the student or blocks exam input.
- Evidence logging for **lecturer review** — recorded signals feed into
  the same `IntegrityEvent` records, evidence reports, and analytics
  that browser-based Secure Exam Mode already produces. Humans make the
  final academic integrity decision, not this client.
- Optional. Existing browser-level Secure Exam Mode (window blur,
  fullscreen tracking, copy/paste blocking, camera monitoring, etc.)
  keeps working exactly as before, with or without this client present.

## What v1 does NOT do

- **Does not block Alt+Tab, or any other OS-level shortcut.** The
  operating system's own window-switching behavior is untouched.
- **Does not stop other applications from running.** A student can
  still have other software open; this client only observes its own
  window's focus state.
- **Does not kill processes.** Never inspects or terminates other
  running programs.
- **Does not prevent all screenshots or screen recording.**
  `setContentProtection(true)` is attempted on the window, but this is
  best-effort, platform-dependent, and not guaranteed — some recording
  tools can still capture the screen on some platforms. The client never
  claims to detect or prevent screenshots.
- **Does not cancel network requests.** External (non-SES) domains are
  logged for evidence, not blocked.
- **Requires student installation.** This is a separate desktop app the
  student must download and run — it is not embedded in or bundled with
  the web app, and Electron is not required to take any exam.
- **No code signing or notarization.** Electron Packaging v1 (see
  `apps/lockdown/README.md` and `apps/lockdown/PILOT-INSTALL.md`)
  produces a Windows NSIS installer and macOS DMG for **controlled
  pilot distribution only**. These are unsigned/unnotarized — Windows
  SmartScreen and macOS Gatekeeper will warn on install, which is
  expected and documented for operators/students. This is not suitable
  for public/broad distribution.
- **No auto-update.** Every pilot needs a fresh installer from the
  operator; there is no update-check or self-update mechanism.
- **No kiosk mode.** The packaged app runs the same detection-and-log
  soft-enforcement behavior as source — packaging does not add any new
  OS-level blocking.
- **No MDM deployment support yet.** There is no managed/silent
  install path for IT-managed fleets in v1.
- **Placeholder branding.** App icons are plain programmatic placeholders
  (dark background, "SES" text) — production-quality icons are required
  before broader distribution.

## v2 candidates (after pilot validation)

A future version may add a stricter kiosk mode and harder enforcement
(e.g. blocking more OS-level escapes, packaged/signed installers, MDM
deployment) — only after this v1's soft-enforcement approach has been
validated in a real pilot and the product/legal tradeoffs of harder
enforcement have been deliberately decided. None of that is in scope
for v1.
