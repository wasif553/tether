# Tether Secure Browser v1.7.4 — Pre-exam Readiness + Safe Lockdown Activation

Physical testing of the v1.7.3 release candidate (the sandboxed-preload
bundling hotfix) confirmed the preload fix itself was correct, but surfaced
three further problems:

1. Pre-exam remediation (closing TeamViewer, disconnecting a display) was
   too restrictive — the during-exam process-detection overlay
   (`alwaysOnTop: "screen-saver"`) could obstruct Task Manager even while
   the student was still meant to be freely remediating.
2. `BLOCKED` display decisions were unconditionally reported as
   `ADDITIONAL_DISPLAY_PRESENT` ("Additional display connected"),
   regardless of cause — a normal `active && !ready` loading transition
   and an inconclusive/failed native topology query both showed the exact
   same claim as a genuine second monitor.
3. The exam timer and question content could become active/reachable
   before secure-client attestation and native lockdown activation had
   actually completed.

## The fix: a two-phase lifecycle

```
PRECHECK PASS
    ↓
Begin examination
    ↓
prepare secure submission/session (PREPARING — activatedAt null)
    ↓
attestation VERIFIED
    ↓
fresh native checks (process, remote session, display — read-only)
    ↓
native lockdown ACTIVE confirmed (window.sesLockdown.activateSecureExamLockdown)
    ↓
server activates timed attempt (POST /api/submissions/[id]/activate)
    ↓
timer starts / Question 1 accessible
```

**Phase 1 — Pre-exam readiness.** No question content is fetched, no
submission is created, and no strict during-exam overlay is active.
`src/app/student/exams/[id]/tether-launch/page.tsx`'s `runPrecheck` runs
every mandatory native condition the exam's policy requires (process scan
via `window.sesLockdown.runLockdownPreflightScan()`, remote-session check,
and — new — a read-only display-topology check via
`window.sesLockdown.getDisplayTopology()`). A failure shows a calm,
factual, in-page remediation screen (`LockdownApplicationCheck.tsx`) —
Task Manager, Alt+Tab, and Windows display settings all remain fully
usable. Only once every check passes does an explicit "Ready to begin —
Begin examination" screen appear; precheck becoming clean never
auto-starts the exam.

**Phase 2 — Secure activation.** Selecting "Begin examination" runs
`POST /api/exams/[id]/start` (creates/resumes the submission — for a
gated exam, `activatedAt` stays `null`), the existing manifest issue/
consume/attestation sequence, and `checkAuthoritativeSessionVerified`.
Once verified, `ensureSecureActivation` runs the REQUIRED ordering:

1. `window.sesLockdown.activateSecureExamLockdown({ requireSingleDisplay,
   requireRemoteSessionCheck })` — a new, narrow, purpose-specific IPC
   invoke (`apps/lockdown/src/main.ts`'s `lockdown:activate-secure-exam-lockdown`
   handler). It re-runs the SAME fresh process scan and a read-only
   display-topology check, and only if every check is clean does it
   atomically activate `DisplayEnforcement` (`active:true, ready:true`),
   `ProcessDetection`'s during-exam poll, and `RemoteSessionMonitor` —
   closing the race where TeamViewer or a second display appears in the
   gap between PRECHECK and Begin examination.
2. `POST /api/submissions/[id]/activate` — the authoritative SERVER
   activation. Never trusts a client-supplied boolean; independently
   re-derives eligibility from the SAME `SecureClientSession` verification
   computation `GET /api/submissions/[id]` already uses. Atomically sets
   `Submission.activatedAt` (and resets `startedAt` to the same instant)
   exactly once — idempotent on repeat.
3. Only after both succeed does the page navigate into exam content.

## Server-side content gate

