# Tether Secure Browser — Pilot Install Guide

This guide is for **controlled pilot** distribution only. The pilot
installer is **not code-signed or notarized**. It will trigger OS
security warnings — this is expected and covered below.

**Product name:** Tether Secure Browser
**What it does:** Detection and soft enforcement of OS-level integrity
signals during an exam, with evidence recorded for lecturer review.
**What it does not do:** It is not a cheat-proof or guaranteed-lockdown
tool. It does not perform full OS lockdown and does not detect cheating
automatically. See `apps/lockdown/README.md` and
`docs/lockdown-browser-known-limitations.md` for the complete scope.

**Institutions should test installation at least 24 hours before exam
day** — do not install for the first time on the morning of an exam.

**Screen-sharing and remote support will not show this app's window.**
Tether Secure Browser enables best-effort content protection
(`setContentProtection(true)`), which deliberately excludes its window
from screenshots, screen recording, and remote screen-sharing tools —
this is intentional anti-recording behavior, not a bug. See "Remote
support limitation" below before relying on any screen-share-based
troubleshooting.

---

## Windows installation

1. The operator provides `Tether-Secure-Browser-<version>-win-x64.exe`.
   This installer is not distributed publicly — it comes from your
   institution or pilot operator directly.
2. Double-click the installer.
3. **Windows SmartScreen will likely show "Windows protected your PC."**
   This is expected for an unsigned pilot build. Click **More info**,
   then **Run anyway**.
4. The installer lets you choose the installation directory (not a
   one-click installer). Accept the default unless your operator
   instructs otherwise.
5. Choose whether to create a desktop shortcut and Start Menu entry
   (both are offered by default).
6. Finish the installer. Launch **Tether Secure Browser** from the
   Start Menu or desktop shortcut.

## macOS installation

1. The operator provides `Tether-Secure-Browser-<version>-mac-<arch>.dmg`
   (choose `arm64` for Apple Silicon Macs, `x64` for Intel Macs).
2. Double-click the `.dmg` to mount it, then drag **Tether Secure
   Browser** into the Applications folder.
3. **The first launch will show "Apple could not verify... is free of
   malware" or "unidentified developer."** This is expected — the pilot
   build is not notarized. To open it anyway:
   - Right-click (or Control-click) the app in Applications → **Open**
     → confirm **Open** in the dialog, **or**
   - Go to **System Settings → Privacy & Security**, scroll to the
     Security section, and click **Open Anyway** next to the blocked-app
     notice, then confirm.
4. Launch **Tether Secure Browser** from Applications or Launchpad.

---

## Launching the app

- The app opens in a fullscreen window and loads the SES web app
  directly — sign in exactly as you would in a normal browser.
- A thin status bar appears at the bottom of the window reading
  **"Tether Browser Active"** with an events-recorded counter.
- This confirms the lockdown client is running and its OS-level signals
  will be recorded alongside the browser-based Secure Exam Mode signals
  the web app already tracks.

## What students should see

- Fullscreen window showing the normal SES login/dashboard/exam pages
- The **"Tether Browser Active"** status bar at the bottom
- A brief yellow warning banner at the top if a signal is recorded
  (e.g. window lost focus, fullscreen exited) — this does not block
  typing or navigation
- Closing the window is always possible — the app never traps a student

---

## Remote support limitation (content protection)

Tether Secure Browser calls `setContentProtection(true)` on its
window as a best-effort measure against screenshots and screen
recording during an exam. A side effect is that **the app's window will
not appear in screen-sharing tools, remote-support software, or
screenshot/screen-capture utilities** — including tools an IT helpdesk
or support agent might normally use to see what a student sees.

**What this means in practice:**

- If a student shares their screen with support staff (Zoom, Teams,
  TeamViewer, etc.) while the app is open, support staff will typically
  see a black or empty rectangle where the app window is — **this is
  expected and does not mean the app crashed or is showing a blank
  screen to the student**. The student's own physical display shows the
  app normally.
- Support teams should **not rely on remote screen-viewing** to
  diagnose issues while a student is inside an active protected exam
  window. Remote viewing works normally for everything else on the
  student's desktop (browser, other apps) — it is specifically this
  app's own window that is excluded.
