# Tether Secure-Launch Verification Investigation (P0 retest follow-up)

Follow-up to `docs/tether-secure-launch-loop-hotfix.md`. The redirect loop
is fixed; a student now reaches a stable "Tether could not verify this
secure exam session" state. This document traces why the underlying
`SecureClientSession.verificationStatus` does not reach `VERIFIED`, and
records what was found, what remains genuinely undetermined without live
production log data, and the safe diagnostics added to resolve that
ambiguity on the next physical attempt.

**Update — second physical retest (single active display):** the retest
was repeated with Windows reporting only one active display and the
result was the SAME stable failure. This rules out "genuine multi-display
policy block" as the primary explanation (see the revised
"What remains undetermined" section below) — the diagnostics in this
change are what will pin down the actual cause on the next attempt.

## Traced physical path

1. `POST /api/exams/[id]/start` — resumes the existing `IN_PROGRESS`
   submission; reports `secureClientLaunch.kind: "REDIRECT_TO_TETHER_LAUNCH"`
   (correct — no verified session exists yet).
2. `POST /api/submissions/[id]/secure-client/launch` — issues a signed
   manifest. No issue found; `issueLaunchManifest` succeeds or fails
   loudly (already `console.error`-instrumented from a prior pass).
3. `POST /api/secure-client/launch/[manifestId]/consume` — consumes the
   manifest. `getOrCreateSessionCore` (`secureClientRunner.ts`) ends any
   prior non-terminal session for this submission
   (`endReason: SUPERSEDED_BY_RELAUNCH`) and creates a fresh one:
   `status: CREATED`, `verificationStatus: NOT_CHECKED`. Confirmed this
   is correct, expected behavior on every retry — not a bug.
4. Session creation — as above.
5. `GET /api/submissions/[id]/secure-client/status` (called by
   `submitInitialAttestation` before attestation) — reads
   `policy.requireDisplayCheck` from the submission's frozen
   `secureClientPolicySnapshotJson`. Correct, consistent source.
6. `getDisplayCount()` — only called when `requireDisplayCheck` is true.
   Traced the Electron implementation
   (`apps/lockdown/src/displayEnforcement.ts`,
   `apps/lockdown/src/preload.ts`, `apps/lockdown/src/main.ts`): this is
   a trivial, synchronous `screen.getAllDisplays().length` call routed
   through one IPC hop — robust, extremely unlikely to throw under
   normal conditions. **Ruled out** as a likely cause of "bridge
   unavailable/throws," though now separately diagnosed (see below) in
   case it does.
7. `POST /api/secure-client/sessions/[sessionId]/attestation` — request
   body validated by a permissive, all-optional zod schema; nothing
   about a missing/absent `checks.displayCheck` value would cause a 400.
8. Attestation HTTP status — no schema-validation or auth issue found
   that would plausibly reject a legitimate request from an
   already-authenticated student against their own session.
9. `overallStatus` — computed by `overallStatusFromChecks`
   (`src/lib/secureClient/attestation.ts`): returns `READY` only when
   every **required** check is `PASS`. With `requireDisplayCheck: false`
   (the common case), `required` is `{}` and the loop trivially returns
   `READY` — verification should succeed on any successful attestation
   POST. With `requireDisplayCheck: true`, `overallStatus` is `READY`
   only if `displayCheck` resolves to exactly `"PASS"` (i.e.
   `getDisplayCount() <= 1`).
10/11. `SecureClientSession.status`/`verificationStatus` — confirmed via
    `recordAttestation`: any `overallStatus` other than `READY` leaves
    `verificationStatus` at `"NOT_CHECKED"` (none of the four boolean
    failure flags are ever set to `true` by this client), and `status`
    becomes `PREFLIGHT`.
12. Final `GET .../secure-client/status` — correctly reflects the
    `NOT_CHECKED`/`PREFLIGHT` state; the new authoritative gate
    (`isSecureClientSessionVerified`) correctly reports "not verified."

## What was ruled out

- **Current-session lookup returning the wrong session** — `getOrCreateSessionCore`
  and `getCurrentSessionForSubmission` both query the same non-terminal
  status set (`CREATED, PREFLIGHT, ACTIVE, INTERRUPTED, RECOVERY_REQUIRED`)
  ordered by `createdAt desc`; a `PREFLIGHT` session (the state after a
  non-READY attestation) remains correctly findable. No mismatch found.
- **Session superseded unexpectedly** — confirmed this happens on every
  retry BY DESIGN (`endReason: SUPERSEDED_BY_RELAUNCH`), and is harmless:
  each retry gets a fresh, independent chance to verify. Not a bug.
- **`getDisplayCount` bridge unavailable/throwing** — the underlying
  Electron implementation is simple and robust; considered unlikely, but
  now independently diagnosed (see below) rather than merely assumed.
- **Attestation write failing at the database layer** — already
  `console.error`-instrumented from a prior pass
  (`docs/tether-production-observability.md`); no evidence of a
  structural issue in this code path.

## What remains undetermined without live production log data

**Revised after the second physical retest.** The first retest could not
distinguish "genuine multi-display policy block" from "some other cause"
from code alone. The second retest — Windows reporting only one active
display — still failed with the identical stable error. This makes
"genuine display-policy block" a much less likely primary explanation
(though not perfectly ruled out in the abstract: `getDisplayCount()`
returns `screen.getAllDisplays().length`, which could in principle differ
from what Windows Settings calls "active" for edge cases like a
disconnected-but-still-enumerated adapter — but this is a materially
weaker candidate than before).

