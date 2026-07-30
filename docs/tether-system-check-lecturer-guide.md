# System check — lecturer interpretation guide

## Where you see it

The submissions list for an exam (`/lecturer/exams/[id]/submissions`)
shows a small badge next to each student's row, next to the existing
Canvas grade-passback status: **Not checked**, **Ready**, **Ready, with
warnings**, or **Not ready**. Hovering the badge shows when the check
was completed and the student's reported Tether Secure Browser version.

## What this tells you — and what it doesn't

A system-check result is a **technical readiness snapshot**, taken by
the student, of their own computer at some point in time — it is not
tied to this specific exam, and it is never evidence of anything about
the student's conduct.

- It does **not** mean the student's exam attempt is currently secured
  by that result — the real exam-start verification (a verified Tether
  Secure Browser session, live display enforcement, camera/microphone
  checks) runs independently every time a student actually starts an
  exam, regardless of any stored system-check record.
- It does **not** update once an exam attempt is in progress — it
  reflects whenever the student last ran the check, which could be
  before, well before, or (if your institution's setting requires it)
  shortly before this attempt started.
- A "Not checked" or "Not ready" badge is **not** a sign of anything
  suspicious. It usually just means the student hasn't run the check
  yet, or ran it in an ordinary browser rather than Tether Secure
  Browser (which cannot produce a "Ready" result at all — see
  `docs/tether-system-check-v1.md`).

## What you can do with it

Use this as an early, informal signal — for example, following up with
a student who shows "Not ready" a day before a final exam, so they have
time to resolve it. It is not a gate you configure per-exam; whether it
blocks exam start at all is a single institution-wide setting
(`TETHER_SYSTEM_CHECK_MODE`) your platform administrator controls.

## What you never see here

Camera or microphone **permission details**, any image or recording, or
any other device information beyond what's listed above. If a student's
camera or microphone check failed, you will never see why beyond the
aggregate readiness badge — the same privacy boundary that applies to
the student applies to what is ever surfaced to you.
