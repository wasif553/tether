# Tether Secure Client — Windows Architecture (documentation only)

**This document describes a future desktop application. Nothing in this
document is implemented by this repository.** No installer, no
Windows service, no kernel driver, no code-signing certificate, and no
process-termination logic exists anywhere in this codebase. This is a
contract specification only, so that a future, separately-built and
separately-reviewed desktop client has a stable, versioned server API to
integrate against — the same signed-manifest, session, attestation, and
event APIs documented in
[`docs/secure-client-foundation-seb-v1.md`](secure-client-foundation-seb-v1.md).

`TETHER_CLIENT_REQUIRED` cannot be selected for any real exam until a
signed production client implementing this contract exists and has been
through its own security review — see
`secureClientAvailability()` in
[`src/lib/secureClientAvailability.ts`](../src/lib/secureClientAvailability.ts),
which unconditionally returns `tetherClientRequiredAvailable: false`.

## Scope of this document

- What the future client would need to do, and the server contract it
  would speak.
- What it must never do, per the operating rules this feature was built
  under.
- Explicitly out of scope for this document: installer engineering, code
  signing, kernel-level enforcement design, or any claim about how hard
  the client would be to bypass.

## Non-goals / explicit restrictions

- **No kernel driver.** Any device-posture check the client performs
  must run at ordinary user-mode privilege.
- **No automatic process termination.** The client may report a
  prohibited-process signal (see "Attestation and preflight" in the main
  design doc); it must never kill another process automatically.
- **No hidden monitoring.** Every check the client performs and every
  event it sends must be visible to the student in its own UI and to the
  lecturer in the session dashboard — nothing collected silently.
- **No unrestricted process inventory or device fingerprinting.** Only
  the bounded check set already defined in
  `src/lib/secureClient/attestation.ts` (display count, remote-session
  detection, VM detection, a rule-matched prohibited-process check,
  capture-protection status, clipboard/printing/external-navigation
  policy compliance) and a random, hashed, per-installation identifier —
  never a hardware serial number, MAC address, or disk identifier.
- **No claim of being impossible to bypass, cheat-proof, or a guaranteed
  screenshot blocker.** Any future client's marketing and in-app copy
  must follow the same product-language rules as the web platform (see
  "Product language" in the main design doc).

## Why this is documentation-only in this release

Building a trustworthy Windows lockdown client is a materially different
engineering and security effort from the web platform: it requires its
own threat model, its own code-signing and update-distribution pipeline,
its own separate security review, and (per the restrictions above) it
must be built without a kernel driver or automatic process termination —
constraints that meaningfully limit what device-level enforcement it can
actually provide. Speccing the server-side contract now, without
building the client, lets the platform: (a) support Safe Exam Browser
today as a real, working compatible client; (b) keep the session/
attestation/event APIs stable so a future client is additive, not a
breaking migration; and (c) avoid shipping an unreviewed native
Windows binary as part of an unrelated web-platform feature branch.

## Contract the future client would implement

### 1. Launch

1. The student requests a launch manifest from the web platform
   (`POST /api/submissions/[id]/secure-client/launch`), the same
   endpoint SEB and the mock client use, with `clientType:
   "TETHER_SECURE_CLIENT"`.
2. The web platform returns a signed
   `SecureLaunchManifest` (see `src/lib/secureClient/secureLaunchManifest.ts`)
   plus its Ed25519 signature.
3. The client must independently verify the signature against the
   public key published at `GET /api/secure-client/signing-keys` before
   trusting any field in the manifest — never trust an unsigned or
   locally-cached manifest.
4. The client calls
   `POST /api/secure-client/launch/[manifestId]/consume` to redeem the
   manifest exactly once (replay-protected via `nonceHash`) and receive
   a `SecureClientSession`.

### 2. Preflight and attestation

The client performs the bounded check set from `attestation.ts` and
reports results via `POST /api/secure-client/sessions/[sessionId]/attestation`,
using the same `PASS | FAIL | WARNING | NOT_CHECKED | NOT_SUPPORTED |
UNKNOWN` status vocabulary as SEB and the mock client. A real Windows
client would be expected to actually support checks SEB cannot
(`SEB_UNSUPPORTED_CHECKS`), such as more precise VM/remote-session
detection, but should never report a check as `PASS` if it did not
genuinely run it.

### 3. Session continuity

The client must send a heartbeat within the interval declared in the
policy snapshot it received in its manifest
(`secureClientHeartbeatIntervalSeconds`), report an explicit
interruption event if it detects one (e.g. loss of focus enforcement,
an unexpected process launch matching a configured rule) rather than
silently going quiet, and call `.../end` when the exam attempt legitimately
finishes — mirroring the state machine in "Session state machine" in the
main design doc exactly; the server-side state machine does not change
for a real client versus the mock client.

### 4. Recovery

If a session reaches `RECOVERY_REQUIRED`, the client must surface this
to the student with actionable, non-alarming language ("action
required" / "possible technical issue"), and accept a lecturer-issued
one-time recovery grant code entered by the student to resume — never
attempt to self-recover past a hard interruption without one.

## Distribution and integrity (future work, unspecified here)

Code-signing strategy, auto-update mechanism, and installer packaging
are explicitly **not** specified by this document — they require their
own dedicated design and security review before any implementation
begins, and are out of scope for this feature.

## Relationship to Safe Exam Browser support

Safe Exam Browser support (implemented in this release) is not a
stepping stone that gets removed once a Tether client exists — both are
expected to remain supported `SecureClientConfiguration.provider`
values indefinitely, since institutions may already have SEB deployment
tooling and policies in place. The web platform must keep working
without either.
