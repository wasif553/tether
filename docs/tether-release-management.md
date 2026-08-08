# Tether Secure Browser — Release Management (v1)

Formal release lifecycle, versioning policy, and publication requirements
for Tether Secure Browser (Windows). This governs the *process* around
publishing a release; it does not itself publish, sign, or rebuild
anything.

## Release lifecycle

```
DEVELOPMENT → RELEASE CANDIDATE → PHYSICAL ACCEPTANCE → PILOT → GENERAL_AVAILABILITY
                                                                        │
                                                                        ▼
                                                              DEPRECATED → UNSUPPORTED
```

| Stage | Meaning | Exit criteria |
|---|---|---|
| **DEVELOPMENT** | Active work on the Electron client (`apps/lockdown`), not yet built into a candidate installer. | A build is produced, versioned, and hashed. |
| **RELEASE CANDIDATE** | A specific, frozen, hashed installer build exists and is undergoing verification. Automated (server-side) verification may be complete; physical Windows acceptance testing may still be outstanding. | Every P0 requirement in the corresponding release-readiness register (e.g. `docs/tether-v1.7.2-pilot-release-readiness.md`) shows PASS. |
| **PHYSICAL ACCEPTANCE** | All P0 gates confirmed via genuine physical testing on real Windows hardware — never inferred from automated tests or code review alone. | Every "Remaining Physical Acceptance Checklist" test in the release-readiness register is recorded PASS with dated physical evidence. |
| **PILOT** | Installer is published for a bounded, known cohort (this deployment's `TETHER_RELEASE_STATUS=PILOT`, `TETHER_INSTALLER_DOWNLOAD_URL` configured). Downloads enabled; release status reflects controlled availability. | Pilot cohort completes its exam period without an unresolved P0-severity incident; institution decides to broaden availability. |
| **GENERAL_AVAILABILITY** | Installer is the standard, broadly-recommended download for all institutions using Tether. `TETHER_RELEASE_STATUS=GENERAL_AVAILABILITY`. | N/A — steady state until superseded or deprecated. |
| **DEPRECATED** | A newer version exists and is recommended; this version is still supported (still passes `minimumSupportedTetherVersion()`) but should not be freshly distributed. | A newer version reaches PILOT or GA. |
| **UNSUPPORTED** | Version no longer meets `minimumSupportedTetherVersion()` — students on it are guided through `UPDATE_REQUIRED` (see `docs/tether-release-management.md#version-compatibility-model` below) whenever a replacement is actually downloadable. | N/A — terminal state for that version. |

**Where v1.7.2 sits today:** RELEASE CANDIDATE. Automated/server-side
verification work is substantially complete (see
`docs/tether-v1.7.2-pilot-release-readiness.md`); the 12-item "Remaining
Physical Acceptance Checklist" in that register is still outstanding.
`resolveTetherReleaseMetadata()`'s default `releaseStatus` is `INTERNAL`
specifically because this stage has not yet been exited — an operator
must explicitly set `TETHER_RELEASE_STATUS=PILOT` once physical
acceptance is complete, this never happens automatically or by inference
from code/test state.

## Semantic versioning policy

Tether follows `MAJOR.MINOR.PATCH`:

- **PATCH** (`1.7.2` → `1.7.3`) — bug fixes, security hardening, or
  behavior corrections that do not change the secure-launch manifest
  schema, the attestation protocol, or any student-visible workflow.
  Compatible with the same `minimumSupportedTetherVersion()` as the
  version it replaces unless the fix specifically requires raising it.
- **MINOR** (`1.7.x` → `1.8.0`) — new capability additions (e.g. a new
  optional check, a new evidence type) that remain backward-compatible:
  an older client can still complete a launch, just without the new
  capability. Never requires raising `minimumSupportedTetherVersion()` by
  itself.
- **MAJOR** (`1.x.x` → `2.0.0`) — a breaking change to the secure-launch
  manifest schema (`SECURE_LAUNCH_MANIFEST_SCHEMA_VERSION`), the
  attestation protocol (`ATTESTATION_PROTOCOL_VERSION`), or any change
  that makes an older client structurally unable to complete a launch.
  Always accompanied by a coordinated `minimumSupportedTetherVersion()`
  raise, and only ever activated once the new version has itself
  completed physical acceptance and downloads are enabled for it (see
  Part D's "impossible update loop" invariant in
  `src/lib/tetherReleaseMetadata.ts` — this is exactly the scenario that
  invariant exists to prevent).

## Never silently replace a published installer under the same version

Once a version has been published (downloads enabled, students may have
already installed it), its installer filename and SHA-256 must never
change. If a defect is found post-publication:

- A genuinely urgent, narrowly-scoped fix ships as a new PATCH version
  with its own filename/hash, going through the same lifecycle from
  RELEASE CANDIDATE again (physical acceptance may be abbreviated to the
  specific regression area at the release owner's discretion, but must
  still be genuine physical testing, not inference).
- The old version's `installerUrl`/hash may be retired (downloads
  disabled for it) once the new version is published, but the historical
  record (git tag, release notes, SHA-256) is never deleted — see
  "Every published release needs" below.