`src/lib/secureClientActivation.ts`'s `isSubmissionContentAccessible` is
the one gate every content-bearing route must pass: `GET
/api/submissions/[id]`, the one-question-at-a-time routes
(`submissionQuestionPayload.ts`'s `loadOneQuestionSubmission`),
`PATCH /api/submissions/[id]/answers`, and `POST
/api/submissions/[id]/submit`. A gated (`TETHER_CLIENT_REQUIRED`/
`SEB_REQUIRED`) submission with `activatedAt === null` gets
`{code: "EXAM_NOT_ACTIVATED"}` — no question text, options, answers, or
deadline. This is what actually prevents Question 1 from ever being
retrievable before activation, not client-side rendering — a direct load
of `/student/exams/[submissionId]` for a PREPARING attempt is blocked by
this same gate and redirected back to `tether-launch`.

## Display blocking-reason taxonomy

`apps/lockdown/src/displayEnforcementLogic.ts`'s `DisplayBlockingReason`:

| Reason | Meaning | Ever reported as `ADDITIONAL_DISPLAY_PRESENT`? |
|---|---|---|
| `POLICY_NOT_READY` | `active && !ready` — a loading transition | Never — not an integrity event at all |
| `ADDITIONAL_ELECTRON_DISPLAY` | `screen.getAllDisplays().length > 1` | Yes |
| `WINDOWS_TOPOLOGY_EXTEND` | native topology classified EXTEND | Yes |
| `WINDOWS_TOPOLOGY_CLONE` | native topology classified CLONE_OR_DUPLICATE | Yes |
| `MULTIPLE_ACTIVE_TARGETS` | native topology classified MULTIPLE_ACTIVE_TARGETS | Yes |
| `TOPOLOGY_CHECK_UNAVAILABLE` | native query ERROR/UNKNOWN — fails closed, but not display evidence | Never — reported as `CLIENT_TECHNICAL_FAILURE` instead |

## Untouched by this pass

`sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`, the
v1.7.3 preload bundling fix, active-exam display/process enforcement
(TeamViewer or a second display appearing AFTER Question 1 is visible
still triggers the existing strict overlay/evidence workflow, unchanged),
fail-closed server verification, and the frozen v1.7.2/v1.7.3 installers.

## Attempt accounting for an unactivated (PREPARING) attempt

A PREPARING submission (`activatedAt: null`) is, and remains, an
ordinary `status: "IN_PROGRESS"` row — this feature never introduces a
new `SubmissionStatus` value. `POST /api/exams/[id]/start`'s pre-existing
idempotency check (`existingInProgress`, unchanged by this pass) already
resumes any `IN_PROGRESS` row for the same student+exam unconditionally,
before ever computing `attemptNumber` or evaluating `canCreateAttempt` —
this is what makes retry-after-activation-failure and close/reopen-later
both resolve to the SAME row, with no second `Submission` ever created.
`attemptsRemaining`/`canCreateAttempt`
(`src/lib/assessmentLifecycle.ts`) count only `finalizedAttemptCount`
(`status !== "IN_PROGRESS"`) — a PREPARING row, being IN_PROGRESS, never
counts against `maxAttempts` merely by existing. An attempt is only ever
"spent" once it reaches a finalized status (SUBMITTED/GRADED), which for
a gated exam requires having passed through activation first (the
content/submit gate — see above). See
src/lib/tetherAttemptAccounting.test.ts for the DB-backed regression
tests proving this end to end (retry after a simulated native-activation
failure, abandon-and-reopen-later, and that a successful activation
still only ever produces exactly one activation write).

## Production rollout order

**Do not deploy any part of this out of order.**

1. **Database migration + historical backfill + zero-downtime default** —
   `docs/tether-preflight-lifecycle-v1.7.4-migration.sql`, applied
   manually via the Supabase SQL Editor (see
   docs/migration-ledger.md's "Deployment procedure" section for this
   file), in its three blocks, strictly in order:
   1. `ADD COLUMN "activatedAt"` (no default — a Postgres volatile
      default set in this same statement would stamp every existing row
      with the migration's own run time instead of preserving history).
   2. Backfill: `activatedAt = startedAt WHERE activatedAt IS NULL`.
      Built into this migration itself — it does not depend on anyone
      remembering to separately run
      `scripts/backfill-submission-activated-at.ts` after deploy. That
      script still exists and remains useful operationally (a dry-run/
      verification tool an operator can re-run at any time to confirm no
      row was left with `activatedAt IS NULL` unexpectedly), but it is
      no longer the primary mechanism.
   3. `ALTER COLUMN "activatedAt" SET DEFAULT CURRENT_TIMESTAMP` — set
      only after the backfill. This is the zero-downtime cutover
      guarantee: for the entire window between this migration and step
      3 below (deploying the new code) — which may be arbitrarily long,
      see step 2 — any Submission row the OLD application code creates
      (its generated Prisma client has no idea this column exists, so
      it never mentions it in the INSERT) is stamped non-null by
      Postgres itself, at insert time, exactly matching pre-v1.7.4
      "created = active" semantics. Without this block, such a row
      would land on `activatedAt IS NULL` — indistinguishable from a
      genuine v1.7.4 PREPARING attempt — and be incorrectly blocked
      (403 `EXAM_NOT_ACTIVATED`) the instant v1.7.4 code goes live, even
      mid-exam for a student who was never near the new PREPARING flow.
      Proven with a real DB-backed test against the disposable database,
      not assumed — see src/lib/tetherActivatedAtCutover.test.ts.
2. **Verify existing production still works** — the OLD (pre-v1.7.4)
   application code is still running at this point; it never reads
   `activatedAt`, and thanks to step 1.3's default, any row it writes
   gets a correct, non-null `activatedAt` automatically. Confirm a
   normal exam start/submit still works exactly as before. Because the
   cutover is now genuinely zero-downtime, this verification window can
   take as long as operationally needed — there is no race to rush
   through before step 3.
3. **Deploy the new web/server v1.7.4 code.** Only after step 1 is
   confirmed applied (verification query 2 in the migration file returns
   0) — deploying first would mean the new code's activation gate reads
   `activatedAt IS NULL` on every historical
   TETHER_CLIENT_REQUIRED/SEB_REQUIRED row and incorrectly blocks
   already-legitimate content.
4. **Publish/serve the v1.7.4 native installer** (the
   `Tether-Secure-Browser-1.7.4-win-x64.exe` this pass built and hashed)
   — only after step 3's server code is live, since the native
   `activateSecureExamLockdown` handshake depends on the new
   `POST /api/submissions/[id]/activate` endpoint existing.
5. **Physical validation** — the acceptance matrix from the prior
   investigation report (TeamViewer preflight, single-display false
   positive, real second-display precheck, Begin-examination timing,
   during-exam TeamViewer/display enforcement).
6. **Only then** make v1.7.4 the normal recommended download/version
   (`TETHER_RELEASE_STATUS`/`TETHER_INSTALLER_DOWNLOAD_URL` — see
   src/lib/tetherReleaseMetadata.ts; both remain at their safe INTERNAL/
   unset defaults until an operator deliberately changes them).

None of steps 1-6 have been performed as part of this pass — this
document and the branch's own code/migration/tests are preparation for
an operator to carry them out deliberately, in this order.
