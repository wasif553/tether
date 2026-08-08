# Tether Windows Code-Signing Plan (v1)

Planning document only. **No signing certificate is purchased or
configured by this document, and `apps/lockdown/electron-builder.yml` is
not modified.** This exists so that when the institution is ready to sign
the Windows installer, the decision points, requirements, and integration
steps are already worked out rather than being figured out under release
pressure.

## Current state (audited, not changed)

`apps/lockdown/electron-builder.yml`:

- `win.signAndEditExecutable: false` — the installed app `.exe` is never
  signed or even rcedit-processed by electron-builder's own step (icon
  embedding is done separately via the standalone `rcedit` package — see
  that file's own doc comment for why: the winCodeSign vendor archive
  electron-builder needs for this step contains symlinks that can't be
  extracted on this build host without Windows Developer Mode/an elevated
  shell).
- No `certificateFile`, `certificateSubjectName`, `certificateSha1`, or
  any other signing credential is referenced anywhere in the config.
- `mac.identity: null`, `mac.hardenedRuntime: false` — macOS is likewise
  entirely unsigned (out of scope for "Windows" in this plan's title, but
  confirmed for completeness).
- **Consequence:** every pilot installer, including the frozen v1.7.2
  build, triggers a Windows SmartScreen "Unknown publisher" warning on
  first run. This is expected and already documented as a known
  pilot-stage limitation (`docs/tether-v1.7.2-pilot-release-readiness.md`,
  `/lockdown-browser`'s own UI copy, and Case 3 of
  `docs/tether-pilot-support-runbook.md`).

## What should be signed

- The NSIS installer executable itself (`Tether-Secure-Browser-*.exe`,
  the artifact students download).
- The installed application executable (the actual `Tether Secure
  Browser.exe` that runs after installation) — this is the
  `signAndEditExecutable`-gated step above; signing this requires solving
  the winCodeSign extraction blocker on the build host (see "Build-host
  blocker" below), independent of which certificate is used.

## Certificate options

| Option | Cost/effort profile | SmartScreen behavior | Notes |
|---|---|---|---|
| **Standard (OV) code-signing certificate** | Lower cost, issued to the institution as an organization | Warnings persist until the certificate accumulates enough download/reputation history with Microsoft (can take weeks to months of real-world installs) | Common starting point; does not immediately eliminate SmartScreen |
| **EV (Extended Validation) code-signing certificate** | Higher cost, stricter identity verification, typically requires a hardware token (USB HSM) or cloud HSM | Immediate SmartScreen reputation — no warm-up period | Recommended once moving beyond a small pilot cohort, specifically because it avoids the OV warm-up gap during exactly the period a growing pilot needs it most |
| **No certificate (status quo)** | Zero cost | SmartScreen warning on every install, indefinitely | Acceptable for a small, briefed pilot cohort (current state); not acceptable at broader rollout — see recommendation below |

This document does not recommend a specific vendor — that is a
procurement decision for the institution, made once the pilot has
validated the product is worth the ongoing cost of maintaining a
certificate (renewal, HSM/token custody, CI integration).

## Secure key storage

Whichever certificate option is chosen, the private key/token must never
be:

- Committed to this repository, in any form (including encrypted blobs
  committed "temporarily").
- Stored on a single developer's local machine as the only copy.
- Embedded in `electron-builder.yml` or any other tracked config file as
  a raw value — `electron-builder`'s own `certificateFile`/
  `certificatePassword` fields must be sourced from CI secrets/environment
  variables, never a literal in the YAML.

Recommended storage: a CI-native secrets store (matching whatever CI
system a future release pipeline uses) or, for an EV certificate,
whatever cloud-HSM/signing-service the certificate authority provides
specifically to avoid ever exporting the private key at all (many EV
providers require this by policy).

## Timestamping

Every signature must be timestamped (`electron-builder`'s
`win.rfc3161TimeStampServer` / `win.timeStampServer` options) — an
untimestamped signature becomes invalid the moment the certificate
expires, which would silently break every previously-signed, already-
distributed installer. This is a required part of any future signing
config, not optional hardening.

## CI/release integration (not built in this pass)

A future signing-enabled release pipeline would need:

1. The certificate/HSM credential available only inside the CI signing
   job, scoped to release builds specifically (never a general-purpose CI
   secret available to every branch/PR build).
2. The signing step wired into the existing `dist:win` packaging script
   (`apps/lockdown/package.json`), after the icon-embedding step and
   before the final artifact is hashed for the release-metadata record
   (`CURRENT_INSTALLER_SHA256` in `src/lib/tetherReleaseMetadata.ts` —
   the hash must be computed on the SIGNED artifact, not before signing).
3. A verification step that confirms the resulting `.exe` is actually
   signed and the signature is valid (`signtool verify /pa`) before it is
   ever treated as a publishable release candidate.

None of this is implemented here — this is the checklist for whoever
builds that pipeline.

## Build-host blocker (must be solved independently of certificate choice)

Signing the installed application executable specifically (not just the
installer wrapper) currently requires solving the winCodeSign vendor
archive extraction failure on the build host (symlink extraction requires
Windows Developer Mode or an elevated shell — see
`electron-builder.yml`'s own doc comment). This is orthogonal to which
certificate is purchased: even with a valid certificate and CI secret in
hand, `signAndEditExecutable: true` will still fail on this exact build
host until that extraction blocker is resolved (e.g. by enabling Developer
Mode on the CI runner, or building on a runner image where 7-Zip can
extract the symlinked archive without elevation). A future release
pipeline may end up building on a different host/runner than the current
manual build process specifically to sidestep this.

## Verification (once signing is live)

Before any signed release is published:

1. `signtool verify /pa /v <installer.exe>` — confirms a valid,
   timestamped signature chain.
2. Confirm the certificate's subject name matches the institution's
   registered legal name (what students will see in the SmartScreen/UAC
   prompt).
3. Re-run the existing SHA-256 computation and confirm it matches what
   was recorded in the release log (`docs/tether-release-management.md`)
   — signing changes the file bytes, so the hash must always be taken
   from the final, signed artifact.

## SmartScreen implications, and the pilot-vs-broad-rollout recommendation

- **Pilot (current stage):** Unsigned is an acceptable, already-documented
  trade-off for a small, briefed cohort who have been told in advance to
  expect the warning (see `docs/tether-pilot-support-runbook.md`, Case 3).
  Purchasing a certificate before the pilot has validated product-market
  fit is premature spend.
- **Broad rollout (post-pilot, GENERAL_AVAILABILITY):** An unsigned
  installer at scale is a materially worse experience — a growing
  proportion of students will not have been personally briefed, and
  "Unknown publisher" at that scale looks like malware to a first-time
  user, undermining trust and support-load simultaneously. **Recommendation:
  obtain a code-signing certificate (EV preferred, to avoid the OV
  reputation warm-up gap) before raising `TETHER_RELEASE_STATUS` to
  `GENERAL_AVAILABILITY`.** This is a recommendation for a future
  decision point, not an action taken by this document.
