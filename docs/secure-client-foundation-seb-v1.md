# Tether Secure Client Foundation + Safe Exam Browser Compatibility v1

## Purpose

This feature adds a foundation for stronger device controls during an
exam attempt, on top of the existing fully-functional web examination
platform:

1. **Examination delivery modes** — a per-exam choice of how strict the
   client environment must be, from ordinary browser delivery up to a
   secure client being required.
2. **Safe Exam Browser (SEB) compatibility** — the platform can be
   configured as a Safe Exam Browser exam, verified via the official
   Browser Exam Key / Config Key protocol (header-based and JavaScript-
   API-based).
3. **Signed secure-launch manifests** — a short-lived, single-use,
   Ed25519-signed manifest binds one launch to one institution, exam,
   submission, student, policy snapshot, and client type.
4. **Secure-client session and attestation contracts** — a documented
   session state machine, heartbeat/interruption/recovery model, and a
   strict, bounded preflight/attestation schema, so a future desktop
   client (or SEB) has a stable contract to integrate against.
5. **Device-preflight and integrity-event infrastructure** — structured,
   typed integrity signals, never an automatic misconduct verdict.
6. **Lecturer and student secure-client interfaces** — configuration,
   session dashboards, and a compatibility page.
7. **A mock Tether client** for safe testing, clearly labelled as a
   development simulator.

**This feature does NOT build the production Windows desktop lockdown
application.** That remains a documented contract only — see
[`docs/tether-secure-client-windows-architecture.md`](tether-secure-client-windows-architecture.md).
The web examination platform (as delivered by every prior feature in
this repository) remains fully functional without Safe Exam Browser or
any Tether client — every new setting defaults to disabled/`STANDARD_WEB`.

## Product language

This feature and its UI consistently use: secure examination mode,
stronger device controls, secure-client session, client verification,
preflight check, integrity signal, action required, needs lecturer
review, possible technical issue, human decision, alternative
explanation, cheat-resistant. The Single Display Requirement adds:
additional display, mirrored display, extended display, display
requirement, needs review, secure exam requirement, configuration
restored.

It never claims: cheat-proof, impossible to bypass, proof of cheating,
detected cheating, automatic misconduct, that a student is guilty,
guaranteed screenshot prevention, guaranteed blocking, or complete
lockdown. No examination technology described here can prevent every
form of unauthorised assistance, and the UI says so explicitly (see the
student compatibility page). STANDARD_WEB never claims to reliably detect
a second monitor.

## Delivery modes

Defined in [`src/lib/secureClientPolicy.ts`](../src/lib/secureClientPolicy.ts):

| Mode | Secure client | Behaviour |
|---|---|---|
| `STANDARD_WEB` | none | Default. Existing behaviour, unchanged. |
| `MONITORED_WEB` | none | Existing camera/screen-share/integrity evidence only — no new client requirement. |
| `SEB_OPTIONAL` | SEB, optional | Students may use an approved Safe Exam Browser configuration; standard web still works. |
| `SEB_REQUIRED` | SEB, required | Attempt start is blocked (409 `SEB_NOT_CONFIGURED`/`SEB_CLIENT_REQUIRED`) until verified. |
| `TETHER_CLIENT_OPTIONAL` / `TETHER_CLIENT_REQUIRED` | future Tether client | Reserved for the future Windows client; **disabled in this release** — the lecturer UI shows these as disabled with "Planned for examinations requiring stronger device controls." |

Every exam defaults to `STANDARD_WEB`. `resolveEffectiveDeliveryMode()`
is the single source of truth used by both the settings UI and the
`start` route.

## Immutable per-attempt snapshot

`Submission.secureClientPolicySnapshotJson` (nullable `Json`) is built
once via `buildSecureClientPolicySnapshot()` when a submission is
created and never modified afterwards — the same pattern as
`examPolicySnapshotJson`, `aiAssistancePolicySnapshotJson`,
`screenSharePolicySnapshotJson`, and
`answerProvenancePolicySnapshotJson`. `parseSecureClientPolicy()` reads
it back; `null` is always treated as `STANDARD_WEB` / every secure-client
control disabled. A lecturer changing exam settings mid-attempt can
never retroactively tighten or loosen an attempt already in progress.