The remaining, genuinely undetermined candidates — which is exactly what
the diagnostics below exist to distinguish on the next attempt — are:

- The attestation request never completing successfully at all (network
  condition, an unexpected non-2xx response, or an exception thrown
  before the `fetch` in `submitInitialAttestation` is reached).
- `displayCheck` resolving to something other than `PASS` even with one
  physical display connected (bridge call succeeding but returning an
  unexpected count, or the bridge check never running at all because
  `requireDisplayCheck` was read as `true` from a stale/unexpected policy
  snapshot).
- Some other required check (unrelated to display) blocking `overallStatus`
  from reaching `READY` that this investigation has not yet considered.

**No security-policy change was made while this ambiguity exists**, per
the explicit instruction to report root cause before any such change.

## Diagnostics added (bounded, safe — see exact fields below)

**Important production-visibility distinction — corrected in this
revision.** This codebase has TWO separate, differently-gated logging
mechanisms, and only one of them is ever visible in production:

- **`logClientTetherDiagnostic`** (`src/lib/tetherDiagnosticLog.ts`) —
  used by every `DISPLAY_CHECK_*` checkpoint below. Gated by
  `isClientTetherDiagnosticLoggingEnabled`, which is **disabled whenever
  `NODE_ENV === "production"`** — by design, this is a development/
  staging tracing aid only. **These checkpoints do NOT reach Vercel's
  logs and cannot be used to diagnose a real production physical
  retest on their own.** An earlier revision of this document did not
  make this limitation explicit enough; it is called out here directly
  so it is never assumed otherwise.
- **`console.error`** (used by the server-side `recordAttestation`
  diagnostic below) — **not** environment-gated; lands in Vercel's
  function logs in every environment, including production. This is the
  one diagnostic mechanism this investigation can actually rely on for a
  real physical production retest.

Server-side, `recordAttestation` (`src/lib/secureClientRunner.ts`) now
logs `recordAttestation: session did not reach VERIFIED` whenever
verification doesn't succeed, including: `overallStatus`,
`newVerificationStatus`, `failingRequiredChecks` (an array of
`{key, status}` pairs — only enum-like strings such as `"FAIL"` /
`"NOT_CHECKED"`, e.g. `{key: "displayCheck", status: "FAIL"}`), and now
also **`displayCount`** — the same bounded, validated number the
attestation row itself stores (`null` whenever the client never reported
one). This is what makes "displayCheck FAIL with N displays" vs
"displayCheck NOT_CHECKED, no count available" unambiguous on the next
physical **production** attempt, since this line is genuinely visible in
Vercel's logs.

To get `displayCount` into that diagnostic at all, `submitInitialAttestation`
(`tether-launch/page.tsx`) now submits the SAME bounded number it used to
derive `checks.displayCheck` as `displayCount` in the existing attestation
request body (the contract already accepted this field — see
`recordAttestation`'s pre-existing `displaySupported`/
`isValidReportedDisplayCount` handling, unchanged by this revision).
Never fabricated: `displayCount` is only ever sent when the bridge call
actually succeeded; the bridge-unavailable and bridge-threw paths never
set it.

Client-side (dev/staging-only, per the distinction above),
`submitInitialAttestation` still logs one of three mutually exclusive
checkpoints whenever `requireDisplayCheck` is true:

- `DISPLAY_CHECK_BRIDGE_UNAVAILABLE` — the bridge function doesn't exist
  at all on this packaged build.
- `DISPLAY_CHECK_BRIDGE_THREW` — the bridge function exists but the call
  itself failed (isolated into its own `try`/`catch`, distinct from the
  function's outer catch-all).
- `DISPLAY_CHECK_RESULT` — the bridge call succeeded; includes the
  reported `displayCount` (a small integer, not sensitive) and the
  resulting `PASS`/`FAIL`.

None of these log a manifest, signature, nonce, token, cookie, or exam
answer — only enum-like status strings, small integers, and existing
non-secret ids (`sessionId`).

## Correction: `window.sesLockdown.platform()` is NOT a bridge mismatch

An earlier revision of this document incorrectly claimed
`apps/lockdown/src/preload.ts` does not expose a `platform` function on
the bridge, based on a grep pattern (`platform\s*:`) that missed the
method-shorthand form actually used in the source. Re-checked directly:

```ts
// apps/lockdown/src/preload.ts
platform(): string {
  return process.platform;
},
```

`platform()` **is** exposed as a real, synchronous function returning
`process.platform` (e.g. `"win32"`). `window.sesLockdown?.platform?.()`
in `tether-launch/page.tsx` is therefore a correct call against the real
v1.7.2 bridge, not a bug. This correction has no bearing on the actual
verification failure either way (the field was never part of the
READY/CANNOT_START decision) — it is recorded here only because the
earlier claim was false and must not be relied on.

## Retry-button copy fix

The failed-verification retry button in the busy/error view read "I have
installed it — open examination" — copied from the OutsideTetherPrompt
installer-fallback flow, where it is correct (the student may or may not
have Tether installed). Inside this flow, the student is already running
inside Tether; installation was never in question. Changed to "Try
again."
