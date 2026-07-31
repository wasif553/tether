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

Three additive Prisma models (see `prisma/schema.prisma`):

- **`TetherSystemCheckRun`** — one row per completed check run, keyed by
  `userId` (not per-exam: a student's readiness is about their computer,
  not any one exam). `resultsJson` stores only the bounded
  `{status, reasonCode}` pair per check id. See "Privacy" below for what
  is explicitly never stored.
- **`SystemCheckSecureClientVerification`** — one row per successful
  purpose-bound (`SYSTEM_CHECK` or `EXAM_SESSION`) challenge/verify
  round trip, including which `installationId` produced it. See
  "Secure Client Attestation v2" below.
- **`TetherClientInstallation`** (Secure Client Attestation v2) — one
  row per registered installation: its public key, fingerprint,
  self-reported `keyProtectionLevel`, and lifecycle `status`
  (`ACTIVE`/`REVOKED`/`REPLACED`). See "Secure Client Attestation v2"
  and "Database model" below.

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
  purpose-bound, installation-aware SYSTEM_CHECK attestation, see
  "Secure Client Attestation v2" below.

### Installation and exam-session routes (`src/app/api/tether/`)

- `POST installation/registration-challenge`, `POST installation/register`
  — per-installation key registration (proof-of-possession required).
- `GET installation/current` — the authenticated student's current
  `ACTIVE` installation, if any (bounded, non-secret fields only).
- `POST installation/[id]/revoke` — student self-service revocation.
- `POST exam-session/attestation/challenge`, `POST exam-session/attestation/verify`
  — additive `EXAM_SESSION`-purpose attestation; see "Real exam
  attestation — additive groundwork".

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

### Secure Client Attestation v2 (supersedes the withdrawn v1.4.0 design)

**v1.4.0's vulnerability — a single, globally-shared secret.** The first
hardening pass fixed "any browser can echo a signed challenge back with
self-reported facts" by adding a SECOND signature, but signed it with
ONE Ed25519 private key compiled into **every** packaged build
(`clientAttestationKey.ts`, since deleted). A security review correctly
identified this as a critical flaw: a private key embedded in a
globally distributed installer/packaged Electron resources/process
memory is extractable (reverse-engineering, not merely opening
DevTools), and extracting it **once** would have let an attacker forge
attestations for **every** installation — there was no way to tell
genuine installations apart or revoke a compromised one without
shipping a whole new build to everybody. v1.4.0 has been **withdrawn**
and must never be distributed; see "Release and rollback".

**The fix — a per-installation keypair, not a shared one.** Every
Tether Secure Browser installation now generates and registers its OWN
Ed25519 keypair the first time it needs one:

- **`apps/lockdown/src/installationKey.ts`** — generates the keypair
  with Node's `crypto` and persists it via `electron-store`, with the
  PRIVATE half encrypted at rest using Electron's `safeStorage` (DPAPI
  on Windows). Decrypted into memory only for the instant a signing
  operation needs it. Never returned by any exported function, never
  sent over any IPC channel, never written to disk in plaintext.
- **`TetherClientInstallation`** (new table, see "Persistence" and
  "Database model") — the server-side registry. Each row is one
  installation's registered PUBLIC key, fingerprint, self-reported
  `keyProtectionLevel`, and `status` (`ACTIVE`/`REVOKED`/`REPLACED`).
- **Registration** (`POST /api/tether/installation/registration-challenge`
  then `POST /api/tether/installation/register`): the student proves
  possession of the private key matching the public key being
  registered by signing a server-issued nonce with it. Registering a
  new installation automatically marks any prior `ACTIVE` installation
  for that user `REPLACED` — at most one `ACTIVE` installation per user
  at a time (see "Known limitations" for the multi-device UX tradeoff
  this implies).
- **Revocation** (`POST /api/tether/installation/[id]/revoke`) — the
  owning student can self-revoke (lost/compromised device). A
  `REVOKED` or `REPLACED` installation can never again produce a
  `VERIFIED` attestation, even against an otherwise-valid outstanding
  challenge — checked fresh at verify time, not just at challenge-issue
  time.
