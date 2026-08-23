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
requires a VALID `--environment <label>` and `--output-dir <path>`
explicitly — there is no default environment and no default output
location, and an empty/whitespace-only/malformed label is rejected
before proceeding, not silently treated as absent. **`--environment`
"production", in ANY case or whitespace variant — "Production",
"PRODUCTION", " production ", "production " all normalise (trim +
lowercase) to the one canonical label "production" before this
decision is made — additionally requires a separate, explicit
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

Dump commands run inside a throwaway, unconfigured "toolbox" Docker
container purely for its bundled client binaries — the toolbox
container itself is never used as a database target, and is
unconditionally removed when the run finishes, succeeds or fails. This
means the operator does not need any Postgres/Supabase client tooling
installed locally, only Docker.

**Source password is never in this process's own subprocess argument
list.** `docker exec -e PGPASSWORD=<value> ...` would put the real
source password directly into the host `docker` process's own
argument vector — visible to any other process on the same machine via
an ordinary process listing, without needing elevated privileges. This
tool instead uses `docker exec -e PGPASSWORD ...` (the bare variable
NAME, no `=value`) — real, documented Docker CLI behaviour that
forwards the CURRENT VALUE of `PGPASSWORD` from the `docker` client
process's OWN environment into the container. The actual value is
handed to the spawned `docker` process only via its environment
(`child_process.spawn`'s own `env` option), never as an argv token —
see `scripts/backupCreation/dockerExecInvocation.ts`.

## Source adapters — local/generic vs. Supabase-managed

Which dump commands actually run is decided by
`scripts/backupCreation/sourceAdapters.ts`, auto-selected from whether
a Supabase project reference is known (explicit `--source-project-ref`
or safely derived from the connection string), overridable with
`--source-type local-generic|supabase-managed`:

- **`local-generic`** — raw `pg_dumpall --roles-only` /
  `pg_dump --schema-only --schema <name> --clean --if-exists` /
  `pg_dump --data-only --schema <name>`. Appropriate for a generic or
  local Postgres source. **This is the path exercised end to end
  against synthetic local data in this pass** (see "Current status"
  below).
- **`supabase-managed`** — the Supabase CLI's own `supabase db dump
  --role-only` / `supabase db dump` / `supabase db dump --data-only
  --use-copy`, which applies Supabase's own managed-schema exclusions
  and reserved-role filtering internally. **This tool deliberately does
  not hand-roll a list of Supabase-reserved roles or internal schemas
  to strip** — that list belongs to Supabase to define and maintain,
  and a raw, unfiltered `pg_dumpall --roles-only` against a real
  Supabase project is not equivalent to `supabase db dump --role-only`
  and must never be used as the Production Supabase path. This adapter
  additionally passes `--exclude-table 'storage.buckets_vectors'
  --exclude-table 'storage.vector_indexes'` per current Supabase
  guidance for Storage vector tables — **not verified against a real
  Supabase CLI in this pass**, listed as a single, easy-to-adjust
  constant (`SUPABASE_VECTOR_TABLE_EXCLUSIONS`) specifically so it can
  be corrected quickly once verified. Excluding these tables does not
  change the separate, unchanged fact that Storage object *bytes* are
  never covered by any database backup — see "What this tooling does
  NOT do" below.

  The Supabase CLI's `--db-url` flag requires the connection string as
  a literal argument — there is no environment-variable-based
  alternative the way `pg_dump`/`psql` have. To avoid that URL (with
  its embedded password) appearing as its own discrete token in the
  HOST's own `docker exec` argv, the command run inside the toolbox
  container is a fixed, static shell string (`sh -c '...'`, itself
  containing no secret — only `$PGUSER`/`$PGPASSWORD`/etc. variable
  *references*), with those references expanded by the shell running
  *inside* the container from its own environment at execution time.
  This moves the exposure from the host's own process list into a
  short-lived, single-purpose container's internal process list — not
  a zero-risk design, but the best available given the Supabase CLI's
  own requirement.

  **`SUPABASE_MANAGED_SOURCE_RUNTIME_TEST: DEFERRED`** — this adapter's
  command construction is unit-tested
  (`scripts/backupCreation/sourceAdapters.test.ts`), but has never been
  executed against a real Supabase CLI or a real Supabase project in
  this pass. No Supabase CLI is available in this development
  environment, and no Production contact is permitted. Do not treat
  this pass's successful `local-generic` synthetic exercise as proof
  that the `supabase-managed` adapter works against a real managed
  project — it proves bundle mechanics (manifest, hashing, restore
  rehearsal, atomicity), not Supabase-specific dump semantics.

## Manifest contents

`manifest.json` contains only non-secret operational metadata. **This
is enforced by validation, not merely by the field types being
`string`** — `--environment` and `--source-project-ref` are each
validated against a strict allowlist pattern
(`scripts/backupCreation/manifestMetadataValidation.ts`) before
`--execute` is permitted to proceed at all; a malformed value (a
connection string pasted into either flag, embedded whitespace,
control characters, an oversized value) is rejected outright and never
reaches manifest creation. `--environment production`, in any case or
whitespace variant ("Production", "PRODUCTION", " production ",
"production "), normalises to the one canonical stored label
`"production"` — this is also the exact form the
`--confirm-production` gate checks against, so the two can never
silently disagree:

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
| Database backup **creation** tooling (`local-generic` adapter) | **IMPLEMENTED AND LOCALLY VERIFIED** — exercised end to end against a disposable, synthetic local Postgres database, including the hardened source-password handling and Production-confirmation casing gate (see `docs/backup-and-disaster-recovery-runbook-v1.md`'s updated Section 8 for the exact local test result) |
| `supabase-managed` adapter | **SUPABASE_MANAGED_SOURCE_RUNTIME_TEST: DEFERRED** — command construction is unit-tested; never executed against a real Supabase CLI/project |
| A real **Production** backup | **NOT YET EXECUTED / VERIFIED** — this tool has never been run with `--environment production --confirm-production` against a real Production database |
| Off-project copy destination | **NOT YET SELECTED / VERIFIED** — PRE-PILOT OFF-PROJECT COPY GATE: OPEN |
| Backup cadence | **NOT YET APPROVED** — PRE-PILOT BACKUP CADENCE DECISION: OPEN |
| PRE-PILOT BACKUP GATE (overall) | **OPEN** — the tooling gap is closed for the `local-generic` path; the `supabase-managed` path is untested at runtime; the operational gap (a real, verified, off-project, restore-tested Production backup) is not closed either way |
