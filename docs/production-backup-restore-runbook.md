# Production Backup & Restore Verification Runbook (v1)

**This is the detailed, technical database-backup-verification
sub-runbook.** Broader Production recovery decisions — evidence-storage
recovery, application/Vercel recovery, configuration recovery, Secure
Browser release-artifact recovery, RPO/RTO, and the overall recovery
process and approval boundary — belong to the umbrella
[`docs/backup-and-disaster-recovery-runbook-v1.md`](backup-and-disaster-recovery-runbook-v1.md),
which cross-links back to this document for the exact `backup:verify`
tool behaviour rather than restating it. This document's own scope and
guarantees below are unchanged by that umbrella document.

## Why this exists

A previous production "backup" was later found to be only 41 bytes —
unusable, and nothing in the workflow at the time would have caught it: a
file existed at the expected path, so the backup step was assumed to have
succeeded. This runbook, and the tool it documents
(`npm run backup:verify`), exist specifically to close that gap:
**a backup is not verified until its file has been checked, and ideally
until it has actually been restored somewhere and shown to produce a real
schema.**

## What this tool does and does not do

- **Does:** verify a dump file that already exists on disk — file
  existence, plausible size, checksum, dump-format detection, and
  (optionally) a full restore rehearsal into a throwaway local Postgres
  container with basic schema/table sanity checks.
- **Does not:** create the backup itself. Producing the actual
  `pg_dump` of the production database remains a separate operational
  step (via Supabase's own backup/export tooling, or a scheduled
  `pg_dump` against the production connection string, run by whoever
  currently owns that credential). This tool starts only once a dump file
  already exists locally.
- **Does not, under any circumstance, connect this tool's restore
  rehearsal to Production.** See "Safety guarantee" below.

## The verification workflow

```
backup created (existing process, out of scope here)
        │
        ▼
   file exists?  ──── no ──→ FAIL (nothing further to check)
        │ yes
        ▼
  plausible size? (≥ 10,000 bytes by default —
  the 41-byte incident would fail here immediately)
        │ yes                ──── no ──→ FAIL
        ▼
   SHA-256 recorded
        │
        ▼
  dump header/type verified
  (pg_dump CUSTOM or PLAIN_SQL — sniffed from
  the file's own bytes, never the filename)
        │ recognised          ──── not recognised ──→ FAIL
        ▼
  [optional --restore flag]
  restore into a DISPOSABLE local Postgres container
        │
        ▼
  schema/table sanity checks
  (at least one table exists; restored tables
  contain rows)
        │
        ▼
  verification result recorded (JSON summary,
  exit code 0 = PASS / 1 = FAIL)
```

## Usage

```bash
npm run backup:verify -- /path/to/backup.dump
```

Runs file-level checks only (fast, no Docker required). This is the
minimum that should run after every backup is produced.

```bash
npm run backup:verify -- /path/to/backup.dump --restore
```

Additionally rehearses a full restore into a throwaway local Postgres
container and runs sanity checks. Requires Docker Desktop installed and
running (the same requirement as `npm run release:validate`). This is the
recommended check to run periodically (e.g. monthly, or before any major
release) — a file that merely "looks plausible" is not the same guarantee
as "this file actually restores into a working database."

Exit code `0` means every requested check passed; `1` means something
failed. The full JSON verification record is printed to stdout — capture
it (e.g. redirect to a file, or paste into an incident/ops log) as the
evidence a given backup was actually verified, and when.

```bash
npm run backup:verify -- /path/to/backup.dump --restore --report ./backup-verification-report.json
```

Production administration hardening v1 — `--report <path>` additionally
writes the SAME verification record to a local JSON file, in a standard,
versioned, machine-readable shape (`schemaVersion`, `backupFilename`,
`sizeBytes`, `sha256`, `verificationTimestamp`, `formatResult`,
`disposableRestoreResult`, `overallPassed` — see
`scripts/backupVerification/verificationReport.ts`). This is a plain
local file artifact, never uploaded anywhere and never containing a
connection string, password, or any other credential — safe to attach to
an incident ticket or archive alongside the backup itself as durable
evidence of verification.

