# Tether Secure Exam Recovery and Resilient Autosave v1

**This is bounded recovery and resilient saving. It is NOT offline
examination delivery.** A student may keep answering through a brief
network blip, a failed autosave, a renderer reload, a Tether crash, a
Windows restart, or an interrupted final-submission request — but every
one of those recoveries is re-verified against the server before it
grants anything, nothing is ever silently extended, and there is no mode
in which this system serves exam content without eventually re-confirming
a live, authoritative connection to the server.

Builds on the existing foundation: Tether Secure Browser v1.6.0, Secure
Client Attestation v2 (installation-bound EXAM_SESSION attestation,
LEGACY/DUAL/V2_REQUIRED per-session snapshots), Mandatory Tether Delivery
for Final Examinations, and the immutable `Submission.examPolicySnapshotJson`
timing freeze. See docs/secure-client-foundation-seb-v1.md and
docs/tether-system-check-v1.md for that foundation.

## Contents

1. [Security and data-integrity principles](#security-and-data-integrity-principles)
2. [Recovery-state architecture](#recovery-state-architecture)
3. [Autosave idempotency and revision control](#autosave-idempotency-and-revision-control)
4. [Local pending-save queue](#local-pending-save-queue)
5. [Network interruption behaviour and configuration](#network-interruption-behaviour-and-configuration)
6. [Heartbeat](#heartbeat)
7. [Crash, relaunch and Windows-restart recovery](#crash-relaunch-and-windows-restart-recovery)
8. [Resume token/challenge decision](#resume-tokenchallenge-decision)
9. [Same-device and device-change behaviour](#same-device-and-device-change-behaviour)
10. [Final submission idempotency](#final-submission-idempotency)
11. [Timer authority](#timer-authority)
12. [Camera and display during interruption](#camera-and-display-during-interruption)
13. [Lecturer visibility](#lecturer-visibility)
14. [Audit](#audit)
15. [Database changes](#database-changes)
16. [Privacy](#privacy)
17. [Accessibility](#accessibility)
18. [Failure injection (dev/test only)](#failure-injection-devtest-only)
19. [Student recovery guide](#student-recovery-guide)
20. [Lecturer recovery interpretation guide](#lecturer-recovery-interpretation-guide)
21. [Exam-day support runbook](#exam-day-support-runbook)
22. [Manual physical test plan](#manual-physical-test-plan)
23. [Rollback procedure](#rollback-procedure)
24. [Known limitations](#known-limitations)

## Security and data-integrity principles

- The server is always authoritative for submission state, answer
  revisions, and timing — never the renderer.
- The client can never reset `startedAt` or extend the deadline. Both are
  read from `Submission.examPolicySnapshotJson.timingPolicy`, frozen once
  at attempt start (`src/lib/assessmentLifecycle.ts`), and nothing added
  by this feature writes to either field.
- A recovered session always requires fresh secure-client verification —
  see [Crash, relaunch and Windows-restart recovery](#crash-relaunch-and-windows-restart-recovery).
- A previously verified `SecureClientSession` is never trusted
  indefinitely — see the freshness gate in
  [Recovery-state architecture](#recovery-state-architecture).
- Resume stays bound to the same authenticated user, institution, exam,
  submission, policy snapshot, question order, and question-pool
  allocation — none of these are ever recomputed on relaunch (see
  `POST /api/exams/[id]/start`'s resume branch, unchanged by this
  feature: it always returns the existing `IN_PROGRESS` row).
- A locally stored answer draft (the IndexedDB queue) never authorizes
  exam access by itself — it is pure client-side cache of not-yet-
  acknowledged text, checked against nothing security-relevant.
- A `SYSTEM_CHECK`-purpose attestation never authorizes exam access or
  resume — purpose isolation between `SYSTEM_CHECK` and `EXAM_SESSION` is
  structural (see `src/lib/secureClient/tetherAttestation.ts`) and
  untouched by this feature.
- Ordinary Chrome/Edge remains unable to access Tether-required content —
  the content-exposure gate in `GET /api/submissions/[id]` is unchanged in
  shape, only strengthened (see the freshness gate below).
- Network interruption, application crash, and autosave retry are
  technical events — never IntegrityEvent, never a misconduct signal (see
  [Audit](#audit)).
- The final-examination fail-closed gate
  (`isFinalExaminationPolicyEstablished`, `POST /api/exams/[id]/start`,
  `POST /api/exams/[id]/[id]/start`'s 409 `FINAL_EXAMINATION_TETHER_UNAVAILABLE`)
  is untouched.

## Recovery-state architecture

**One central resolver — `src/lib/tetherRecovery.ts`'s `resolveRecoveryState`.**
Pure, dependency-free, exhaustively unit-tested
(`src/lib/tetherRecovery.test.ts`). Every recovery-status surface (the
student page's banner, `GET /api/submissions/[id]/recovery-status`, the
lecturer submissions list) reads from this ONE function via
`src/lib/tetherRecoveryRunner.ts` (the Prisma-backed wrapper) — nothing
re-derives its own version.

States: `NOT_STARTED`, `ACTIVE`, `TEMPORARILY_DISCONNECTED`,
`RESUME_REQUIRES_TETHER`, `RESUME_REQUIRES_REAUTHENTICATION`,
`RESUME_REQUIRES_FRESH_ATTESTATION`, `MANUAL_REVIEW_REQUIRED`,
`SUBMITTED`, `EXPIRED` — matching the task spec's suggested set exactly.

Inputs are all server-authoritative: submission status, the frozen
deadline (`submissionDeadline(startedAt, timingPolicy.durationMins)`),
the frozen `secureClientPolicySnapshotJson.deliveryMode`, and the current
`SecureClientSession`'s own status/verification/heartbeat fields read
fresh from the database. The only renderer-supplied input is an OPTIONAL
`requestingInstallationId` query parameter, used ONLY for a proactive,
non-authoritative "this looks like a different computer" UI hint — never
for the decision itself (see [Same-device](#same-device-and-device-change-behaviour)).
Nothing renderer-supplied (remaining time, deadline, recovery state,
"current" installation id) is ever trusted for the decision.

### The freshness gate — the actual fix for "trusted indefinitely"

`resolveTrustedTetherVerification` (same file) wraps the existing,
untouched `resolveEffectiveTetherVerification`
(`src/lib/tetherAttestationConfig.ts`, the LEGACY/DUAL/V2_REQUIRED truth
table) with a heartbeat-freshness check
(`isVerificationStillFresh`, `src/lib/secureClient/secureClientSession.ts`).
A session that WAS genuinely verified keeps being trusted only while
contact (`lastHeartbeatAt`, falling back to `startedAt` if none has ever
arrived) is within `heartbeatIntervalSeconds + heartbeatGraceSeconds +
TETHER_OFFLINE_CONTINUE_MINUTES`. Past that combined window, the two real
content-access gates —
`resolveSecureClientLaunchField` (`POST /api/exams/[id]/start`) and the
inline gate in `GET /api/submissions/[id]` — stop trusting the row's
`VERIFIED` value, **even though the database still literally says
`VERIFIED`**. This is the mechanism, not just a UI label, behind "a
previously verified SecureClientSession must not be trusted indefinitely
after a crash or relaunch" — see the DB-backed test "17/19" in
`src/lib/tetherRecovery.routes.test.ts` for the end-to-end proof (a
VERIFIED session's `startedAt`/`lastHeartbeatAt` are backdated past the
window and `GET /api/submissions/[id]` is confirmed to return 403 again).

An ordinary short reconnect (well inside the bounded window) never
crosses this threshold — the student keeps editing, Tether restrictions
stay active, and the recovery state is `TEMPORARILY_DISCONNECTED`, not a
content block.

## Autosave idempotency and revision control

`PATCH /api/submissions/[id]/answers` — see
`src/app/api/submissions/[id]/answers/route.ts`. Backward-compatible:
`clientRequestId`/`clientRevision` are both optional; a caller that omits
them gets the exact previous last-write-wins upsert.

When sent:
- Retrying the SAME `clientRequestId` returns the current row unchanged —
  never a second write, never a duplicate row (the existing
  `@@unique([submissionId, questionId])` constraint already guarantees at
  most one `Answer` row per question either way).
- A `clientRevision` not strictly greater than the row's current
  `Answer.clientRevision` is a no-op — the current row is returned as-is,
  `response` is never regressed.
- The response always includes `acknowledgedRevision`/`acknowledgedRequestId`
  — the authoritative saved state, whether or not THIS request's own
  write actually applied.
- Concurrency: two requests carrying the identical `clientRequestId`
  racing each other still produce exactly one Postgres row (the existing
  `answer.upsert`'s `ON CONFLICT` semantics), and since both carry
  identical content the end state is identical regardless of which
  "wins" — one logical save.
- Cross-submission/cross-student reuse of a `clientRequestId` string
  cannot affect another student's answer: a request id is only ever
  compared against the ONE `Answer` row the request is already
  ownership-checked to touch (`submission.studentId !== session.user.id`
  → 404, before any request-id logic runs) — there is no global
  request-id lookup table.

`POST /api/submissions/[id]/submit` gained the identical pattern for
final submission — see [Final submission idempotency](#final-submission-idempotency).

## Local pending-save queue

`src/lib/pendingSaveQueue.ts` (pure logic — supersession, expiry, bounded
exponential backoff, acknowledgement classification) +
`src/lib/pendingSaveQueueStore.ts` (the ONLY file touching IndexedDB) +
`src/hooks/useResilientAutosave.ts` (the thin React adapter, following
this codebase's existing `useScreenShareLifecycle.ts`/
`useAnswerDevelopmentCapture.ts` convention).

Stores exactly the Part-3-allowed fields — user id, exam id, submission
id, question id, the answer draft text, `clientRequestId`, revision,
queued timestamp, retry count — and nothing else (see
`PendingSaveEntry` and `pendingSaveQueueStore.ts`'s own top-level doc
comment, which is exhaustive about what is and is never stored: no
passwords, tokens, manifests, challenges, private keys, DPAPI material,
signing keys, or camera/microphone data).

- Scoped per authenticated user id + submission id
  (`scopedKey`/IndexedDB composite key) — another OS user account never
  sees this browser profile's IndexedDB at all (standard profile
  isolation); a different application account signed into the SAME
  browser profile is a residual, documented trust boundary identical to
  every other client-side cache a web app already accepts (see
  `pendingSaveQueueStore.ts`'s own doc comment — no weak home-grown
  encryption was invented for this; IndexedDB is treated plainly as local
  application storage, per the spec's own guidance).
- An entry is deleted ONLY after a confirmed server acknowledgement, a
  confirmed final submission (`clearAll()`, called from every
  `res.ok`/finalized branch of `handleSubmit` in the student exam page),
  or retention expiry (`pruneExpired`, `TETHER_PENDING_SAVE_RETENTION_HOURS`).
- A newer revision for the same question always supersedes an older
  unsent one in-place (`shouldSupersede`) — never queued alongside it.
- Survives a renderer reload by construction (IndexedDB persists across
  reloads); the hook's mount effect replays whatever is left for this
  user+submission and immediately attempts to flush it.
- The UI (`src/components/RecoveryStatusBanner.tsx`) distinguishes
  queued/sending/saved/failed/conflict using the approved product
  language — see [Accessibility](#accessibility).
- `save()`'s external contract is unchanged from the raw `fetch` it
  replaced: resolves `true` only once the SERVER has acknowledged — a
  queued-but-unsent draft is never reported as saved.

## Network interruption behaviour and configuration

While offline: Tether restrictions, display enforcement, and camera/
microphone handling all stay exactly as they were (nothing in this
feature touches any of them) — only the autosave path changes, routing
through the queue instead of a bare fetch. The banner shows "Connection
interrupted. Reconnecting" plus the pending count; "Saved" is never shown
again until a real acknowledgement arrives. The exam timer keeps counting
down from the same frozen `deadline` the whole time (see
[Timer authority](#timer-authority)) — connectivity has no effect on it
either way.

Four new, conservative, clamped environment variables
(`src/lib/tetherRecoveryConfig.ts`, documented in full in `.env.example`):

| Variable | Default | Bounds | Purpose |
|---|---|---|---|
| `TETHER_OFFLINE_CONTINUE_MINUTES` | 10 | [2, 30] | How long a verified session's staleness is tolerated before the freshness gate stops trusting it. |
| `TETHER_AUTOSAVE_RETRY_MAX_SECONDS` | 60 | [10, 300] | Ceiling of the client's bounded exponential backoff. |
| `TETHER_PENDING_SAVE_RETENTION_HOURS` | 72 | [1, 168] | How long an unsent local draft survives before being discarded. |
| `TETHER_HEARTBEAT_INTERVAL_SECONDS` | 30 | [15, 120] | Default suggested cadence before a per-exam policy is known — the per-attempt frozen `secureClientHeartbeatIntervalSeconds` remains authoritative once an attempt exists. |

Once the offline-continue window genuinely expires (the freshness gate
above trips), content access is blocked again (`RESUME_REQUIRES_FRESH_ATTESTATION`)
— queued answers are preserved, nothing is silently submitted unless the
frozen `autoSubmitOnTimerEnd`/`allowLateSubmit` policy already says so,
and Tether restrictions are never unlocked.

## Heartbeat

`POST /api/submissions/[id]/session-heartbeat` (already existing, already
called every ~25s by the student exam page) now ALSO touches the current
`SecureClientSession.lastHeartbeatAt` (via the existing `recordHeartbeat`,
awaited so the response is never sent before contact is durably
recorded) — this is the actual fix for `lastHeartbeatAt` previously never
being updated by any real exam-taking flow at all (the dedicated
`POST /api/secure-client/sessions/[id]/heartbeat` route existed but
nothing in the student page ever called it).

Payload gained one optional field, `pendingSaveCount` — never answer
content, never a key/token/manifest/signature. Server behaviour: updates
`lastHeartbeatAt`, self-heals `INTERRUPTED` → `ACTIVE` (existing,
unchanged logic), and — only when `pendingSaveCount > 0` — records a
lightweight `AUTOSAVE_PENDING_COUNT_REPORTED` `SecureClientEvent`
(INFORMATIONAL level; nothing is written when the count is 0, keeping
the common case from generating rows). **No `IntegrityEvent` is ever
created by a heartbeat, missed or not** — confirmed by the DB-backed
test "28/29".

## Crash, relaunch and Windows-restart recovery

The full sequence, end to end:

1. Tether relaunches and re-authenticates the student if needed (existing
   NextAuth session handling, unchanged).
2. The student returns to `/student/exams/[id]/tether-launch`, which
   calls `POST /api/exams/[id]/start` — idempotent, resumes the existing
   `IN_PROGRESS` submission (unchanged).
3. If the recomputed `secureClientLaunch.kind` is
   `REDIRECT_TO_TETHER_LAUNCH` (now correctly the case once the
   freshness gate trips), the student sees "Resume secure examination".
4. The launch page issues+consumes a FRESH signed launch manifest
   (`POST /api/submissions/[id]/secure-client/launch` →
   `POST /api/secure-client/launch/[manifestId]/consume`) — unchanged
   endpoints, but `getOrCreateSessionCore`
   (`src/lib/secureClientRunner.ts`) now behaves differently: if a
   non-terminal session already exists for this submission, it is
   **superseded**, never reused —
   `status: "ENDED"`, `endedAt`, `endReason: "SUPERSEDED_BY_RELAUNCH"`,
   PLUS the new `closedAt`/`closeReason` fields (distinct from a
   student-initiated `.../end`, which sets only the first pair). A
   genuinely fresh session is created —
   `verificationStatus: "NOT_CHECKED"`, `installationAttestationVerified: false`,
   `recoveryOfSessionId` pointing at the superseded row. A best-effort
   `TETHER_SECURE_RESUME_INITIATED` audit entry is written.
5. A fresh, purpose-bound `EXAM_SESSION` challenge is issued
   (`POST /api/tether/exam-session/attestation/challenge`, unchanged) for
   the NEW session.
6. Fresh installation-bound attestation runs
   (`POST /api/tether/exam-session/attestation/verify`,
   `verifyExamSessionAttestation`) — the full existing 20-point checklist,
   PLUS a new check (see [Same-device](#same-device-and-device-change-behaviour)).
7. Once verified, `Submission.resumeCount` increments and `lastResumedAt`
   is set — but ONLY via the calling route
   (`POST /api/tether/exam-session/attestation/verify`), never inside
   `verifyExamSessionAttestation` itself, which deliberately keeps its
   existing structural guarantee of never writing to `Submission` (see
   that file's own top-level doc comment). A
   `TETHER_SECURE_RESUME_COMPLETED` audit entry is written.
8. Exam content is restored only once this fresh session satisfies the
   snapshotted attestation requirement — the unchanged content-exposure
   gate in `GET /api/submissions/[id]`.
9. The pending-save queue (already replayed on mount) finishes flushing
   idempotently against the now-reachable server.
10. The original timer continues uninterrupted — nothing above ever
    touches `startedAt`, `examPolicySnapshotJson`, `questionOrderJson`, or
    any pool-allocation field.

Never reset by any of this: `startedAt`, the deadline, `timingPolicy`,
`questionOrderJson` (question order + pool allocation + randomised MCQ
option order all live in this one field, untouched), the exam/AI-
assistance/screen-share/answer-provenance/secure-client policy snapshots,
`Answer` revision history, and every prior `IntegrityEvent`/audit record.
Confirmed by the DB-backed tests "13/14" and "10/11/12/38".

## Resume token/challenge decision

**No new token type was introduced.** The existing signed
`SecureLaunchManifest` (server-issued, short-lived, single-use via a
`nonceHash` unique constraint, bound to
institution/exam/submission/policy-hash) already satisfies every property
Part 7 asks for a dedicated resume token to have, and the existing
purpose-bound `EXAM_SESSION` attestation challenge already satisfies
"initiates the fresh secure-client verification flow, never
independently authorizes content" — reusing both, unmodified, is
strictly simpler and avoids a second, parallel credential type with its
own trust surface. This was a deliberate design decision, not an
oversight — see `getOrCreateSessionCore`'s doc comment in
`secureClientRunner.ts`.

## Same-device and device-change behaviour

Two layers, defense in depth (matching this codebase's existing pattern
for display-policy enforcement — a proactive UI hint plus a separate,
authoritative server gate):

- **Authoritative**: inside `verifyExamSessionAttestation`
  (`src/lib/systemCheck/tetherAttestationRunner.ts`), when the session
  being attested has `recoveryOfSessionId` set, the superseded session's
  own `clientInstallationId` is compared against the installation
  actually attempting THIS attestation. A mismatch returns
  `DEVICE_CHANGE_DETECTED` (409) — verification is refused, nothing is
  granted, and a `TETHER_SECURE_RESUME_DENIED_DEVICE_CHANGE`
  `PlatformAuditLog` entry is written. **Never an `IntegrityEvent`** — a
  device change is a technical/administrative fact, not a misconduct
  signal.
- **Proactive UI hint**: `resolveRecoveryState` accepts an optional
  `requestingInstallationId` (a client claim — see its own doc comment);
  when it differs from the current session's bound installation, the
  state is `MANUAL_REVIEW_REQUIRED` and
  `GET /api/submissions/[id]/recovery-status` also writes a
  `TETHER_DEVICE_CHANGE_RECOVERY_BLOCKED` audit entry, so the student
  never even attempts the doomed attestation. This is read-only and
  confers no trust by itself.

The exact message: *"This examination was started on another registered
computer. Contact your lecturer or exam support."* — no broad lecturer-
approval UI was built (none existed to reuse safely within this task's
scope); a lecturer can still see `Manual review required` on the
submissions list (see [Lecturer visibility](#lecturer-visibility)) and
follow up directly.

A revoked installation cannot attest at all (existing, unchanged
`INSTALLATION_NOT_ACTIVE` check, confirmed rejecting even a recovery
attempt in test "23"). The SAME installation may always resume after
completing fresh verification — nothing about "same device" requires any
special-casing beyond the ordinary attestation checklist succeeding
again.

## Final submission idempotency

`POST /api/submissions/[id]/submit` gained an optional
`submissionRequestId`. The pre-existing idempotency machinery (a
Postgres advisory lock keyed on the submission id, a fresh in-transaction
status re-check, and a conditional `where: { status: "IN_PROGRESS" }`
update) remains the real correctness guarantee — unmodified. What's new:

- The first request whose transaction actually transitions the
  submission is the one that gets to write
  `Submission.finalSubmissionRequestId` — every subsequent
  duplicate/retry/timeout-driven resend, whether or not it carries the
  matching id, still returns the SAME `ALREADY_FINALIZED` (200) result it
  always did.
- When a resend's `submissionRequestId` matches the one that already
  finalized the submission, a distinct
  `TETHER_IDEMPOTENT_FINAL_SUBMISSION_REPLAY_RESOLVED` audit entry is
  written (Part 13) — never a second grading pass, never duplicate
  evidence/audit records for the grading itself.
- The client (`handleSubmit` in the student exam page) never shows
  "Submission received" until `res.ok` — and on a network failure (which
  may or may not mean the server actually committed), it shows "Checking
  submission status..." and re-queries `GET /api/submissions/[id]`
  (Part 9: "a timeout after server commit can be resolved by querying
  submission status") rather than assuming failure.
- Pending local drafts (`resilientAutosave.clearAll()`) are cleared ONLY
  once a submission is confirmed finalized — covering the fresh-submit
  path, the already-finalized-on-retry path, and the
  timeout-then-confirmed-via-GET path identically.
- A submitted attempt never reopens — unchanged; confirmed by test "32".

## Timer authority

The countdown was already architecturally sound: the deadline is
server-computed once, frozen in
`Submission.examPolicySnapshotJson.timingPolicy`
(`resolveSubmissionTimingPolicy`, `src/lib/assessmentLifecycle.ts`), and
every tick recomputes `remainingSeconds(deadline, now)` fresh from the
client's own wall clock — so there is no accumulated-drift bug to fix,
and a lecturer editing `Exam.durationMins`/`secureSettings` after an
attempt starts already never touches an in-progress attempt (confirmed
in `docs/secure-client-foundation-seb-v1.md` and every existing timing-
policy test). What this feature adds: `refreshRecoveryStatus()` (student
exam page) re-fetches the authoritative `deadline` from
`GET /api/submissions/[id]/recovery-status` whenever the heartbeat starts
failing, so a resumed/recovered attempt's displayed countdown is always
re-grounded in a fresh server read rather than only ever trusting the
value fetched once at page load. No client clock can extend time; no
reconnect, crash, or relaunch resets `startedAt` or the deadline (see the
DB-backed tests). Late-submit acceptance still follows the frozen
`allowLateSubmit`/`autoSubmitOnTimerEnd` policy, unchanged.

## Camera and display during interruption

Verified, not modified: camera detection and display enforcement run
entirely client-side (local inference / the Electron main process) and
were already fully decoupled from network state before this feature —
the existing `online`/`offline` listeners in the student exam page only
ever fired `NETWORK_OFFLINE`/`NETWORK_ONLINE` telemetry, never
paused/resumed camera or display logic, and this feature's own new
`offline`/`online` listeners (for the autosave banner) are additive,
parallel, and equally inert with respect to camera/display. A crash/
relaunch always runs a fresh attestation (see above), which is itself
the "fresh camera/display preflight" the spec asks for. No new
`IntegrityEvent` path was added anywhere in this feature — confirmed
across every DB-backed recovery test (`integrityEvents` count assertions
after heartbeats, session supersession, and device-change denial all
assert exactly 0).

## Lecturer visibility

A compact `RecoveryBadge` on the existing lecturer submissions list
(`src/app/lecturer/exams/[id]/submissions/page.tsx`), backed by a batched
(never N+1) helper —
`resolveExamSubmissionsRecoveryStatuses` in `src/lib/tetherRecoveryRunner.ts`
— added to the existing `GET /api/exams/[id]/submissions` response as a
new `recovery` field per row. Shows exactly: Active / Connection
interrupted / Resumed / Submitted / Manual review required, plus a
tooltip with last server contact, resume count, and pending-save count
(only when a recent, fresh report exists — otherwise omitted, never
shown as a stale/misleading zero). Never exposes local answer contents,
tokens, public keys, signatures, installation secrets, or stack traces.
No large exam-operations console was built.

## Audit

`PlatformAuditLog` actions added, all best-effort (never allowed to fail
the request that triggered them):

| Action | Where |
|---|---|
| `TETHER_SECURE_RESUME_INITIATED` | `getOrCreateSessionCore` — a non-terminal session is superseded by relaunch. |
| `TETHER_SECURE_RESUME_COMPLETED` | `POST /api/tether/exam-session/attestation/verify` — the superseding session's FIRST successful attestation. |
| `TETHER_SECURE_RESUME_DENIED_DEVICE_CHANGE` | `verifyExamSessionAttestation` — a different installation attempted the recovery. |
| `TETHER_DEVICE_CHANGE_RECOVERY_BLOCKED` | `GET /api/submissions/[id]/recovery-status` — the proactive UI-hint check flagged a mismatch. |
| `TETHER_IDEMPOTENT_FINAL_SUBMISSION_REPLAY_RESOLVED` | `POST /api/submissions/[id]/submit` — a resend matched the request id that already finalized the submission. |

`IntegrityEvent` is never created for: network disconnection, Tether
crashing, a renderer reload, a student relaunching, an autosave retry, or
a missed heartbeat — every one of these is exercised directly by the
DB-backed test suite.

## Database changes

Additive only — see `docs/sql/add-tether-secure-resume-recovery.sql`
(NOT applied by this change; Preview and Production share one Supabase
database, see docs/migration-ledger.md).

- `SecureClientSession`: `closedAt`, `closeReason`, `recoveryOfSessionId`
  (self-relation, `onDelete: SetNull`).
- `Submission`: `resumeCount` (default 0), `lastResumedAt`,
  `lastAutosaveAcknowledgedAt`, `finalSubmissionRequestId` (unique).
- `Answer`: `lastClientRequestId`, `clientRevision`.

No new table — a dedicated idempotency/recovery-session model was
considered (Part 14 suggests it) but rejected: the additive columns above
are sufficient, smaller, and keep every read colocated with the row it
describes (no extra join for the hot autosave/heartbeat paths). Apply
**after** every migration file already recorded in
docs/migration-ledger.md, in particular
`docs/secure-client-foundation-seb-v1-migration.sql` (the new
`recoveryOfSessionId` foreign key targets that same table). See the SQL
file's own header for the full pre/post-verification queries and
execution order; see docs/migration-ledger.md for this project's general
manual-SQL discipline. **Not applied as part of this change** — a human
operator applies it via the Supabase SQL Editor after review, then
records the date in the ledger.

## Privacy

Never stored by this feature: camera/microphone recordings, screenshots
taken solely for recovery, full browser-state snapshots, private keys,
authentication tokens, full signed manifests, unnecessary IP/network
identifiers, or raw IndexedDB database dumps. The local pending-save
queue's own privacy posture is documented in full in
[Local pending-save queue](#local-pending-save-queue) and
`pendingSaveQueueStore.ts`'s own doc comment — plain (unencrypted)
IndexedDB, bounded retention, per-user+submission scoping, cleared on
confirmed save/submission/expiry.

## Accessibility

`src/components/RecoveryStatusBanner.tsx`: `role="status"
aria-live="polite"` (screen-reader users hear state changes without
polling), never colour-alone (every state has distinct wording, not just
a colour swap), no flashing/pulsing animation (instant text swaps only),
a keyboard-reachable "Retry now" button (`focus:outline`) for
failed/resume states, and plain-language copy throughout — see
[Product language](#student-recovery-guide) below. Focus is never
programmatically stolen on reconnect (the banner mounts/updates in place,
never a modal). Local pending changes ("Changes waiting to save") are
always worded distinctly from confirmed server saves ("Saved").

## Failure injection (dev/test only)

`src/lib/tetherFaultInjection.ts` — gated on
`process.env.NODE_ENV !== "production"` AND a defined `window` (so it is
unreachable in Preview or Production builds, and a safe no-op in every
server-side/Node test context — see its own doc comment). Covers all ten
requested fault kinds: `AUTOSAVE_TIMEOUT`, `AUTOSAVE_HTTP_500`,
`CONNECTION_OFFLINE`, `CONNECTION_RESTORED`, `STALE_AUTOSAVE_RESPONSE`,
`DUPLICATE_AUTOSAVE_REQUEST`, `FINAL_SUBMIT_TIMEOUT_AFTER_COMMIT`,
`RENDERER_RELOAD`, `STALE_SECURE_CLIENT_SESSION`,
`EXPIRED_RESUME_CHALLENGE` — wired into `useResilientAutosave`'s send
path for the autosave-related kinds (`consumeFault(...)` checks before
each attempt); the remaining kinds are documented hooks for manual/E2E
scripts rather than already-wired automatic triggers (see
[Known limitations](#known-limitations)).

## Student recovery guide

If your connection drops during an exam:

- Keep typing. Your Tether restrictions (fullscreen, camera, display
  checks) stay active the whole time — this is expected, not an error.
- You'll see **"Connection interrupted. Reconnecting"** with a count of
  changes waiting to save. This is normal for a brief Wi-Fi drop.
- Once your connection returns, queued changes are sent automatically —
  you don't need to do anything. The banner will show **"Saved"** once
  the server confirms.
- Your exam timer never stops and never gets extra time added for a
  disconnection — it keeps counting down from your original start time.

If Tether crashes or you have to restart your computer:

- Reopen Tether and sign back in if asked.
- You'll see **"Resume secure examination"** — select it.
- Tether will run a **"Recovery check"** (a fresh verification, just like
  when you first started) before your exam content reappears. This is
  expected — it does not mean anything is wrong.
- Your timer continues from where it was — it does not restart.
- Your saved answers, question order, and (if your exam uses question
  pools) which questions you were given are all exactly as they were.

If you submit and aren't sure it went through:

- You'll see **"Checking submission status"** rather than a confusing
  error. Wait for it to resolve rather than repeatedly clicking submit.
- Once the server confirms, you'll see **"Submission received."** A
  submission can never be un-submitted or reopened by resubmitting.

If you see **"This examination was started on another registered
computer. Contact your lecturer or exam support"** — this means Tether
detected you're trying to resume from a different computer than the one
your attempt is currently bound to. **Do not attempt to sign in on the
original computer to bypass this — contact your lecturer or exam
support**, who can advise on next steps.

## Lecturer recovery interpretation guide

On the submissions list, a compact badge shows each student's recovery
status:

- **Active** — no interruption on record.
- **Connection interrupted** — the student's heartbeat is currently
  overdue but still within the bounded recovery window; this is a
  technical blip, not evidence of anything.
- **Resumed** — the student's attempt survived a crash/relaunch and
  completed fresh verification at least once. This is expected recovery
  behaviour, not a flag to investigate by itself.
- **Manual review required** — a DIFFERENT registered computer attempted
  to resume this attempt and was blocked. This is the one status worth a
  direct follow-up with the student — hover the badge for the last
  server contact time, resume count, and (if recently reported) pending-
  save count.
- **Submitted** — finalized; cannot reopen.

None of these statuses are, by themselves, evidence of misconduct — a
disconnection, a crash, or a resume is a technical event. Treat "Manual
review required" as a conversation starter with the student, not a
verdict.

## Exam-day support runbook

1. **Student reports being stuck on "Connection interrupted"** — ask them
   to check their own network connection first; the system retries
   automatically and needs no action once connectivity returns. Confirm
   via the lecturer badge whether the server is still receiving
   heartbeats at all.
2. **Student's Tether crashed or their computer restarted** — reassure
   them this is a supported, expected scenario. Walk them through:
   reopen Tether → sign in → "Resume secure examination" → wait for the
   recovery check to complete. Their timer and answers are safe.
3. **Student sees "This examination was started on another registered
   computer"** — confirm which computer they intend to use for the rest
   of the exam. If they genuinely need to switch computers (e.g. their
   original machine failed), there is no built-in lecturer-approval
   override in this release (see [Known limitations](#known-limitations))
   — escalate per your institution's existing exceptional-circumstances
   process; do not attempt to work around this by having the student sign
   in on the original computer if it is unavailable.
4. **Student worried their submission didn't go through** — check the
   submissions list: `Submitted`/`GRADED` status is authoritative
   regardless of what the student's own browser showed them. A duplicate
   click or a lost network response never creates a duplicate grade or
   reopens the attempt.
5. **A final examination cannot resume at all, for every student** —
   check whether Tether availability itself has been disabled
   (`TETHER_CLIENT_REQUIRED_DISABLED`) or the attestation mode changed
   unexpectedly (`TETHER_EXAM_ATTESTATION_MODE`) — this feature does not
   change either of those existing kill switches.

## Manual physical test plan

**Chrome (ordinary browser):**
1. Attempt to open an in-progress Tether-required exam directly in
   Chrome — confirm secure content stays blocked and the student is
   guided to open Tether instead.
2. Confirm a submitted exam cannot be reopened via Chrome either.

**Tether — full crash/recovery walkthrough:**
1. Start a final examination.
2. Answer several questions.
3. Disconnect the network for 2–5 minutes; continue editing — confirm
   changes show as "waiting to save".
4. Reconnect — confirm queued saves receive acknowledgements ("Saved").
5. End Tether via Task Manager.
6. Relaunch Tether, sign in again if prompted.
7. Confirm "Resume secure examination" appears, and resume completes a
   fresh secure-client verification.
8. Confirm the timer continued from the original attempt (not reset).
9. Confirm previously saved answers are all present.
10. Confirm question order is unchanged.
11. Confirm question-pool allocation (if used) is unchanged.
12. Interrupt a final submission (e.g. kill the network mid-request);
    relaunch and confirm the authoritative submitted state is correctly
    reported either way.
13. Restart Windows entirely during a test attempt; repeat the recovery
    walkthrough above.
14. Revoke the installation (Manage registered computers) and confirm
    resume is blocked.
15. Attempt recovery from a second registered computer and confirm
    "Manual review required" / the exact student-facing message appears.

This plan requires physical hardware/network control and packaged Tether
builds this environment does not have — it was not executed by the
assistant that implemented this feature; the automated DB-backed test
suite (`src/lib/tetherRecovery.routes.test.ts`) exercises the equivalent
server-side logic for every step above that doesn't require a literal
network cable or Windows restart.

## Rollback procedure

All server-side changes in this feature are individually reversible
without any schema rollback, since every new column is nullable/defaulted
and every code path treats a missing value as "no recovery history on
record" (never an error, never a security-relevant default):

- **Disable resilient autosave client-side**: revert
  `src/app/student/exams/[id]/page.tsx`'s `saveAnswer`/`flushAnswerNow`
  to call `fetch` directly instead of `resilientAutosave.save` — the
  server-side idempotency fields on `Answer` simply go unused.
- **Disable the freshness gate**: the two call sites in
  `POST /api/exams/[id]/start` and `GET /api/submissions/[id]` can revert
  to calling `resolveEffectiveTetherVerification` directly instead of
  `resolveTrustedTetherVerification` — this exactly restores the
  pre-feature (indefinite-trust) behaviour.
- **Disable session supersession**: `getOrCreateSessionCore` in
  `secureClientRunner.ts` can revert to its prior unconditional-reuse
  branch.
- **Database**: see `docs/sql/add-tether-secure-resume-recovery.sql`'s
  own "Rollback" section — every new column can be dropped independently;
  the preferred practical rollback (per this project's established
  convention for additive, opt-in-by-construction columns) is simply not
  relying on the new behaviour rather than dropping columns.

## Known limitations

- **No dedicated resume-token type** — intentional; see
  [Resume token/challenge decision](#resume-tokenchallenge-decision).
- **No lecturer-approval override for a genuine device change** — Part 8
  explicitly asked for this to be skipped unless a narrow existing
  mechanism could be reused safely; none existed. A student who
  genuinely needs to switch computers mid-exam has no in-product path in
  this release — see the [runbook](#exam-day-support-runbook).
- **`apps/lockdown` (the Electron Tether client) was not modified** — no
  packaged-behaviour change, so v1.6.0 is unchanged and no installer was
  rebuilt (see the implementation report's "Electron changes" section).
  The client-side heartbeat/resume flow works today because the *web
  app* (which Tether loads directly, per its own architecture) already
  drives it — nothing Electron-specific was required for this pass.
- **Failure injection is wired into autosave sends only** — the other
  documented fault kinds (final-submit timeout, renderer reload, stale
  session, expired resume challenge) are defined and safely no-op outside
  dev/test, but are hooks for a future manual/E2E script rather than
  already-triggering automatic injections in this pass.
- **Camera-availability is not a distinct EXAM_SESSION attestation
  check** — display topology is (`SINGLE_DISPLAY_REQUIRED`), but this
  codebase's v2 attestation checklist does not include a camera-required
  check at that layer; camera enforcement remains a separate, existing,
  client-side concern (Camera Monitoring v1). Part 18's item 27
  ("required camera failure blocks resume") is therefore not applicable
  as a distinct server-side gate — it was not fabricated into this test
  suite.
- **The freshness gate's default heartbeat bounds in
  `POST /api/exams/[id]/start`** use the global default constants (not
  the exact per-exam configured cadence) — see
  `resolveSecureClientLaunchField`'s own doc comment for why (that
  function only receives `deliveryMode`, not the full frozen policy) and
  why the imprecision is bounded and acceptable
  (`TETHER_OFFLINE_CONTINUE_MINUTES`'s 2-minute floor dominates). The
  `GET /api/submissions/[id]` gate uses the exact per-attempt policy.
- **Manual physical hardware/Windows-restart/network-cable testing** (Part
  21) was not executed — see that section's own note.
