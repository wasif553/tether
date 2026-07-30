# Tether System Check and Exam Readiness v1

A student-facing "Check this computer" workflow that confirms whether the
current computer, Tether Secure Browser installation, and essential
permissions are ready for a secure examination — reducing exam-day
technical failures without weakening any existing secure-client
enforcement.

This is a **technical readiness feature**, not an integrity/misconduct
feature. Every result is one of `PASS` / `WARNING` / `BLOCKED` /
`NOT_CHECKED` at the per-check level, and `READY` / `READY_WITH_WARNINGS`
/ `NOT_READY` overall. Nothing here creates an `IntegrityEvent`, a
`Submission`, or labels a student as suspicious.

## Architecture

### Pure logic

- **`src/lib/systemCheck/readiness.ts`** — the single source of truth for
  the result model, the ten check ids, which are required vs optional,
  the aggregation function (`computeOverallStatus`), semantic
  client-version comparison, display-topology/camera/microphone/
  network/clock evaluation, expiry, `OFF`/`WARN`/`REQUIRE` mode
  resolution, and the final-examination gate
  (`evaluateFinalExamSystemCheckGate`). Every UI surface and API route
  reuses this module — nothing recomputes readiness independently.
- **`src/lib/systemCheckConfig.ts`** — the only place `process.env` is
  read for this feature (mode, validity hours, minimum supported
  version), each with a safe default.

### Persistence

One additive Prisma model, `TetherSystemCheckRun` (see
`prisma/schema.prisma`) — one row per completed check run, keyed by
`userId` (not per-exam: a student's readiness is about their computer,
not any one exam). `resultsJson` stores only the bounded
`{status, reasonCode}` pair per check id. See "Privacy" below for what is
explicitly never stored.

### API routes (`src/app/api/tether/system-check/`)

- `GET config` — mode, validity hours, minimum supported version, server
  clock.
- `GET latest` — the authenticated student's most recent run, with
  server-computed expiry.
- `POST runs` — persists one run. **Never trusts a client-supplied
  status for the checks that matter**: authentication, secure-client
  genuineness, client version, operating system, display topology, and
  bridge availability are all recomputed server-side from
  server-verified data (a real `SecureClientSession` row, a real version
  comparison, a real raw platform/topology/capability report) or a
  server-side comparison (the clock check, recomputed from the client's
  raw timestamp against this server's own clock). Camera, microphone,
  and network results are trusted as self-reported — lying about one's
  own camera/network provides no advantage, and neither is ever
  required for `READY` (see `OPTIONAL_CHECK_IDS`).
- `GET ping` — a dedicated, unauthenticated, trivial round-trip target
  for the network-connectivity check, alongside the existing
  `/api/auth/session`, `/api/version`, and `/api/readiness` endpoints.

### Why the secure-client check is usually `NOT_CHECKED` on a first run

Check B ("secure client") can only ever be a genuine `PASS` when the
POST body includes a `secureClientSessionId` that the server can verify
is (a) owned by the requesting student and (b) currently
`verificationStatus: "VERIFIED"`. A verified `SecureClientSession` only
ever exists in the context of a real exam attempt (the signed
launch-manifest + attestation flow — see
`docs/secure-client-foundation-seb-v1.md`), and the system check is
explicitly forbidden from creating a submission or starting an exam
itself. This means a student's **first-ever** standalone check (run from
the dashboard, before ever having taken a Tether-delivered exam) will
show "secure client: not checked" until they have gone through a real
Tether launch at least once. This is a deliberate, documented tradeoff —
see "Known limitations" below — not a bug: it is exactly what makes
`ordinary Chrome/Edge must never produce a fully ready result` true even
under a crafted raw HTTP request, since nothing server-side can be
fabricated into a genuine verified session.

### Ordinary browser vs Tether Secure Browser

Four checks are Tether-exclusive (`TETHER_ONLY_CHECK_IDS` in
`readiness.ts`) and always report `NOT_CHECKED` outside Tether: secure
client, client version, display topology, and the local secure-client
bridge. All four are also **required**, which is what guarantees an
ordinary browser can never reach `READY` — not a UI-level restriction,
a property of the aggregation function itself. Every other check
(authentication, operating system, camera, microphone, network, clock)
runs for real in an ordinary browser too, so a student gets genuinely
useful feedback before ever installing Tether.

### Electron (`apps/lockdown`)

Four narrowly scoped, read-only preload methods, added in v1.3.0:

- `getClientVersion()` → the packaged app's own version string.
- `getOperatingSystemInfo()` → `{ platform, release }` from Node's `os`
  module in the main process.
- `getDisplayTopology()` → an on-demand (not cached) native Windows
  topology read, reusing `windowsDisplayTopology.ts` /
  `windowsDisplayTopologyClassifier.ts` from the single-display
  enforcement feature (see `docs/lockdown-browser-known-limitations.md`).
- `getSecureClientCapabilities()` → which of the above four methods this
  build actually exposes (lets an older packaged install self-report as
  incomplete rather than silently failing).

Each is backed by exactly one `ipcRenderer.invoke` to one narrowly
scoped `ipcMain.handle`, returning only the named bounded value — no
generic IPC passthrough, no shell/filesystem/process/environment access.
`contextIsolation` stays enabled, `nodeIntegration` stays disabled,
`sandbox` stays enabled — unchanged from every prior release.

### Enforcement modes

| Mode | Behaviour |
| --- | --- |
| `OFF` | The check still works for students who use it, but nothing is required anywhere. |
| `WARN` (default) | Latest result shown; a current check is encouraged; exam start is never blocked by a missing/expired/not-ready record. |
| `REQUIRE` | A **final examination's** start route (`POST /api/exams/[id]/start`) is blocked (409, `code` one of `SYSTEM_CHECK_REQUIRED` / `SYSTEM_CHECK_EXPIRED` / `SYSTEM_CHECK_NOT_READY`) until a current `READY` or `READY_WITH_WARNINGS` record exists for that student. |

