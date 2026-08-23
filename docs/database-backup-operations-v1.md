# Database Backup Operations v1

**This closes the TOOLING portion of the PRE-PILOT BACKUP GATE
(`docs/backup-and-disaster-recovery-runbook-v1.md`, Section 8/37) — it
does NOT by itself close the gate.** The gate closes only once a real,
authorised Production backup has actually been created, copied
off-project, verified, and restore-tested — none of which this pass
performs. See the status summary at the end of this document.

This document is the operator runbook for `npm run backup:create` and
`npm run backup:verify-bundle`. It sits alongside, and cross-links to,
[`docs/production-backup-restore-runbook.md`](production-backup-restore-runbook.md)
(the existing single-file verification tool, unchanged) and
[`docs/backup-and-disaster-recovery-runbook-v1.md`](backup-and-disaster-recovery-runbook-v1.md)
(the umbrella DR runbook this tooling feeds into).

---

## What this tooling does

`npm run backup:create -- --execute --environment <label> --output-dir <path>
[--confirm-production] [--source-project-ref <ref>] [--pg-schema <name>]`
creates a logical database backup **bundle** — a directory, never one
ambiguous unnamed file:

```
database-backup-<timestamp>/
  roles.sql       # pg_dumpall --roles-only — cluster-wide roles, not scoped to one database
  schema.sql      # pg_dump --schema-only --schema <name>
  data.sql        # pg_dump --data-only --schema <name>
  manifest.json   # non-secret operational metadata — see below
```

`--pg-schema` defaults to `public` — the application's own schema (per
`DATABASE_URL`'s `?schema=public`, `prisma/schema.prisma`). Scoping the
dump to this schema follows current Supabase guidance to exclude
Supabase-managed internal schemas (`auth`, `storage`, `realtime`,
`extensions`, `graphql`, `pgsodium`, `vault`, etc.) from an ordinary
application-data backup — this application does not use Supabase Auth
or reference Supabase's internal schemas, so scoping to `public` both
follows that guidance and avoids dumping infrastructure this application
doesn't own.

