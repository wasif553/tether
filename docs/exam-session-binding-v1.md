# Exam session binding — v1

Status: implemented, v1. Migration: `docs/exam-session-binding-migration.sql`.

## What this feature is

Privacy-conscious device/session continuity checks for one exam attempt, producing explainable
**lecturer review signals** — never an automatic misconduct finding, never a grade input, never an
automatic attempt termination.

It is **not**:
- A browser/canvas/WebGL/audio fingerprinting system.
- An IP geolocation feature (v1 does no geolocation at all — see "IP handling" below).
- A device-intelligence or fraud-scoring third-party integration (none is called in v1).
- A feature that terminates an attempt, auto-submits an exam, or notifies the student of an
  accusation.
- A replacement for NextAuth's own session cookie — that is untouched. This feature's cookies are a
  **separate**, purpose-built pair, scoped only to exam attempts.

## Required wording

- "Session review recommended" (`NEEDS_REVIEW`, and several signal-type headlines)
- "Device or browser changed during attempt" (`DEVICE_TOKEN_CHANGED` /
  `COARSE_DEVICE_PROFILE_CHANGED` / `USER_AGENT_CHANGED` headline)
- "Network changed during attempt" (`NETWORK_PREFIX_CHANGED` / `REPEATED_NETWORK_CHANGES` headline)
- "Concurrent exam sessions detected" (student-facing notice wording, see below)
- "Lecturer review recommended" / "Oral verification recommended" (combined recommendation, shared
  with `docs/time-anomaly-review-v1.md`)

Never used: "Cheating detected", "Student cheated", "Device fraud confirmed", "Pasted answer
confirmed", "Impersonation confirmed", "Misconduct proven", "Guilty" — enforced by convention (no
occurrence anywhere in this feature's code/UI copy) and by the neutral wording baked into every
signal-builder function in `src/lib/sessionIntegrity.ts`.

## First-party token binding is primary; the coarse fingerprint is secondary

Two server-issued, HMAC-hashed, first-party cookies are the primary binding mechanism:

1. **Browser-session token** (`exam_bst`, Secure/HttpOnly/SameSite=Lax, 6-hour max age) — scoped to
   one attempt. Only its HMAC-SHA256 hash (`ExamAttemptSession.browserSessionTokenHash`) is ever
   stored; the raw token lives only in the cookie.
2. **Device token** (`exam_dt`, same cookie flags, 180-day max age) — persists across attempts on
   the same browser. This is the **primary device-continuity signal**.

A **coarse fingerprint** (`ExamAttemptSession.coarseFingerprintHash`) is computed only from
low-entropy inputs — browser family, OS family, device category, primary accepted language,
timezone, and a bucketed screen-size ("small"/"medium"/"large") — and is explicitly a **supporting**
signal only, never the primary mechanism. See "No invasive fingerprinting" below for what is
deliberately excluded.

All hashing uses HMAC-SHA256 with a server secret (`EXAM_BINDING_HMAC_SECRET`, falling back to a
random per-process secret exactly like `NETWORK_EVIDENCE_SALT` in
`docs/network-evidence-and-ip-location.md` — set the env var in production for hashes stable across
restarts). Deliberately a distinct secret from `AUTH_SECRET`.

## Why binding happens on first heartbeat, not at `POST /api/exams/[id]/start`

`POST /api/exams/[id]/start` is already a large, carefully-sequenced route (access code check,
attempt-count check, question-pool selection, network evidence capture, idempotent-create race
handling). Rather than adding session-binding logic into that route, v1 creates/resumes the
`ExamAttemptSession` on the exam page's **first heartbeat call** instead
(`POST /api/submissions/[id]/session-heartbeat`, called immediately on page mount and then every
25 seconds — see the student exam page). This keeps the start route completely untouched and gives
one single, well-tested place (`src/lib/examAttemptSessionRunner.ts`) where all binding logic lives.
The very first heartbeat after an attempt starts effectively **is** "at attempt start" from the
student's perspective — there is no meaningful gap where the exam is being taken without a session
having been created shortly after.

## No invasive fingerprinting

