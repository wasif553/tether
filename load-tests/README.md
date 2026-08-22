# Tether realistic load-test harness

Implements `TETHER_LOAD_TEST_HARNESS_READINESS_P0_V1`: a k6-based
concurrency harness for validating Tether at 10 / 25 / 50 / 100 / 250 /
500 concurrent students, built strictly through the currently-shipped
API contracts, with a non-overridable production denylist and a
deterministic, database-verifiable synthetic-data design.

**This harness has never been run against any deployment.** See
"Execution status" below for the exact blocking prerequisite.

## Do not rely on the old script

`scripts/load-test-secure-exam.mjs` and `docs/concurrent-exam-pilot-capacity.md`
are a prior, materially different harness/validation record (Secure Exam
Mode's early browser-only design: two questions per exam, no
one-question-at-a-time delivery, no Question Navigator, no
`save-and-navigate`, deletes every exam it creates as cleanup). Per this
task's own instruction, it was traced but never used as the current
specification, and is left completely untouched — this harness lives
entirely under `load-tests/` and shares no code with it.

## Architecture

1. **k6** drives all concurrent HTTP workload (`load-tests/k6/`).
2. **Node scripts** (run via `tsx`/`node`, no k6 involved) handle
   one-time setup and post-run verification — never concurrent load
   themselves (`load-tests/setup/`, `load-tests/verify/`).
3. **No new application test endpoint** was added anywhere in `src/`.
   Every request this harness sends is a request a real browser could
   send to the currently-shipped API.
4. **No modification to any normal Production request path.** The only
   files changed outside `load-tests/` are `.gitignore` (one new ignore
   rule) and `package.json` (two new npm script entries).
5. Every target (Vercel URL, database URL, run size) is supplied via
   environment variables / CLI flags — nothing is hard-coded except the
   denylist itself (see below).
6. No secrets are committed. `load-tests/runs/**` (manifests +
   plaintext synthetic credentials) is gitignored in full.

```
load-tests/
  shared/                  Pure JS, imported unmodified by BOTH k6 and Node
    productionDenylist.mjs   The non-overridable target/database guard
    deterministicAnswers.mjs Deterministic per-student expected answers
  setup/
    provisionFixture.mjs     Creates lecturer + exam + 20 questions + N students (HTTP only, no DB)
  k6/
    lib/                     config.js, metrics.js, thresholds.js, studentJourney.js (shared VU workload)
    scenarios/               smoke.js sanity.js rehearsal.js stage1.js stage2.js stage3.js microburst.js
  verify/
    verifyRun.mjs             Post-run DB-backed correctness verification (the one script that opens a DB connection)
  runs/                      Gitignored — per-run manifest.json + credentials.local.json
```

## Exact current endpoint contracts discovered (Phase 0 trace)

Traced directly from source before writing any harness code, per the
task's own "FIRST — TRACE THE CURRENT IMPLEMENTATION" requirement:

