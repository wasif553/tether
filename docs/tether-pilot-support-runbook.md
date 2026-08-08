# Tether Pilot Support Runbook (v1)

Operational guide for support staff, lecturers, and administrators handling
student-reported issues with Tether Secure Browser during the pilot. This is
not a technical architecture document (see `docs/tether-release-management.md`
and `docs/tether-production-observability.md` for that) — it is a case-by-case
"what do I do right now" reference.

## Core principles (apply to every case below)

- **Integrity signals support lecturer review — they never automatically
  determine misconduct.** No case in this document instructs anyone to treat
  an integrity event as proof of cheating.
- **Never bypass installation binding or recovery controls to make a symptom
  go away.** If a student is blocked, the fix is to diagnose and resolve the
  underlying condition (or route to a lecturer recovery grant — see below),
  not to manually manipulate database rows or session state.
- **Never ask a student to disable a security control** (antivirus,
  SmartScreen, firewall, screen-lock policy, etc.) to work around a Tether
  problem. If a control is genuinely incompatible with Tether, that is an
  escalation, not a workaround.
- **Never collect signing keys, tokens, manifests, or session identifiers
  from a student "to debug."** Nothing a student can see or copy/paste is a
  legitimate diagnostic artifact for this system. Evidence is inspected
  server-side by staff with access, not solicited from students.
- **Never manually delete or edit database rows to "fix" a stuck
  session.** Any state that looks wrong is either (a) already handled by the
  recovery flow, (b) fixed by a lecturer recovery grant, or (c) a genuine bug
  to escalate — not a manual data-repair task.

## Case index

