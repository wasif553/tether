# Screen-share Evidence Mode v1

An optional, opt-in exam policy that asks a student to share their
entire display for the duration of an attempt, and records defensible
review signals about that share's lifecycle. **This is an
integrity-review feature, not an automatic cheating detector.**
Interruptions and unusual activity are never automatically treated as
misconduct — the lecturer/institution remains the final decision-maker.
Disabled (`OFF`) by default; a lecturer must explicitly enable it per
exam.

## What this feature does

- Requires (`REQUIRED` mode) `getDisplayMedia()` entire-screen sharing,
  started by direct student action, before the attempt can begin.
- Monitors the share's lifecycle (started/interrupted/restored/
  permission-denied/unavailable/surface-rejected) and records each
  transition as an `IntegrityEvent`.
- Optionally (a separate, nested setting) captures low-frequency,
  bounded still frames of the shared screen to the existing private
  evidence-storage system, for lecturer review only.
- Shows a lecturer a lifecycle timeline and, where enabled, evidence
  thumbnails, with an explicit human-review disclaimer.

## What this feature explicitly does NOT do (non-goals)

No continuous recording. No microphone or system-audio capture. No OCR,
no external vision APIs, no AI content classification of frames, no
process/app inspection or OS-level lockdown. No automatic determination
that a prohibited application is open. No claim that the browser can
force a particular share selection, or that screen sharing can detect a
separate physical device. No native lockdown browser. No multi-monitor
guarantee beyond what the browser itself reports. No automatic
misconduct decision, ever — a single interruption never crosses into
"high" severity (see "Audit treatment" below), and a repeated pattern
only ever *contributes* to the existing explainable risk model, exactly
like every other integrity signal in this repo.

## Architecture

```text
Lecturer enables policy (secureExam.ts settings)
      │
      ▼
Attempt start (POST /api/exams/[id]/start)
      │  buildScreenSharePolicySnapshot() — clamps to safe server bounds
      ▼
Submission.screenSharePolicySnapshotJson  (immutable for this attempt)
      │
      ▼
Student pre-exam gate (student/exams/[id]/page.tsx)
      │  explains collection BEFORE requesting permission
      │  getDisplayMedia() only from a direct click
      ▼
useScreenShareLifecycle() hook  ── pure state machine: screenShareLifecycle.ts
      │  track ended/muted/unmuted, permission denied, surface rejected
      ├──► POST /api/submissions/[id]/integrity-events   (lifecycle events)
      └──► POST /api/submissions/[id]/screen-evidence     (evidence frames)
                     │  atomic reservation, rate limiting, MIME/size checks
                     ▼
            IntegrityEvidenceAsset (kind = SCREEN_SHARE_EVIDENCE_FRAME)
                     │
                     ▼
          Lecturer evidence review (lecturer/submissions/[id]/evidence)
          — timeline + thumbnails + policy-at-time-of-attempt + disclaimer
```

Pure/impure split, consistent with the rest of this repo: the state
machine, policy math, and evidence-validation rules live in
dependency-free `src/lib/*.ts` modules with no DOM/Prisma/Next imports
(`screenSharePolicy.ts`, `screenShareLifecycle.ts`,
`screenShareEvidence.ts`), unit-tested directly with no mocking. DOM
access (`getDisplayMedia`, `MediaStreamTrack` listeners, canvas capture)
lives entirely in `src/hooks/useScreenShareLifecycle.ts` — the first
hook this repo has needed, mirroring the camera lifecycle hook's
generation-guard pattern for invalidating stale async work after a
stream restart/stop.

## Policy (`src/lib/screenSharePolicy.ts`)

A strongly-typed enum, not a bare boolean — `screenShareMode: "OFF" |
"REQUIRED"` — because a future version may add a non-blocking
"encouraged" tier, and a bare boolean would not extend cleanly.

```text
screenShareMode                       OFF | REQUIRED           default OFF
screenShareCaptureEvidence            boolean                  default false
screenShareEvidenceIntervalSeconds    30–300                   default 60
screenShareMaxEvidenceFrames          1–50 (hard max)          default 20
```