- For pilot support, ask the student to **describe verbally** what they
  see (e.g. "I see the login page," "I see the status bar at the
  bottom," "I see a yellow warning banner"), or use the out-of-band
  support channel established for the pilot (phone, messaging app,
  in-person) rather than asking them to screen-share the exam window
  itself.
- If genuinely necessary, ask the student to take a **photo of their
  screen with a second device** (phone camera) — this captures what a
  human eye sees, unlike software-based screen capture.

## Troubleshooting

### Windows SmartScreen warning
Expected for this unsigned pilot build. Click **More info → Run
anyway**. If the option doesn't appear, the installer may have been
blocked entirely by antivirus/Group Policy — contact IT.

### macOS "unidentified developer" warning
Expected for this unsigned pilot build. Use **Right-click → Open**, or
approve it in **System Settings → Privacy & Security → Open Anyway**.
If neither works, `System Settings → Privacy & Security → Security`
may have "Allow apps from" restricted to App Store only — the operator
or IT admin needs to permit this exception for the pilot.

### App opens but shows a blank screen
Usually a network issue reaching the production SES URL. Confirm the
device has internet access and can reach
`https://tether-murex.vercel.app` in a normal browser. If the
institution uses a custom `SES_BASE_URL`, confirm it with the operator.

### Login issue
The lockdown browser uses the exact same login as the normal web app —
if login fails, it's an account issue, not an Electron issue. Verify
credentials work in a normal browser first, then retry in the lockdown
app.

### Access code issue
The lockdown app does not change how access codes work — the code is
entered on the exam page exactly as in a browser. Confirm with the
lecturer that the code has been shared and hasn't expired for the
session.

### Camera permission issue
If the exam requires camera monitoring, the OS may prompt for camera
permission the first time. On Windows: **Settings → Privacy & Security
→ Camera** → ensure desktop apps can access the camera and that Tether
Secure Browser is allowed. On macOS: **System Settings → Privacy &
Security → Camera** → enable for Tether Secure Browser.

### Network issue during the exam
The lockdown app queues integrity events locally and uploads them once
connectivity returns — a brief network drop does not lose exam answers,
which are saved by the web app's own autosave. If disconnection is
prolonged, follow the operator's contingency plan in
`docs/controlled-pilot-operator-guide.md`.

---

## Install/uninstall lifecycle

Tether Secure Browser is **not** meant to be installed and removed
around every single exam. The correct lifecycle for a pilot or exam
period is:

1. **Install** at least 24 hours before the first exam that requires it
   (see "Windows installation" / "macOS installation" above).
2. **Keep it installed** for the entire exam or pilot window — if a
   student has more than one SES exam scheduled, they should leave the
   app installed between exams rather than reinstalling each time.
3. **Uninstall** only after the student's **final** SES exam for that
   institution or pilot, or when the institution/pilot operator
   explicitly instructs students to remove it.

**The app does not uninstall itself.** There is no auto-uninstall,
scheduled removal, or self-cleanup in v1 — see "Why there is no
auto-uninstall" below.

- **BYOD (student's own device):** the student uninstalls it manually
  using the OS's normal uninstall path (Windows: Settings → Apps;
  macOS: drag to Trash — see "Uninstall" below).
- **Managed/institution device:** the institution's IT team or MDM
  tooling handles install and removal; students on managed devices
  should not need to do this themselves.

### Why there is no auto-uninstall in v1

- **Multiple exams.** A student may have several SES exams across a
  term or pilot; auto-uninstalling after one exam would force a
  reinstall (and a fresh SmartScreen/Gatekeeper warning) before the
  next one.
- **Permission issues.** Triggering an uninstall from inside the running
  app would require elevated permissions on some systems and could fail
  silently or partially depending on how the app was installed
  (per-user vs. all-users).
- **Partial uninstall risk.** An uninstall initiated while the app's own
  process is still running risks leaving orphaned files, registry
  entries, or shortcuts — safer to let the OS's own uninstaller run
  standalone, as it does today.
- **Managed-device policy.** On institution-managed devices, software
  removal is usually an IT/MDM decision, not something an individual
  app should decide for itself.
- **Support risk.** An app that can uninstall itself (or trigger OS
  uninstall commands) is a bigger support and security surface than one
  that doesn't — v1 deliberately keeps install/uninstall entirely in
  the hands of the student or their institution's IT team.

## Uninstall

**Windows:** Settings → Apps → Installed apps → search "Tether Secure
Browser" → Uninstall. Or use the uninstaller shortcut created alongside
the Start Menu entry.

**macOS:** Drag the app from Applications to Trash. No separate
uninstaller is needed (no system-level services or launch agents are
installed by this pilot build).

---

## Support escalation checklist

Before escalating to the development team, confirm:

- [ ] Installer came from the operator's approved source (not a
      forwarded/unknown link)
- [ ] Device meets minimum requirements: Windows 10+ or macOS 12+,
      stable internet, laptop/desktop (not mobile)
- [ ] The same login works in a normal browser at the production URL
- [ ] SmartScreen/Gatekeeper warning was bypassed using the steps above
      (not silently blocked by IT policy)
- [ ] Camera/network permissions were granted if the exam requires them
- [ ] The exact error message or screenshot is captured before
      escalating

If all the above are confirmed and the issue persists, escalate with:
the OS and version, Tether Secure Browser version (Settings/About or
the version in the installer filename), and the exact point of failure.

---

## Pre-pilot sign-off: physical verification required

Because content protection excludes this app's window from screenshots,
screen recording, and remote-support tools (see above), **automated or
remote QA cannot visually confirm the app's on-screen behavior**. Before
distributing the installer to pilot students, an operator must
physically sit at a real machine, look at the real screen, and confirm
each item below with their own eyes:

- [ ] The login page is visible after launching the app
- [ ] The **"Tether Browser Active"** status bar is visible at
      the bottom of the window
- [ ] A warning banner appears when triggering a blur or fullscreen-exit
      event (e.g. Alt+Tab away, then back; or exit fullscreen)
- [ ] The events-recorded counter in the status bar increases when a
      signal is triggered
- [ ] A test exam can be started and submitted successfully from inside
      the app
- [ ] The lecturer can open the submission's evidence report afterward
      and see the recorded integrity events

Do not sign off on pilot readiness based on remote testing, automated
scripts, or screenshots alone — none of these can see this app's
window. This physical checklist is the only reliable verification
method for this app's interactive behavior.
