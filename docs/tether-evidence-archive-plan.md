# Evidence Backup/Recovery — Implementation Record (v1)

## Background

Per `TETHER_EVIDENCE_BACKUP_RECOVERY_P1_ARCHITECTURE_GATE`, Supabase
Storage objects are never included in Supabase's own database backups —
confirmed directly from official Supabase documentation. Tether's
retention-deletion tooling (`docs/tether-evidence-retention-plan.md`) is
safety-hardened but, by design, permanently removes evidence bytes with
no built-in recovery path. This pass closes that gap with the minimum
pilot-safe architecture: **Option B — a separate Supabase project holding
one private archive bucket, with its own, independent credentials.**

Option A (a second bucket in the *same* primary project) was explicitly
rejected: the primary `SUPABASE_SERVICE_ROLE_KEY` is project-wide, not
bucket-scoped, so a same-project "backup" shares the exact blast radius a
compromised primary key already has — it is "another folder in the same
failure domain," not a real backup. Option C (a fully external cloud
provider) and Option D (operator-controlled offline export) were judged
disproportionate infrastructure for a ~44-object pilot dataset; Option B
reuses ~90% of the already-reviewed primary adapter's code shape while
closing the two failure modes that actually matter here — service-role
compromise and single-project operator mistake.

## What was built (code + tests only — see "What was deliberately NOT done")