`clampScreenShareEvidenceIntervalSeconds()` /
`clampScreenShareMaxEvidenceFrames()` enforce these bounds on every
write path (lecturer settings save, and defensively again inside
`buildScreenSharePolicySnapshot()`) — a malicious or buggy client can
never request an interval below 30s or a frame count above the hard
max of 50.

**Immutable per-attempt snapshot** — the same pattern as
`examPolicySnapshotJson`/`aiAssistancePolicySnapshotJson`:
`buildScreenSharePolicySnapshot()` copies the exam's current
`screenShare*` settings into `Submission.screenSharePolicySnapshotJson`
once, at attempt start. Every later request for that attempt reads
`parseScreenSharePolicy()` on the STORED snapshot, never the exam's live
settings, so a lecturer editing the policy mid-exam never affects an
attempt already in progress. A null/missing snapshot — every submission
created before this feature, or any exam that never configured it — is
always treated as `DISABLED_SCREEN_SHARE_POLICY` (`mode: "OFF"`), and a
malformed stored snapshot falls back to the same safe default rather
than throwing.

`isScreenShareRequired()`, `isScreenShareEvidenceEnabled()`,
`hasReachedMaxEvidenceFrames()`, `isEvidenceCaptureDue()` (client-side
interval pacing), `minServerCaptureGapMs()` /
`isWithinMinCaptureGap()` (server-side duplicate-capture guard,
independent of what the client claims its own pacing is), and
`isWithinScreenEvidenceRateLimit()` (max 3 uploads / 20s per
submission) are the policy decision points the route and hook both call
into — no policy math is duplicated between them.

## Lifecycle state machine (`src/lib/screenShareLifecycle.ts`)

```text
IDLE → REQUESTING → ACTIVE ⇄ INTERRUPTED
                  ↘ PERMISSION_DENIED
                  ↘ UNAVAILABLE
                  ↘ SURFACE_REJECTED
ACTIVE/INTERRUPTED/... → STOPPED  (submit / exit / unmount / attempt invalid)
```

- `nextScreenShareLifecycleState()` is a pure reducer; `TRACK_ENDED` and
  `TRACK_MUTED` both drive `ACTIVE → INTERRUPTED` (the visible student
  experience — "sharing stopped" — is identical either way, and treating
  them identically avoids two parallel near-duplicate code paths).
  `TRACK_UNMUTED` alone never restores — `RESTORED` is a separate,
  explicit transition driven only by the student's own "Resume screen
  sharing" action, never by a browser callback firing on its own,
  matching the requirement that Tether never silently re-invokes
  `getDisplayMedia()`.
- `shouldEmitLifecycleEvent(prev, next)` is true only on an actual state
  change — this alone makes repeated `TRACK_ENDED`/`TRACK_MUTED`
  callbacks for the same interruption idempotent, with no separate
  server-side dedup needed beyond the existing debounce window (below).
- `evaluateDisplaySurface(displaySurface, mode)` returns one of
  `MONITOR_CONFIRMED | NOT_MONITOR_REJECTED | UNVERIFIABLE_ACCEPTED`.
  When `MediaStreamTrack.getSettings().displaySurface` reliably reports
  `"window"`/`"browser"`/`"application"`, the share is rejected before
  the exam can start. When the browser cannot report a surface type at
  all (`undefined` — genuinely common; support is inconsistent across
  browsers), the share is **accepted** rather than blocked — Tether
  never claims it can force a particular selection, and blocking every
  student on an unsupported browser would be a worse failure mode than
  trusting an unverifiable share. The student still sees an explicit
  "we couldn't verify this was your entire screen" notice either way
  (`surfaceUnverifiable` in the hook's result).
- `classifyGetDisplayMediaError()` maps `NotAllowedError`/
  `SecurityError` to `PERMISSION_DENIED`; every other/unknown error name
  fails safe to `UNAVAILABLE` rather than guessing.

## Evidence capture (`src/lib/screenShareEvidence.ts`,
`src/hooks/useScreenShareLifecycle.ts`)

- No continuous recording anywhere — the hook draws a single video frame
  to an off-screen canvas (`EVIDENCE_CAPTURE_MAX_WIDTH = 960`, reducing
  resolution before encoding), encodes it as `image/jpeg`, and uploads
  that one blob. The `MediaStream` itself is never recorded or piped to
  a `MediaRecorder`.