| Endpoint | Contract |
|---|---|
| NextAuth Credentials | `GET /api/auth/csrf` → `csrfToken`; `POST /api/auth/callback/credentials` (form-encoded `csrfToken`, `email`, `password`, `json=true`) → session cookie. Rate limits: 5 attempts / 5 min per (source IP + account) [`LOGIN_SOURCE_ACCOUNT_*`], 200 attempts / 5 min per source IP (safety net, transient occupancy only — a success releases its slot immediately) [`LOGIN_SOURCE_FAILURES_*`]. |
| `POST /api/exams/:examId/start` | `{ policyAcknowledged: true }` (+ `accessCode` if required). Idempotent — an existing `IN_PROGRESS` attempt is returned unchanged. `secureClientLaunch: { required: false }` for every non-Tether-required delivery mode. |
| `GET /api/submissions/:id` | Full submission view (used by the lecturer/grading UI and non-one-question-mode delivery); this harness's fixture uses one-question-mode, so its VUs never call this directly. |
| `GET /api/submissions/:id/question` | Read-only current-question payload: `{ currentIndex, totalQuestions, canGoPrevious, canGoNext, question: { id, type, text, options, points }, existingResponse }`. |
| `GET /api/submissions/:id/question-navigator` | `{ submissionId, currentQuestionIndex, totalQuestions, settings, progress: { answeredCount, unansweredCount, flaggedCount, visitedCount }, questions: [{ questionId, index, number, state, flaggedForReview, locked, canNavigate }] }`. |
| `PATCH /api/submissions/:id/answers` | `{ questionId, response, clientRequestId?, clientRevision? }` → `{ questionId, response, acknowledgedRevision, acknowledgedRequestId }`. This is the exact contract `useResilientAutosave.ts`'s debounced `save()` uses. |
| `POST /api/submissions/:id/save-and-navigate` | `{ questionId, response, clientRequestId?, clientRevision?, currentIndex }` → `{ answer: {...}, navigation: <question payload for the new index> }`. One transaction; the answer save and the index advance either both commit or neither does. |
| `POST /api/submissions/:id/question-progress` | Sequential: `{ currentIndex }`. GOTO: `{ action: "GOTO", targetIndex }` (requires `allowQuestionJumping`). Returns the resolved question payload directly. |
| `PATCH /api/submissions/:id/question-state/:questionId` | `{ flaggedForReview: boolean }` → `{ questionId, flaggedForReview }`. |
| `POST /api/submissions/:id/session-heartbeat` | `{ timezone?, screenWidth?, cameraPermissionState?, pendingSaveCount? }` → `{ sessionStatus, cameraPermissionState, concurrentSessionDetected }`. Documented client cadence ≈25s — this harness never sends faster. |
| `POST /api/submissions/:id/integrity-events` | `{ eventType, severity, message, metadata?, occurredAt? }`; several event types are server-side debounced (see `DEBOUNCE_WINDOWS_MS` in the route). |
| `POST /api/submissions/:id/submit` | `{ submissionRequestId? }` → final status; a repeat with the SAME `submissionRequestId` returns `{ code: "ALREADY_FINALIZED" }` idempotently, never a second grading pass. |
| `POST /api/submissions/:id/activate` | Only meaningful for `TETHER_CLIENT_REQUIRED`/`SEB_REQUIRED` delivery modes — a `STANDARD_WEB` submission already has `activatedAt` stamped at creation (see `POST /start`). **Never called by this harness** — see "Secure Tether session strategy" below. |
| `GET /api/submissions/:id/secure-client/status`, `POST .../secure-client/session`, `POST .../secure-client/launch`, `POST .../secure-client/mock-launch` | Full Tether Secure Client Foundation flow. `status` is a plain, always-safe read (no session required) — this harness calls it once per student to exercise the real "secure client" lifecycle phase. The other three are **not called** — see below. |

## Secure Tether session strategy — the investigation's central finding

The task required investigating whether `POST /api/submissions/:id/secure-client/mock-launch`
can legitimately establish the session/trust a realistic workload needs, and
to **STOP and report the exact blocker** rather than invent a bypass if it
cannot.

Tracing `mock-launch` → `POST /api/secure-client/launch/[manifestId]/consume`
→ `POST /api/secure-client/sessions/[sessionId]/attestation` shows the mock
flow CAN create a `SecureClientSession` and even flip its legacy
`verificationStatus` to `VERIFIED` through a self-reported request body (no
cryptographic proof). But every content-bound route for a
`TETHER_CLIENT_REQUIRED` submission — `GET /api/submissions/:id`,
`PATCH .../answers`, `POST .../save-and-navigate`,
`GET/POST .../question(-progress)`, `POST .../activate`, `POST .../submit`
— additionally requires a **content-access lease**
(`src/lib/secureClient/requireTetherContentAccess.ts`), and that lease's own
doc comment is explicit: it is issued **only** by
`POST /api/tether/exam-session/attestation/verify`, which requires a
genuine Ed25519 signature from a real, installed Tether client's private
key. The legacy attestation route's own doc comment states this even more
directly: *"This route continues to exist ONLY for the legacy
SecureClientSession.verificationStatus compatibility decision — never as a
source of proof for protected content access."*

**Conclusion:** for a `TETHER_CLIENT_REQUIRED` (or `SEB_REQUIRED`) fixture
exam, no automated script — including the mock-launch flow — can
legitimately obtain the content-access lease a realistic full workload
(reading question content, saving answers, activating, submitting) needs,
without fabricating cryptographic proof. Doing that would be exactly the
"authentication/session/security bypass for k6" this task explicitly
forbids. **This is the reported blocker** for that delivery mode, per the
task's own STOP instruction.

