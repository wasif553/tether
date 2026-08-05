# Tether Windows Lockdown Hardening v1

## Table of contents

1. [Objective and scope](#objective-and-scope)
2. [Core principles](#core-principles)
3. [Architecture](#architecture)
4. [Capability registry](#capability-registry)
5. [Detection methods](#detection-methods)
6. [Preflight blocking (Part 3)](#preflight-blocking-part-3)
7. [During-exam detection (Part 4)](#during-exam-detection-part-4)
8. [Remote-session and virtual-machine detection (Part 5)](#remote-session-and-virtual-machine-detection-part-5)
9. [Screen-sharing and capture signals (Part 6)](#screen-sharing-and-capture-signals-part-6)
10. [Electron hardening (Part 7)](#electron-hardening-part-7)
11. [Keyboard and escape controls (Part 8)](#keyboard-and-escape-controls-part-8)
12. [Clipboard and file transfer (Part 9)](#clipboard-and-file-transfer-part-9)
13. [Restoration and crash safety (Part 10)](#restoration-and-crash-safety-part-10)
14. [Audit and evidence (Part 11)](#audit-and-evidence-part-11)
15. [Privacy](#privacy)
16. [Configuration and environment variables](#configuration-and-environment-variables)
17. [Student UX (Part 13)](#student-ux-part-13)
18. [Lecturer visibility (Part 14)](#lecturer-visibility-part-14)
19. [Schema and SQL impact](#schema-and-sql-impact)
20. [Failure injection (dev/test only)](#failure-injection-devtest-only)
21. [Manual/physical test plan](#manualphysical-test-plan)
22. [Rollback](#rollback)
23. [Known limitations](#known-limitations)
24. [Unsupported controls](#unsupported-controls)
25. [Ctrl+Alt+Delete limitation](#ctrlaltdelete-limitation)
26. [External-device/hardware-capture limitation](#external-devicehardware-capture-limitation)

## Objective and scope

Strengthen the Windows build of Tether Secure Browser so it can detect,
block, or safely respond to applications and OS behaviours that could
undermine exam integrity, while restoring the computer cleanly after the
exam ends or Tether crashes. This is a **practical** hardening pass for a
**controlled pilot** — not a kiosk-mode lockdown product and not an
anti-cheat platform.

Explicitly out of scope, per the task that commissioned this work:
kernel drivers, invasive antivirus-style behaviour, blanket process
termination without policy, TPM attestation, macOS support, live remote
proctoring, automatic misconduct conclusions, permanent changes to
Windows settings, and inaccessible kiosk behaviour that traps the
student after a failure.

## Core principles

- Tether remains fail-safe and recoverable — it never traps the student
  (closing the window is always allowed) and never modifies a permanent
  Windows setting.
- Every detection is an **integrity signal for lecturer review**, never
  proof of cheating and never an automatic misconduct conclusion.
- Tether may block exam access or require support when prohibited
  software is active, but always with a calm, non-accusatory,
  recoverable UI.
- Every temporary control (overlays, polling, enforcement flags) is
  restored after normal exit and after recoverable crashes, through one
  idempotent lifecycle.
- Tether never terminates an unrelated process automatically.
- Detection plus controlled remediation is always preferred over
  aggressive system modification — even a "blocking" capability's
  enforcement can be downgraded to detect-only by policy (Part 12), and
  a downgrade never means "stop looking," only "stop blocking."
- No unrelated personal files, browsing history, keystrokes, or
  application content are ever collected — only a matched capability id,
  a normalized executable name (never a full path or command line), and
  bounded timestamps/durations.

## Architecture

Two packages, exactly like every prior Tether feature in this
repository:

- **`apps/lockdown`** (Electron, Windows-only detection/enforcement) —
  owns the actual Windows process enumeration, the remote-session/VM
  check, the main-owned preflight/during-exam overlays, and every
  Electron-level hardening control (permissions, navigation, downloads,
  DevTools, keyboard shortcuts, command-line switches). Has **zero**
  awareness of exam policy on its own — every policy decision (which
  capability categories are enforced, whether an exam is a final
  examination) is resolved server-side and relayed down through the
  hosted page via IPC, mirroring the existing `setSecureClientEnforcementState`
  pattern used for display enforcement.
- **Main web app** (`src/`) — resolves the four `TETHER_BLOCK_*` policy
  toggles server-side (`src/lib/tetherLockdownConfig.ts`), serves them
  via `GET /api/tether/lockdown/policy`, classifies and persists every
  detection as either a reviewable `IntegrityEvent` or a technical
  `PlatformAuditLog` entry (`src/lib/lockdownEventClassification.ts`,
  `src/lib/lockdownClient.ts`), and renders the student- and
  lecturer-facing UI.

New Electron-side modules (all pure/testable except where they touch
Electron's own `BrowserWindow`/`session`/`app` APIs):

| Module | Role |
|---|---|
| `lockdownCapabilityRegistry.ts` | The central registry (Part 1) — pure data + matching/policy-resolution helpers. |
| `processDetectionLogic.ts` | Pure scan-outcome parsing, episode-diffing, preflight-decision logic. |
| `windowsProcessList.ts` | Spawns the bounded, timeout-guarded `Get-Process` PowerShell query. |
| `processDetection.ts` | Main-process service tying the above together — polling, overlay, episode tracking. |
| `windowsSessionDetectionLogic.ts` / `windowsSessionDetection.ts` | Remote-session/VM classification (pure logic + spawn wrapper). |
| `keyboardHardeningLogic.ts` | Pure keyboard-shortcut classification. |
| `commandLineSafety.ts` | Pure unsafe-command-line-switch detection. |
| `lockdownLifecycle.ts` | The restoration state machine (Part 10). |
| `lockdownConfig.ts` | Operational tuning (scan interval/timeout/recheck) — Electron-local env vars. |
| `lockdownFaultInjection.ts` | Dev/test-only fault injection (Part 17). |

## Capability registry

`apps/lockdown/src/lockdownCapabilityRegistry.ts` is the single source
of truth for "which applications/behaviours does Tether care about, and
what does it do about each one." Every entry has: a stable `id`, a calm
`displayName`, a `category` (`REMOTE_CONTROL` / `DEBUGGING` /
`VIRTUALIZATION` / `CAPTURE_OVERLAY` / `NAVIGATION_ESCAPE`), the
normalized `executableNames` it matches on (process-based capabilities
only), its `detectionMethod`, `detectionNotes` (including known
false-positive limitations), `falsePositiveRisk` (LOW/MEDIUM/HIGH), its
`defaultAction` (`BLOCK_BEFORE_EXAM` / `BLOCK_DURING_EXAM` /
`WARN_AND_REQUIRE_CLOSE` / `DETECT_AND_RECORD` / `NOT_SUPPORTED`), which
`configToggle` (if any) can downgrade it, its `studentExplanation`
(shown only when it blocks/warns), its `auditEvidenceBehavior`, and its
`supportedWindowsVersions`.

Full current registry (36 entries):

| Capability | Category | Default action | False-positive risk | Config toggle |
|---|---|---|---|---|
| TeamViewer | REMOTE_CONTROL | BLOCK_DURING_EXAM | LOW | `TETHER_BLOCK_REMOTE_CONTROL` |
| AnyDesk | REMOTE_CONTROL | BLOCK_DURING_EXAM | LOW | `TETHER_BLOCK_REMOTE_CONTROL` |
| RustDesk | REMOTE_CONTROL | BLOCK_DURING_EXAM | LOW | `TETHER_BLOCK_REMOTE_CONTROL` |
| Chrome Remote Desktop | REMOTE_CONTROL | BLOCK_DURING_EXAM | MEDIUM | `TETHER_BLOCK_REMOTE_CONTROL` |
| Microsoft Remote Desktop (mstsc/MSRDC) | REMOTE_CONTROL | BLOCK_DURING_EXAM | LOW | `TETHER_BLOCK_REMOTE_CONTROL` |
| Quick Assist | REMOTE_CONTROL | BLOCK_DURING_EXAM | LOW | `TETHER_BLOCK_REMOTE_CONTROL` |
| Zoom | REMOTE_CONTROL | WARN_AND_REQUIRE_CLOSE | HIGH | `TETHER_BLOCK_REMOTE_CONTROL` |
| Microsoft Teams | REMOTE_CONTROL | WARN_AND_REQUIRE_CLOSE | HIGH | `TETHER_BLOCK_REMOTE_CONTROL` |
| Discord | REMOTE_CONTROL | WARN_AND_REQUIRE_CLOSE | HIGH | `TETHER_BLOCK_REMOTE_CONTROL` |
| VNC (RealVNC/TightVNC/UltraVNC) | REMOTE_CONTROL | BLOCK_DURING_EXAM | LOW | `TETHER_BLOCK_REMOTE_CONTROL` |
| Remote debugging port (Tether's own `--remote-debugging-port`) | DEBUGGING | BLOCK_BEFORE_EXAM | LOW | — |
| Developer tools (Tether's own DevTools) | DEBUGGING | BLOCK_DURING_EXAM | LOW | — |
| Node.js process | DEBUGGING | DETECT_AND_RECORD | HIGH | — |
| Visual Studio (devenv/msvsmon) | DEBUGGING | BLOCK_DURING_EXAM | MEDIUM | `TETHER_BLOCK_DEBUG_TOOLS` |
| VS Code debug session (debug-adapter processes) | DEBUGGING | DETECT_AND_RECORD | MEDIUM | `TETHER_BLOCK_DEBUG_TOOLS` |
| PowerShell / Command Prompt / Windows Terminal | DEBUGGING | DETECT_AND_RECORD | HIGH | — (never gated) |
| Process Explorer / Process Hacker | DEBUGGING | BLOCK_DURING_EXAM | LOW | `TETHER_BLOCK_DEBUG_TOOLS` |
| Hyper-V console (vmconnect) | VIRTUALIZATION | BLOCK_DURING_EXAM | LOW | `TETHER_BLOCK_VIRTUAL_MACHINES` |
| VMware | VIRTUALIZATION | WARN_AND_REQUIRE_CLOSE | MEDIUM | `TETHER_BLOCK_VIRTUAL_MACHINES` |
| VirtualBox | VIRTUALIZATION | WARN_AND_REQUIRE_CLOSE | MEDIUM | `TETHER_BLOCK_VIRTUAL_MACHINES` |
| Windows Sandbox | VIRTUALIZATION | BLOCK_DURING_EXAM | LOW | `TETHER_BLOCK_VIRTUAL_MACHINES` |
| Remote Desktop session (inbound — Tether itself remoted into) | VIRTUALIZATION | BLOCK_DURING_EXAM | LOW | `TETHER_BLOCK_REMOTE_CONTROL` |
| Virtual machine (Tether itself running inside one) | VIRTUALIZATION | WARN_AND_REQUIRE_CLOSE | MEDIUM | `TETHER_BLOCK_VIRTUAL_MACHINES` |
| OBS Studio | CAPTURE_OVERLAY | BLOCK_DURING_EXAM | LOW | `TETHER_BLOCK_SCREEN_CAPTURE_TOOLS` |
| Screen recorders (Camtasia/Bandicam/ShareX/Fraps) | CAPTURE_OVERLAY | BLOCK_DURING_EXAM | LOW | `TETHER_BLOCK_SCREEN_CAPTURE_TOOLS` |
| NVIDIA capture/broadcast tools | CAPTURE_OVERLAY | DETECT_AND_RECORD | HIGH | — |
| Xbox Game Bar | CAPTURE_OVERLAY | WARN_AND_REQUIRE_CLOSE | MEDIUM | `TETHER_BLOCK_SCREEN_CAPTURE_TOOLS` |
| Snipping Tool | CAPTURE_OVERLAY | DETECT_AND_RECORD | HIGH | — |
| Clipboard manager | CAPTURE_OVERLAY | DETECT_AND_RECORD | MEDIUM | — |
| External protocol launch / shell-open / new window / download / dev menu / off-origin navigation | NAVIGATION_ESCAPE | BLOCK_DURING_EXAM | LOW | — (Electron-level, always on) |

See the module's own inline doc comments for the full reasoning behind
each `falsePositiveRisk` rating and `defaultAction` choice — in
particular why Zoom/Teams/Discord/VMware/VirtualBox are deliberately
**not** hard-blocked (process presence alone cannot distinguish "open"
from "actively being used against Tether," and all four have enormous
everyday legitimate use outside any exam context).

## Detection methods

- **`PROCESS_NAME_MATCH`** (Part 2) — `windowsProcessList.ts` spawns a
  single, fully static, auditable PowerShell script
  (`@(Get-Process | Select-Object -ExpandProperty ProcessName) | ConvertTo-Json -Compress`)
  via `child_process.spawn()` with an **argv array**, never a shell
  string — there is no command-injection surface even in principle,
  since nothing from the registry, an IPC payload, or any other runtime
  value is ever interpolated into the script. Only the process **name**
  is requested (never `Path` or `CommandLine`) — this needs no elevated
  privileges and means there is structurally no command-line-argument
  data for this module to even accidentally collect. Every raw name is
  normalized (`normalizeExecutableName` — lowercased, path-stripped,
  `.exe`-stripped, length-bounded) before being compared against the
  registry, so detection never depends on a window title (which is
  trivially renamed/hidden).
- **`WINDOWS_SESSION_API`** (Part 5) — `windowsSessionDetection.ts`
  queries `GetSystemMetrics(SM_REMOTESESSION)` via a small embedded C#
  snippet (the same `Add-Type`-based pattern already used by
  `windowsDisplayTopology.ts`), corroborated by the OS-set `SESSIONNAME`
  environment variable.
- **`WINDOWS_SYSTEM_INFO`** (Part 5) — matches
  `HKLM\HARDWARE\DESCRIPTION\System\BIOS`'s `SystemManufacturer`/
  `SystemProductName` against well-known VM signature substrings
  (vmware, virtualbox, qemu, xen, parallels, kvm, "virtual machine").
- **`ELECTRON_WEBCONTENTS_API`** / **`ELECTRON_COMMAND_LINE`** (Part
  7/8) — `will-navigate`, `setWindowOpenHandler`, `will-download`,
  `devtools-opened`, `before-input-event`, and a `process.argv` scan at
  startup.

Every scan/query is bounded by a configurable timeout
(`TETHER_PROCESS_SCAN_TIMEOUT_SECONDS`) and never polls unbounded — see
[Configuration](#configuration-and-environment-variables).

## Preflight blocking (Part 3)

Wired into `src/app/student/exams/[id]/tether-launch/page.tsx`, before
either the auto-resume path or the manual "Start exam" click ever calls
`runLaunchSequence`. `window.sesLockdown.runLockdownPreflightScan()`
returns one of three states:

- **`CLEAN`** — proceeds normally.
- **`BLOCKED`** — renders `LockdownApplicationCheck` (state `"BLOCKED"`)
  with the exact required copy and the list of matched applications'
  calm display names; a "Check again" button re-runs the scan and, if
  clean, resumes the interrupted launch attempt (remembered via a ref,
  never re-derived).
- **`UNAVAILABLE`** — renders the same component in its `"UNAVAILABLE"`
  state. **This is never conflated with a clean scan** —
  `resolvePreflightCheckResult` in `processDetectionLogic.ts` models it
  as a structurally distinct third outcome, not a boolean.

Required copy (verbatim, enforced by
`LockdownApplicationCheck.test.tsx`):

> **Close applications before continuing**
> Tether found applications that may allow screen sharing, remote
> access, recording or debugging. Close the listed applications, then
> check again.

> **Application check could not be completed**
> Tether could not verify that prohibited applications are closed.
> Restart Tether or contact exam support.

Fails **open** only for a packaged build that predates the lockdown
bridge (`typeof window.sesLockdown?.runLockdownPreflightScan !== "function"`)
— every other outcome fails closed.

## During-exam detection (Part 4)

`processDetection.ts`'s `ProcessDetection` class polls at
`TETHER_PROCESS_SCAN_INTERVAL_SECONDS` (default 20s) while an exam is
active, and at the faster `TETHER_LOCKDOWN_RECHECK_SECONDS` (default 5s)
while a `BLOCK_DURING_EXAM` capability is actively covering content —
so a student who has already closed the offending application is never
left staring at the overlay for a full scan interval. The timer is
server-authoritative throughout (this feature never touches it);
autosave and pending drafts are completely unaffected (nothing here
ever calls the autosave queue).

A capability transition is reported to the hosted page **once per
continuous episode** (`diffDetectionEpisodes`), never every poll — the
page (`src/lib/lockdownClient.ts`) then:

- **`DETECTED`**, effective action `BLOCK_DURING_EXAM` or
  `DETECT_AND_RECORD` → a category-specific `IntegrityEvent`
  (`REMOTE_CONTROL_SOFTWARE_DETECTED` / `SCREEN_CAPTURE_SOFTWARE_DETECTED`
  / `DEBUGGING_TOOL_DETECTED` / the generic `PROHIBITED_APPLICATION_DETECTED`
  for VIRTUALIZATION), severity MEDIUM for a genuine block, INFO for a
  policy-downgraded detect-only match.
- **`CLEARED`** → the generic, always-INFO
  `PROHIBITED_APPLICATION_CLOSED`, carrying the computed
  `durationMs` in its metadata.
- `WARN_AND_REQUIRE_CLOSE`-effective capabilities are **never** reported
  here at all — per their own registry documentation they are
  `PlatformAuditLog`-only and never re-cover/re-record content
  reappearing mid-exam.

The live blocking overlay (a main-owned `BrowserWindow`, exactly like
`displayEnforcement.ts`'s own overlay) is shown **only** for the
`BLOCK_DURING_EXAM` subset of what was just detected.

## Remote-session and virtual-machine detection (Part 5)

Checked only for **final examinations**
(`result.exam.assessmentType === "FINAL_EXAMINATION"`), only after the
process scan itself is clean, in the same preflight flow. Uses the
Win32-authoritative `GetSystemMetrics(SM_REMOTESESSION)` signal (never
inferred from screen resolution). If the check cannot be resolved at all
(`remoteSessionSignalSource === "UNAVAILABLE"`), the preflight **fails
closed** — the student sees "Application check could not be completed,"
exactly like a failed process scan. An ordinary non-final Tether exam
never runs this check at all and is completely unaffected (Part 16 item
32).

**False-positive limitations** (documented in the registry's own
`detectionNotes`): a deliberately evasive VM can rewrite its own
BIOS/system-identification strings to defeat the `WINDOWS_SYSTEM_INFO`
signal; `SESSIONNAME` is a plain environment variable and is
theoretically settable before Tether launches (mitigated by treating the
Win32 API result as authoritative whenever it is available).

## Screen-sharing and capture signals (Part 6)

Tether can detect and, for the higher-confidence subset, block **known
applications** (OBS, dedicated recorders) and **known Electron/Chromium
APIs** (its own `desktopCapturer`/permission surface, denied entirely —
see [Electron hardening](#electron-hardening-part-7)). It explicitly
**cannot** prove that no external camera or hardware capture device
(e.g. a phone on a tripod, an HDMI capture dongle) exists — this
boundary is documented, never claimed otherwise anywhere in the product
copy.

## Electron hardening (Part 7)

Confirmed/enforced on every `BrowserWindow` this app creates:

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
  `webSecurity: true` — no remote module (the option was removed from
  modern Electron entirely; never re-introduced).
- **Permission allowlist** (`setPermissionRequestHandler`): only
  `media` (camera, required by Camera Monitoring v1) and `fullscreen`
  are granted; every other permission (geolocation, notifications, MIDI,
  HID, serial, USB, clipboard-read, display-capture outside the approved
  flow) is denied.
- **Navigation**: `will-navigate` denies any URL whose origin does not
  match the configured `SES_BASE_URL` — this is also the structural fix
  for drag/drop of external files/URLs and `file://` escapes, both of
  which surface as a navigation attempt to a non-SES origin.
- **`window.open()`**: `setWindowOpenHandler` always returns
  `{action: "deny"}` — this app has no legitimate use for a second
  window.
- **Downloads**: `session.on("will-download")` cancels every download,
  session-wide.
- **DevTools**: prevented in packaged production builds only
  (`app.isPackaged`) via `webContents.on("devtools-opened")` closing it
  immediately and recording `DEBUGGING_TOOL_DETECTED`; a development
  build (`npm start`) is unaffected, so the team can still debug Tether
  itself.
- **Command-line switches**: `findUnsafeCommandLineSwitch(process.argv)`
  is checked before `app.requestSingleInstanceLock()` even runs —
  `--remote-debugging-port`, `--remote-debugging-pipe`, `--inspect(-brk)`,
  `--js-flags`, `--disable-web-security`,
  `--allow-running-insecure-content`, `--ignore-certificate-errors`,
  `--disable-site-isolation-trials`, and `--allow-file-access-from-files`
  all refuse the process from continuing (`app.exit(1)`).
- **IPC payload validation**: every new handler validates its payload's
  shape before trusting it (`isValidPolicyToggles`, a boolean check on
  `active`, a bounded string-length check on audit-fact `action`) — see
  `lockdownHardeningChain.test.ts` for the structural proof.
- **No arbitrary shell execution / no renderer-controlled file paths**:
  confirmed structurally — `main.ts` never calls `shell.openExternal`,
  and `child_process.exec`/`execSync` are never called anywhere in this
  package; every spawn uses `spawn()` with a static argv array.

## Keyboard and escape controls (Part 8)

`keyboardHardeningLogic.ts`'s pure `classifyKeyboardShortcut` (wired
into `webContents.on("before-input-event")`, unconditionally, dev and
packaged builds alike) blocks: Alt+F4, Ctrl+W, Ctrl+R/F5,
Ctrl+Shift+I/J/C, F12, Ctrl+U, Ctrl+L, Alt+Left/Right, Ctrl+N/T, Ctrl+P,
Ctrl+S. The right-click context menu is unaffected by this feature (it
was already governed by the existing `blockRightClick` exam policy, in
the web app itself — unchanged here). See
[Ctrl+Alt+Delete limitation](#ctrlaltdelete-limitation) for the one
explicitly unpreventable escape path.

## Clipboard and file transfer (Part 9)

The existing browser-level clipboard restrictions (`blockCopyPaste`,
`COPY_ATTEMPT`/`PASTE_ATTEMPT` events, from Secure Exam Mode v1 / Browser-
Level Friction v1) are **unchanged and unaffected** by this pass —
confirmed via the full regression suite (Part 16 item 23). This pass
adds the Electron-level pieces that were genuinely missing: drag/drop of
an **external** file (denied via the same `will-navigate` origin check),
and downloads (denied via `will-download`). File **upload** question
types are completely unaffected — they submit via `fetch`/`XHR` from
inside the page, never through Electron's download mechanism at all, so
exam policy (not this feature) continues to decide whether a question
renders a file-upload control at all (Part 16 item 24).

## Restoration and crash safety (Part 10)

`lockdownLifecycle.ts`'s `LockdownLifecycleManager` implements the
five-state lifecycle (`PREPARING` → `ACTIVE` → `RESTORING` →
`RESTORED`/`RESTORE_FAILED`) as a **total function** over every
(state, event) pair — the same event always produces the same resulting
state, which is what makes `restore()` inherently safe to call any
number of times, from any trigger, including concurrently.

**Tether never modifies any permanent OS-level setting** (no registry
write, no group policy, no persistent keyboard remap) — there is
therefore nothing to snapshot/restore at the OS level. Restoration is
entirely in-process teardown: hiding the process-detection overlay,
stopping the poll, and resetting display enforcement to inactive — both
registered as idempotent `restoreAction`s.

Wired into every documented trigger:

- Normal submission (`handleSubmit`'s success path, immediately — not
  waiting for unmount, since the student may linger on the confirmation
  screen).
- The exam page's own unmount (covers navigating away / a lecturer-
  authorised exit).
- A failed launch or failed attestation (`uncoverOnFailure` in
  `tether-launch/page.tsx`).
- A blocked preflight (never activated in the first place, so
  restoration is a safe no-op).
- A renderer crash (`webContents.on("render-process-gone")`), main-owned
  — never depends on the page's own JS being responsive.
- `window-closed` and `before-quit` (covers a clean app exit and Windows
  shutdown/restart alike).

A restoration failure is recorded as `TETHER_LOCKDOWN_RESTORATION_FAILED`
(`PlatformAuditLog`, never an `IntegrityEvent`) and the resulting
`RESTORE_FAILED` state is available to the page for support guidance.

## Audit and evidence (Part 11)

`IntegrityEvent` is used **only** for a prohibited application actually
appearing during an active exam (`REMOTE_CONTROL_SOFTWARE_DETECTED`,
`SCREEN_CAPTURE_SOFTWARE_DETECTED`, `DEBUGGING_TOOL_DETECTED`,
`PROHIBITED_APPLICATION_DETECTED`) and its resolution
(`PROHIBITED_APPLICATION_CLOSED`). Every other lockdown fact is
`PlatformAuditLog` only, via the fixed allow-list in
`src/lib/lockdownEventClassification.ts`
(`LOCKDOWN_AUDIT_ACTIONS`): preflight blocked, process inspection
unavailable, restoration started/completed/failed, detection-service
failure, an application closed before content opened, a denied
navigation/download/window-open, a remote-session check that failed
closed, a virtual-machine indicator. **Never** an `IntegrityEvent` for:
Tether startup, an ordinary process scan, an application successfully
closed before the exam opened, a technical scan timeout alone, or a
crash-restoration attempt.

Evidence is minimal by construction — `IntegrityEvent.metadataJson`
only ever carries `{capabilityId, category, policyAction}` (detected) or
`{capabilityId, category, durationMs}` (cleared); never a full process
list, command-line arguments, window contents, unrelated application
names, or a screenshot (the `POST /api/tether/lockdown/audit-event`
route's own Zod schema structurally rejects any non-primitive metadata
value, including an array — see its route test).

## Privacy

- No command-line arguments are ever collected — `Get-Process` is
  queried for `ProcessName` only.
- No full process list ever leaves the Electron main process — only
  matched registry capability ids cross the IPC boundary
  (`resolveScanOutcome`'s own signature structurally enforces this).
- No window titles, browsing history, keystrokes, or unrelated
  application content are ever collected.
- No screenshots are captured by this feature.

## Configuration and environment variables

Electron-local operational tuning (`apps/lockdown/src/lockdownConfig.ts`
— read from this process's own environment, effectively fixed at the
shipped default for every packaged install):

| Variable | Default | Range |
|---|---|---|
| `TETHER_PROCESS_SCAN_INTERVAL_SECONDS` | 20 | 10–120 |
| `TETHER_PROCESS_SCAN_TIMEOUT_SECONDS` | 5 | 2–15 |
| `TETHER_LOCKDOWN_RECHECK_SECONDS` | 5 | 2–30 |

Server-resolved security toggles
(`src/lib/tetherLockdownConfig.ts` — served via `GET
/api/tether/lockdown/policy`, relayed to Electron by the hosted page;
**never** read from Electron's own local environment, so a local install
can never silently downgrade its own enforcement):

| Variable | Default | Governs |
|---|---|---|
| `TETHER_BLOCK_REMOTE_CONTROL` | `true` | Remote-control/communication apps + inbound RDP session |
| `TETHER_BLOCK_SCREEN_CAPTURE_TOOLS` | `true` | OBS and dedicated recorders |
| `TETHER_BLOCK_DEBUG_TOOLS` | `false` | Visual Studio, Process Explorer/Hacker, VS Code debug sessions |
| `TETHER_BLOCK_VIRTUAL_MACHINES` | `false` | Hyper-V console, VMware, VirtualBox, Windows Sandbox, VM indicator |

A toggle being `false` never fully silences its category — it only
downgrades `BLOCK_DURING_EXAM`/`WARN_AND_REQUIRE_CLOSE` down to
`DETECT_AND_RECORD` (`resolveEffectiveAction`), never the reverse.
`TETHER_BLOCK_DEBUG_TOOLS`/`_VIRTUAL_MACHINES` default OFF deliberately
— those two categories carry the highest false-positive risk for a
CS-student pilot population (see the registry's own per-capability
notes).

## Student UX (Part 13)

`LockdownApplicationCheck.tsx` (preflight — Part 3) and the main-owned
overlay (during-exam — Part 4) are the two visible states; both are
keyboard accessible (a plain `<button>`/`<a>`, no custom widgets),
`role="status" aria-live="polite"`, never colour-only, calm and
non-accusatory (no "suspicious," "misconduct," "cheat," or similar
language — enforced by `lockdownCapabilityRegistry.test.ts`), and show
only the exact application display name — never a raw executable name,
path, or internal error/stack detail.

## Lecturer visibility (Part 14)

A compact badge (`LockdownBadge`) added to the **existing** lecturer
submissions list (`src/app/lecturer/exams/[id]/submissions/page.tsx`) —
no new dashboard. Backed by a batched (never N+1) resolver,
`src/lib/lockdownStatusRunner.ts`, showing: the most recent detection
(with category, detected/cleared timestamps, duration), "Needs review"
for a currently-open episode, or "Detection unavailable."

## Schema and SQL impact

**Additive only** — five new `IntegrityEventType` enum values
(`REMOTE_CONTROL_SOFTWARE_DETECTED`, `SCREEN_CAPTURE_SOFTWARE_DETECTED`,
`DEBUGGING_TOOL_DETECTED`, `PROHIBITED_APPLICATION_DETECTED`,
`PROHIBITED_APPLICATION_CLOSED`). No new table, no new column —
`PlatformAuditLog.action` is already a plain string, so every
audit-only fact needed no schema change at all. See
`docs/sql/add-tether-windows-lockdown-hardening.sql` and
`docs/migration-ledger.md` (row 16, **NOT YET APPLIED**).

## Failure injection (dev/test only)

`apps/lockdown/src/lockdownFaultInjection.ts` — gated on
`process.env.NODE_ENV !== "production"`, mirroring the web app's own
`src/lib/tetherFaultInjection.ts` convention exactly (one-shot,
explicitly armed, a safe no-op everywhere else). Covers all seven
requested fault kinds: `PROCESS_ENUMERATION_TIMEOUT`,
`PROCESS_ENUMERATION_PERMISSION_DENIED`,
`PROCESS_ENUMERATION_MALFORMED_OUTPUT`, `PROHIBITED_PROCESS_APPEARS`,
`PROHIBITED_PROCESS_DISAPPEARS`, `RESTORATION_FAILURE`, `IPC_TIMEOUT` —
each wired into a real production code path (`windowsProcessList.ts`,
`processDetection.ts`, `lockdownLifecycle.ts`'s constructor-injected
fault hook, and the `lockdown:run-preflight-scan` IPC handler
respectively), never a separate simulated-only mechanism. Never
reachable in a packaged build (no `app.isPackaged`-gated call site ever
wires it in).

## Manual/physical test plan

The 18-step physical test plan (launch clean; launch with each of
TeamViewer/AnyDesk/Quick Assist/OBS/Zoom-or-Teams-sharing/VS Code
debugger; launch under Remote Desktop; start clean then open a
prohibited app; close and recover; DevTools shortcuts; navigation/
external links; downloads/file drops; kill Tether during lockdown;
relaunch and verify restoration; submit normally and verify restoration;
restart Windows after a forced failure; confirm normal desktop behaviour
is restored) requires physical Windows 10/11 hardware with the named
third-party applications actually installed, and a packaged Tether
build — **this environment has neither**, and the plan was **not
executed by the assistant that implemented this feature**. The
automated test suite (`apps/lockdown`'s 232 vitest tests plus the
web app's DB-backed route tests) exercises the equivalent logic for
every step that doesn't require literally installing TeamViewer or
restarting a physical machine — see [Required tests](#schema-and-sql-impact)
above and the commit's own test files. An operator with access to real
Windows hardware should run this plan before any real pilot rollout.

## Rollback

Every server-side change is individually reversible without any schema
rollback (every new enum value is additive and unused until this
feature's application code writes it):

- **Disable the whole feature client-side**: revert
  `apps/lockdown/src/main.ts`'s new IPC handlers and the two page-level
  wiring changes (`tether-launch/page.tsx`, `student/exams/[id]/page.tsx`)
  — every call into `window.sesLockdown`'s new methods is feature-
  detected (`?.`), so an older/reverted Electron build already behaves
  exactly as if this feature never shipped.
- **Disable server-side enforcement without a code revert**: set all
  four `TETHER_BLOCK_*` toggles to `false` — every capability downgrades
  to detect-only, never blocking any real exam.
- **New enum values**: Postgres cannot remove them once added; leaving
  them unused is safe and is the recommended forward-fix.
- **New routes** (`/api/tether/lockdown/policy`,
  `/api/tether/lockdown/audit-event`): safe to leave deployed and
  unused — they require student authentication and write only bounded,
  additive data.

## Known limitations

- Process-name matching cannot distinguish a renamed/replaced executable
  from the real one — a determined student could rename `TeamViewer.exe`
  to evade detection. This is an accepted limitation for a controlled
  pilot (the same limitation every process-name-based tool has, absent a
  kernel-level integrity check, which is explicitly out of scope).
- Zoom/Teams/Discord/VMware/VirtualBox detection cannot distinguish
  "open" from "actively being used against Tether" — deliberately
  softened to `WARN_AND_REQUIRE_CLOSE`/detect-only rather than a hard
  block, to avoid locking out students who merely have the app open for
  unrelated reasons.
- The remote-session/VM check is a best-effort signal (documented
  false-positive/false-negative limitations above) — never a guarantee.
- No lecturer-approval override exists for a lockdown-driven manual
  review, mirroring the same accepted limitation already documented for
  device-change manual review in
  `docs/tether-secure-resume-recovery-v1.md`.

## Unsupported controls

Explicitly `NOT_SUPPORTED` in this pilot (documented, not silently
absent): reliable detection of every possible VNC fork beyond the three
covered; reliable detection of a `node --inspect` debugging session
specifically (vs. ordinary Node.js use) without collecting command-line
arguments, which this pass deliberately does not do; blocking Windows'
own Secure Attention Sequence (see below); preventing capture by
external hardware (see below).

## Ctrl+Alt+Delete limitation

Windows' Secure Attention Sequence is intercepted by the operating
system itself, in kernel/session-manager code, **before** any user-mode
application — Electron included — ever receives the keystroke. There is
no `before-input-event`, no keyboard hook, and no Windows-supported API
available to an ordinary desktop application that can intercept or block
it. This is a hard OS boundary, not a missed implementation detail —
`keyboardHardeningLogic.ts` has no representation of it at all, by
design (see that module's own doc comment).

## External-device/hardware-capture limitation

Tether can detect and block **known applications and APIs** running on
the same Windows installation. It **cannot** detect or prevent an
external camera, phone, or dedicated hardware HDMI-capture device
pointed at the screen from outside the computer — there is no software
signal for this to observe. This boundary is stated plainly here and in
the in-product copy is never implied to be covered.