Never collected, in any form: canvas fingerprinting, WebGL fingerprinting, audio fingerprinting,
font/plugin enumeration, hardware serial numbers, MAC addresses, exact geolocation, exact screen
dimensions (only a 3-bucket size class), individual keystrokes, or clipboard contents. No external
device-intelligence service and no IP geolocation service is called in v1.

## IP changes are weak signals; no raw IP storage

Nothing here ever stores a raw IP address. `src/lib/sessionBinding.ts` immediately reduces a raw IP
to an HMAC-hashed network **prefix** (`/24` for IPv4, `/48` for IPv6) plus an IP version, then
discards the raw value. A **single** prefix change is deliberately `LOW`/informational
(`NETWORK_PREFIX_CHANGED`) — mobile networks, institutional Wi-Fi, and VPNs legitimately rotate
addresses. Only **repeated** distinct prefixes within a 30-minute window (≥3 by default,
`MIN_DISTINCT_PREFIXES_FOR_REPEATED_CHANGE`) escalate to `MEDIUM` (`REPEATED_NETWORK_CHANGES`). This
is never described as geographic travel — v1 performs no IP geolocation at all (unlike the separate,
pre-existing Academic Integrity Network Evidence v1 feature, which is untouched by this work).

## Camera permission

Only one of `granted | denied | prompt | unavailable | unknown` is ever stored
(`ExamAttemptSession.cameraPermissionState`). An unsupported Permissions API result is `unknown`,
never treated as a violation. Only the "access was revoked" direction
(`granted → denied`/`unavailable`) is flagged, and only at `LOW` — this never duplicates the
separate, pre-existing camera integrity event stream (`CAMERA_PERMISSION_GRANTED`/`DENIED` on
`IntegrityEvent`, which is completely untouched by this feature).

## Signals implemented

All deterministic and explainable, in `src/lib/sessionIntegrity.ts` (pure) +
`src/lib/examAttemptSessionRunner.ts` (server orchestration):

1. **`CONCURRENT_ACTIVE_SESSIONS`** — two different browser-session tokens both active (seen within
   `ACTIVE_SESSION_TIMEOUT_MS` = 90s) with a genuinely overlapping active window
   (≥ `MIN_OVERLAP_MS_FOR_CONCURRENT_SIGNAL` = 5s) — never a page refresh resuming the same token,
   never a session that went stale before another started, never a single duplicate request's
   momentary overlap.
2. **`DEVICE_TOKEN_CHANGED`** — the persistent device token changed mid-attempt. `MEDIUM`, or `HIGH`
   if the previous session was still active/recently active.
3. **`COARSE_DEVICE_PROFILE_CHANGED`** — desktop↔mobile switch, OS family change, or browser family
   + device category both changing. `MEDIUM`. Never flags a minor browser *version* change (family
   is already coarse).
4. **`USER_AGENT_CHANGED`** — `LOW` alone; `MEDIUM` only when combined with another concurrent
   device/session change.
5. **`NETWORK_PREFIX_CHANGED`** / **`REPEATED_NETWORK_CHANGES`** — see "IP changes" above.
6. **`CAMERA_PERMISSION_CHANGED`** — see "Camera permission" above.
7. **`SESSION_TOKEN_MISMATCH`** — a request's session identifier matched no known session
   (reserved for future stricter-binding routes; not currently wired into every route — see
   "What v1 actually enforces" below).
8. **`SESSION_RESTARTED`** — a new browser-session token appears on a device that already has a
   non-active session for this submission — informational only (`LOW`), expected after a browser
   restart.

## Deduplication / cooldown

A signal of the same type is never recreated within `SIGNAL_DEDUPLICATION_COOLDOWN_MS` (10 minutes)
of the last one for the same submission (`shouldEmitSignal()` in `sessionIntegrity.ts`) — so a
heartbeat every 25 seconds never spams the review queue with the same finding.

## What v1 actually enforces on which routes

Per Part 4 of the task, binding is meant to be attached/checked on every attempt route. v1's
concrete implementation:

- **`POST /api/submissions/[id]/session-heartbeat`** — the only route that creates/resumes binding
  and runs the full classification pipeline (concurrent sessions, device/UA/network/camera
  changes).