This harness's fixture exam therefore uses `deliveryMode: "STANDARD_WEB"`
(the platform default) with `secureModeEnabled: true` and the full
one-question-at-a-time / Question Navigator / autosave surface — every
content-bound route above skips the lease/activation gate entirely for
this delivery mode (confirmed by direct trace of the exact same route
files), so the complete realistic workload runs through zero secure-client
machinery and zero bypass. Each VU calls
`GET /secure-client/status` once (a real, always-available, session-free
read) to exercise the "secure client" lifecycle phase the task's STUDENT
LIFECYCLE section asks for; `session`/`launch`/`activate`/`mock-launch`
are legitimately out of scope for `STANDARD_WEB` and are never called.

## Production denylist

`load-tests/shared/productionDenylist.mjs` — imported unmodified by every
Node script and every k6 scenario (via `k6/lib/config.js`, which throws at
INIT time, before a single request is sent, if the check fails).

- **No override flag exists anywhere in this harness.** There is no
  `ALLOW_PRODUCTION_LOAD_TEST`-shaped environment variable, and
  `productionDenylist.test.ts` asserts none of the module's exports even
  contain the words "allow", "override", or "bypass".
- Exact-match denylist of the three Production hostnames for this
  project (discovered directly from the Vercel API, `get_project` on
  `prj_3gM8EAl8GKfgeBWlMLa0svWGHlpN`, 2026-08-22):
  `tether-murex.vercel.app`, `tether-tether5.vercel.app`,
  `tether-git-main-tether5.vercel.app`. Exact match only, deliberately —
  this project's ordinary Preview deployments share the same
  `tether-<hash>-tether5.vercel.app` naming scheme (confirmed against a
  real Preview URL from earlier in this session), so a pattern-based
  block would also wrongly block legitimate non-Production targets.
- A separate database-URL guard rejects the known Production Supabase
  project reference (`ugckdvbjzauvcovcqebw`, taken from this
  repository's own `scripts/releaseValidation/dbSafetyGuard.ts` reject
  list) wherever it appears in `LOADTEST_DATABASE_URL` — hostname or
  pooler username.
- Both guards fail closed on missing/malformed input — there is no
  default target and no default database.

## Execution status — why nothing was run

The task permits ONE conditional 10-user smoke, gated on six
independently-proven preconditions. Tracing this project's actual Vercel
configuration during Phase 0 surfaced a blocker that applies to **every**
deployment of this project, not just Production:

> `src/lib/secureClientAvailability.ts`'s own doc comment: *"this
> project's Preview and Production deployments share the same Supabase
> database"* (see `docs/migration-ledger.md`).

