# System check — support troubleshooting guide

For institution IT/helpdesk staff supporting students through "Check
this computer" (`/student/system-check`).

## "Secure client: not checked" even inside Tether Secure Browser

Expected on a student's **first-ever** check if they have never started
a Tether-delivered exam attempt before — genuine verification only ever
exists after a real signed launch/attestation flow (see
`docs/tether-system-check-v1.md`, "Why the secure-client check is
usually not checked on a first run"). This is not an error. It resolves
itself the first time the student actually launches an exam through
Tether.

## "This operating system is not currently supported"

Tether Secure Browser (and this check) support Windows only in v1 — see
`docs/tether-system-check-v1.md`, "Windows compatibility statement".
There is no workaround for macOS/Chromebook/Linux/iPad in this release.

## "Your Tether Secure Browser version is out of date"

The installed client is older than `TETHER_MINIMUM_SUPPORTED_VERSION`
(currently 1.3.0). Direct the student to download and install the
latest version from the same installer link used on the Tether launch
page, then retry.

## Camera/microphone checks

| Message | Likely cause | Fix |
| --- | --- | --- |
| Permission was denied | Browser/OS blocked camera or mic access | Check the browser's site-permission settings, and Windows Settings → Privacy → Camera/Microphone, then retry. |
| No device was found | No camera/microphone connected, or driver issue | Connect/reconnect the device; check Windows Device Manager. |
| Being used by another application | Another app (Zoom, Teams, another browser tab) has an exclusive lock on the device | Close other apps using the camera/microphone, then retry. |
| Stream could not be started | Generic driver/OS failure | Restart the browser, then the device, if it persists. |
| Lighting is too low | The frame was too dark to confirm clearly | Move to a better-lit area and retry — this is not a failure, just a caution. |
| Camera visibility is temporarily uncertain | The frame was unusually flat/low-contrast (e.g. a covered lens) | Confirm the lens isn't covered and retry. |

A camera or microphone result never blocks the overall check from
reaching "Ready" — see `docs/tether-system-check-v1.md`, both are
optional checks.

## "Device clock is significantly different from the server"

The student's system clock has drifted enough that a real secure launch
token would likely fail validation. Have them enable automatic date/time
in Windows Settings, then retry.

## "Display setup" is blocked, but only one monitor is connected

Windows Duplicate/Extend display modes are sometimes left configured
even with only one physical monitor attached (a stale display profile).
Have the student open Windows Display Settings and confirm only "PC
screen only" / a single active display is selected, then retry. If the
issue persists with a single physical monitor, this may indicate a
native-topology read failure — see `docs/tether-system-check-v1.md`,
"Known limitations", and escalate with the student's
`getDisplayTopology()` raw classification if diagnostics logging is
enabled (see `docs/lockdown-browser-known-limitations.md`).

## "Your result could not be saved"

The check ran fully and the results shown are accurate for that moment,
but the save request to the server failed (usually a transient network
issue). Retry; if it persists across multiple attempts and multiple
students, escalate — check `GET /api/readiness` and `GET
/api/tether/system-check/config` respond normally.

## A student says the page got stuck

Every individual check has its own timeout (8 seconds) and the run
never halts on one failed step — if the page still appears stuck,
have the student refresh and select **Retry check**; this clears any
lingering camera/microphone state safely (all active media tracks are
stopped on every retry and on leaving the page).