## Database models

Seven new tables, documented field-by-field in `prisma/schema.prisma`:

- **`SecureClientConfiguration`** — one lecturer-managed provider
  configuration per exam (`SAFE_EXAM_BROWSER` or `TETHER_SECURE_CLIENT`),
  versioned, `DRAFT` until explicitly `ACTIVE`. At most one `ACTIVE` row
  per `(examId, provider)`, enforced by a partial unique index.
- **`SebAllowedExamKey`** — accepted Browser Exam Key / Config Key
  values. Only a SHA-256 `keyHash` (for lookup) and an AES-256-GCM
  `rawKeyCiphertext` (needed for the reversible per-request hash
  protocol — see "Known limitations") are ever stored; the raw key is
  never returned to any client after entry.
- **`SecureClientLaunchManifest`** — one short-lived, single-use signed
  launch. Only `nonceHash` is stored, never the raw nonce.
- **`SecureClientSession`** — one verified/attempted session per
  submission. At most one non-terminal session per submission, enforced
  by a partial unique index (`status NOT IN ('ENDED', 'REJECTED')`).
- **`SecureClientAttestation`** — one structured preflight/verification
  result per report, strict per-check fields only.
- **`SecureClientEvent`** — structured integrity signals with a strict,
  discriminated per-`eventType` metadata schema. No event is itself a
  misconduct label.
- **`SecureClientRecoveryGrant`** — one lecturer-issued, one-time
  recovery credential; only `grantCodeHash` is stored.

## Safe Exam Browser configuration

Two paths, both under `/lecturer/exams/[id]/secure-client`:

1. **Admin-provided**: a lecturer adds one or more accepted Browser Exam
   Keys / Config Keys (masked fingerprint shown; full value never
   redisplayed) generated by their institution's existing SEB config
   tooling.
2. **Tether-generated plain config**: `generatePlainSebConfig()` in
   [`src/lib/secureClient/sebConfigGenerator.ts`](../src/lib/secureClient/sebConfigGenerator.ts)
   deterministically builds a `.seb` XML plist from a conservative,
   documented allowlist of keys (`SUPPORTED_SEB_CONFIG_KEYS`) — start
   URL, quit URL, and the platform's own basic lockdown toggles. There is
   **no encrypted `.seb` (`pswd`-protected) config generator** in this
   release; requesting one returns
   `ENCRYPTED_SEB_CONFIG_UNAVAILABLE_MESSAGE` rather than a fabricated
   implementation.

Client verification (both header-based and JavaScript-API-based) follows
the official SEB protocol: `expectedHash = SHA256(canonicalRequestUrl +
rawKey)`, compared against `X-SafeExamBrowser-RequestHash` /
`X-SafeExamBrowser-ConfigKeyHash`, or against
`window.SafeExamBrowser.security.updateKeys()` results reported by the
client — see
[`src/lib/secureClient/sebBrowserExamKey.ts`](../src/lib/secureClient/sebBrowserExamKey.ts)
and
[`src/lib/secureClient/sebJavascriptApi.ts`](../src/lib/secureClient/sebJavascriptApi.ts).
Every configured key is checked (never short-circuited), comparisons use
`crypto.timingSafeEqual`, and the response never reveals which key
matched. `buildCanonicalRequestUrl()` /
[`src/lib/secureClient/canonicalOrigin.ts`](../src/lib/secureClient/canonicalOrigin.ts)
resolve the canonical origin from an explicit allowlist (`APP_URL`) —
never a trusted raw/forwarded `Host` header, since this app runs behind
Vercel's proxy.

## Display requirement (Single Display Requirement v1)

Lets a lecturer require students to use a single active display for an
exam — "additional display", "mirrored display", and "extended display"
are all rejected the same way: by refusing to run at all with more than
one display connected. This does **not** distinguish mirror vs. extend at
the topology level — see the capability table below for exactly what is
and isn't implemented.