In every mode, and even when `REQUIRE` permits continuation: the real
exam-start preflight and verified secure-client checks always run again
unchanged. This gate only decides whether a student may proceed to the
(unmodified) Tether launch flow — it never itself authorises exam
content, and it only ever applies to a **brand-new** attempt, never to
resuming an already-`IN_PROGRESS` submission (so a mid-exam student can
never be locked out by a since-expired check).

Non-final assessments (practice, quiz/test, mid-semester) are never
affected by this gate, in any mode.

## Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `TETHER_SYSTEM_CHECK_MODE` | `WARN` | `OFF` \| `WARN` \| `REQUIRE`. Any missing/unrecognised value falls back to `WARN` — this feature can never accidentally block all students due to a configuration typo. |
| `TETHER_SYSTEM_CHECK_VALIDITY_HOURS` | `24` | Any missing/non-positive value falls back to the default. |
| `TETHER_MINIMUM_SUPPORTED_VERSION` | `1.3.0` | Compared against the client-reported Tether version (Check C) using semantic, not lexical, comparison. |

See `.env.example` for the exact same table inline with the rest of the
Tether configuration.

## Manual SQL application instructions

This project's Preview and Production deployments share one Supabase
database (see `docs/migration-ledger.md`) — schema changes are never
applied via `prisma db push`/`migrate`, only via a hand-written additive
SQL file applied manually through the Supabase SQL Editor.

**File:** `docs/sql/add-tether-system-check-readiness.sql`

1. Open the Supabase SQL Editor for the shared Preview/Production
   database.
2. Run the pre-application verification query at the top of the file —
   expect `NULL` (the table does not exist yet).
3. Run the file's `BEGIN; ... COMMIT;` block.
4. Run every post-application verification query at the bottom of the
   file — expect the table, all three indexes, and the foreign key to
   exist, with a row count of `0`.
5. Confirm existing tables are untouched by re-running the `Submission`
   / `SecureClientSession` / `IntegrityEvent` row-count queries included
   at the bottom of the file and comparing against a count taken before
   step 3.
6. Add one line to `docs/migration-ledger.md`'s "Confirmed applied" list
   once done.

This file was **not** applied by the assistant that generated it — apply
manually after review, per this project's standing safety rule.

## Release and rollback

- **Web app**: this feature is entirely additive (new files, new
  routes, new optional preload methods, one new table). Deploying the
  web app **before** the SQL file is applied is safe: every route that
  touches `TetherSystemCheckRun` is new, so nothing existing depends on
  the table existing yet — students simply won't be able to save a
  system-check result until the table exists (`POST runs` will 500;
  `GET latest` will error and the UI shows a "could not be saved"
  notice while still displaying local results). Deploying the SQL
  **before** the web app is equally safe (an empty additive table has no
  effect on anything). There is no ordering requirement between the two.
- **Rollback**: reverting the web app deployment requires no SQL
  rollback — the table simply stops being read/written. If the table
  itself ever needs to be removed, that is a separate, manually-reviewed
  `DROP TABLE IF EXISTS "TetherSystemCheckRun"` — not included in this
  release's SQL file, and not something to run without a fresh backup
  check first.
- **Emergency disable**: set `TETHER_SYSTEM_CHECK_MODE=OFF` (or leave
  `REQUIRE` never configured) to immediately stop this feature from
  blocking anything, with zero code deploy needed.

## Windows compatibility statement

Tether System Check and Exam Readiness v1 supports **Windows only** —
the same Windows versions already intended by Tether Secure Browser
(see `docs/lockdown-browser-known-limitations.md`). It does not claim
macOS, Chromebook/ChromeOS, Linux, or iPad support at any point: the
operating-system check (`evaluateOperatingSystem` in `readiness.ts`)
reports a clear "This operating system is not currently supported"
result for anything other than Windows, in both the ordinary-browser and
Tether-Secure-Browser code paths.

## Known limitations

- **First-run secure-client check**: see "Why the secure-client check is
  usually `NOT_CHECKED` on a first run" above — this is deliberate, not
  a defect.
- **Operating-system self-report in an ordinary browser** is inferred
  from `navigator.userAgentData`/`navigator.platform`/`navigator.userAgent`,
  which a sufficiently motivated user could spoof via browser DevTools.
  This does not weaken anything security-critical: the operating-system
  check is not one of the four Tether-exclusive checks, and even a
  perfectly spoofed browser environment still cannot produce a genuine
  `PASS` for secure client, client version, display topology, or the
  local bridge — so `READY` remains unreachable outside a real Tether
  installation regardless.
- **Native display-topology and bridge-capability reads over IPC** are,
  like every other native signal in this codebase, informational rather
  than cryptographically attested — see the same caveat already
  documented for the existing single-display enforcement feature in
  `docs/lockdown-browser-known-limitations.md`. This system check is
  explicitly advisory (see "Enforcement modes" above): the real
  security boundary remains the unmodified signed launch-manifest +
  attestation flow at actual exam start, which this feature never
  bypasses or replaces.
- **Network latency measurement** reflects one client-observed round
  trip per endpoint at the moment of the check — it is not a bandwidth
  test and never promises a guaranteed exam experience, only a
  directional signal with warning thresholds.
- No physical multi-monitor hardware was available to re-verify the
  Windows display-topology reads produced by `getDisplayTopology()`
  beyond what was already verified for the existing single-display
  enforcement feature it reuses — see that feature's own known
  limitations for the recommended physical smoke test.
