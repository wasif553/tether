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

Two additive Prisma models (see `prisma/schema.prisma`):

- **`TetherSystemCheckRun`** — one row per completed check run, keyed by
  `userId` (not per-exam: a student's readiness is about their computer,
  not any one exam). `resultsJson` stores only the bounded
  `{status, reasonCode}` pair per check id. See "Privacy" below for what
  is explicitly never stored.
- **`SystemCheckSecureClientVerification`** (corrective pass) — one row
  per successful SYSTEM_CHECK challenge/verify round trip. See "System-
  check secure-client verification" below.

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
- `POST secure-client/challenge`, `POST secure-client/verify` —
  corrective pass, see below.

### System-check secure-client verification (corrective pass)

**Root cause of the original limitation.** Check B ("secure client")
could originally only ever be a genuine `PASS` when the POST body
included a `secureClientSessionId` that the server could verify was (a)
owned by the requesting student and (b) currently
`verificationStatus: "VERIFIED"`. A verified `SecureClientSession` only
ever exists in the context of a real exam attempt (the signed
launch-manifest + attestation flow — see
`docs/secure-client-foundation-seb-v1.md`), and the system check is
explicitly forbidden from creating a submission or starting an exam
itself. This meant a student's **first-ever** standalone check showed
"secure client: not checked" until they had gone through a real Tether
exam launch at least once — defeating the actual point of a pre-exam
readiness check.

**The fix** is a second, purpose-scoped verification path that reuses
the exact same signing/nonce/replay-protection primitives as the real
exam-launch manifest flow, but is structurally incapable of touching
exam content:

