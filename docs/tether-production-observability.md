# Tether Production Observability (v1)

Audit of failure-handling for the core Tether secure-client pipeline, plus
the low-risk hardening applied in this pass. No external monitoring vendor
is introduced here — this documents what the platform itself currently does
and could alert on, using its existing tools (Vercel function logs,
`PlatformAuditLog`).

## Audit: current failure handling, checkpoint by checkpoint

| Checkpoint | Function / route | Before this pass | After this pass |
|---|---|---|---|
| Secure-client launch creation | `issueLaunchManifest` (`src/lib/secureClientRunner.ts`) | Manifest-create failure threw with no log — opaque 500 | `console.error("issueLaunchManifest: manifest create failed", {submissionId, errorName, errorCode})` before rethrow |
| Manifest consume | `consumeLaunchManifest` (`src/lib/secureClientRunner.ts`) | Already logs (`console.error("consumeLaunchManifest: transaction failed", ...)`) — added during the P2028 fix | Unchanged — already adequate |
| Attestation (system-check) | `verifySystemCheckAttestation` (`src/lib/systemCheck/tetherAttestationRunner.ts`) | Non-replay transaction failure rethrown with no log | `console.error("verifySystemCheckAttestation: verification transaction failed", {userId, installationId, errorName, errorCode})` before rethrow |
| Attestation (real exam session) | `verifyExamSessionAttestation` (same file) | Same gap, separate code path | Same fix, `verifyExamSessionAttestation: verification transaction failed` |
| Attestation (legacy per-session) | `recordAttestation` (`src/lib/secureClientRunner.ts`) | Both the attestation-create and the session-status-update writes were unlogged | Each wrapped: `recordAttestation: attestation create failed` / `recordAttestation: session status update failed` |
| Heartbeat | `recordHeartbeat` (`src/lib/secureClientRunner.ts`) | Unlogged | `recordHeartbeat: session update failed` (bounded to `sessionId` — this is a high-frequency path, so the log stays minimal) |
| Screen evidence upload | `POST /api/submissions/[id]/screen-evidence` | Already has `console.error` on upload/DB failure | Unchanged — already adequate |
| Camera evidence upload | `POST /api/submissions/[id]/integrity-events/[eventId]/evidence-frame` | Already has `console.error` | Unchanged — already adequate |
| Integrity-event creation | `POST /api/submissions/[id]/integrity-events` | No error handling at all — both the plain-create and the debounced-transaction path threw straight to an opaque 500 | Both wrapped: `POST integrity-events: create failed` / `POST integrity-events: debounced transaction failed` (never logs `message`/`metadata` — those are student-authored/free-form) |
| Lecturer recovery grant | `issueRecoveryGrant` (`src/lib/secureClientRunner.ts`) | Unlogged | `issueRecoveryGrant: grant create failed` (bounded to `sessionId`/`submissionId`) |

## What "diagnostic" means here

This codebase has two logging mechanisms, deliberately different in scope:

- **`logServerTetherDiagnostic`/`logClientTetherDiagnostic`**
  (`src/lib/tetherDiagnosticLog.ts`) — opt-in, non-production tracing for
  the launch pipeline. `isServerTetherDiagnosticLoggingEnabled` explicitly
  returns `false` whenever `deploymentEnvironment() === "production"` — by
  design, this is a development/staging debugging aid, not a production
  observability mechanism, and this pass does not change that.
- **`console.error`** — the actual production-visible mechanism. Every fix
  in this pass follows the existing convention already established by
  `consumeLaunchManifest`'s own breadcrumb (added during the P2028 fix):
  a short, greppable message prefixed with the function name, followed by
  a bounded object of safe fields only (ids, enum-like strings, error
  name/code — **never** the full error/stack, request body, session
  token, manifest, nonce, or any evidence content). This lands in Vercel's
  function logs regardless of environment.
- **`createPlatformAuditLog`** — the durable, queryable audit trail
  (`PlatformAuditLog` table). Already used extensively across
  installation registration/revocation, recovery denial, etc. Not
  extended in this pass — the gaps found were all missing
  *error*-path visibility, not missing *audit*-trail entries for normal
  operation, which was already well covered.

## Why these specific 9 checkpoints, and why these were the only 6 fixed

All 9 checkpoints named in the audit request were reviewed. Three already
had adequate failure logging (manifest consume, screen evidence upload,
camera evidence upload) and were left untouched. The other six had a
genuine, low-risk gap — each fix is a pure wrap-and-rethrow: no control
flow, response shape, or error code visible to any caller changed. This
was verified by running `npx tsc --noEmit` clean after every edit; the
DB-backed test suites covering these paths run under
`npm run release:validate` (Part R of this pass) against a disposable
Postgres instance, which is the authoritative verification for behavioral
equivalence.

## Recommended future alerts (not implemented — no monitoring vendor added)