This means condition 3 ("target Supabase is dedicated synthetic/load-test
infrastructure") and condition 4 ("no real pilot/student records exist
there") **fail categorically** for this repository as currently
provisioned — not just for the canonical Production URL, but for any
Preview deployment too, since Preview and Production write to the exact
same database. There is currently no dedicated, isolated Supabase project
this harness could safely target at any concurrency, including 10 users.

**Missing prerequisite:** a genuinely separate Supabase project (its own
connection string, never `ugckdvbjzauvcovcqebw`) wired to a dedicated
Vercel deployment (via its own `DATABASE_URL` environment variable, its
own `LOADTEST_TARGET_BASE_URL`), holding no real pilot/student records.
Until that infrastructure exists, this harness must not send synthetic
load anywhere — this is exactly the "STOP and report the blocker rather
than run" behaviour the task's own EXECUTION PERMISSION section requires.

No load traffic — smoke, sanity, or any numbered stage — was generated
against Production or any other deployment of this project as part of
this task.

## Synthetic-data strategy

- Run id: `LT-<epoch-ms>-<8 hex chars>`, e.g. `LT-1787380000000-a1b2c3d4`.
- Lecturer: `loadtest-lecturer-<runId>@example.invalid`.
- Students: `loadtest-student-<runId>-<index>@example.invalid`,
  `LOADTEST_Student_<runId>_<index>`.
- Exam: `LOADTEST_<runId>_<label>`, assignment mode `STANDALONE` (an
  `ExamAssignment` accepted via invite token — no institution-membership
  dependency, so a self-service student with `institutionId: null` can
  legitimately access it; see `provisionFixture.mjs`'s own comment for
  why this was chosen over an institution-wide exam).
- 20 questions, fixed order: 12 MCQ (`buildFixtureQuestionDefinitions()`
  in `deterministicAnswers.mjs`, options `["A","B","C","D"]`, correct
  option cycling through all 4 slots) then 8 SHORT_ANSWER. No ESSAY
  questions, so every finalized submission auto-grades to `GRADED`
  (never `SUBMITTED`-pending-manual-grading).
- Every synthetic student's response is a **pure function** of
  `(runId, studentIndex, questionIndex)` — MCQ: always the objectively
  correct option; short answer: the self-identifying string
  `LT-<runId>-S<studentIndex>-Q<questionIndex>`. `verify/verifyRun.mjs`
  recomputes the same function independently, so any mismatch is
  unambiguous evidence of a real defect, not a harness artifact.
- Passwords are generated per-account (`Lt_<24 random bytes, base64url>`)
  and written only to the gitignored `credentials.local.json` — never
  logged, never committed.
- Cleanup: **none automatic**, per the task's own instruction (never
  replicate `scripts/load-test-secure-exam.mjs`'s exam-delete cleanup).
  Every `LOADTEST_`/`loadtest-*@example.invalid`-prefixed record is left
  in place for post-run inspection. Retiring a dedicated load-test
  environment entirely is a separate, explicit, future operation.

## Workload model (`k6/lib/studentJourney.js`)

One k6 VU = one synthetic student's one complete attempt, start to
submit. Shared unmodified across every stage — only the VU ramp
shape/duration differs per scenario file, so a correctness defect found
at 10 VUs is the same defect that would occur at 500.

Per student: `POST /start` → `GET secure-client/status` (once) → for
each of the 20 questions: periodic `GET question-navigator` (every 4th
question), think-time with randomized jitter, ordinary debounced
`PATCH /answers` (≈1/3 of questions), occasional flag
(`PATCH question-state`, ≈15%), a minority of students send 1-2
`POST integrity-events` total (never per-question), periodic
`POST session-heartbeat` at the real ≈25s cadence, occasional
Previous-then-GOTO review (≈10%), then `POST save-and-navigate` to
advance → after the last question, `POST submit`. A bounded 1-in-20
subset replays `submit` with the identical `submissionRequestId` to
verify idempotency; the explicit negative-ownership test runs separately,
post-run, in `verify/verifyRun.mjs` (a VU is never given another VU's
submission id, so it cannot attempt the cross-student read itself — see
`studentJourney.js`'s own comment).

Backend save/durability semantics are never touched: every autosave call
carries a real `clientRequestId`/`clientRevision`, navigation always goes
through the real transactional routes, and nothing here writes a
database row directly.

## Metrics (`k6/lib/metrics.js`)

One Trend (latency) + Rate (success) + Counter (4xx/5xx/timeout/
unexpected-429) per **logical operation** (`exam_start`,
`secure_client_status`, `question_get`, `question_navigator`,
`answers_patch`, `save_and_navigate`, `question_progress_goto`,
`question_state_flag`, `session_heartbeat`, `integrity_event`, `submit`,
`submit_idempotent_replay`) — never fragmented by raw URL, which a
parameterized `/api/submissions/:id/...` path would otherwise explode
into one series per submission id. Plus
`duplicate_idempotency_conflict_total`,
`stale_navigator_reconciliation_total`,
`ownership_rejection_confirmed_total` for live-observable correctness
signals. k6's own JSON/summary export (`k6 run --summary-export=out.json`)
is the machine-readable output.

## Correctness checks (`verify/verifyRun.mjs`)

Implements all 12 items from the task's DATA-INTEGRITY VERIFICATION list
plus the explicit negative ownership test, against a dedicated database
connection (never the application's own `src/lib/prisma.ts` singleton).
Exits non-zero on any finding — every check is zero-tolerance, matching
the task's own PASS/FAIL gates (lost answers, wrong association,
cross-student leakage, ownership bypass, duplicate corruption, incorrect
final status: all must be exactly 0).

## Stage definitions and how to run

| Stage | VUs | Active window | Scenario file |
|---|---|---|---|
| Smoke | 10 | ~5 min | `k6/scenarios/smoke.js` |
| Sanity | 25 | ~5-10 min | `k6/scenarios/sanity.js` |
| Rehearsal | 50 | ~10 min | `k6/scenarios/rehearsal.js` |
| Stage 1 | 100 | ~15 min | `k6/scenarios/stage1.js` |
| Stage 2 | 250 | ~15-20 min | `k6/scenarios/stage2.js` |
| Stage 3 | 500 | ~20 min | `k6/scenarios/stage3.js` |
| Microburst | 100 steady + 25 burst | ~12 min + short burst window | `k6/scenarios/microburst.js` |

```bash
# 1. Provision the fixture (HTTP only — no database access):
LOADTEST_TARGET_BASE_URL=https://your-dedicated-loadtest-deployment.vercel.app \
  node load-tests/setup/provisionFixture.mjs --students=12 --label=smoke
# → prints a runId, e.g. LT-1787380000000-a1b2c3d4

# 2. Run the k6 stage against the SAME target:
k6 run load-tests/k6/scenarios/smoke.js \
  -e LOADTEST_TARGET_BASE_URL=https://your-dedicated-loadtest-deployment.vercel.app \
  -e RUN_ID=LT-1787380000000-a1b2c3d4 \
  --summary-export=load-tests/runs/LT-1787380000000-a1b2c3d4/k6-summary.json

# 3. Verify persisted correctness against the dedicated database:
LOADTEST_TARGET_BASE_URL=https://your-dedicated-loadtest-deployment.vercel.app \
LOADTEST_DATABASE_URL=postgresql://...your-dedicated-loadtest-project... \
  npx tsx load-tests/verify/verifyRun.mjs --runId=LT-1787380000000-a1b2c3d4
```

Every command above independently re-runs the production denylist —
there is no "trusted after step 1" shortcut.

**Only the smoke stage may ever be run, and only once every condition in
"Execution status" above is independently proven for the target
environment.** `stage1.js`/`stage2.js`/`stage3.js`/`microburst.js` carry
an explicit "DO NOT RUN without separate authorisation" header and were
never invoked while building this harness.

## STOP conditions

A stage must be stopped immediately on evidence of: a lost answer, wrong
question/student association, cross-student data leakage, an ownership
failure, a Secure Browser/session-binding bypass, incorrect question
sequencing, duplicate submission corruption, database connection
exhaustion, Supabase pooler exhaustion, repeated Prisma `P2028`
transaction-start failures, severe transaction waits, Vercel throttling,
sustained severe latency, any real/non-synthetic record being touched, or
the target environment unexpectedly resolving to Production.

Operational stop guidance (check between stages, or live via a second
terminal watching the k6 text-summary output): unexpected 5xx > 1% for
two consecutive measurement windows; a catastrophic 5xx burst > 5% in one
window; timeout rate > 1% sustained; Save + Next p95 > 5s sustained;
autosave p95 > 4s sustained; submit p95 > 8s sustained; database
connections approaching ~80% of the **target database's actual configured
maximum** (record the real value at run time — `src/lib/prisma.ts` caps
this application's own per-instance pool at `DATABASE_POOL_MAX` (default
3), but the ceiling that matters is the Supabase pooler's own connection
limit for whatever plan the dedicated load-test project is on; never
assume 60, or any other number, without checking the actual project).

## Run evidence

`load-tests/runs/<runId>/manifest.json` (non-secret): run metadata, exact
git SHA the target was built from (record this manually from the
deployment's own `githubCommitSha` — see `get_deployment` in whatever
Vercel MCP/CLI access is available), environment identifier, VU
count/stage, timestamps, workload configuration, question fixture
definitions. Pair this with k6's own `--summary-export` JSON
(endpoint-specific p50/p95/p99, status/error counts) and
`verify/verifyRun.mjs`'s printed PASS/FAIL correctness report.

Not captured by this harness (record manually, alongside the above, for
a real run):
- Vercel runtime/function errors and throttling — Vercel dashboard →
  project → Observability/Logs, or the `get_runtime_errors` /
  `get_runtime_logs` MCP tools, for the exact run window.
- Vercel invocation/compute usage — Vercel dashboard → Usage.
- Supabase connection pressure, query/transaction latency, pooler
  errors — Supabase dashboard → Database → connection pool usage /
  Logs, for the dedicated load-test project.
- Prisma `P2028` occurrences — grep Vercel function logs for the run
  window; this harness's own k6-side 5xx counters will show the
  resulting HTTP failures but not the underlying Prisma error code.

This harness never fabricates any of the above — the manifest and k6
summary only ever contain what was directly measured.