- **Purpose-bound attestation challenge**
  (`src/lib/secureClient/tetherAttestation.ts`,
  `src/lib/systemCheck/tetherAttestationRunner.ts`) — one shared
  framework for two purposes, `SYSTEM_CHECK` and `EXAM_SESSION`. Every
  challenge binds `installationId` + that installation's PINNED
  `publicKeyFingerprint` (read from the DB at challenge-issue time, so
  a mid-flow key swap invalidates the signature); `EXAM_SESSION`
  additionally binds `examId`/`submissionId`/a `policyHash`. The
  installation signs a purpose-tagged canonical string
  (`buildSystemCheckAttestationCanonicalString` /
  `buildExamSessionAttestationCanonicalString`) — the `"SYSTEM_CHECK"` /
  `"EXAM_SESSION"` tag means a signature for one purpose can never be
  reinterpreted as the other, even if every other field happened to
  collide.
- Two new preload methods mirror this: `attestSystemCheck(nonce)` and
  `attestExamSession({nonce, examId, submissionId, policyHash})`. Both
  gather every fact (client version, platform, native display topology,
  display count) in the MAIN process and sign there — the renderer
  supplies only the server-issued binding values, never chooses what
  gets signed.

**What exactly does each signature prove, and whose key produces it?**

| Signature | Signed by | Proves |
| --- | --- | --- |
| Challenge signature | Server's `TETHER_SECURE_CLIENT_SIGNING_PRIVATE_KEY` | This specific challenge was genuinely issued by this server, for this user, this installation, this purpose, and hasn't expired. Does **not** prove who is responding. |
| Installation signature | That ONE installation's own private key, generated on-device and never shared with any other installation | The responder possesses the specific private key registered for `installationId`, AND the exact nonce/facts/purpose/exam-binding were unaltered since the installation signed them. |

**The honest limit of this design — read before relying on it.** Per-
installation keys fix *compromise containment* (one installation's key
leaking never affects any other installation) and *revocability* (a
suspicious installation can be cut off immediately) — but registration
itself is inherently **trust-on-first-use**: proof of possession only
proves "whoever registered this key can sign with it," which is
equally true whether that "whoever" is a genuine packaged Electron app
or a scripted HTTP client (curl, a test harness, a browser using
WebCrypto) that generates its own key and drives the registration +
attestation endpoints directly. **No purely software key-based scheme —
this one included — can cryptographically distinguish "signed by
genuine Electron main.ts" from "signed by any other process holding the
same class of key" without real hardware-backed remote attestation**
(TPM quote + attestation-authority verification), which this pass does
**not** implement — see "Known limitations". What v2 genuinely
guarantees, and what it does not, are listed there explicitly; the
mandatory security tests in `tetherSystemCheck.routes.test.ts` are
scoped to prove exactly the former, not the latter.

**Why `SystemCheckSecureClientVerification` is a separate table, not a
nullable `submissionId` on `SecureClientSession`.** Nothing in the exam
start/launch/attestation code path (`secureClientRunner.ts`,
`secureClientStartGate.ts`, `POST /api/exams/[id]/start`,
`GET /api/submissions/[id]`) ever reads
`SystemCheckSecureClientVerification` — there is no code path by which
a SYSTEM_CHECK verification could be mistaken for, or accepted as, exam
launch authorization. This is a **structural** guarantee (the two
tables are simply unrelated), not a runtime check that could regress.
See `src/lib/tetherSystemCheck.routes.test.ts` for the automated proof:
a verified SYSTEM_CHECK record for a student does not change the
behaviour of `POST /api/exams/[id]/start` or `GET /api/submissions/[id]`
one bit — the real exam still requires its own genuine, submission-bound
`SecureClientSession`, governed entirely by the unmodified legacy
`recordAttestation()` flow.

A first-time student can now reach overall `READY` on their very first
standalone check, with zero prior exam activity.