- **`src/lib/evidenceArchiveStorage.ts`** — a *separate* storage
  interface, `EvidenceArchiveStorageAdapter`, with **no `delete()`
  method at all** (not merely unused — the type doesn't declare it, and
  neither implementation defines it). The backup path has no
  application-level capability to remove an archive object. Two
  providers, mirroring `evidenceStorage.ts`'s own split:
  `LocalDevEvidenceArchiveStorageAdapter` (filesystem, dev/test only,
  writes under `.evidence-archive-storage/` — a directory entirely
  separate from the primary's `.evidence-storage/`) and
  `SupabaseEvidenceArchiveStorageAdapter` (a private bucket in a
  *different* Supabase project, using `ARCHIVE_SUPABASE_SERVICE_ROLE_KEY`
  — never the primary key). `resolveEvidenceArchiveStorageAdapter()`
  fails closed on missing config, exactly like the primary resolver.
  `extractSupabaseProjectRef()` parses a Supabase URL's project-ref
  subdomain — used only for the separation guard below, never logged
  alongside the full URL or a credential.

- **`src/lib/evidenceArchive.ts`** — the orchestrator:
  - `findEvidenceArchiveCandidates()` — reads `IntegrityEvidenceAsset`
    metadata only (read-only, no mutation).
  - `verifySourceEvidence()` — downloads the **primary** object through
    the *existing, unmodified* `EvidenceStorageAdapter`, recomputes its
    SHA-256, and compares against the database's own recorded digest and
    byte size *before* anything is ever archived. A missing, undigested,
    hash-mismatched, or size-mismatched source object is never archived.
  - `generateArchiveObjectKey()` — a **deterministic**
    `evidence/v1/<evidenceAssetId>.<ext>` key (extension from the
    already-approved `{image/jpeg: jpg, image/webp: webp}` mapping,
    never a user-controlled filename, never a random suffix or
    `archiveRunId` — the same asset always resolves to the same archive
    key, which is what makes idempotency meaningful across reruns).
  - `archiveVerifiedEvidence()` — idempotent, verified write: checks
    whether the deterministic key already exists (matching SHA-256 →
    `ALREADY_ARCHIVED_VERIFIED` safe no-op; mismatched → `ARCHIVE_CONFLICT`,
    never auto-overwritten); otherwise uploads (`upsert:false` at the
    adapter level) and then **downloads the bytes back** and re-verifies
    SHA-256 + size before ever reporting `ARCHIVED_VERIFIED` — an upload
    "success" response is never trusted alone.
  - A **non-circular manifest digest**: `computeManifestSha256()`
    reconstructs a plain object in a fixed, explicit field order
    (excluding `manifestSha256` itself) and hashes that canonical JSON
    serialization — no third-party canonical-JSON dependency, no risk of
    hashing a document that already contains its own digest.
    `buildManifestDocument()`/`verifyManifestDocument()` are exact
    inverses of each other, both covered by dedicated tests including a
    field-order-independence proof.
  - `assertSupabaseArchiveOperationSafe()` — the **shared**,
    **machine-enforced** project-separation guard used by BOTH archive
    execute and restore (a security-corrections v1 fix: restore
    previously resolved the archive adapter directly, with no identity
    validation at all — the two paths can no longer drift out of sync).
    It fails closed, unconditionally, if the archive project ref would
    ever resolve to the *same* Supabase project as the primary. For any
    *real* (`supabase_storage`, never `local_dev`) archive destination it
    additionally requires: the primary project ref to be resolvable, the
    archive project ref to be resolvable, `ARCHIVE_EXPECTED_PRIMARY_PROJECT_REF`
    to be configured, and the primary project ref to equal it. Crucially,
    "is this Production" (`isProductionOperation`) is derived **solely**
    from this actual, operator-configured environment — **never** from
    any caller-supplied argument. `assertProductionArchiveSafe()` and
    `assertRestoreOperationSafe()` are thin, direction-specific wrappers
    that additionally require `--confirm-production-archive` /
    `--confirm-production-restore` respectively whenever
    `isProductionOperation` is true. Both are called from *inside*
    `runEvidenceArchiveSweep`/`restoreEvidenceAsset` themselves — not
    only at the CLI layer — so a caller cannot bypass either by invoking
    the library function directly.

    **Security correction: a caller-supplied `sourceEnvironment` can no
    longer weaken the guard.** The prior design let
    `runEvidenceArchiveSweep({ sourceEnvironment })` override the guard's
    own view of "is this production," which meant a direct caller could
    label a real-production write "test" and skip the confirmation
    requirement entirely. `sourceEnvironment` is now recorded **only** as
    manifest metadata (`ArchiveManifestPayload.sourceEnvironment`) and
    has zero influence on the guard — proven by dedicated tests that set
    the real environment to a genuinely production-matching
    configuration, pass `sourceEnvironment: "test"` and no confirmation
    flag, and assert the operation still fails closed for both archive
    execute and restore.
  - `runEvidenceArchiveSweep()` — the entry point. `dryRun: true` (the
    default) only downloads and source-verifies each candidate; it never
    resolves the archive adapter, never writes a manifest, never writes
    an audit row, never modifies the database or primary storage — the
    archive adapter object literally isn't obtained on that path, so
    there is no code path by which a dry run could write anything. Only
    `dryRun: false` calls the production guard and actually archives.

    Audit writes are **awaited** (never fire-and-forget — a security
    correction from the prior pass, which used
    `createPlatformAuditLog(...).catch(() => {})` and returned without
    ever knowing whether the record actually persisted) and
    **existence-checked before writing**: `ensureArchiveAudit()` queries
    for an existing `INTEGRITY_EVIDENCE_ARCHIVE_VERIFIED` row for the
    asset first. Already present → `ALREADY_AUDITED` (no duplicate).
    Absent → attempts the write; success → `AUDITED`; failure →
    `AUDIT_FAILED`. This runs for **both** `ARCHIVED_VERIFIED` and
    `ALREADY_ARCHIVED_VERIFIED` outcomes (not just newly-archived ones),
    which means a rerun **self-repairs** an asset that was successfully
    archived on an earlier run whose audit write itself failed. A failed
    archive audit makes `overallOk` false, but the archive object itself
    is **never** rolled back or deleted merely because its audit failed.
  - **Manifest coverage metadata** (a security correction — the prior
    manifest only ever listed successfully-archived assets, with no
    top-level signal that a run was incomplete). `ArchiveManifestPayload`
    now carries `candidateCount`, `verifiedAssetCount`, `failureCount`,
    and `runStatus` (`"COMPLETE"` only when every candidate reached a
    verified archive state; `"PARTIAL_FAILURE"` otherwise) — all four
    participate in the canonical digest, so relabeling a partial run as
    complete (or tampering with any count) breaks `verifyManifestDocument()`.
    A partial manifest still only ever contains entries for the assets
    that actually verified, but its own top-level fields make that
    incompleteness unambiguous even though the manifest document itself
    still verifies cryptographically.
  - `restoreEvidenceAsset()` — minimum pilot restore only. Supports
    scenario **A** (primary object missing, DB row intact) and scenario
    **C** (primary object exists but fails SHA-256 verification —
    corrupt). A **healthy** primary object is always refused, regardless
    of confirmation. Every restore requires explicit `--confirm-restore`,
    and — per the shared guard above — a restore against the configured
    Production primary project additionally requires
    `--confirm-production-restore`. The archive copy is **never** deleted
    by this function under any outcome. Because the primary adapter's
    `put()` always uses `upsert:false` (unmodified — see
    `evidenceStorage.ts`), overwriting a corrupt primary requires first
    calling the *existing* `delete()` on that one key — only ever reached
    after confirmation and after the archive bytes have already been
    proven correct against the database's own recorded digest.

    The restore audit write is likewise **awaited**, never
    fire-and-forget. Bytes are restored and SHA-verified *before* the
    audit write is attempted, so an audit failure is reported as a
    distinct `RESTORED_VERIFIED_AUDIT_FAILED` outcome — the operator is
    told bytes are safe but reconciliation is needed — rather than either
    silently swallowing the failure or rolling back an already-healthy
    primary object.

    **Restore error sanitization** (a security correction): the primary
    adapter's own error messages can embed the raw `storageKey` (e.g.
    Supabase's `upload failed for "<key>": ...`, or local_dev's `Unsafe
    evidence storage key: "<key>"`) — `evidenceStorage.ts` is
    deliberately left unmodified, so this is fixed at the restore
    boundary instead: a primary write/verify failure during restore
    always returns a fixed, bounded message (`"Primary evidence restore
    write failed."` / `"...verification failed."`), never the
    underlying adapter's `err.message`. Proven by an adversarial test
    that forces the primary adapter to throw a message containing the
    real storage key, an internal URL, and a fake credential token, and
    asserts none of it appears in the returned outcome.