## Safety guarantee — this can never target Production

`scripts/backupVerification/restoreRehearsal.ts` never accepts a
caller-supplied database connection string as its restore target. Every
run:

1. Generates a fresh, random container name/database name/username/
   password.
2. Starts a brand-new `postgres:16-alpine` Docker container bound only to
   `127.0.0.1` on a freshly-allocated free port (reusing
   `scripts/releaseValidation/docker.ts` — the exact same infrastructure
   `npm run release:validate` already relies on for its own disposable
   database).
3. Runs the resulting connection string through
   `requireDisposableDatabaseUrl` (`scripts/releaseValidation/dbSafetyGuard.ts`)
   — the same guard that fails closed against anything that isn't an
   unambiguous loopback Postgres URL, including an explicit reject-list
   for Supabase hostname/pooler-username markers. This is not a
   configuration option; there is no flag or environment variable that
   can redirect the restore rehearsal elsewhere.
4. Copies the dump file into that container (`docker cp`) and restores it
   using the container's own bundled `pg_restore`/`psql` — the host
   machine never needs local Postgres client tools installed, and no
   restore command ever runs against a connection string this module
   didn't generate itself in step 1-2.
5. Unconditionally removes the container when done — success, failure, or
   an unexpected exception all reach the same cleanup path (mirroring
   `release-validate.ts`'s own cleanup-on-any-outcome discipline).

## Interpreting a failure

| Failure | Likely meaning | Next step |
|---|---|---|
| File does not exist | The backup step didn't run, ran against the wrong path, or the file was moved/deleted | Re-run the backup step; confirm the output path |
| Implausibly small (< 10,000 bytes) | The exact class of failure this tool exists to catch — the backup step likely failed partway through, or wrote an error message instead of dump data | Re-run the backup step; inspect the backup tool's own logs/exit code from that run |
| Unrecognised dump format | The file isn't a `pg_dump` custom-format or plain-SQL dump at all — could be truncated, corrupted, or the wrong file entirely | Do not trust this file as a usable backup; re-run the backup step |
| Restore fails | The dump is real but something in it is not restorable (version mismatch, incomplete transfer, genuine corruption) | Inspect the restore error detail in the tool's output; consider re-running the backup step and re-verifying |
| Restore succeeds but sanity checks fail (zero tables) | The dump restored cleanly but appears to contain no schema — possibly a dump of the wrong database, or an empty one | Confirm which database the backup step actually targeted |

## What this tool deliberately does not check

- It does not compare the restored schema against this repository's
  current Prisma schema (`prisma/schema.prisma`) table-by-table — the
  sanity checks are intentionally generic (at least one table, tables
  contain rows) so this tool never silently bit-rots every time the
  schema changes. A stronger, schema-aware check could be added later if
  needed, but is out of scope for this pass.
- It does not automate scheduling of backups or of this verification
  step itself — this is a manual/CI-triggered tool, not a background job.
- It does not upload, transmit, or store the backup file anywhere — it
  only reads the local file path given to it.

## Tests

`scripts/backupVerification/backupFileChecks.test.ts` covers the pure,
Docker-independent file-level checks against synthetic fixtures: a
missing file, an empty file, a 41-byte file (the exact historical
incident size), a large file with unrecognisable content, and both
well-formed custom-format and plain-SQL dumps. These run as part of the
ordinary `npm test` suite (no Docker/database required).

The disposable-restore rehearsal itself (`restoreRehearsal.ts`) is not
covered by an automated unit test in this pass — it is Docker- and
network-dependent in the same way `release-validate.ts`'s own disposable-
database orchestration is, and that file likewise has no dedicated unit
test, relying instead on its own real execution as the verification (see
`npm run release:validate`). Exercise it manually with a real or
synthetic dump file and `--restore` before relying on it operationally.