### Real exam attestation — additive groundwork

The pre-existing real exam-launch attestation route
(`POST /api/secure-client/sessions/[sessionId]/attestation` →
`recordAttestation` in `secureClientRunner.ts`) has the SAME
unattested-facts weakness the original SYSTEM_CHECK design had — it
accepts `checks`/`clientVersion`/`platform`/`displayTopology` directly
from the request body with no client-side signature at all. This was
flagged as an important finding during the first hardening pass.

This pass adds a NEW, purely additive `EXAM_SESSION` attestation
purpose (`POST /api/tether/exam-session/attestation/challenge` +
`.../verify`) that DOES genuinely verify an installation-signed
attestation bound to a specific exam/submission/policy hash — but it
deliberately does **not** wire that verification into
`SecureClientSession.status`/`.verificationStatus`, which remain
governed entirely by the existing, unmodified `recordAttestation()`
flow. A successful `EXAM_SESSION` verification only populates the
existing (previously dormant — confirmed never written by any code
path before this pass) `SecureClientSession.clientInstallationIdHash`
field. This is a deliberate scoping decision, not an oversight: wiring
new attestation logic into the actual READY/CANNOT_START decision for
live exam-taking is a change with real production blast radius that
deserves its own dedicated, separately-reviewed pass — see "Compatibility
and rollout" below and "Known limitations". `TETHER_REQUIRE_EXAM_SESSION_V2`
exists now (defaulting to unset/false) so that future enforcement work
has a config surface ready to attach to.

### Compatibility and rollout

- `ATTESTATION_PROTOCOL_VERSION = 2` (`src/lib/tetherAttestationConfig.ts`)
  — the protocol version this server issues challenges under. There is
  no v1 SYSTEM_CHECK code path any more (removed entirely, not merely
  deprecated) — v1.4.0 clients get `ATTESTATION_UNAVAILABLE` /
  `INSTALLATION_UNAVAILABLE`, never a silently-accepted weaker result.
- `TETHER_LEGACY_ATTESTATION_ALLOWED` (default: accepted/unset) governs
  whether the LEGACY real exam-launch attestation route remains
  accepted. Defaults to accepted because that route is still the ONLY
  thing that establishes a verified `SecureClientSession` for a real
  exam — flipping this before `EXAM_SESSION` v2 is genuinely wired into
  that decision would lock every student out of every Tether-required
  exam.
- `TETHER_REQUIRE_EXAM_SESSION_V2` (default: `false`) — reserved for a
  future pass; the enforcement path it would gate does not exist yet.
- **Transition plan**: Phase 1 (this pass) — `EXAM_SESSION` v2 is
  additive/optional; the legacy flow remains the sole real gate. Phase 2
  (future, requires physical validation on real hardware first) — wire
  `EXAM_SESSION` v2 into the exam-start/content gate for NEWLY created
  final examinations only, behind `TETHER_REQUIRE_EXAM_SESSION_V2`,
  with the legacy path still available as a fallback. Phase 3 (future) —
  once Phase 2 has run in Production without incident, consider
  flipping defaults and deprecating the legacy path. **This pass does
  not enable Phase 2 or 3 in Production** — no enforcement code path
  reads `TETHER_REQUIRE_EXAM_SESSION_V2` yet.
- Forced client upgrade: setting `TETHER_MINIMUM_SUPPORTED_VERSION` to
  `1.5.0` (the default) already reports any older client as `BLOCKED`
  for the readiness check; a genuinely forced upgrade (refusing exam
  start outright below a version floor) is a natural extension of the
  same `evaluateClientVersion` comparison but is not separately wired
  into exam-start enforcement in this pass.

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
| `TETHER_MINIMUM_SUPPORTED_VERSION` | `1.5.0` | Compared against the client-reported Tether version (Check C) using semantic, not lexical, comparison. v1.4.0 shipped a critical vulnerability and has been withdrawn — see "Release and rollback". |
| `TETHER_LEGACY_ATTESTATION_ALLOWED` | accepted (any value other than the exact string `"false"`) | Whether the legacy, pre-v2 real exam-launch attestation route remains accepted — see "Compatibility and rollout". |
| `TETHER_REQUIRE_EXAM_SESSION_V2` | `false`/unset | Reserved for a future pass — no enforcement code path reads this yet. |