- **`PATCH /api/submissions/[id]/answers`** (existing autosave) — attaches the most-recently-seen
  session id to its `ANSWER_SAVED` telemetry event (best-effort lookup, fire-and-forget; never
  blocks the save).
- **`POST /api/submissions/[id]/submit`** — records an `ATTEMPT_SUBMITTED` telemetry marker and ends
  every non-ENDED `ExamAttemptSession` for the submission (fire-and-forget; never blocks
  submission).
- **`POST /api/exams/[id]/start`** — records only an `ATTEMPT_STARTED` telemetry marker (no binding
  cookies are set here — see "Why binding happens on first heartbeat" above).
- **`POST /api/submissions/[id]/question-progress`** — records a rate-limited `QUESTION_NAVIGATED`
  telemetry marker (fire-and-forget).

`GET /api/submissions/[id]` (submission read) and `GET /api/submissions/[id]/question` (current
question fetch) are **not** modified in v1 — they continue to use only their existing
`session.user.id === submission.studentId` authorisation check, which already prevents a client from
reading another student's submission with a mismatched session. No client-supplied user id or
submission id is ever trusted anywhere in this feature.

## Data model

`ExamAttemptSession`, `SessionIntegritySignal` — fully additive, see `prisma/schema.prisma` and
`docs/exam-session-binding-migration.sql`. Status/type/level/review-status fields are validated
`String` columns, not Postgres enums, following the `SubmissionSimilarityAnalysis` convention.

## Lecturer-only visibility and safe DTOs

`GET /api/lecturer/submissions/[id]/session-review` and the `PATCH` review routes require a
`LECTURER` (exam owner) or `PLATFORM_ADMIN` session, same institution — identical convention to
every other lecturer route in this repo. The response **never** includes:
`browserSessionTokenHash`, `deviceTokenHash`, `coarseFingerprintHash`, `userAgentHash`,
`ipPrefixHash`, a raw IP, a raw user-agent string, or the HMAC secret. Only safe, already-classified
fields (`browserFamily`, `operatingSystemFamily`, `deviceCategory`, `ipVersion`,
`cameraPermissionState`, timestamps, status) are ever returned. Students always receive 401/403 from
every lecturer-only route.

## Student-facing wording

Only neutral, operational messages — see the student exam page:
- "Session connection could not be confirmed." (heartbeat failure — informational only)
- "This exam is also active in another browser session. Close the other session to avoid answer
  conflicts." (only shown when a concurrent session is actually detected)

Never accusatory wording ("Suspicious device detected", "You are being investigated", "Cheating
behaviour identified"). v1 never automatically terminates either session — that would require an
explicit, separate institutional policy not implemented here.

## Audit logging

`createPlatformAuditLog()` records `SESSION_INTEGRITY_SIGNAL_DETECTED` (actor is `null` — the
student's own heartbeat request detected the signal, not a lecturer action) and
`SESSION_SIGNAL_REVIEW_UPDATED` (old/new status only, never the review note or any hash).

## Performance, retention, and reliability

- Every heartbeat query is scoped to one submission's own sessions — never institution-wide.
- Indexes on `submissionId`, `userId`, `status`, `lastSeenAt`, `deviceTokenHash`.
- Heartbeat telemetry markers are rate-limited (`dedupeWindowMs` in
  `recordSimpleActivityEvent()`) so a fast retry loop can't flood `AnswerActivityEvent`.
- **Retention recommendation**: `ExamAttemptSession` and `SessionIntegritySignal` rows are small and
  tied 1:1 (or a handful) to a submission — no special retention job is implemented in v1. If
  storage growth becomes a concern, a reasonable policy is to prune rows for submissions whose exam
  is more than 12 months past its `endsAt`/`availableUntil`, after any institutional review window
  has closed. This is a recommendation, not an implemented job.

## Migration and existing in-progress attempts

Purely additive — see `docs/exam-session-binding-migration.sql`. No backfill is required or
possible. An attempt that was **already in progress** when this feature is deployed simply has no
`ExamAttemptSession` row until its next heartbeat after deployment (the student's exam page starts
sending heartbeats as soon as the new client code loads, which happens on their next
render/navigation) — the attempt itself is never interrupted, no error is shown, and no historical
session data is invented for the period before deployment.