- Captures are triggered periodically (client-paced by
  `isEvidenceCaptureDue()` against the policy's configured interval) and
  around interruption/restoration events, up to the per-attempt maximum.
- `validateScreenEvidenceUpload()` — server-side MIME allow-list
  (`image/jpeg`, `image/webp` only) and a strict byte-size ceiling
  (`MAX_SCREEN_EVIDENCE_BYTES`, 500KB) applied to every upload
  regardless of what the client claims about its own encoder settings.
- `generateScreenEvidenceStorageKey()` is entirely server-generated
  (`submissionId` + a random suffix) — the client never supplies, and
  the server never trusts, an arbitrary storage path.
- Frame bytes are never embedded in `IntegrityEvent.metadataJson`, never
  base64-encoded into Postgres, and never logged — only structured
  metadata (`trigger`, `captureIndex`) is written to the event row; the
  image itself lives solely in the private evidence-storage bucket,
  addressed only by an opaque `IntegrityEvidenceAsset.storageKey` never
  exposed to any client.

## Integrity events

Eight new `IntegrityEventType` values, added to the existing enum
rather than a parallel event system:

```text
SCREEN_SHARE_STARTED                  INFO    informational
SCREEN_SHARE_RESTORED                 INFO    informational
SCREEN_SHARE_EVIDENCE_CAPTURED        INFO    informational
SCREEN_SHARE_EVIDENCE_CAPTURE_FAILED  INFO    informational (a failed capture must never look punitive)
SCREEN_SHARE_PERMISSION_DENIED        LOW
SCREEN_SHARE_UNAVAILABLE              LOW
SCREEN_SHARE_SURFACE_REJECTED         LOW
SCREEN_SHARE_INTERRUPTED              MEDIUM  (capped — never HIGH for a single interruption)
```

`severityFor()` (`src/lib/secureExam.ts`) encodes this — a single
interruption can never reach `HIGH` severity; only a documented pattern
across the existing explainable risk model
(`src/lib/integrityRisk.ts`) can compound multiple `MEDIUM` signals into
something a lecturer sees flagged more prominently, and even then the
system only ever labels it "needs review," never "misconduct."

`integrityEventTypeForState()` maps each terminal lifecycle state to its
event type (or `null` for transient states like `REQUESTING`, which
never themselves get logged — only settled outcomes do).

Lifecycle events (all except `SCREEN_SHARE_EVIDENCE_CAPTURED`, which
goes through the dedicated evidence route below) are logged through the
existing generic `POST /api/submissions/[id]/integrity-events` route —
no new event-logging route was needed. That route's existing
`DEBOUNCE_WINDOWS_MS` dictionary gained four new entries
(`SCREEN_SHARE_INTERRUPTED`/`SCREEN_SHARE_RESTORED`/
`SCREEN_SHARE_STARTED`: 5s, `SCREEN_SHARE_EVIDENCE_CAPTURE_FAILED`: 10s)
so a repeated browser callback for the same underlying interruption
returns the existing recent event instead of creating a duplicate,
layered on top of the state-machine-level idempotency above.

## Evidence storage: reuse, not a new table

`IntegrityEvidenceAsset` (pre-existing, used previously only for camera
evidence) is reused directly via its generic `kind`/`eventType`
free-string columns — `kind = "SCREEN_SHARE_EVIDENCE_FRAME"` — rather
than creating a parallel table. The existing
`GET /api/integrity-evidence/[evidenceAssetId]` signed-view route is
already kind-agnostic and required **zero changes** to serve
screen-share frames.

One schema constraint shaped the upload route's design:
`IntegrityEvidenceAsset.integrityEventId String @unique` allows at most
one evidence asset per integrity event. Camera evidence satisfies this
by always attaching to an already-logged single detection event. Screen
evidence has no such pre-existing event (periodic/interruption-triggered
captures are not "detections") — so `POST
/api/submissions/[id]/screen-evidence` creates a fresh
`SCREEN_SHARE_EVIDENCE_CAPTURED` `IntegrityEvent` **and** its
`IntegrityEvidenceAsset` together, atomically, in the same transaction
as the count/rate-limit check (see "Concurrency" below) — one row of
each per captured frame.

## Concurrency: atomic evidence-slot reservation

`reserveAndCreateEvidence()`
(`src/app/api/submissions/[id]/screen-evidence/route.ts`) directly
reuses the transaction-scoped advisory-lock pattern established for AI
brainstorming assistance's prompt-slot reservation
(`docs/controlled-ai-brainstorming-assistance-v1.md`, "Concurrency"):
the count-check-then-insert sequence runs inside a single Postgres
transaction guarded by `pg_advisory_xact_lock(hashtext(submissionId))`
— the transaction-scoped variant, safe under Supabase's PgBouncer
transaction-mode pooler, since the lock is held only within one
transaction and never across the separate storage-write call (which
happens *before* the transaction, so a slot is never reserved for bytes
that failed to upload — see "Ordering" below).

Order of operations in the route: validate policy/ownership/status →
validate MIME/size → idempotency fast-path check (before ever touching
storage) → write bytes to the storage adapter → **then** the atomic
reserve-and-create transaction. If the transaction determines the slot
was not actually available (max reached, rate-limited, too soon since
the last capture — another concurrent request won the race), the
just-written storage object is deleted so storage never accumulates
orphaned files with no corresponding database row.

**Idempotency key.** The hook generates one `crypto.randomUUID()` per
logical capture action and sends it as `clientRequestId`.
`IntegrityEvidenceAsset.clientRequestId` is a nullable `@unique` column
(camera evidence never sets it, so its rows are simply never
deduplicated — Postgres allows unlimited `NULL`s in a unique index). A
retried request with the same key replays the original asset's ID
(`replay: true`) instead of creating a second row and consuming a second
slot.

## API

`POST /api/submissions/[id]/screen-evidence` — multipart/form-data
(`file`, `clientRequestId`, optional `trigger` ∈
`PERIODIC|INTERRUPTION|RESTORATION`). Validates, in order: authenticated
STUDENT, submission ownership, submission `IN_PROGRESS` (409 once
submitted — no evidence upload is ever accepted for a finished attempt),
policy snapshot has `mode: REQUIRED` and `captureEvidence: true` (403
otherwise — an exam that never enabled evidence capture can never
receive frames, regardless of what the client claims), MIME/size (400),
then the atomic reservation above (409 max reached, 429 rate-limited or
too-soon). Returns `{ ok, evidenceAssetId, replay? }`. Storage failures
return 503 without destroying the attempt — a temporarily-unavailable
storage backend never fails the exam, only that one capture.

`POST /api/submissions/[id]/integrity-events` (existing, extended) —
lifecycle events; validated and debounced as described above.

`GET /api/integrity-evidence/[evidenceAssetId]` (existing, unchanged) —
lecturer-only signed view, described above.

## Lecturer configuration

Exam editor → Secure Exam Mode settings → "Screen-share evidence"
section (`src/app/lecturer/exams/[id]/page.tsx`):

- Toggle: **"Require students to share their entire screen."**
  Supporting text: *"Students must share their entire display while
  completing this exam. Tether records sharing interruptions and may
  save limited evidence frames for lecturer review."*
- Nested toggle (only meaningful once the above is on): **"Save limited
  screen evidence frames"** — with interval/max-frame number inputs
  that are disabled in the UI, and rejected server-side, when this is
  off.
- Explicit copy in this section: no audio is ever captured, no
  continuous recording occurs, evidence is stored in the existing
  private bucket, and this produces review signals for a human, not
  findings — plus a note that browser/OS limitations apply (see "Known
  limitations").

Client-side validation mirrors the server's clamps
(`clampScreenShareEvidenceIntervalSeconds`/
`clampScreenShareMaxEvidenceFrames`) so a lecturer sees the same bounds
reflected immediately, but the server clamp is what actually matters —
the snapshot-build step re-clamps unconditionally regardless of what
was saved.

## Student experience

**Pre-exam gate** (added to the same gated pre-exam flow the camera
check already uses, in `student/exams/[id]/page.tsx`): explains what is
collected — entire-screen only, no audio, no continuous video, only
configured evidence frames and lifecycle events, reviewed by a human —
**before** requesting permission. `getDisplayMedia()` is called only
from the "Share entire screen" button's own click handler (a direct
user gesture — never invoked automatically, never re-invoked silently
after a stop). A small local preview is shown once sharing starts. If
the browser reports a non-monitor surface where it can reliably do so,
the share is rejected with a clear explanation and the student must
share again; if the browser cannot report a surface type at all, the
student proceeds with an explicit limitation notice rather than being
blocked. The Start button is disabled until both the camera gate (if
applicable) and this gate are satisfied.

**During the attempt:** a compact status indicator only —
"Screen sharing active" / "Screen sharing needs attention" / "Screen
sharing stopped" — never a large distracting panel, and never
conveyed by colour alone (each state has its own text label).

**On interruption** (required mode only): a focused, `alertdialog`
overlay blocks new content access — autosaved answers are preserved,
the timer keeps running exactly as it otherwise would, and the exam is
**never auto-submitted**. A "Resume screen sharing" button requires
another explicit click (never a silent re-request); a separate
`SCREEN_SHARE_RESTORED` event is recorded on success, distinct from the
original `SCREEN_SHARE_STARTED`. Support guidance is shown for a
student who cannot resolve the interruption. All screen-share tracks
are stopped on submit, exit, unmount, attempt-invalid, attempt-expired,
or user-change — capture is never left active after the exam ends.

## Lecturer review

`src/app/lecturer/submissions/[id]/evidence/page.tsx`, extended (not a
second review system): a "Screen-share integrity signals" section with
per-type counts (started/interrupted/restored/surface-rejected/
permission-denied/unavailable/evidence captured/evidence capture
failed), the policy that was actually in effect for that attempt
(mode, evidence capture on/off, interval, max frames — read from the
stored snapshot, not live settings), and a fixed disclaimer requiring
human interpretation. Evidence frames appear in the existing "Evidence
frames" list alongside camera frames, each labelled by source
(`evidenceFrameSourceLabel()` — "Screen-share evidence" vs. "Camera
evidence") and by the event that triggered it, viewable only via the
existing short-lived signed-view route. Never shown: automatic
"cheating detected" labels, unsupported claims about which application
was open, confidence percentages (no model produces one here), or raw
storage paths/object keys.

## Security and privacy summary

- No public evidence URLs; every frame is served only via the existing
  authenticated, ownership-checked, audit-logged signed-view route.
- No service-role storage credentials in client code — uploads go
  through the Next.js route, never a direct client-to-storage
  presigned-PUT flow.
- Server-generated storage keys only; no client-supplied path is ever
  trusted.
- Upload authorisation fails closed (missing policy, wrong student,
  submitted attempt, disallowed MIME/size all reject); a temporarily
  unavailable storage backend fails that one capture (503) without
  destroying the attempt.
- Concurrent requests cannot bypass the max-frame limit (atomic
  reservation, above) or replay to double-count (idempotency key,
  above).
- No screen titles, application names, or frame content are ever
  written into any event's metadata — metadata is limited to
  `trigger` and a numeric `captureIndex`.

## Testing

Pure logic — `screenSharePolicy.test.ts` (defaults/clamping/legacy
compatibility/immutable-snapshot round-trip/interval and max-frame
enforcement/rate limiting/capture-trigger validation),
`screenShareLifecycle.test.ts` (monitor-vs-window/tab handling,
`getDisplayMedia()` error classification, the full state machine
including track-ended/muted/unmuted, interruption deduplication,
restoration flow, event-type mapping), `screenShareEvidence.test.ts`
(MIME/size validation, storage-key generation and safety, frame source
labelling) — **50 tests, all passing**, no mocking required since these
modules touch no DOM/Prisma/network state.

Route-level (DB-backed) — `screenShareEvidence.routes.test.ts` — covers
upload authorisation (mode OFF or evidence disabled rejects; wrong
student's submission rejects; a valid upload creates exactly one event
and one asset), denial after submission, legacy-snapshot compatibility,
MIME/size rejection at the route, idempotent replay via
`clientRequestId`, **concurrent final evidence-slot reservation**
(`Promise.all` against a `maxEvidenceFrames: 1` policy asserting exactly
one of two simultaneous uploads succeeds and exactly one
`IntegrityEvidenceAsset` row exists afterward), and lecturer-only
evidence access via the existing signed-view route (owner lecturer can
view; a student is rejected by the route's own role check before
ownership is even considered). See "Known limitations" — this file
could not be executed against a reachable, migrated database in this
environment.

## Manual Preview validation checklist

The following require a real browser with `getDisplayMedia()` support
and cannot be exercised by the automated suite; they are the deploying
operator's responsibility once the migration below has been applied to
a Preview environment:

1. An exam with the policy left at `OFF` behaves exactly as before —
   no gate step, no status indicator, existing camera/AI-assistance
   features unaffected.
2. An exam with `REQUIRED` set blocks Start until entire-screen sharing
   is active.
3. Sharing the entire monitor is accepted and the gate clears.
4. Sharing a single browser window or tab is rejected with a clear
   message (on a browser that reports `displaySurface`).
5. Denying the permission prompt shows a clear retry path, not a dead
   end.
6. Stopping the share mid-attempt (via the browser's own "Stop
   sharing" control) immediately records an interruption event, shows
   the blocking overlay, preserves autosaved answers, keeps the timer
   running, and never auto-submits.
7. Clicking "Resume screen sharing" restores the share and records a
   separate `SCREEN_SHARE_RESTORED` event.
8. With evidence capture on, periodic frames appear at roughly the
   configured interval and stop once the configured maximum is
   reached.
9. Rapidly triggering multiple captures (e.g. repeated interruption/
   restoration) never exceeds the configured maximum, even under
   near-simultaneous requests.
10. Submitting the exam stops all screen-share tracks; no further
    evidence upload is accepted afterward.
11. The lecturer evidence review page shows the lifecycle timeline,
    interruption/restoration counts, and evidence thumbnails (where
    captured) with the policy that was actually in effect.
12. A student cannot view another student's evidence; a lecturer from
    a different institution/exam cannot view it either.
13. Existing camera detection and AI brainstorming assistance continue
    to work unaffected on an exam that also has screen-share evidence
    enabled.
14. Repeat 1–10 on both Chrome and Edge; document any other browser
    tested (Safari and Firefox have historically inconsistent
    `getDisplayMedia()`/`displaySurface` support and should be called
    out explicitly if tested).
15. Confirm no console errors/warnings appear during a full attempt
    with the feature enabled.

## Known limitations

- **No real browser/`getDisplayMedia()` testing was performed in this
  environment.** All lifecycle/state-machine logic is unit-tested with
  `MediaStream`/`MediaStreamTrack`/`getDisplayMedia` mocked at the pure-
  module level — actual cross-browser behaviour (especially
  `displaySurface` support, which is inconsistent across Chrome/Edge/
  Safari/Firefox) has not been validated live. The manual Preview
  checklist above must be run by the deploying operator before relying
  on this feature.
- **Browser APIs cannot provide full OS-level lockdown.** A student can
  still open unrelated windows on a second physical monitor the browser
  never sees, use a second physical device, or (on a browser that
  cannot report `displaySurface`) share a window that isn't their full
  screen without Tether being able to tell. This is disclosed to
  students in the pre-exam notice and is why this feature produces
  review signals, not proof.
- **Concurrency guarantees are implemented but not yet validated
  against a real database in this environment** — same gap as AI
  brainstorming assistance's reservation logic (see that feature's
  "Known limitations"): `screenShareEvidence.routes.test.ts` is written
  and type-checks/lints cleanly, but could not run its assertions here
  because the only reachable database in this environment is the
  shared Production/Preview instance itself, which does not yet have
  the new columns (the migration must not be applied there per this
  task's constraints) — see "Migration application instructions" in
  this doc's sibling ledger entry. Running this suite against a
  reachable, migrated Preview database is required before relying on
  the concurrency guarantee in production.
- **No OCR, no AI content classification, no process inspection** — by
  design (non-goal), not a gap to be filled later without a separate,
  explicit product decision given the privacy implications of any of
  those.
- Rate limiting and the minimum capture gap are DB-query-based, not a
  dedicated in-memory/Redis limiter — adequate for this feature's low
  request volume per student, consistent with the same tradeoff already
  accepted for AI brainstorming assistance.
- Default interval (60s) and max-frame (20) bounds are the task's own
  recommended v1 starting points, not the result of a validated
  institutional pilot — see the sibling pilot-process docs.