- **`scripts/run-evidence-archive.ts`** — `npm run evidence:archive`,
  mirroring `scripts/run-evidence-retention.ts`'s own manual-CLI,
  dry-run-by-default conventions exactly. Archive mode:
  `[--execute] [--confirm-production-archive]`. Restore mode:
  `--restore-asset <id> [--confirm-restore] [--confirm-production-restore]`.
  Routine output shows only asset id, kind, capturedAt, byteSize, status,
  and audit status — never a `submissionId`, `storageKey`, archive object
  key, raw URL, or credential.

### `DB_METADATA_RECONSTRUCTION: MANUAL_RECOVERY_PROCEDURE / NOT AUTOMATED`

If Postgres is ever restored to an earlier point and the archive holds
objects whose metadata no longer exists in the restored database, this
tooling does **not** attempt to automatically recreate `IntegrityEvidenceAsset`,
`IntegrityEvent`, `Submission`, or `Exam` rows from the archive manifest.
The manifest (which, for exactly this reason, embeds `institutionId`,
`examId`, `submissionId`, and `integrityEventId` per asset — protected,
private-manifest-only fields, never printed to routine CLI output or
written to an audit row) is meant to assist a human operator's manual
investigation and reconciliation after such an event. Relational
database reconstruction is explicitly out of scope for pilot v1.

## Security corrections v1

An independent security review of the first implementation pass found
four issues, all fixed in this same branch before any provisioning:

1. **Restore lacked the project-separation guard entirely.** Fixed by
   introducing `assertSupabaseArchiveOperationSafe()` as a single shared
   primitive used by both archive execute and restore, so the two paths
   cannot drift out of sync again.
