# System check — privacy explanation

## What is collected

Per completed check, one row is stored (`TetherSystemCheckRun` — see
`prisma/schema.prisma`):

- Which browser/client ran the check (ordinary browser vs Tether Secure
  Browser).
- The reported Tether Secure Browser version, operating system, and
  operating system version, if detected.
- A bounded pass/warning/blocked-and-a-short-reason-code result for each
  of the ten checks (for example `{"camera": {"status": "PASS",
  "reasonCode": "OPERATIONAL"}}`).
- An advisory pointer to a secure-client session id, if one was
  genuinely verified and reused (never a fabricated or another
  student's session — see `docs/tether-system-check-v1.md`).
- When the check was run and when it expires.

Corrective pass: a first-time secure-client verification (see
`docs/tether-system-check-v1.md`, "System-check secure-client
verification") stores one additional row in
`SystemCheckSecureClientVerification` — the same bounded client
type/version/platform fields as above, plus a hashed nonce and
challenge fingerprint used only for replay protection. No hardware
serial number, MAC address, or machine fingerprint is ever derived or
stored — the row's own id is the only "session" identity, scoped to
your account.

## What is never collected

- No photo, image, or video frame from the camera.
- No audio recording from the microphone.
- No raw browser permission objects.
- No authentication tokens, session cookies, or signed launch
  manifests.
- No unnecessarily identifying hardware information — no device serial
  number, MAC address, hardware fingerprint, monitor EDID/serial, or
  similar. The display-topology check reports only a coarse
  classification (for example "single display" or "extended display"),
  reusing the same bounded values already used by the existing
  single-display enforcement feature.

## When the camera/microphone are active

Only while the check is actively running, and only after the student
deliberately selects "Run system check" — never automatically on page
load. All active camera/microphone tracks are stopped as soon as that
one check finishes, when the student navigates away from the page, and
before every retry.

## Who can see a stored result

- The student who ran it (their own history, via the system-check
  page).
- Lecturers and platform admins, but only the aggregate readiness badge
  and timestamp/version described in
  `docs/tether-system-check-lecturer-guide.md` — never camera/microphone
  permission details or any other device information.

## How long it is kept

A result is treated as "current" for `TETHER_SYSTEM_CHECK_VALIDITY_HOURS`
(default 24 hours) and is superseded by the student's next check —
older rows are not automatically deleted in v1, but contain nothing
more sensitive than the bounded fields listed above regardless of age.