1. `POST /api/tether/system-check/secure-client/challenge` — the
   authenticated student requests a short-lived (120s), signed
   `SystemCheckChallenge` (`src/lib/secureClient/systemCheckChallenge.ts`).
   `purpose` is always `"SYSTEM_CHECK"`, bound to `userSubjectHash`
   (a hash of the student's id, never the raw id/email), an `audience`
   string, `issuedAt`/`notBefore`/`expiresAt`, and a single-use `nonce`.
   Signed with the SAME Ed25519 private key as the real exam-launch
   manifest (`getSigningPrivateKey()` in `secureClientRunner.ts`) — no
   second signing key is introduced. **No database write happens here**
   — the challenge is a stateless, self-contained signed artifact, like
   the payload of a signed JWT.
2. Tether Secure Browser's renderer gathers real native facts via the
   existing `window.sesLockdown` bridge (`getClientVersion()`,
   `getOperatingSystemInfo()`) and echoes the challenge, its signature,
   and those facts to `POST .../secure-client/verify`.
3. The server **independently re-verifies everything** —
   `validateChallengeContext` re-checks the Ed25519 signature, `purpose
   === "SYSTEM_CHECK"`, `userSubjectHash` against the *currently
   authenticated* session (not whatever the request claims), and
   expiry/not-before/audience. It never reads or trusts a
   renderer-supplied `verified` boolean — there is no such field in the
   request body at all. Only once every check passes does it insert one
   `SystemCheckSecureClientVerification` row; a second verify attempt
   with the same nonce fails the `nonceHash` **unique constraint**
   outright (replay protection, identical in spirit to
   `consumeLaunchManifest`'s replay handling for the real exam flow).
4. The returned `verificationId` is passed to `POST .../runs` as
   `systemCheckVerificationId`. That route re-verifies ownership
   (`userId` match), `purpose`, `verificationStatus === "VERIFIED"`, and
   that the verification itself hasn't expired, before letting the
   `secureClient` check report `PASS` — mirroring exactly how
   `secureClientSessionId` was already handled for the exam-context
   case, just against a different table.

**IMPORTANT — steps 1–4 above are NOT sufficient on their own.** A
security review (see "Genuine client attestation" immediately below)
found that this challenge/verify round trip, by itself, only proves the
SERVER's own challenge signature round-tripped intact — it does **not**
prove the responder is a genuine packaged Tether Secure Browser
instance, since any authenticated browser (including an ordinary Chrome
tab) can request the same challenge and echo it back with entirely
fabricated `clientVersion`/`platform`/`displayTopologyClassification`
values. This gap has been closed — see the next section — and
`verifySystemCheckChallenge` now REQUIRES a second, independent
signature (`clientAttestation`) before ever writing a `VERIFIED` row.

### Genuine client attestation (security hardening pass)

**The vulnerability.** `window.sesLockdown` is a JavaScript object.
Nothing stops a technically capable student from opening DevTools in an
ordinary Chrome/Edge tab, navigating to `/student/system-check`, and
defining `window.sesLockdown = { getClientVersion: async () => "1.4.0",
getOperatingSystemInfo: async () => ({ platform: "win32" }), ... }`
themselves — a plain object with fake async functions that never touch
any real Electron process. The original challenge/verify flow described
above would have accepted this: it checked the SERVER's own signature,
the purpose, the subject, and the expiry, but never checked anything
that could only have come from genuine Electron code. The identical
weakness was independently confirmed in the **pre-existing real
exam-launch attestation flow**
(`POST /api/secure-client/sessions/[sessionId]/attestation` →
`recordAttestation` in `secureClientRunner.ts`) — that route also
accepts `checks`/`clientVersion`/`platform`/`displayTopology` directly
from the request body with no client-side signature at all. That
pre-existing flow was **not** modified by this pass (out of scope — see
"Known limitations"), but the finding is reported here for visibility.

**The fix — an embedded, build-time client-attestation keypair.**
Mirrors `TETHER_SECURE_CLIENT_SIGNING_PRIVATE_KEY` (server-side), just
on the client:

- **`apps/lockdown/src/clientAttestationKey.ts`** — a literal Ed25519
  PRIVATE key, generated once and compiled directly into every packaged
  Tether Secure Browser build. Never read from `process.env` at
  runtime (a locally double-clicked `.exe` has no deploy-time
  environment configuration to read), never sent over IPC to the
  renderer, never served over HTTP, never present in the web app's
  bundle. The only way to obtain it is to possess (or reverse-engineer)
  the installed native application's own compiled files — a
  categorically different, much higher bar than opening DevTools and
  defining a fake `window.sesLockdown` object.
- The matching **PUBLIC** key is configured server-side as
  `TETHER_CLIENT_ATTESTATION_PUBLIC_KEY` (see "Environment variables").
  Verification logic lives in
  `src/lib/secureClient/systemCheckClientAttestation.ts`.
- New main-process-only IPC handler `lockdown:attest-system-check`
  (exposed to the renderer as `window.sesLockdown.attestSystemCheck(nonce)`):
  takes ONLY the server-issued challenge nonce as input. Every fact in
  the response — `clientVersion` (the compiled-in `LOCKDOWN_VERSION`
  constant), `platform` (`process.platform`, read by main, not
  reported by the renderer), and `displayTopologyClassification` (a
  fresh on-demand native Windows topology read via the existing
  `displayEnforcement.getOnDemandDisplayTopology()`) — is gathered by
  the MAIN PROCESS itself. Main then builds the canonical string
  `SYSTEM_CHECK_ATTESTATION_V1|<nonce>|<clientVersion>|<platform>|<displayTopologyClassification>`
  and signs it with the embedded private key. The renderer receives
  only `{signature, clientVersion, platform, displayTopologyClassification}`
  — it never sees the key, never computes the signature, and cannot be
  made to sign attacker-chosen data (the canonical format is fixed and
  built entirely in `main.ts`).
- `POST .../secure-client/verify` now requires this `clientAttestation`
  object in its body (Zod-enforced — a request without it is rejected
  as malformed before any business logic runs). Server verification
  (`verifySystemCheckChallenge` in `systemCheckSecureClientRunner.ts`)
  performs **two independent signature checks**, both of which must
  pass:
  1. The server's own challenge signature (as before) — proves the
     challenge is genuine, current, and bound to this user/purpose.
  2. `verifyClientAttestation(...)` — reconstructs the SAME canonical
     string server-side from the reported nonce/clientVersion/platform/
     displayTopologyClassification and verifies the signature against
     `TETHER_CLIENT_ATTESTATION_PUBLIC_KEY`. If ANY fact was tampered
     with after main.ts signed it, or if the signature was produced by
     any other key (including one an attacker generated for themselves
     via WebCrypto or Node's `crypto` module), verification fails.
  Only when BOTH pass is a `VERIFIED` row ever written; a missing or
  invalid `clientAttestation` yields `CLIENT_ATTESTATION_INVALID`
  (400), and the request never reaches the database write.
- `POST .../runs` now pulls `clientVersion`/`platform`/
  `displayTopologyClassification` FROM the stored, signature-verified
  `SystemCheckSecureClientVerification` row whenever
  `systemCheckVerificationId` is used — never from the separate,
  unsigned body fields a browser could set to anything. This closes the
  loop for all three of Check B/C/E together, not just Check B.

**What exactly does each signature prove, and whose key produces it?**

| Signature | Signed by | Proves |
| --- | --- | --- |
| Challenge signature | Server's `TETHER_SECURE_CLIENT_SIGNING_PRIVATE_KEY` | This specific challenge was genuinely issued by this server, for this user, for SYSTEM_CHECK, and hasn't expired. Does **not** prove who is responding. |
| Client attestation signature | The embedded `clientAttestationKey.ts` private key, compiled into the packaged app, signed entirely inside the Electron main process | The responder possesses the private key that only exists inside a genuine packaged Tether Secure Browser installation, AND the specific nonce/clientVersion/platform/topology facts were exactly what main.ts gathered and signed — none of it was altered afterward. |

An ordinary Chrome/Edge tab can trivially produce the first signature
(by simply calling the challenge endpoint) but has no path to the
second: it does not possess, and cannot derive, the embedded private
key, and has no IPC channel to ask a genuine main process to sign on
its behalf.

**Why this is a separate table, not a nullable `submissionId` on
`SecureClientSession`.** Nothing in the exam start/launch/attestation
code path (`secureClientRunner.ts`, `secureClientStartGate.ts`,
`POST /api/exams/[id]/start`, `GET /api/submissions/[id]`) ever reads
`SystemCheckSecureClientVerification` — there is no code path by which
a SYSTEM_CHECK verification could be mistaken for, or accepted as, exam
launch authorization. This is a **structural** guarantee (the two
tables are simply unrelated), not a runtime check that could regress.
See `src/lib/tetherSystemCheck.routes.test.ts`, describe block "SYSTEM_CHECK
verification never authorises exam content", for the automated proof:
a verified SYSTEM_CHECK record for a student does not change the
behaviour of `POST /api/exams/[id]/start` or `GET /api/submissions/[id]`
one bit — the real exam still requires its own genuine, submission-bound
`SecureClientSession`.

A first-time student can now reach overall `READY` on their very first
standalone check, with zero prior exam activity.

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

A fifth, added in v1.4.0 (security hardening pass):

- `attestSystemCheck(nonce)` → `{ signature, clientVersion, platform,
  displayTopologyClassification } | null`. Takes only the server-issued
  challenge nonce; every fact in the response is gathered by the MAIN
  process itself (never an argument the renderer supplies) and signed
  with the embedded client-attestation private key
  (`clientAttestationKey.ts`) — see "Genuine client attestation" above.
  The renderer never sees that key and cannot make this method sign
  anything other than the one fixed canonical format main.ts builds.

Each is backed by exactly one `ipcRenderer.invoke` to one narrowly
scoped `ipcMain.handle`, returning only the named bounded value — no
generic IPC passthrough, no shell/filesystem/process/environment access.
`contextIsolation` stays enabled, `nodeIntegration` stays disabled,
`sandbox` stays enabled — unchanged from every prior release. The
embedded private key is compiled into `clientAttestationKey.ts` only —
no new IPC channel exposes it, reads it, or echoes it back in any form.

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

## Chrome / ordinary-browser behaviour (corrective pass)

The aggregation function (`computeOverallStatus`) was already correct —
see the explicit invariant tests added in `readiness.test.ts`, describe
block "corrective pass — aggregation invariants": a required `BLOCKED`
or `NOT_CHECKED` check always forces `NOT_READY`, `READY_WITH_WARNINGS`
requires every required check to be `PASS`/`WARNING` (never `BLOCKED`/
`NOT_CHECKED`) with at least one genuinely warning, and an ordinary
browser — where all four Tether-only checks are guaranteed `NOT_CHECKED`
— can never reach `READY` or `READY_WITH_WARNINGS`.

What the corrective pass changed is the **presentation**. Completing a
run in an ordinary browser with every web-safe check `PASS`/`WARNING`
(never an actual `BLOCKED` result among them) now shows:

> **Web checks completed**
> Open Tether Secure Browser to complete the required computer checks.

instead of the generic "This computer is not ready yet" headline — the
summary card stays neutral (gray border, no red), since Chrome being
unable to run native checks is expected and not a device failure. If a
web-safe check genuinely fails (e.g. camera permission denied), the
generic `NOT_READY` headline is shown instead, since that IS a real
finding worth flagging plainly. See
`isIncompleteOnlyDueToMissingNativeChecks` in
`src/app/student/system-check/page.tsx`. The underlying `overallStatus`
is `NOT_READY` in both cases — only the headline text differs.

## Safe DB-backed test execution (corrective pass)

**Root cause found:** `.env`/`.env.local`'s `DATABASE_URL` is the real
shared Preview/Production Supabase project (confirmed against
`scripts/releaseValidation/dbSafetyGuard.ts`'s own reject-list). A
direct `npx vitest run <file>` on any DB-backed test file — not just
this feature's — therefore connected to, and wrote test rows into, the
shared database. This was caught and all test rows were cleaned up (see
the session history); it is now fixed at the root, not just papered
over for one file.

**The fix:** `src/lib/prisma.ts` — the one module every route AND every
DB-backed test transitively gets its Prisma client from — now refuses
to construct a client at all when `process.env.VITEST === "true"` (set
automatically by Vitest in every test process, never outside one) and
`DATABASE_URL` doesn't resolve to a disposable loopback database. It
reuses `assertDisposableDatabaseUrl` from
`scripts/releaseValidation/dbSafetyGuard.ts` directly — the exact same
allow/deny list `npm run release:validate` already uses for its own
disposable-container check — rather than maintaining a second,
inconsistent copy of the Supabase project-ref/pooler-hostname markers.
See `src/lib/prismaDbSafetyGuard.test.ts` for the automated proof (an
unsafe `DATABASE_URL` throws before any query; a disposable localhost
one does not; the guard never runs outside a Vitest process).

**Why direct DB-backed `vitest run` commands are prohibited:** there is
no way to distinguish "a developer intentionally pointed DATABASE_URL at
a real disposable database they started themselves" from "a developer
ran the test file with whatever `.env` already has configured" without
inspecting the URL itself — and this repository's own `.env`/`.env.local`
happen to hold the real shared credential. The guard therefore treats
*any* non-loopback `DATABASE_URL` as unsafe under `VITEST=true`,
including this repository's own committed values. **Always use `npm run
release:validate`** (provisions and tears down a disposable Docker
Postgres container automatically) for any test file that touches the
database — `src/lib/finalExaminationPolicy.routes.test.ts`,
`src/lib/tetherSystemCheck.routes.test.ts`, and every other
`*.routes.test.ts`/DB-backed file in `src/lib/` are all protected by
this same guard now, uniformly, with no per-file configuration needed.

## Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `TETHER_SYSTEM_CHECK_MODE` | `WARN` | `OFF` \| `WARN` \| `REQUIRE`. Any missing/unrecognised value falls back to `WARN` — this feature can never accidentally block all students due to a configuration typo. |
| `TETHER_SYSTEM_CHECK_VALIDITY_HOURS` | `24` | Any missing/non-positive value falls back to the default. |
| `TETHER_MINIMUM_SUPPORTED_VERSION` | `1.4.0` | Compared against the client-reported Tether version (Check C) using semantic, not lexical, comparison. Versions before 1.4.0 cannot produce a genuine client attestation at all regardless of this setting. |
| `TETHER_CLIENT_ATTESTATION_PUBLIC_KEY` | *(none — required for real verification)* | The public half of the Ed25519 keypair embedded in the packaged Tether build — see "Genuine client attestation". Missing/misconfigured fails closed: every client-attestation signature check fails rather than being skipped. |

See `.env.example` for the exact same table inline with the rest of the
Tether configuration.

**The public key value to configure** for this build's embedded
private key (`apps/lockdown/src/clientAttestationKey.ts`, packaged into
v1.4.0):

```
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAVOWPXH0dOA8DKEQRDC+eiKnFTLEkTd9QniGFOaPukpI=
-----END PUBLIC KEY-----
```

### Key rotation

Rotating the embedded client-attestation key requires, in order: (1)
generate a new Ed25519 keypair, (2) replace the private key literal in
`clientAttestationKey.ts`, (3) bump `LOCKDOWN_VERSION`, (4) rebuild and
redistribute the packaged app, (5) update
`TETHER_CLIENT_ATTESTATION_PUBLIC_KEY` in every environment — steps 4
and 5 should land together, since a server updated before students have
the new build rejects every genuine v(old) client's attestation
(fail-closed, not fail-open — an outage, not a security gap, and
resolved simply by rolling the env var update out alongside the
release rather than ahead of it).

## Manual SQL application instructions

This project's Preview and Production deployments share one Supabase
database (see `docs/migration-ledger.md`) — schema changes are never
applied via `prisma db push`/`migrate`, only via a hand-written additive
SQL file applied manually through the Supabase SQL Editor.

**Files:**
- `docs/sql/add-tether-system-check-readiness.sql` (`TetherSystemCheckRun`)
- `docs/sql/add-system-check-secure-client-verification.sql`
  (`SystemCheckSecureClientVerification` — corrective pass)

Apply both the same way, independently (neither depends on the other):

1. Open the Supabase SQL Editor for the shared Preview/Production
   database.
2. Run the pre-application verification query at the top of the file —
   expect `NULL` (the table does not exist yet).
3. Run the file's `BEGIN; ... COMMIT;` block.
4. Run every post-application verification query at the bottom of the
   file — expect the table, its indexes, and the foreign key to exist,
   with a row count of `0`.
5. Confirm existing tables are untouched by re-running the `Submission`
   / `SecureClientSession` / `SecureClientLaunchManifest` /
   `IntegrityEvent` row-count queries included at the bottom of each
   file and comparing against a count taken before step 3.
6. Add one line per file to `docs/migration-ledger.md`'s "Confirmed
   applied" list once done.

Neither file was applied by the assistant that generated it — apply
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

- **(RESOLVED by the security hardening pass — kept here for history.)**
  The original SYSTEM_CHECK challenge/verify flow proved only that the
  challenge was genuine, current, single-use, and bound to the
  authenticated student — it did NOT prove the responder was genuinely
  Electron. See "Genuine client attestation" above for the fix (an
  embedded, build-time client-attestation keypair) and the "Mandatory
  security tests" in `tetherSystemCheck.routes.test.ts` for the
  automated proof that an ordinary browser (simulated by signing with a
  self-generated, non-embedded key) can no longer obtain a verified
  result.
- **The embedded client-attestation private key is a baked-in
  application secret, not a hardware-backed one** (no TPM/Secure
  Enclave attestation is used). A sufficiently determined attacker who
  reverse-engineers the packaged binary could theoretically extract it
  — the same class of limitation any embedded API key or code-signing
  key carries, and consistent with this codebase's existing,
  consistently-applied "cheat-resistant, not cheat-proof" stance (see
  `docs/lockdown-browser-known-limitations.md`). This is a categorically
  higher bar than the previous vulnerability (which required no more
  than opening DevTools), and this feature remains advisory (see
  "Enforcement modes") and structurally cannot authorise exam content
  regardless — the real security boundary is, and remains, the
  unmodified signed launch-manifest + attestation flow at actual exam
  start.
- **The pre-existing real exam-launch attestation flow
  (`POST /api/secure-client/sessions/[sessionId]/attestation` →
  `recordAttestation`) has the SAME unattested-facts weakness the
  original SYSTEM_CHECK design had** — it accepts `checks`/
  `clientVersion`/`platform`/`displayTopology` directly from the request
  body with no client-side signature. This was discovered while auditing
  the SYSTEM_CHECK trust chain and is reported here as an important,
  separate finding — it was deliberately NOT modified by this pass
  (out of scope: this task is scoped to the SYSTEM_CHECK flow), but
  applying the same embedded-key attestation pattern to the real exam
  launch flow would be a natural, valuable follow-up.
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