**This tool creates backups only. It has no restore capability of any
kind** — restoring is exclusively the job of `npm run backup:verify`
(single dump file, existing tool, unchanged) and
`npm run backup:verify-bundle` (this pass's bundle-aware counterpart),
both of which restore **only** into a disposable local Docker container,
never Production.

## Dry run is the default

Running `npm run backup:create` with **no** `--execute` flag is always a
**DRY RUN / INFORMATION ONLY** — it prints what would happen, contacts
no database, and starts no Docker container. `--execute` additionally
requires `--environment <label>` and `--output-dir <path>` explicitly —
there is no default environment and no default output location.
**`--environment production` additionally requires a separate, explicit
`--confirm-production` flag** — this is never inferred from the
connection string; a `local-test`/`staging`/other non-"production"
label is trusted as the operator's own deliberate statement.

## Connection source

Reads `BACKUP_SOURCE_DATABASE_URL` (preferred — a dedicated variable,
distinct from the application's own runtime `DATABASE_URL` connection
pool) or falls back to `DATABASE_URL` if unset. The raw connection
string is never logged, never written to the manifest, and never
appears in this tool's own console output — only a redacted
`host:port/database` description is ever printed, and any subprocess
error text is redacted before being logged or stored (see
`scripts/backupCreation/connectionRedaction.ts`).

## Mechanism

`pg_dump`/`pg_dumpall` run inside a throwaway, unconfigured "toolbox"
Docker container (the same `postgres:16-alpine` image
`npm run release:validate` and `npm run backup:verify --restore` already
use) purely for its bundled client binaries — the toolbox container
itself is never used as a database target, and is unconditionally
removed when the run finishes, succeeds or fails. This means the
operator does not need `pg_dump`/`pg_dumpall` installed locally, only
Docker.

## Manifest contents

`manifest.json` contains only non-secret operational metadata — there
is no field in its type that could hold a credential, by construction:

- manifest schema version
- backup ID (matches the bundle's own timestamp-based directory name)
- `createdAt` (UTC)
- source environment label (operator-supplied)
- source project reference, if explicitly supplied via
  `--source-project-ref`, or safely derived from a recognised Supabase
  hostname/pooler-username pattern — never a connection string
- tool version (from `package.json`) and repository commit (best-effort
  `git rev-parse HEAD`), if available
- for each of roles/schema/data: filename, byte size, SHA-256
- bundle status: `IN_PROGRESS` / `COMPLETE` / `FAILED`
- failure detail (redacted), only set when `FAILED`
- verification status, once a subsequent `backup:verify-bundle` run has
  recorded one

## Atomicity / partial-failure behaviour

The bundle is written first under a `.<name>.inprogress` temporary
directory name. Only once every stage succeeds — all three files
produced, hashed, and copied out of the toolbox container — is the
directory renamed to its final `database-backup-<timestamp>` name and
the manifest's status set to `COMPLETE`. **A failed or interrupted run
can never look like a valid, `COMPLETE` bundle**: on any failure, the
manifest is marked `FAILED` with a redacted diagnostic, and the
directory is renamed to `database-backup-<timestamp>.FAILED` rather than
silently deleted — the diagnostic evidence is preserved for
troubleshooting, never hidden.

## Verifying a bundle

```bash
npm run backup:verify-bundle -- <bundle-dir>
```

Reads the manifest, refuses to proceed if it is missing, malformed, or
not `COMPLETE`, then recomputes each file's SHA-256 and byte size and
compares against the manifest's recorded values — detecting both a
missing file and a tampered/corrupted one.

```bash
npm run backup:verify-bundle -- <bundle-dir> --restore --report <path>
```

Additionally rehearses restoring the bundle (`roles.sql` → `schema.sql`
→ `data.sql`, in that order) into a throwaway local Docker Postgres
container — reusing the exact same disposable-container infrastructure
and sanity checks as the existing single-file
`npm run backup:verify --restore` (`scripts/backupVerification/restoreRehearsal.ts`),
never a parallel implementation. **This can never restore into
Production** — see `scripts/backupCreation/bundleRestoreRehearsal.ts`'s
own doc comment for the same structural guarantee (`requireDisposableDatabaseUrl`)
the existing single-file tool already relies on.

## Output location safety

Backups are refused from writing into any ordinary tracked repository
path (`src/`, `docs/`, `prisma/`, `apps/`, `scripts/`, `.git/`, the
repository root itself, or any other unrecognised in-repo path — this
fails closed, it is not a denylist of a few obvious names). The only
permitted destinations are:

- an explicit path outside this repository entirely, or
- the one dedicated, gitignored local directory: `.local-backups/`
  (see `.gitignore` and `scripts/backupCreation/outputPathSafety.ts`).

This makes it difficult for an accidental `git add .` to ever pick up a
database backup.

---

## What this tooling does NOT do — read this before relying on it

- **It does not back up Supabase Storage object bytes.** A database
  backup — whether created by this tool, `supabase db dump`, or plain
  `pg_dump` — never contains Storage API object bytes, only whatever
  metadata about them the application's own tables happen to store.
  Evidence-storage recovery is a completely separate domain — see
  `docs/backup-and-disaster-recovery-runbook-v1.md`, Sections 9–10. This
  boundary is unchanged by this pass.
- **It does not schedule anything.** `npm run backup:create` is never
  invoked automatically by this repository — no cron, no route, no
  build step, no CI job. Every run is a deliberate operator action.
- **It does not create a Production backup by itself completing
  successfully in this repository's own development/test environment.**
  Every test and validation run behind this pass used only disposable,
  synthetic local databases — see the "Current status" section below.

---

## Off-project copy — PRE-PILOT OFF-PROJECT COPY GATE: OPEN

A backup bundle created by this tool, sitting only in the same Supabase
project's failure domain (or only on the operator's own machine), is
not yet a disaster-recovery-grade backup — it must be copied to a
**separate failure domain** before it protects against the scenario
that matters most (complete loss of the primary project).

This pass does **not** implement a paid/cloud storage destination.
Acceptable categories for a **future** choice (not decided here):

- encrypted institutional/company-managed object storage;
- an encrypted managed backup storage service;
- another reviewed off-project location meeting the same bar.

**Explicitly NOT acceptable**, regardless of convenience:

- the same Supabase project the backup was taken from;
- a public GitHub repository;
- an ordinary source-control commit (of any kind, public or private —
  this repository's own `.gitignore` refuses `.local-backups/` for
  exactly this reason);
- only the operator's own laptop, with no second copy anywhere;
- the same disk as the working repository clone.

**PRE-PILOT OFF-PROJECT COPY GATE: OPEN** — no destination has been
selected or tested as of this pass. This document does not invent a
provider before the user chooses one.

## Backup cadence — PRE-PILOT BACKUP CADENCE DECISION: OPEN

**No contractual RPO is committed by this document.** Candidate
operational cadences, for future decision (none approved yet):

- before a major schema/release change;
- before a pilot exam window;
- a regular scheduled cadence, once a real pilot begins;
- on-demand, before risky maintenance.

This document does not state "daily backups are guaranteed," or any
other cadence claim, because no scheduled execution mechanism has been
implemented or tested — see "What this tooling does NOT do" above.
**PRE-PILOT BACKUP CADENCE DECISION: OPEN** until an operator explicitly
approves a cadence.

---

## Current status (as of this pass)

| Item | Status |
|---|---|
| Database backup **creation** tooling | **IMPLEMENTED AND LOCALLY VERIFIED** — exercised end to end against a disposable, synthetic local Postgres database only (see `docs/backup-and-disaster-recovery-runbook-v1.md`'s updated Section 8 for the exact local test result) |
| A real **Production** backup | **NOT YET EXECUTED / VERIFIED** — this tool has never been run with `--environment production --confirm-production` against a real Production database |
| Off-project copy destination | **NOT YET SELECTED / VERIFIED** — PRE-PILOT OFF-PROJECT COPY GATE: OPEN |
| Backup cadence | **NOT YET APPROVED** — PRE-PILOT BACKUP CADENCE DECISION: OPEN |
| PRE-PILOT BACKUP GATE (overall) | **OPEN** — the tooling gap is closed; the operational gap (a real, verified, off-project, restore-tested Production backup) is not |