**Model.** `displayPolicy: "UNRESTRICTED" | "SINGLE_DISPLAY_REQUIRED"` —
see `DISPLAY_POLICIES`/`isValidDisplayPolicy` in
[`src/lib/secureClientPolicy.ts`](../src/lib/secureClientPolicy.ts). Lives
in the same JSON policy model as every other secure-client setting (no new
database column, no migration) — `secureExamSettingsSchema` in
[`src/lib/secureExam.ts`](../src/lib/secureExam.ts), frozen into the
immutable per-attempt `Submission.secureClientPolicySnapshotJson` snapshot
by `buildSecureClientPolicySnapshot()` exactly like `deliveryMode` itself.
Defaults to `UNRESTRICTED` for every existing exam and every legacy
snapshot that predates this field.

**Valid combinations.** `isDisplayPolicyCombinationValid()` allows
`SINGLE_DISPLAY_REQUIRED` only alongside `SEB_REQUIRED` or `SEB_OPTIONAL`
— never `STANDARD_WEB` or `MONITORED_WEB`, which have no mechanism to
enforce or even observe display topology. Enforced twice: server-side in
`PATCH /api/exams/[id]` (400 if invalid) and again inside
`buildSecureClientPolicySnapshot()`/`parseSecureClientPolicy()` themselves
(so a SEB_REQUIRED exam whose availability gets downgraded to
STANDARD_WEB at attempt start — see `resolveEffectiveDeliveryMode()` —
can never freeze a `SINGLE_DISPLAY_REQUIRED` snapshot it can't actually
enforce).

**Capability table:**

| Delivery mode | Can it verify display topology? | What this feature does |
|---|---|---|
| `STANDARD_WEB` | **No.** Cannot reliably verify the number or topology of connected displays — no legitimate browser API exposes this, and `screen.availWidth`/window position/CSS media queries are not trustworthy security signals (they describe the browser window, not the display hardware). | `displayPolicy` is always `UNRESTRICTED` here; the preflight/status APIs and student UI report "Not enforceable in standard web mode," never a false PASS. |
| `SCREEN_SHARE_REQUIRED` (Screen-share Evidence Mode v1, a separate feature — see `docs/screen-share-evidence-v1.md`) | **Partial.** Can require sharing an entire display as evidence. **Cannot prove another display is absent** — a student can share one display while a second, unshared display sits next to it. | Unrelated to `displayPolicy`; not a substitute for it. |
| `SEB_REQUIRED` with `displayPolicy: SINGLE_DISPLAY_REQUIRED` | **Count-based, plus mirroring explicitly disabled.** SEB's official `allowedDisplaysMaxNumber` setting (see below) limits the allowed display count to one where SEB's display validation supports it; `allowDisplayMirroring=false` explicitly disables display mirroring on supported SEB platforms. Neither setting performs direct topology classification. Requires real Safe Exam Browser validation before any Production claim (see the manual checklist below) — not yet performed in this implementation pass. | `sebConfigGenerator.ts` sets both `allowDisplayMirroring` (`false`) and `allowedDisplaysMaxNumber` (`1`) in the generated `.seb` configuration; `SEB_OPTIONAL` gets the same treatment when a student actually launches via SEB. |
| Future native Tether client (Windows) | **Would be able to report trusted display count and topology** (`SINGLE`/`CLONE`/`EXTEND`/`EXTERNAL_ONLY`/`UNKNOWN`) via the bounded, optional attestation fields already reserved for it (`SecureClientAttestation.displayCount`, `displayTopology` inside `detailsJson`) — see "Secure-client attestation" below. **Not implemented in this task** — see `docs/tether-secure-client-windows-architecture.md`. |

**Safe Exam Browser configuration keys.** `allowDisplayMirroring`
(boolean) and `allowedDisplaysMaxNumber` (integer) — both confirmed by the
official SEB developer config-key reference
(`safeexambrowser.org/developer/seb-config-key.html`, which lists them
together: `allowDisplayMirroring` example value `false`,
`allowedDisplaysMaxNumber` example value `1`, described there as
"specifies the maximum number of displays that can be connected") and an
official demo `.seb` file published by the SafeExamBrowser GitHub
organisation. What this codebase claims about them, and no more:
`allowedDisplaysMaxNumber` is the documented SEB
maximum-connected-display setting; `allowDisplayMirroring=false`
explicitly disables display mirroring on supported SEB platforms;
limiting the allowed display count to one prevents operation with more
than one display where SEB's display validation supports it; real-device
validation against an actual SEB installation is still required before
relying on this for a live exam. `allowedDisplayBuiltin` is deliberately
**not** set — the policy requires one active display, not specifically
the device's built-in display. No other display-related SEB key (no
`maxDisplays` or `allowExternalScreen` — neither is a real SEB setting) is
used anywhere in this codebase. `UNRESTRICTED` omits both keys entirely
from the generated configuration rather than guessing an
"unlimited"/"allowed" sentinel value that isn't documented anywhere — see
`SINGLE_DISPLAY_MAX_COUNT` in
[`src/lib/secureClient/sebConfigGenerator.ts`](../src/lib/secureClient/sebConfigGenerator.ts).

