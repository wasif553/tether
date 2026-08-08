# Secure-Launch Signing Key Runbook (v1)

Covers the **server's own** Ed25519 signing key — the key that signs
launch manifests (`secureLaunchManifest.ts`) and attestation challenges
(`tetherAttestation.ts`), read via `getSigningPrivateKey()` /
`getSigningPublicKey()` / `getSigningKeyId()` in
`src/lib/secureClientRunner.ts`. This is distinct from the
**per-installation** keys students' own Tether installs generate
themselves (see "Per-installation keys — different lifecycle, already
handled" at the end of this document).

**This document does not generate, rotate, or expose any actual
Production key value.** It documents the current architecture, a genuine
gap it has, and the procedure to follow when rotation is actually needed.

## Current architecture (audited, not changed)

```
TETHER_SECURE_CLIENT_SIGNING_PRIVATE_KEY   — server env, never committed
TETHER_SECURE_CLIENT_SIGNING_PUBLIC_KEY    — server env, never committed
TETHER_SECURE_CLIENT_SIGNING_KEY_ID        — server env, defaults to "dev-key-1"
```

- **Ownership:** whoever holds deploy access to the production
  environment's secret store (the same access tier that could already
  read `DATABASE_URL`, NextAuth secrets, etc. — no separate key-custody
  tier exists for this specifically).
- **Storage:** server environment variables only. Never read from a file
  checked into the repo, never logged, never returned in any API
  response.
- **Where it's used:** `issueLaunchManifest` (signs the manifest),
  `issueRegistrationChallenge` / `issueAttestationChallenge` (sign
  challenges) — all in `secureClientRunner.ts` /
  `tetherAttestationRunner.ts`. Verification (`consumeLaunchManifest`,
  `validateRegistrationChallengeContext`, `validateAttestationChallengeContext`)
  always verifies against the SAME single current `getSigningPublicKey()`
  value — there is no per-manifest or per-challenge key selection.

## The gap: `keyId` is not wired to actual key selection

`manifest.keyId` (`secureLaunchManifest.ts`) and each challenge's own
`keyId` field are populated from `getSigningKeyId()` at issuance time, and
are zod-validated as a string on the consume/verify side — but **nothing
in the verification code path ever reads that field to decide which
public key to check the signature against.** Verification always uses
whatever `getSigningPublicKey()` currently returns, unconditionally.

**Consequence:** there is currently no way to rotate the signing key
without a hard cutover. The instant `TETHER_SECURE_CLIENT_SIGNING_PUBLIC_KEY`
/ `_PRIVATE_KEY` are changed in the deployment environment:

- Every manifest/challenge issued under the OLD key that has not yet been
  consumed/verified becomes permanently unverifiable (its signature will
  never validate against the new public key).
- Any student mid-launch at the exact moment of rotation gets a hard
  failure, not a graceful fallback.

This is recorded as a genuine gap, not silently worked around. See
"Severity and classification" below.

## Severity and classification

**P1** — not a P0 pilot blocker (the key is not rotated during normal
pilot operation, and the manifest/challenge TTLs are short — 120 seconds
for challenges, `secureLaunchTokenTtlSeconds` for manifests — so the
actual blast radius of a rotation is bounded to whatever is in-flight in
that narrow window), but a real gap that must be closed before this
architecture can support a genuinely safe, zero-downtime rotation. Until
an overlapping-verification-window mechanism is built, "rotate the
signing key" and "briefly disrupt any student mid-launch during the
rotation window" are the same operation.

## Emergency compromise response (works TODAY, without the missing overlap feature)

If the private key is suspected compromised, safety takes priority over
graceful continuity:

1. Immediately rotate `TETHER_SECURE_CLIENT_SIGNING_PRIVATE_KEY` /
   `TETHER_SECURE_CLIENT_SIGNING_PUBLIC_KEY` to a freshly-generated
   keypair (see "Generating a replacement pair" below) in the production
   environment's secret store.
2. Accept that every in-flight manifest/challenge at the moment of
   rotation fails closed (`INVALID_SIGNATURE`/`INVALID` outcomes) — this
   is the correct, safe behavior: a compromised key must not continue to
   be trusted for any in-flight operation, even at the cost of disrupting
   active launches.
3. Redeploy so every server instance picks up the new environment values
   (this codebase reads them via `process.env` at call time, not cached
   at startup, but a redeploy/restart is still the safest way to
   guarantee every instance is consistent).