## Every published release needs

Before any version's `TETHER_RELEASE_STATUS` is raised to `PILOT` or
`GENERAL_AVAILABILITY` and `TETHER_INSTALLER_DOWNLOAD_URL` is populated,
the following must exist and be recorded (in this document's release log
below, or a linked equivalent):

1. **Git tag** — e.g. `tether-v1.7.2`, pointing at the exact commit the
   installer was built from.
2. **Release notes** — what changed since the previous published version.
3. **Installer file** — the actual `.exe`, hosted somewhere
   `TETHER_INSTALLER_DOWNLOAD_URL` can point to.
4. **SHA-256** — matching `CURRENT_INSTALLER_SHA256` in
   `src/lib/tetherReleaseMetadata.ts`.
5. **Signing status** — signed or unsigned, and if unsigned, that this
   was a deliberate pilot-stage decision (see
   `docs/tether-windows-code-signing-plan.md`), not an oversight.
6. **Validation result** — automated verification status (test suite,
   `npm run release:validate`) as of the release commit.
7. **Physical acceptance record** — link to the dated, evidenced
   checklist entries in the corresponding release-readiness register.
8. **Known limitations** — anything documented as P1/P2 in the
   readiness register at time of publication.
9. **Supported/minimum versions** — what `minimumSupportedTetherVersion()`
   is at time of publication, and whether this release changes it.
10. **Release date**.
11. **Rollback path** — see below.

## Rollback path

If a published version is found to have a P0-severity defect after
release:

1. Set `TETHER_INSTALLER_DOWNLOAD_URL` back to empty (or to the prior
   known-good version's URL) — this immediately disables new downloads of
   the defective version via `resolveTetherReleaseMetadata()`'s
   `downloadsEnabled` derivation, with no code change required.
2. Do not lower `minimumSupportedTetherVersion()` to try to "unsupport"
   the bad version retroactively — existing installations already running
   it are unaffected by this env change and must be handled via direct
   communication (see `docs/tether-pilot-support-runbook.md`).
3. If the defect is security-relevant (e.g. a signing-key or attestation
   issue), follow the emergency procedure in
   `docs/secure-launch-signing-key-runbook.md`.
4. Publish a corrected PATCH version through the normal lifecycle above;
   never overwrite the defective version's own filename/hash record.

## Version compatibility model

See `src/lib/tetherReleaseMetadata.ts`'s `resolveTetherCompatibilityState`
for the informational (non-security-enforcing) SUPPORTED /
OUTDATED_BUT_ALLOWED / UPDATE_REQUIRED / UNKNOWN model, and
`docs/tether-v1.7.2-pilot-release-readiness.md` /
`tetherAttestationRunner.ts`'s `CLIENT_VERSION_UNSUPPORTED` check for the
actual enforced minimum-version gate. The two are deliberately separate —
see that module's own doc comment for why.

## Release log

| Version | Stage | Date | Notes |
|---|---|---|---|
| 1.7.2 | RELEASE CANDIDATE | (frozen build, not yet publicly published) | Installer: `Tether-Secure-Browser-1.7.2-win-x64.exe`. SHA-256: `2295deeb6d78ff3f42911d2c0af904355e9cbd7048505c14a60e7a7072faed2d`. See `docs/tether-v1.7.2-pilot-release-readiness.md` for full readiness detail. Unsigned (see `docs/tether-windows-code-signing-plan.md`). |