**Why this cannot be observed through attestation for SEB.** The official
SEB JavaScript API (`window.SafeExamBrowser` — see
[`src/lib/secureClient/sebJavascriptApi.ts`](../src/lib/secureClient/sebJavascriptApi.ts))
exposes only `version` and `security.updateKeys()` — nothing about
displays. SEB enforces `allowedDisplaysMaxNumber` entirely client-side,
before/without ever reporting the outcome back to this application. For
this reason `displayCheck` has been added to `SEB_UNSUPPORTED_CHECKS` in
[`src/lib/secureClient/attestation.ts`](../src/lib/secureClient/attestation.ts)
— a SEB session can never claim PASS or FAIL for this check, and the
signed launch manifest's `requiredChecks` list is filtered through
`checksSupportedByClientType()` so `displayCheck` is never marked REQUIRED
for a SEB session (a required-but-unsupported check would otherwise
permanently force every such attestation to `CANNOT_START`). The
restriction is still enforced for SEB — just out-of-band, via the
generated `.seb` file, not through this attestation channel. Only a
future native Tether client (`TETHER_SECURE_CLIENT`) or the dev/mock
simulator (`MOCK_TETHER_CLIENT`) may report `displayCheck` and the bounded
`displayCount`/`displayTopology` fields.

**Manual real-device validation checklist.** None of the scenarios below
have been executed against a real Safe Exam Browser installation as part
of this implementation pass — do not describe SEB single-display
enforcement as production-verified until they have been:

- [ ] 1. Laptop internal display only — exam starts normally.
- [ ] 2. Laptop plus an HDMI monitor in **extended** mode — SEB refuses to
      run (or blanks) with `allowedDisplaysMaxNumber: 1` configured.
- [ ] 3. Laptop plus an HDMI monitor in **duplicate/mirrored** mode — same
      expected refusal.
- [ ] 4. A projector connected — same expected refusal.
- [ ] 5. A wireless display (e.g. Miracast/AirPlay) connected — same
      expected refusal.
- [ ] 6. External display disconnected before launch — exam starts
      normally.
- [ ] 7. A display connected **during** an active exam — confirm SEB's
      own live re-validation behaviour (blank/refuse) and whatever, if
      anything, reaches this application (see "why this cannot be
      observed through attestation for SEB" above — expect nothing to
      reach the server for a SEB session).
- [ ] 8. Display removed and configuration restored — confirm the exam
      resumes/recovers correctly.
- [ ] 9. Sleep/resume with the display configuration unchanged.
- [ ] 10. Secure-client restart and recovery (existing session
      interruption/recovery flow, unrelated to this feature but must
      keep working).

## Signed secure-launch manifest

[`src/lib/secureClient/secureLaunchManifest.ts`](../src/lib/secureClient/secureLaunchManifest.ts):

- Canonical JSON serialization (recursively sorted keys) makes signing
  and hashing deterministic.
- `signManifest()` / `verifyManifestSignature()` use Node's Ed25519
  (`crypto.sign(null, data, privateKeyPem)` /
  `crypto.verify(null, data, publicKeyPem, signature)`).
- Every manifest carries `institutionId`, `examId`, `submissionId`,
  `studentId`, `configurationId` (nullable), `clientType`, a
  `policyHash` (binding it to the exact policy in force), an
  `expiresAt`, and a nonce — hashed (`nonceHash`) before storage, never
  stored raw.