2. **A caller-supplied `sourceEnvironment` argument could downgrade the
   security decision** (e.g. label a real-production write "test" to
   skip confirmation). Fixed by deriving `isProductionOperation` solely
   from actual environment configuration; `sourceEnvironment` is now
   manifest metadata only.
3. **A partial archive run's manifest gave no top-level signal that it
   was incomplete.** Fixed by adding `candidateCount` /
   `verifiedAssetCount` / `failureCount` / `runStatus` to the manifest
   payload, all participating in its digest.
4. **Audit writes were fire-and-forget**, so the caller never knew
   whether an audit record actually persisted, and a failed archive
   audit had no effect on the reported run status. Fixed by awaiting
   every audit write, existence-checking before writing (so a rerun
   self-repairs a missing audit without duplicating an existing one),
   and making a failed archive audit turn `overallOk` false. Restore
   audit failures are reported via a distinct
   `RESTORED_VERIFIED_AUDIT_FAILED` status rather than being silently
   swallowed or triggering a rollback of an already-healthy primary
   object. A related, smaller finding — restore forwarding the raw
   primary-adapter error message (which can embed the storage key) to
   operator output — was fixed at the same time by sanitizing at the
   restore boundary.

## What was deliberately NOT done in this pass

- **No real archive Supabase project was created.** No second Supabase
  project, no real bucket, no cloud resource of any kind. All tests run
  against local, disposable primary/archive `local_dev` adapters and a
  local test Postgres instance.
- **No archive credentials were added to Vercel.** This tool is designed
  to be run manually from an operator workstation with locally-supplied
  credentials — never deployed, never automated. This is what actually
  keeps archive credentials outside the blast radius of a Vercel-side
  compromise, independent of which provider was chosen (see the
  architecture-gate's own threat-matrix analysis).
- **No Production evidence was copied, archived, or restored.** No
  `--execute` or `--confirm-restore` run was ever performed against a
  real Production or Preview environment.
- **No retention execution.** `npm run evidence:retention -- --execute`
  was not run.
- **No scheduler.** This remains a manual, operator-triggered tool only,
  exactly like the retention runner.
- **No institution/submission CLI filters.** `findEvidenceArchiveCandidates()`
  accepts an optional `institutionId` parameter (used only for test
  isolation, mirroring the identical existing precedent in
  `findEligibleEvidenceAssetsForDeletion`), but the shipped CLI never
  exposes it — at current pilot scale, a full, unfiltered run is simpler
  and safer than a partial one.

## How to use this (once a real archive project exists)

```bash
# Report what would be archived — archives nothing.
npm run evidence:archive

# Actually archive (non-production source, e.g. local/dev testing).
npm run evidence:archive -- --execute

# Actually archive against the configured Production primary project
# (required whenever the ACTUAL primary Supabase project matches
# ARCHIVE_EXPECTED_PRIMARY_PROJECT_REF — determined from real
# environment configuration, never from a script argument): requires a
# genuinely separate ARCHIVE_SUPABASE_URL and this flag.
npm run evidence:archive -- --execute --confirm-production-archive

# Restore one asset (only after confirming this is genuinely needed).
npm run evidence:archive -- --restore-asset <evidenceAssetId>
npm run evidence:archive -- --restore-asset <evidenceAssetId> --confirm-restore

# Restore against the configured Production primary project requires both flags.
npm run evidence:archive -- --restore-asset <evidenceAssetId> --confirm-restore --confirm-production-restore
```

### Environment variables (names only)

`ARCHIVE_STORAGE_PROVIDER`, `ARCHIVE_SUPABASE_URL`,
`ARCHIVE_SUPABASE_SERVICE_ROLE_KEY`, `ARCHIVE_STORAGE_BUCKET`,
`ARCHIVE_SOURCE_ENVIRONMENT` (manifest metadata only — see "Security
corrections v1" above), `ARCHIVE_EXPECTED_PRIMARY_PROJECT_REF`. None of
these are `NEXT_PUBLIC_*`; none may reuse the primary
`SUPABASE_SERVICE_ROLE_KEY`.
