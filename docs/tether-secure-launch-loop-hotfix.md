# Tether Secure-Launch Redirect Loop — P0 Hotfix (v1)

## The defect

A student starting/resuming a Tether-required exam could enter an
infinite `Loading… → Opening your exam in Tether Secure Browser… →
Loading…` cycle, never reaching camera/screen-share/exam-readiness
checks, with "Dashboard" navigation appearing to pull them right back in.

## Root cause

`src/app/student/exams/[id]/tether-launch/page.tsx`'s `runLaunchSequence`
issued a launch manifest, consumed it, and submitted attestation — then
navigated into the exam **unconditionally**, without checking whether
attestation actually resulted in a `VERIFIED` secure-client session.
Consuming a manifest only ever *creates* a session
(`verificationStatus: NOT_CHECKED`); attestation can fail outright, or
succeed but resolve to `ACTION_REQUIRED`/`CANNOT_START` (e.g. a
display-policy violation). Either way, the session never reaches
`VERIFIED`. `GET /api/submissions/[id]`'s own `TETHER_SESSION_REQUIRED`
gate then immediately bounced the student back to `tether-launch`, whose
mount effect auto-resumed the exact same broken sequence — with no
termination condition and no stable error state ever shown.

## Intended secure-launch / readiness order

```
ACCESS CHECK
  → PREFLIGHT (Tether Windows Lockdown scan — process/remote-session)
  → START / RESUME SUBMISSION (POST /api/exams/[id]/start)
  → ISSUE MANIFEST (POST .../secure-client/launch)
  → CONSUME MANIFEST (POST /api/secure-client/launch/[id]/consume)
  → INITIAL (LEGACY) ATTESTATION (POST .../sessions/[id]/attestation)
  → V2 ATTESTATION where applicable (best-effort, additive, never blocks under LEGACY mode)
  → AUTHORITATIVE SERVER VERIFICATION CHECK  ← the step that was missing
  → ONLY THEN navigate into exam content
```

Camera readiness, Entire Screen sharing, and other exam-specific checks
are rendered by the exam content page (`/student/exams/[id]/page.tsx`)
itself, which only ever mounts successfully once the secure-client
session has passed this gate. The student in the reported defect never
reached those checks not because of a sequencing defect, but because the
session-verification step above them was silently failing and looping —
this is the CORRECT order; the fix does not reorder anything.

## The fix

`runLaunchSequence` now calls `checkAuthoritativeSessionVerified(submissionId)`
after attestation, which re-reads the same server-computed
`SecureClientSession.verificationStatus` field (via the existing
`GET /api/submissions/[id]/secure-client/status` endpoint) the real gate
is based on — never a client-derived approximation. Navigation into the
exam happens **only** when that field is exactly `"VERIFIED"`. On
failure, the student sees a stable message ("Tether could not verify
this secure exam session…") with a manual retry button — never another
automatic attempt, never a silent bounce.

Two additional guards close related gaps:
- `unmountedRef` — an in-flight launch attempt started before the
  student navigates away (e.g. clicking "My Exams") can no longer call
  `router.replace` after unmount, fixing the "Dashboard escape" symptom.
- `autoAttemptedRef` — the mount effect's auto-resume of an existing
  `IN_PROGRESS` submission fires at most once per mount, as a defensive
  second line against the same effect re-firing (not the primary fix —
  the primary fix is that a failed launch no longer triggers the
  redirect that caused remounts in the first place).

No security gate was weakened: the fix reads existing authoritative
server state more carefully — it does not change what the server
requires, does not bypass attestation, and does not grant access to any
unverified session.

## Existing IN_PROGRESS submissions

No database intervention is required. Once this fix is deployed, the
next time the affected student opens the exam (manually or via
auto-resume), the SAME `POST /api/exams/[id]/start` idempotently resumes
their existing submission, a fresh manifest/attestation cycle runs, and —
if attestation now succeeds — the page proceeds normally. If attestation
still fails (e.g. a genuine display-policy violation), the student now
sees a stable, actionable error instead of a silent loop, and can retry
or contact support per `docs/tether-pilot-support-runbook.md`.