These are recommendations for whatever alerting layer the institution
eventually adopts (Vercel's own log-drain/alerting, or a future APM). None
of this is wired up in this pass:

1. **Secure launch failure rate** — spike in non-2xx responses from
   `POST /api/submissions/[id]/secure-client/launch` or
   `POST /api/secure-client/launch/[manifestId]/consume` over a rolling
   window.
2. **P2028 / transaction-timeout recurrence** — any `console.error` from
   `consumeLaunchManifest` or the newly-instrumented functions above with
   `errorCode` indicating a Prisma transaction-timeout class of failure,
   which would indicate the P2028 fix's margin has been exceeded again
   (e.g. under materially higher load or worse cross-region latency).
3. **Attestation failure rate** — spike in `REPLAY`, `INVALID`, or
   thrown/unhandled outcomes from `verifySystemCheckAttestation` /
   `verifyExamSessionAttestation`.
4. **Recovery failure / manual-review rate** — spike in sessions reaching
   `MANUAL_REVIEW_REQUIRED` (see `resolveRecoveryState` in
   `src/lib/tetherRecovery.ts`) relative to total exam attempts.
5. **Evidence-storage 5xx rate** — failures from the screen-evidence and
   camera-evidence-frame upload routes.
6. **Unsupported client version rate** — spike in `CLIENT_VERSION_UNSUPPORTED`
   outcomes, which could indicate a cohort running a stale installer that
   needs an out-of-band nudge (see `docs/tether-pilot-support-runbook.md`,
   Case 5).
7. **API latency** — p95/p99 latency on the secure-client launch/consume/
   attestation endpoints, given the known cross-region (Vercel iad1 →
   Supabase AP-Northeast) latency profile — see
   `docs/tether-production-observability.md#region-follow-up` below.
8. **Database availability** — connection failures across any of the
   instrumented write paths above, which would now surface as
   `console.error` entries with `errorCode` values like `P1001`
   (can't reach database server).
9. **Abnormal crash/support-case rate** — a spike in students reaching
   Case 13 ("Tether closed unexpectedly") or Case 14 ("Recovery requires
   support") in the pilot support runbook, tracked manually during the
   pilot in the absence of an automated support-ticket integration.

## Region follow-up

**Documented here only — no region migration is performed in this pass.**

**Current confirmed state:** Vercel serverless functions run in `iad1`
(Washington, D.C., US) — this is the platform default; no `regions` or
`preferredRegion` configuration exists anywhere in this repo to override
it. The Supabase Postgres instance is provisioned in `AP-Northeast`
(Tokyo). Every database round trip from a request-serving function
therefore pays full US-East ↔ Japan cross-Pacific network latency, on
top of ordinary query time.

**Why this matters:** this cross-region latency was a direct contributing
factor in the P2028 ("query cannot be executed on an expired transaction")
incident fixed earlier in this project's history — the interactive
transaction in `consumeLaunchManifest` was making enough sequential
round trips that, at this latency, it could exceed Prisma's default
5-second interactive-transaction budget. The fix reduced the transaction's
round-trip count and added an explicit, larger, overridable timeout — it
mitigated the symptom, but did not, and could not, change the underlying
per-round-trip latency itself. Every other DB-touching request path in
this application (not just secure-launch consume) pays the same latency
tax on every query, all the time — it's just that most paths don't do
enough sequential round trips in one interactive transaction for it to
have caused a hard failure yet.

**Options for a future pass (not evaluated in depth here, not acted on):**

1. **Move Vercel functions closer to Supabase** — set `regions` (or per-
   function `preferredRegion`) to an APAC region nearer Tokyo. Tradeoff:
   moves the latency instead of eliminating it, from the DB-round-trip
   side to the client-request side, for any end users physically closer
   to `iad1` than to Tokyo — the right answer depends on where this
   platform's actual student/lecturer population is concentrated, which
   this document does not have data on.
2. **Move the Supabase project closer to Vercel's function region** —
   Supabase supports project region selection at creation time; migrating
   an existing project's region is a heavier operation (effectively a new
   project + data migration), out of scope for a quick config change.
3. **Read replicas / connection pooling tuned for cross-region latency**
   — could reduce impact for read-heavy paths without solving it for
   writes.
4. **Do nothing further for now** — acceptable at current pilot scale
   (the P2028 fix's timeout margin was chosen specifically to absorb this
   latency with headroom — see `docs/tether-release-management.md`'s
   discussion of that fix), revisited if either the P2028 alert
   recommended above starts firing again, or before broad commercial
   rollout meaningfully increases concurrent load.

**Recommendation:** treat this as a pre-broad-rollout item (see the P1
table in `docs/tether-v1.7.2-pilot-release-readiness.md`, "Vercel/Supabase
region optimisation"), not a pilot blocker — revisit once real usage data
shows where the actual student/lecturer population is concentrated, so
whichever side moves is an evidence-based decision rather than a guess.