- `consumeLaunchManifest()` in
  [`src/lib/secureClientRunner.ts`](../src/lib/secureClientRunner.ts)
  enforces replay protection (nonce hash checked and the manifest row
  atomically marked consumed inside the same transaction), expiry, and
  signature validity, returning a discriminated result — `OK`,
  `INVALID_SIGNATURE`, `EXPIRED`, `ALREADY_CONSUMED`, `REVOKED`,
  `CONTEXT_MISMATCH` — via `MANIFEST_VALIDATION_REASON_CODES`.

## Secure-client session APIs

Student/client-facing routes under `/api/submissions/[id]/secure-client/*`
and `/api/secure-client/*`:

- `launch` — issues a manifest for a real client (SEB / future Tether).
- `mock-launch` — issues a `MOCK_TETHER_CLIENT` manifest, gated by
  `isMockSecureClientAllowed()` (see "Mock Tether client" below).
- `launch/[manifestId]/consume` — validates and consumes a manifest,
  creating or resuming a `SecureClientSession`.
- `signing-keys` — publishes the current Ed25519 public key (and key
  id) for client-side signature verification.
- `preflight` — runs the SEB header/JS-API compatibility check without
  requiring a full session.
- `session`, `sessions/[id]/attestation`, `.../heartbeat`,
  `.../events`, `.../interrupt`, `.../recover`, `.../end` — session
  lifecycle.
- `status` — current delivery-mode and session summary for the student
  compatibility page.
- `seb-config` — downloads (or `seb://`-launches) the generated plain
  `.seb` configuration.

## Session state machine

[`src/lib/secureClient/secureClientSession.ts`](../src/lib/secureClient/secureClientSession.ts):

`CREATED → PREFLIGHT → ACTIVE ⇄ INTERRUPTED → RECOVERY_REQUIRED → ACTIVE`,
terminating in `ENDED` or `REJECTED`.

- `deriveSessionStatus()` computes status on demand from the last
  heartbeat, the immutable snapshot's `heartbeatIntervalSeconds` /
  `heartbeatGraceSeconds`, and recorded interruption/recovery timestamps
  — there is **no background job** driving this in v1 (no existing
  scheduler pattern to reuse in this repository, and this feature only
  needs on-demand derivation for its required guarantees).
- A **soft** interruption (missed heartbeat within grace) self-heals
  back to `ACTIVE` the moment a heartbeat resumes.
- A **hard** interruption (explicit client-reported interruption, or a
  miss beyond grace) moves to `RECOVERY_REQUIRED`, which needs an
  explicit lecturer-issued one-time `SecureClientRecoveryGrant` to
  resume — never an automatic recovery.
- Only one non-terminal session can exist per submission at a time
  (database-enforced, see the migration); a duplicate launch attempt is
  rejected or resumes the existing session, never silently creates a
  second concurrent one.

## Attestation and preflight

[`src/lib/secureClient/attestation.ts`](../src/lib/secureClient/attestation.ts)
defines a bounded set of checks (`displayCheck`, `remoteSession`,
`virtualMachine`, `processCheck`, `captureProtection`, `clipboardPolicy`,
`printingPolicy`, `externalNavigationPolicy`, plus signature/config
verification), each with a status of `PASS | FAIL | WARNING |
NOT_CHECKED | NOT_SUPPORTED | UNKNOWN`. `checksSupportedByClientType()`
declares which checks Safe Exam Browser cannot report
(`SEB_UNSUPPORTED_CHECKS`) so those are always `NOT_SUPPORTED`, never a
fabricated pass/fail. `overallStatusFromChecks()` rolls these into
`READY | ACTION_REQUIRED | CANNOT_START | NOT_SUPPORTED |
TECHNICAL_FAILURE` for display.