1. [Installer unavailable / download link broken](#1-installer-unavailable--download-link-broken)
2. [Installer fails to run](#2-installer-fails-to-run)
3. [Windows SmartScreen warning](#3-windows-smartscreen-warning)
4. [Tether won't open](#4-tether-wont-open)
5. [Wrong / outdated Tether version](#5-wrong--outdated-tether-version)
6. [System check fails](#6-system-check-fails)
7. [Camera unavailable](#7-camera-unavailable)
8. [Screen sharing fails to start](#8-screen-sharing-fails-to-start)
9. [Prohibited application detected](#9-prohibited-application-detected)
10. [Second display detected](#10-second-display-detected)
11. [Remote session detected](#11-remote-session-detected)
12. [Network interruption during exam](#12-network-interruption-during-exam)
13. [Tether closed unexpectedly](#13-tether-closed-unexpectedly)
14. ["Recovery requires support" message](#14-recovery-requires-support-message)
15. [Secure launch failure](#15-secure-launch-failure)
16. [Lecturer recovery-grant path](#16-lecturer-recovery-grant-path)

---

### 1. Installer unavailable / download link broken

- **Symptom:** `/lockdown-browser` or the exam launch page shows "Tether
  Secure Browser is not yet available for public download," or a student
  reports a broken download link.
- **Likely category:** Expected pilot state (installer not yet published) —
  see `docs/tether-release-management.md`. Not a bug.
- **Safe first response:** Confirm with the institution whether an approved
  installer build has actually been distributed for this pilot cohort yet.
- **Evidence to inspect:** `TETHER_RELEASE_STATUS` / `TETHER_INSTALLER_DOWNLOAD_URL`
  deployment configuration (operator-only, not student-visible).
- **Student action:** Contact institution/exam support for the installer
  file directly (email, LMS, or in-person handoff), per current pilot
  distribution process.
- **Lecturer/admin action:** Confirm the correct installer + SHA-256 for this
  pilot cohort before distributing it out-of-band.
- **Escalation trigger:** The message appears even though the institution
  confirms downloads should be enabled — escalate as a possible
  configuration issue.
- **What NOT to do:** Do not send students a link to an unverified or
  differently-hashed installer file "to unblock them quickly."

### 2. Installer fails to run

- **Symptom:** Double-clicking the installer does nothing, or it errors
  immediately.
- **Likely category:** Corrupted download, insufficient permissions, or
  antivirus quarantine.
- **Safe first response:** Ask the student to re-download and verify the
  file size looks reasonable (a 0-byte or tiny file indicates a failed
  download).
- **Evidence to inspect:** None collected from the student directly; this is
  local-machine troubleshooting.
- **Student action:** Re-download; try running as the current user (not
  "Run as administrator" unless specifically instructed); check antivirus
  quarantine/history for a blocked file.
- **Lecturer/admin action:** If repeated across multiple students on the
  same network/device image, escalate — may indicate an institutional
  antivirus policy blocking the unsigned installer (see
  `docs/tether-windows-code-signing-plan.md`).
- **Escalation trigger:** Fails consistently for a student after a clean
  re-download and antivirus exclusion.
- **What NOT to do:** Do not instruct students to disable antivirus
  entirely — at most, a scoped exclusion for the specific installer file,
  and only if the institution's IT policy allows it.

### 3. Windows SmartScreen warning

- **Symptom:** "Windows protected your PC" / "Unknown publisher" warning on
  install.
- **Likely category:** Expected — the pilot installer is not yet
  code-signed (see `docs/tether-windows-code-signing-plan.md`).
- **Safe first response:** Confirm this is expected pilot behavior, not a
  sign of a corrupted or malicious file — but only if the installer's
  SHA-256 has been verified against the known-good value published for this
  pilot.
- **Evidence to inspect:** Compare the downloaded file's SHA-256 against the
  canonical value in `tetherReleaseMetadata.ts` / the release register.
- **Student action:** Click "More info" → "Run anyway" only after the
  institution has confirmed this is the genuine pilot installer.
- **Lecturer/admin action:** Make sure students were told in advance to
  expect this warning, so it doesn't read as a red flag.
- **Escalation trigger:** A student reports a SmartScreen warning with
  wording that doesn't match "Unknown publisher" (e.g. a malware-specific
  warning) — treat as a potential genuinely different, unverified file and
  escalate immediately.
- **What NOT to do:** Never tell a student to disable SmartScreen system-wide.

### 4. Tether won't open

- **Symptom:** Installed, but double-clicking the app / clicking "Open
  Tether Secure Browser" does nothing.
- **Likely category:** Protocol handler not registered, app already running
  in the background, or a crash on launch.
- **Safe first response:** Ask the student to check Task Manager for an
  existing Tether process and close it, then retry.
- **Evidence to inspect:** None from the student; if it recurs, ask whether
  any error dialog appeared (exact wording).
- **Student action:** Restart the device if a stuck background process is
  suspected; reinstall as a last resort.
- **Lecturer/admin action:** If this affects many students on a shared
  device image, escalate to check whether the protocol handler
  registration step of the installer is failing on that image.
- **Escalation trigger:** Reinstall doesn't resolve it.
- **What NOT to do:** Do not ask the student to manually edit the Windows
  registry.

### 5. Wrong / outdated Tether version

- **Symptom:** System check or exam launch reports an unsupported/outdated
  client version.
- **Likely category:** Student has an older installer than the current
  minimum supported version (see `minimumSupportedTetherVersion()` in
  `src/lib/systemCheckConfig.ts`).
- **Safe first response:** Confirm the currently-required minimum version
  for this pilot cohort, and whether a newer installer is actually
  available for distribution yet (see Case 1 — never send a student into an
  "update required" loop with no real installer to get).
- **Evidence to inspect:** Reported client version (visible in system-check
  results), current `minimumSupportedTetherVersion()` configuration.
- **Student action:** Install the currently-distributed installer if one is
  available.
- **Lecturer/admin action:** If no newer installer is actually published
  yet, do not raise the minimum version in production — this is exactly the
  "impossible update loop" the release-metadata model
  (`src/lib/tetherReleaseMetadata.ts`) is designed to prevent structurally.
- **Escalation trigger:** A student is blocked by a version requirement with
  no installer available to satisfy it — this is a configuration bug, not a
  student-side issue.
- **What NOT to do:** Do not tell a student to try to spoof or manually edit
  a reported version string.

### 6. System check fails

- **Symptom:** `/student/system-check` reports a BLOCKED or WARNING result.
- **Likely category:** Varies — see the specific check that failed
  (camera, display, process, network).
- **Safe first response:** Read the specific failed-check message shown on
  the page — it already describes the actual condition (see
  `docs/tether-system-check-v1.md`).
- **Evidence to inspect:** The system-check result payload for this
  student's session (server-side, via support tooling — not solicited from
  the student).
- **Student action:** Address the specific condition described (close
  extra displays, close a flagged app, etc.) and re-run the check.
- **Lecturer/admin action:** If a check is failing in a way that doesn't
  match the student's actual machine state, escalate as a possible false
  positive.
- **Escalation trigger:** The same check fails after the described
  condition is genuinely resolved.
- **What NOT to do:** Do not tell a student to disable the check itself
  (there is no such option, and one should not be improvised).

### 7. Camera unavailable

- **Symptom:** Camera-required exam reports the camera as unavailable or
  permission-denied.
- **Likely category:** OS-level camera permission not granted to Tether,
  camera in use by another app, or no camera present.
- **Safe first response:** Ask the student to check Windows Settings →
  Privacy → Camera, and confirm Tether has permission; close other apps
  that might be holding the camera (video calls, other browser tabs).
- **Evidence to inspect:** None collected from the student for this case;
  it's local OS permission state.
- **Student action:** Grant camera permission, close conflicting apps,
  retry.
- **Lecturer/admin action:** If camera monitoring is a hard requirement for
  the exam and cannot be resolved in time, this is a recovery-grant
  decision — see Case 16.
- **Escalation trigger:** Permission is granted and no other app is using
  the camera, but it still fails.
- **What NOT to do:** Never ask a student to email or upload camera footage
  "for verification" outside the platform's own evidence pipeline.

### 8. Screen sharing fails to start

- **Symptom:** The "share your entire screen" prompt fails, is cancelled
  unexpectedly, or never appears.
- **Likely category:** OS-level screen recording permission not granted, or
  the student selected a window/tab instead of "Entire Screen."
- **Safe first response:** Confirm the student selected "Entire Screen" (not
  a specific window or tab) when prompted, and that screen-recording
  permission is granted to Tether at the OS level.
- **Evidence to inspect:** None from the student; check for a
  `SCREEN_SHARE_*` integrity event on the session server-side if it
  recurs.
- **Student action:** Retry, explicitly choosing "Entire Screen."
- **Lecturer/admin action:** If this fails consistently for a student after
  correct selection, may warrant a recovery grant depending on exam policy.
- **Escalation trigger:** Fails after confirmed "Entire Screen" selection
  and granted OS permission.
- **What NOT to do:** Do not accept a screenshot or manual description as a
  substitute for the actual screen-share evidence pipeline.

### 9. Prohibited application detected

- **Symptom:** Tether reports a blocked/prohibited application running.
- **Likely category:** A genuinely disallowed app is open, or a false
  positive on an app with a similar process name.
- **Safe first response:** Ask the student to close the named application
  and retry — this is a normal, expected control, not a punitive action by
  itself.
- **Evidence to inspect:** The specific application name/identifier
  reported (visible to the student on the blocking screen itself).
- **Student action:** Close the named application fully (not just minimize
  it) and select "Check again."
- **Lecturer/admin action:** If a student disputes that the named
  application was actually running, this becomes a review question for the
  lecturer using the recorded integrity event — not something support
  resolves by overriding the check.
- **Escalation trigger:** The block persists after the student closes the
  application and confirms via Task Manager it is not running.
- **What NOT to do:** Do not tell the student the flagged app "doesn't
  matter" or that they can ignore the block — always close it and retry
  properly, and never characterize a detection as proof of wrongdoing.

### 10. Second display detected

- **Symptom:** Tether blocks entry citing multiple displays.
- **Likely category:** A genuine second monitor, or a display incorrectly
  reported due to a docking station / GPU driver quirk.
- **Safe first response:** Ask the student to physically disconnect any
  additional monitor and retry.
- **Evidence to inspect:** None solicited from the student.
- **Student action:** Disconnect extra displays; if using a laptop docking
  station, undock fully and retry.
- **Lecturer/admin action:** If a student's setup genuinely cannot reduce to
  a single display (rare hardware cases), this is a recovery-grant/exam-
  policy decision, not something to bypass in the client.
- **Escalation trigger:** Block persists with only one physical display
  confirmed connected.
- **What NOT to do:** Do not instruct the student to use display-mirroring
  tricks or virtual-display software to "trick" the check — that undermines
  the control this check exists for.

### 11. Remote session detected

- **Symptom:** Tether blocks or flags a Remote Desktop / remote-access
  session.
- **Likely category:** A genuine RDP/remote-support session is active, or a
  background remote-access tool (e.g. TeamViewer, AnyDesk) is running even
  if not actively connected.
- **Safe first response:** Ask the student to fully exit any remote-access
  software and end any active remote session before retrying.
- **Evidence to inspect:** None solicited from the student directly.
- **Student action:** Close remote-access applications completely (check
  the system tray, not just the main window) and retry.
- **Lecturer/admin action:** If the student has a legitimate accessibility
  need requiring remote assistance during the exam, this must be arranged
  as a documented accommodation before the exam, not resolved by bypassing
  the check mid-exam.
- **Escalation trigger:** Block persists with no remote-access software
  confirmed running.
- **What NOT to do:** Never suggest disabling the remote-session check for
  an individual student as a quick fix.

### 12. Network interruption during exam

- **Symptom:** Connectivity drops mid-exam; heartbeat/evidence uploads
  fail.
- **Likely category:** Local network issue on the student's end, or a
  platform-side outage.
- **Safe first response:** Reassure the student that brief network
  interruptions are expected to be handled by the recovery flow — advise
  them not to force-close Tether, and to reconnect and let it retry.
- **Evidence to inspect:** Heartbeat/evidence-upload failure patterns for
  the session (server-side, via observability — see
  `docs/tether-production-observability.md`).
- **Student action:** Reconnect to network; do not restart the device
  unless instructed.
- **Lecturer/admin action:** If the interruption is confirmed
  platform-side (not the student's network), this should factor into any
  review of the resulting integrity events, and may warrant a recovery
  grant.
- **Escalation trigger:** Repeated interruptions affecting many students
  simultaneously — likely platform-side, escalate immediately as a possible
  incident.
- **What NOT to do:** Do not tell a student to keep retrying indefinitely
  without escalating if the platform itself appears to be down.

### 13. Tether closed unexpectedly

- **Symptom:** The app crashes or closes without the student intentionally
  exiting.
- **Likely category:** Application crash, OS-forced termination (e.g. low
  memory), or an unhandled error.
- **Safe first response:** Ask the student not to panic — reopen Tether and
  attempt to resume; the recovery flow is designed for exactly this case.
- **Evidence to inspect:** Any crash/error details the student can describe
  (on-screen error text, if any); server-side session state for the
  affected submission.
- **Student action:** Reopen Tether via the exam link and follow the resume
  flow.
- **Lecturer/admin action:** If recovery routes the student to "Recovery
  requires support" (Case 14), follow that case.
- **Escalation trigger:** Recurs multiple times for the same student in one
  sitting.
- **What NOT to do:** Do not manually mark the submission as complete or
  edit its status directly in the database.

### 14. "Recovery requires support" message

- **Symptom:** The student sees `ManualReviewNotice` after attempting to
  resume — recovery could not automatically re-verify this attempt.
- **Likely category:** By design — this state exists specifically for
  cases the automated recovery logic cannot safely resolve on its own
  (e.g. installation-binding mismatch, ambiguous session state). See
  `docs/tether-v1.7.2-pilot-release-readiness.md` recovery-lifecycle notes.
- **Safe first response:** This is not necessarily a problem with the
  student's conduct — explain that this is a normal safety checkpoint that
  requires a human decision, not an accusation.
- **Evidence to inspect:** The submission's recovery-status detail
  (`GET /api/submissions/[id]/recovery-status`) and any related integrity
  events, reviewed by the lecturer/admin.
- **Student action:** Contact their lecturer/institution as instructed on
  the notice; do not repeatedly retry.
- **Lecturer/admin action:** Review the session/evidence and use the
  recovery-grant path (Case 16) if appropriate.
- **Escalation trigger:** N/A — this state is itself already the
  escalation point; route directly to the lecturer.
- **What NOT to do:** Do not attempt to clear this state by deleting or
  editing the session/submission row directly. Do not tell the student this
  means they have been flagged for misconduct — it has not made that
  determination.

### 15. Secure launch failure

- **Symptom:** Launch-manifest issue/consume fails with an error (e.g. a
  `resolveTetherLaunchFailureMessage`-mapped code shown on the launch page).
- **Likely category:** Varies by error code — expired/replayed manifest,
  installation mismatch, transient server error (see the P2028
  transaction-timeout fix and related observability work).
- **Safe first response:** Ask the student to retry via "I have installed
  it — open examination"; most transient failures resolve on retry.
- **Evidence to inspect:** The specific failure code shown, and
  corresponding server-side diagnostic/audit-log entries if it recurs (see
  `docs/tether-production-observability.md`).
- **Student action:** Retry once; if it fails again, note the exact error
  text shown and contact support.
- **Lecturer/admin action:** If failures cluster around a specific time
  window or many students, escalate as a possible platform-side incident.
- **Escalation trigger:** Fails repeatedly for the same student with the
  same error code.
- **What NOT to do:** Do not attempt to manually issue or fabricate a
  launch manifest/session for a student. Do not disable manifest signature
  verification "temporarily."

### 16. Lecturer recovery-grant path

- **When to use:** A student is blocked by a state that automated recovery
  correctly refuses to resolve on its own (Case 14), or a documented
  accommodation requires manual override of a normally-enforced check.
- **Who can do this:** The lecturer/course admin for the exam, via the
  platform's existing recovery-grant workflow (not a support-staff
  database edit).
- **Safe first response:** Review the available evidence and session
  history for this student before granting — the grant should be a
  considered decision, not a reflexive unblock.
- **Evidence to inspect:** All integrity events, recovery-status history,
  and evidence assets associated with the submission, as surfaced in the
  lecturer's own review UI.
- **What this does NOT do:** A recovery grant is a decision to let the
  student proceed or resume — it is not, by itself, a finding that no
  misconduct occurred or that misconduct did occur. It restores the
  student's ability to continue; any integrity determination remains a
  separate, human academic-integrity process.
- **What NOT to do:** Do not grant recovery via direct database
  modification. Do not grant recovery without reviewing the actual evidence
  available. Do not treat a granted recovery as closing the integrity
  question either way.

---

## Escalation contacts

Pilot-phase escalations should go through the institution's existing
exam-support/IT channel. This document does not define new contact points —
it defines when to use the ones that already exist.
