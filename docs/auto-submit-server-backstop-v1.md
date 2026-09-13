# Auto-Submit Server Backstop v1

## The defect this closes

Physical v1.8.1 QA on a Tether exam found an `IN_PROGRESS` submission whose
deadline had already passed sitting indefinitely `IN_PROGRESS` — the student
saw the attempt as expired, but it never converged to `SUBMITTED`/`GRADED`.

Root cause (see the investigation that preceded this feature): auto-submit
was entirely a **live-client** mechanism — a `setInterval` in
`src/app/student/exams/[id]/page.tsx` that only ever runs while that exact
page is mounted with data already loaded. For a Tether-gated exam, a fresh
Electron process resuming an already-overdue attempt first goes through a
native-lockdown reactivation check (`src/app/student/exams/[id]/page.tsx`'s
pre-load gate) that has no concept of "this attempt's deadline already
passed" — so the timer effect, and therefore auto-submit, could go
unreached entirely. Even when reached, nothing server-side ever backstops a
client that simply never shows up again after the deadline.

## The fix

Two layers, both driven by the same canonical timing logic
(`resolveSubmissionTimingPolicy` / `submissionDeadline` in
`src/lib/assessmentLifecycle.ts` — never a second deadline implementation):

1. **Live client** (unchanged) — the existing timer effect still fires
   `handleSubmit({ systemAutoSubmit: true })` the instant its own
   `remainingSeconds` reads 0, when it is running.
2. **Server backstop** (new) — `shouldServerBackstopFinalize(...)` decides
   whether an `IN_PROGRESS` attempt is overdue and configured to
   auto-finalize (`now >= deadline && autoSubmitOnTimerEnd`), independent of
   any client. Checked in two places:
   - **Primary, immediate**: `POST /api/exams/[id]/start`'s existing-attempt
     resume path — checked before any secure-client reactivation/launch
     decision, so a student (or a fresh Tether process) resuming an overdue
     attempt gets its finalized result immediately, never a reactivation
     handshake for content that no longer exists.
   - **Coarse safety net**: `POST /api/internal/finalize-overdue-submissions`,
     a protected internal endpoint invoked on a schedule (see
     `.github/workflows/finalize-overdue-submissions.yml`) for rows nobody
     happens to read/resume soon after expiry.

Both layers — and the ordinary student `POST /api/submissions/[id]/submit`
route — finalize through the **one** shared mechanism,
`finalizeSubmission()` in `src/lib/submissionFinalization.ts`: the same
advisory lock, fresh in-transaction status re-check, grading,
essay/non-essay status selection, and provenance checkpoint every
finalization has always used. There is no second, independently
re-implemented finalization algorithm.

## What differs by trigger

- **`finalResponses`**: a live client may supply its last on-screen text;
  the server backstop always passes `{}` — it has no browser to ask, and
  must never fabricate content the student never actually saved. Grading
  reads whatever the ordinary ~600ms-debounced autosave already persisted.
- **Post-finalization effects** (`runPostFinalizationEffects`): Canvas
  passback, activity telemetry, and exam-attempt-session teardown run for
  every trigger identically. Request/IP-attributed network evidence only
  ever runs for a genuine student HTTP request (never fabricated for a
  server-triggered finalization, which has no request to honestly
  attribute it to).
- **Audit trail**: a server-triggered finalization additionally writes one
  `PlatformAuditLog` row (`action: "SUBMISSION_SERVER_BACKSTOP_FINALIZED"`)
  in the **same transaction** as the status transition — never a
  fire-and-forget best-effort call — so the audit trail and the status
  transition can never disagree about whether server-triggered
  finalization happened.
- **Source-declaration requirement**: the ordinary submit route still
  blocks a student from finalizing without a required AI-use declaration;
  the server backstop does not enforce this (there is no student to
  prompt) but still writes provenance checkpoints when the policy has them
  enabled at all.

## Scheduling

This project has no pre-existing scheduled-execution infrastructure, and is
on Vercel's Hobby plan, whose Cron Jobs are capped at once per day — not
frequent enough for a primary exam-expiry backstop. The scheduled sweep is
instead triggered by a GitHub Actions workflow
(`.github/workflows/finalize-overdue-submissions.yml`, every 10 minutes,
plus manual `workflow_dispatch`), calling the protected endpoint with a
bearer secret. Required configuration:

- Vercel Production environment variable `OVERDUE_FINALIZATION_SECRET`
- GitHub repository secret `OVERDUE_FINALIZATION_SECRET` (same value)

Neither has been configured automatically — see the deployment steps in
the corresponding implementation report before enabling the schedule in
Production.