See `.env.example` for the exact same table inline with the rest of the
Tether configuration. There is no server-side "attestation public key"
environment variable in v2 — each installation's public key is stored
per-row in `TetherClientInstallation`, not configured globally.

### Key rotation / compromise response

Unlike v1.4.0's single embedded key (which required a coordinated
key+env-var+rebuild rotation across every installation at once), v2 is
per-installation, so compromise response is scoped to exactly the
affected installation(s):

- **One student's device is lost, stolen, or suspected compromised**:
  that student (or, once an administrative surface exists — see "Known
  limitations") calls `POST /api/tether/installation/[id]/revoke`. That
  installation can never attest again; every other installation is
  completely unaffected.
- **A student gets a new/reimaged computer**: simply re-registering
  (the normal first-run flow) automatically marks the old installation
  `REPLACED` — no explicit revoke action needed.
- **The server's OWN `TETHER_SECURE_CLIENT_SIGNING_PRIVATE_KEY` is
  compromised** (unchanged from before v2 — this key signs CHALLENGES,
  not installation attestations): rotate it exactly as documented in
  `docs/secure-client-foundation-seb-v1.md`; every installation's
  registration remains valid since installation keys are independent of
  it.

## Manual SQL application instructions

This project's Preview and Production deployments share one Supabase
database (see `docs/migration-ledger.md`) — schema changes are never
applied via `prisma db push`/`migrate`, only via a hand-written additive
SQL file applied manually through the Supabase SQL Editor.

**Files:**
- `docs/sql/add-tether-system-check-readiness.sql` (`TetherSystemCheckRun`)
- `docs/sql/add-system-check-secure-client-verification.sql`
  (`SystemCheckSecureClientVerification`, now including the required
  `installationId` column added by Secure Client Attestation v2)
- `docs/sql/add-tether-client-installation.sql` (`TetherClientInstallation`
  — Secure Client Attestation v2; apply this one first, or together with
  the one above, since it is the more intuitive order even though
  `installationId` has no enforced foreign key)

Apply all three the same way, independently (none strictly depends on
another at the SQL level, since advisory pointers are used throughout
rather than foreign keys — see each file's own doc comment):

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
- **v1.4.0 is WITHDRAWN and must never be distributed.** It shipped a
  single Ed25519 private key compiled into every packaged build
  (`clientAttestationKey.ts`, since deleted from source) — extracting it
  from any one installation would have compromised every installation's
  attestation. The local `.exe`/`win-unpacked` build artifacts for
  v1.4.0 have been deleted from this working tree (they were never
  committed to git — `apps/lockdown/release/` is gitignored — and were
  never pushed, merged, or deployed). If a v1.4.0 build was EVER
  installed on any real machine outside this development environment, it
  must be uninstalled and replaced with v1.5.0+; do not attempt to
  "patch" it in place. `TETHER_MINIMUM_SUPPORTED_VERSION` defaults to
  `1.5.0` specifically so a v1.4.0 client is reported as unsupported by
  the readiness check even if one somehow remains installed somewhere.

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

- **(HISTORY — resolved, then superseded.)** The very first
  challenge/verify design proved only that the server's own challenge
  was genuine — not that the responder was genuinely Electron. A first
  hardening pass "fixed" this with a single Ed25519 key compiled into
  every packaged build; a security review correctly identified THAT as
  a critical flaw (one extraction compromises every installation), and
  it has been withdrawn — see "Secure Client Attestation v2" above for
  the current per-installation design.
- **Registration is inherently trust-on-first-use — read this
  carefully before relying on `keyProtectionLevel` for anything beyond
  labelling.** Per-installation keys solve compromise containment and
  revocability, but do NOT, by themselves, cryptographically prove a
  registering party is genuine Electron rather than a scripted HTTP
  client (curl, a test harness, browser WebCrypto) driving the
  registration + attestation endpoints directly. Proof of possession
  only proves "whoever registered this key can sign with it" — which is
  true of ANY party that generated that key, genuine app or not. This
  release implements ONLY `SOFTWARE_PROTECTED` registration (no real
  TPM/CNG hardware binding — see below), so this is a genuine, present
  limitation, not a hypothetical one. What v2 DOES guarantee, precisely:
  (1) no single secret's compromise cascades to other installations;
  (2) a suspicious installation is immediately and independently
  revocable; (3) the system never MISREPRESENTS a self-registered
  software key as `TPM_ATTESTED` (registration explicitly rejects that
  claim — see the mandatory tests); (4) this feature remains advisory
  (see "Enforcement modes") and structurally cannot authorise exam
  content regardless of any of the above — the real security boundary
  for an actual exam attempt is, and remains, the unmodified legacy
  `recordAttestation()` flow at real exam start.
- **Real hardware-backed (TPM/CNG) key storage was investigated and
  deliberately NOT implemented this pass.** Windows supports TPM-backed,
  non-exportable keys via the Microsoft Platform Crypto Provider (CNG),
  reachable from Node/Electron via a spawned PowerShell script — the
  same pattern already used for `windowsDisplayTopology.ts`. This was
  not attempted because (a) no TPM hardware was available in this
  development environment to verify the implementation against, and (b)
  shipping unverified native-crypto code that could silently fail
  signing is worse than being explicit about the gap. `keyAlgorithm`
  (`"ECDSA_P256"` reserved) and `keyProtectionLevel`
  (`"TPM_UNATTESTED"`/`"TPM_ATTESTED"` reserved) in
  `TetherClientInstallation` already accommodate this without a further
  schema change once implemented.
- **Genuine remote TPM attestation (proving to the SERVER that a key
  really came from a TPM, not merely that a CNG provider was
  requested) requires attestation-authority infrastructure this
  codebase does not have** — either a custom TPM-quote verification
  service or an external one (e.g. Microsoft Azure Attestation). Until
  that infrastructure exists, `TPM_ATTESTED` can never be legitimately
  issued by this system, and the registration route enforces that by
  rejecting any client-claimed `TPM_ATTESTED` value outright (never
  silently downgrading it — a downgrade would be indistinguishable from
  an honest `SOFTWARE_PROTECTED` registration in the audit trail).
- **The pre-existing real exam-launch attestation flow
  (`POST /api/secure-client/sessions/[sessionId]/attestation` →
  `recordAttestation`) still has the unattested-facts weakness** — it
  accepts `checks`/`clientVersion`/`platform`/`displayTopology` directly
  from the request body with no client-side signature verification
  gating `verificationStatus`/`status`. This pass adds a genuinely
  verified, purpose-bound, installation-signed `EXAM_SESSION`
  attestation path (`POST /api/tether/exam-session/attestation/*`) but
  deliberately keeps it ADDITIVE ONLY (see "Real exam attestation —
  additive groundwork") rather than wiring it into the actual
  READY/CANNOT_START decision, to avoid an undertested change to the
  live exam-taking path in this single pass. Wiring `EXAM_SESSION` v2
  into that decision (Phase 2 of "Compatibility and rollout") is the
  recommended, valuable follow-up.
- **No administrative (lecturer/platform-admin) installation-revocation
  surface exists yet** — only student self-service revocation
  (`POST /api/tether/installation/[id]/revoke`). An institution wanting
  to revoke a specific student's installation (e.g. a shared lab
  computer flagged for reuse) would need direct database access today.
- **At most one `ACTIVE` installation per user at a time** — registering
  a new installation automatically replaces any prior one. A student
  with two legitimate devices (e.g. home + campus lab) must re-register
  each time they switch, rather than maintaining both simultaneously.
  Multi-device support was out of scope for this pass.
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
