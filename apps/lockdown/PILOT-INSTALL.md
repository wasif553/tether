# SES Secure Exam Browser — Pilot Install Guide

This guide is for **controlled pilot** distribution only. The pilot
installer is **not code-signed or notarized**. It will trigger OS
security warnings — this is expected and covered below.

**Product name:** SES Secure Exam Browser
**What it does:** Detection and soft enforcement of OS-level integrity
signals during an exam, with evidence recorded for lecturer review.
**What it does not do:** It is not a cheat-proof or guaranteed-lockdown
tool. It does not perform full OS lockdown and does not detect cheating
automatically. See `apps/lockdown/README.md` and
`docs/lockdown-browser-known-limitations.md` for the complete scope.

**Institutions should test installation at least 24 hours before exam
day** — do not install for the first time on the morning of an exam.

---

## Windows installation

1. The operator provides `SES-Secure-Exam-Browser-<version>-win-x64.exe`.
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
6. Finish the installer. Launch **SES Secure Exam Browser** from the
   Start Menu or desktop shortcut.

## macOS installation

1. The operator provides `SES-Secure-Exam-Browser-<version>-mac-<arch>.dmg`
   (choose `arm64` for Apple Silicon Macs, `x64` for Intel Macs).
2. Double-click the `.dmg` to mount it, then drag **SES Secure Exam
   Browser** into the Applications folder.
3. **The first launch will show "Apple could not verify... is free of
   malware" or "unidentified developer."** This is expected — the pilot
   build is not notarized. To open it anyway:
   - Right-click (or Control-click) the app in Applications → **Open**
     → confirm **Open** in the dialog, **or**
   - Go to **System Settings → Privacy & Security**, scroll to the
     Security section, and click **Open Anyway** next to the blocked-app
     notice, then confirm.
4. Launch **SES Secure Exam Browser** from Applications or Launchpad.

---

## Launching the app

- The app opens in a fullscreen window and loads the SES web app
  directly — sign in exactly as you would in a normal browser.
- A thin status bar appears at the bottom of the window reading
  **"SES Lockdown Browser Active"** with an events-recorded counter.
- This confirms the lockdown client is running and its OS-level signals
  will be recorded alongside the browser-based Secure Exam Mode signals
  the web app already tracks.

## What students should see

- Fullscreen window showing the normal SES login/dashboard/exam pages
- The **"SES Lockdown Browser Active"** status bar at the bottom
- A brief yellow warning banner at the top if a signal is recorded
  (e.g. window lost focus, fullscreen exited) — this does not block
  typing or navigation
- Closing the window is always possible — the app never traps a student

---

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
→ Camera** → ensure desktop apps can access the camera and that SES
Secure Exam Browser is allowed. On macOS: **System Settings → Privacy &
Security → Camera** → enable for SES Secure Exam Browser.

### Network issue during the exam
The lockdown app queues integrity events locally and uploads them once
connectivity returns — a brief network drop does not lose exam answers,
which are saved by the web app's own autosave. If disconnection is
prolonged, follow the operator's contingency plan in
`docs/controlled-pilot-operator-guide.md`.

---

## Uninstall

**Windows:** Settings → Apps → Installed apps → search "SES Secure Exam
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
the OS and version, SES Secure Exam Browser version (Settings/About or
the version in the installer filename), and the exact point of failure.