Prohibited-process evidence (`ProhibitedProcessEvidence`), when present
at all, is restricted to a configured rule identifier, a matched
category, a normalised application identifier, and a timestamp — never
an unrestricted process inventory, command-line arguments, open document
names, or window titles (operating rules #15/#18).

`SecureClientAttestation.displayCount` (bounded integer, 1 to
`MAX_REPORTED_DISPLAY_COUNT`) and `displayTopology`
(`SINGLE`/`CLONE`/`EXTEND`/`EXTERNAL_ONLY`/`UNKNOWN`, stored inside the
existing `detailsJson` blob rather than a new column) are reserved for a
future trusted native Tether client — see "Display requirement" above.
Both are silently dropped, never persisted, for a `SAFE_EXAM_BROWSER`
session, since `displayCheck` is one of the checks SEB genuinely cannot
report. Never a raw monitor name, serial number, EDID, or device path.

## Integrity event taxonomy

[`src/lib/secureClient/secureClientEvents.ts`](../src/lib/secureClient/secureClientEvents.ts)
defines 32 event types (session lifecycle, attestation results, key
verification outcomes, manifest validation failures, recovery actions,
etc.), each with a strict discriminated Zod metadata schema — mirrors
`DEVELOPMENT_EVENT_METADATA_SCHEMAS` in `src/lib/answerDevelopment.ts`.
Every event has an `eventLevel` of `INFORMATIONAL | CONTEXT |
ACTION_REQUIRED | REVIEW_CONTEXT` — never a violation score, and no event
is automatically converted into a misconduct finding (operating rule
#14). `clientRequestId` gives idempotent submission (unique nullable
column, find-before-create, `P2002` recovery — same idempotency pattern
used throughout this codebase); `sequenceNumber` is checked server-side
via `checkSequenceNumber()`, never trusted as authoritative from the
client alone.

`ADDITIONAL_DISPLAY_PRESENT` and `DISPLAY_CONFIGURATION_CHANGED` (both
pre-existing) plus `DISPLAY_POLICY_RESTORED` (Single Display Requirement
v1) cover the display requirement — see "Display requirement" above.
These can only ever be recorded by a session whose `clientType` supports
`displayCheck` (never `SAFE_EXAM_BROWSER` — enforced in
`POST /api/secure-client/sessions/[sessionId]/events`, which rejects any
attempt with 403), so an ordinary browser page can never fabricate one.
Lecturer-facing copy for `ADDITIONAL_DISPLAY_PRESENT` reads: "An
additional display was reported by the secure exam client. The exam was
paused until the display requirement was restored. Needs review." — a
neutral integrity signal, never automatic misconduct, never a mark
change, never an automatic submit; recovery follows the existing
session interruption/recovery model.

## Heartbeat and recovery

- Heartbeat interval and grace period come from the immutable policy
  snapshot (`secureClientHeartbeatIntervalSeconds` /
  `secureClientHeartbeatGraceSeconds`), clamped to documented bounds.
- A missed heartbeat within grace does not interrupt the exam attempt
  itself — the student's answers, timer, and submission continue exactly
  as in `STANDARD_WEB` mode; only the secure-client session's status
  changes.
- Recovery beyond the soft grace window requires a lecturer to issue a
  one-time recovery grant from the session detail page, with a mandatory
  reason (audited via `createPlatformAuditLog`).

## Lecturer interfaces

- **`/lecturer/exams/[id]/page.tsx`** — new "Exam delivery" section:
  radio-style delivery-mode cards (Tether Secure Client modes shown
  disabled with "Planned for examinations requiring stronger device
  controls"), conditional SEB settings, and a link to the secure-client
  configuration page.
- **`/lecturer/exams/[id]/secure-client/page.tsx`** — SEB configuration
  management (create/activate/revoke, add/revoke keys with masked
  fingerprints only) and a session dashboard with status filters.
- **`/lecturer/secure-client/sessions/[sessionId]/page.tsx`** — session
  detail: timeline, attestation results, recovery-grant history, an
  "Alternative explanations to consider" disclaimer box (shared network,
  connectivity interruption, approved accessibility tool, routine
  updates, sanctioned device switch), and explicit reminders that a
  technical failure is not misconduct and lecturer judgement remains
  final.

## Student interfaces

**`/student/exams/[id]/secure-client/page.tsx`** — compatibility page:
current required delivery mode, SEB install links (official SEB
download page), "Open in Safe Exam Browser" (`seb://`) and "Download
exam configuration" actions, a "Run compatibility check" button showing
per-check `READY/ACTION_REQUIRED/CANNOT_START/TECHNICAL_FAILURE`
results, and an explicit accessibility note that generic checks never
block a student who has an approved accommodation on file with their
lecturer.

## Mock Tether client (development simulator)

**Never a verified production client.** Location:
`src/app/dev/mock-secure-client/[id]/page.tsx` plus
`POST /api/submissions/[id]/secure-client/mock-launch`.

- Server-side gating in
  [`src/lib/secureClientAvailability.ts`](../src/lib/secureClientAvailability.ts)
  (`isMockSecureClientAllowed()`) requires **all three**: `NODE_ENV !==
  "production"`, the explicit `TETHER_MOCK_SECURE_CLIENT_ENABLED=true`
  flag, and an institution-slug match against the
  `TETHER_MOCK_CLIENT_ALLOWED_INSTITUTION_SLUGS` allowlist (comma-
  separated) — never a frontend query parameter, and unreachable in
  Production regardless of what the client sends or which flags are set.
- `clientType` is always `MOCK_TETHER_CLIENT`, distinct from
  `SAFE_EXAM_BROWSER` / `TETHER_SECURE_CLIENT` everywhere it is stored
  or displayed.
- The driving page is clearly labelled "Development simulator" with an
  explicit "not a verified production client" banner.
- Simulated scenarios covered: ready preflight, an additional-display
  warning, an unsupported client version, a remote-session warning, a
  virtual-machine warning, a prohibited-process warning, a missed
  heartbeat, an interruption, a successful recovery, an invalid
  signature, an expired launch manifest, and a replayed nonce.
- Makes **no** OS-restriction claim, performs **no** real process
  scanning, **no** capture blocking, has **no** installer, and makes
  **no** code-signing claim — it calls the same real session/attestation
  APIs a genuine client would, with hand-constructed payloads.

## Security controls

- All new secure-client settings default to disabled
  (`DISABLED_SECURE_CLIENT_POLICY`, `deliveryMode: "STANDARD_WEB"`).
- No process termination anywhere in this phase (operating rule #17).
- No hidden monitoring — every attestation/event the client sends is
  visible to the lecturer on the session detail page, and the student
  compatibility page shows the same checks the student's own client
  reported.
- No kernel driver, no redistribution or modification of Safe Exam
  Browser binaries — this platform only acts as an external SEB-
  compatible examination client (config generation + verification),
  never a fork or bundled copy of SEB itself.
- Raw SEB keys and raw launch nonces are never persisted; only their
  hashes (or, for the SEB key's narrow verification requirement, an
  AES-256-GCM ciphertext — see "Known limitations").

## Institution isolation

Every lecturer route checks exam/session ownership first (404, not 403,
to avoid confirming existence to another institution) via the existing
`assertSameInstitution` / `institutionErrorResponse` / `isPlatformAdmin`
helpers from `src/lib/institutionScope.ts`, duplicated per-route per this
repository's established convention. Every mutating lecturer action is
recorded via `createPlatformAuditLog`.

## Privacy

- No unrestricted process inventories, hardware serial numbers, MAC
  addresses, or unrestricted device identifiers are ever collected —
  `clientInstallationIdHash` is a random, hashed, per-installation value
  only.
- Prohibited-process evidence is limited to rule id / category /
  normalised app identifier / timestamp (see "Attestation and
  preflight").
- Full SEB key values are never displayed after entry, in any lecturer
  or student-facing response.

## Accessibility

The student compatibility page explicitly states that an approved
accessibility accommodation is honoured by the lecturer and a generic
compatibility check does not block a student who has one on file — a
human decision always overrides an automated signal for these cases.

## Known limitations

- **No encrypted (`pswd`-protected) `.seb` config generator.** Only the
  plain-config path is implemented, against a conservative, documented
  key allowlist; the exact current encrypted-format spec could not be
  verified against an authoritative source at implementation time, so an
  honest `ENCRYPTED_SEB_CONFIG_UNAVAILABLE_MESSAGE` fallback is returned
  rather than a fabricated implementation. Matches this codebase's
  established convention of honest limitation framing (see
  `CodeExecutionEvent`'s `NOT_CONFIGURED` exit status in the prior
  Answer-Development Provenance feature).
- **`SebAllowedExamKey.rawKeyCiphertext` is a documented, deliberate
  deviation** from the literal spec's field list: the official SEB
  request-hash protocol (`SHA256(url + rawKey)`) is not verifiable from a
  one-way hash of the key alone, so the raw key is stored AES-256-GCM
  encrypted at rest (`SEB_KEY_ENCRYPTION_SECRET`, server-only env var)
  purely to support per-request verification. The recommended hardening
  path for a future release is a KMS-backed envelope key instead of a
  single static encryption secret.
- **No background job drives session-status transitions.** Status is
  derived on demand (`deriveSessionStatus()`); a session that is never
  queried again after a real interruption will not proactively notify a
  lecturer until they open the dashboard. Acceptable for v1 given no
  existing scheduler infrastructure in this codebase; a future release
  could add a low-frequency job to surface stale sessions proactively.
- **Tether Secure Client (Windows) delivery modes are not selectable.**
  `TETHER_CLIENT_OPTIONAL` / `TETHER_CLIENT_REQUIRED` exist in the type
  system and database only; the lecturer UI shows them disabled. See
  `docs/tether-secure-client-windows-architecture.md` for the documented
  future contract.
- **SEB compatibility has not been validated against a real Safe Exam
  Browser installation** in this implementation pass — the header/JS-API
  verification logic follows the documented public protocol, but no live
  SEB client was available to exercise it end-to-end. Preview
  verification (see below) covers the mock client and API contracts
  only.
- **Single Display Requirement (`displayPolicy: SINGLE_DISPLAY_REQUIRED`)
  has not been validated against a real Safe Exam Browser installation**
  — see the "Display requirement" section above for the exact SEB config
  keys used (`allowDisplayMirroring`, `allowedDisplaysMaxNumber` — neither
  performs direct mirror-vs-extend topology classification) and its own
  manual real-device checklist, none of which has been executed yet.
  `STANDARD_WEB` and
  `MONITORED_WEB` never claim to enforce or observe this at all. A future
  native Tether client could report trusted display count/topology (the
  bounded `SecureClientAttestation.displayCount`/`displayTopology` fields
  already exist for exactly this) but that client does not exist yet.

## Migration procedure

See
[`docs/secure-client-foundation-seb-v1-migration.sql`](secure-client-foundation-seb-v1-migration.sql)
and the "Deployment procedure —
`docs/secure-client-foundation-seb-v1-migration.sql`" section of
[`docs/migration-ledger.md`](migration-ledger.md). **PENDING — NOT
APPLIED** to any environment as of this writing.

## Rollback procedure

See the matching "Rollback" subsection in `docs/migration-ledger.md`.
Additive-only; the practical rollback for almost any issue is simply
ensuring no exam uses a non-default delivery mode, rather than reverting
the schema.

## Preview smoke test

Once the migration has been applied to the shared Preview/Production
database by an authorized operator:

1. As a lecturer, open an exam's settings and confirm "Exam delivery"
   defaults to "Standard web" with the Tether Secure Client option shown
   disabled.
2. Switch to "Safe Exam Browser — optional", save, and open
   `/lecturer/exams/[id]/secure-client` — create a draft configuration,
   add a test Browser Exam Key, activate it.
3. As a student on a test account, open
   `/student/exams/[id]/secure-client` and run the compatibility check
   (expect `NOT_SUPPORTED`/`ACTION_REQUIRED` outside a real SEB browser —
   this is correct, not a bug).
4. Using the mock client
   (`/dev/mock-secure-client/[submissionId]`, on a non-production
   environment with the mock allowlist configured for the test
   institution), walk through: request launch → consume → ready
   attestation → heartbeat → simulate interruption → recover → end.
   Confirm each step's log line and confirm the lecturer session detail
   page reflects the same timeline.
5. Confirm a replayed manifest consume attempt is rejected
   (`ALREADY_CONSUMED`), an expired manifest is rejected (`EXPIRED`), and
   an invalid-signature consume attempt is rejected
   (`INVALID_SIGNATURE`) — none of these should ever create a session.
6. Switch the exam back to "Standard web" and confirm the exam start/
   resume flow is completely unaffected — no secure-client prompts, no
   behaviour change versus before this feature existed.
7. Confirm the mock-client route and page return 403/are unreachable
   when the test institution is removed from the mock allowlist or when
   `NODE_ENV === "production"`.

Do not run this checklist against Production, and do not enable any
SEB-required delivery mode on a real (non-test) exam until the
institutional pilot-readiness checklist in `docs/pilot-readiness.md` is
complete.