4. Notify affected students via the existing support channel (see
   `docs/tether-pilot-support-runbook.md`, Case 15 — "Secure launch
   failure") that a retry is expected to succeed once the rotation is
   complete.
5. Record the rotation (old key ID, new key ID, reason, timestamp,
   who performed it) as a `PlatformAuditLog` entry or equivalent
   institutional incident record — this codebase does not currently emit
   an automatic audit-log entry for a key rotation itself (it happens
   entirely outside the application, via environment configuration), so
   this step is a manual/operational requirement, not an automated one.
6. If the compromise is suspected to have enabled a forged manifest to be
   consumed BEFORE rotation, review `SecureClientLaunchManifest` /
   `SecureClientSession` records created in the suspected window for
   anomalies (unexpected institution/exam/student combinations, unusual
   timing) — this is a manual investigation; no automated compromise-
   detection exists.

## Generating a replacement pair

Ed25519 keypair generation (example, run in a secure, ephemeral
environment — never on a machine where the output could be logged or
persisted anywhere other than the target secret store):

```bash
node -e "const {generateKeyPairSync}=require('crypto');const {publicKey,privateKey}=generateKeyPairSync('ed25519');console.log('PUBLIC:',publicKey.export({type:'spki',format:'pem'}));console.log('PRIVATE:',privateKey.export({type:'pkcs8',format:'pem'}));"
```

Store the two PEM values directly into
`TETHER_SECURE_CLIENT_SIGNING_PUBLIC_KEY` /
`TETHER_SECURE_CLIENT_SIGNING_PRIVATE_KEY` in the deployment platform's
secret store (never a file, never a chat message, never a commit). Choose
a new, distinct value for `TETHER_SECURE_CLIENT_SIGNING_KEY_ID` (e.g. an
incrementing label or a date-stamped identifier) so the `keyId` embedded
in newly-issued manifests/challenges is visibly different from the
retired key's — this is already useful today purely as a diagnostic
breadcrumb (visible in `console.error` output from the observability
hardening in `docs/tether-production-observability.md`), even though
verification does not yet act on it.

## What "safe rotation" would require (future work — not built here)

To support a genuine overlapping-verification window (old key still
verifies in-flight manifests issued before rotation, new key verifies
everything issued after), the verification code paths would need to:

1. Accept a small, explicit set of currently-trusted `(keyId ->
   publicKey)` pairs, not a single `getSigningPublicKey()` value.
2. Look up the specific key by the manifest's/challenge's own `keyId`
   field (already present, currently unused for this) to select which
   public key to verify against.
3. Retire an old key from that trusted set only once its own maximum
   possible outstanding TTL has fully elapsed since the rotation
   (bounded and short today, per "Severity and classification" above —
   this makes the safe overlap window small, not eliminate the need for
   one).

This is schema/config work (likely a small JSON/env-driven map rather
than two flat env vars) and is out of scope for this pass — recorded here
as the concrete requirement for whoever picks it up.

## Revocation / retirement

A retired key is simply removed from production configuration once no
manifest/challenge signed with it could possibly still be outstanding
(today: after its TTL has elapsed following the cutover — see emergency
response above for the "immediately, accepting disruption" case, or wait
out the TTL for a planned, non-emergency rotation).

## Rollback

If a rotation is performed and then needs to be reversed (e.g. the new
key was generated incorrectly), the SAME emergency procedure applies:
revert the environment variables to the previous known-good values,
redeploy, and expect the same "anything issued during the window fails
closed" behavior in reverse.

## Audit evidence

Until the future work above exists, the only durable record of a
rotation having occurred is whatever the operator records manually (step
5 of the emergency procedure). Consider this a manual runbook checklist
item, not an automated guarantee, for now.

## Per-installation keys — different lifecycle, already handled

The Ed25519 keypairs individual Tether installations generate for
themselves (`TetherClientInstallation.publicKey`, registered via
`registerInstallation` in `tetherAttestationRunner.ts`) are a completely
separate system from the server's own signing key covered above:

- Each installation has its own independent keypair.
- Compromise or replacement of ONE installation's key only ever affects
  that one installation — revocable independently via the existing
  self-service `revokeInstallation` flow, with no impact on any other
  student's installation or on the server's own signing key.
- No rotation runbook is needed for these — "revoke and register a new
  installation" already IS their rotation mechanism, and it already works
  today with no gap.
