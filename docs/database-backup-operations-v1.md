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
  roles.sql       # cluster-wide roles, not scoped to one database
  schema.sql      # schema, scoped to <name> (local-generic) or the connected project's own default (supabase-managed)
  data.sql        # data, scoped to <name> (local-generic) or the connected project's own default (supabase-managed)
  manifest.json   # non-secret operational metadata — see below
```

The exact dump command behind each file depends on the source adapter
(`local-generic` vs. `supabase-managed`) — see "Source adapters" below.

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

Two source adapters exist, and — unlike an earlier version of this
tool — they are never forced through the same execution mechanism. See
`scripts/backupCreation/sourceAdapters.ts` (`executor` field on each
adapter) and the "Source adapters" section below for the full design.

**`local-generic`** dump commands run inside a throwaway, unconfigured
"toolbox" Docker container purely for its bundled `pg_dump`/`pg_dumpall`
client binaries — the toolbox container itself is never used as a
database target, and is unconditionally removed when the run finishes,
succeeds or fails. **Source password is never in this process's own
subprocess argument list.** `docker exec -e PGPASSWORD=<value> ...`
would put the real source password directly into the host `docker`
process's own argument vector — visible to any other process on the
same machine via an ordinary process listing, without needing elevated
privileges. This adapter instead uses `docker exec -e PGPASSWORD ...`
(the bare variable NAME, no `=value`) — real, documented Docker CLI
behaviour that forwards the CURRENT VALUE of `PGPASSWORD` from the
`docker` client process's OWN environment into the container. The
actual value is handed to the spawned `docker` process only via its
environment (`child_process.spawn`'s own `env` option), never as an
argv token — see `scripts/backupCreation/dockerExecInvocation.ts`.

**`supabase-managed`** dump commands run the project-pinned Supabase
CLI directly on the HOST — the Postgres toolbox container has no
Supabase CLI runtime at all, so this path never touches Docker or the
toolbox container. See "Source adapters" and
`scripts/backupCreation/supabaseCliExecutor.ts` for the full design,
including how the source credential is kept out of this adapter's own
subprocess argv too.

## Source adapters — local/generic vs. Supabase-managed

Which dump commands run, and how, is decided by
`scripts/backupCreation/sourceAdapters.ts`, auto-selected from whether a
Supabase project reference is known (explicit `--source-project-ref` or
safely derived from the connection string), overridable with
`--source-type local-generic|supabase-managed`:

- **`local-generic`** (`executor: "postgres-toolbox"`) — raw
  `pg_dumpall --roles-only` / `pg_dump --schema-only --schema <name>
  --clean --if-exists` / `pg_dump --data-only --schema <name>`, run via
  `docker exec` inside the toolbox container described above.
  Appropriate for a generic or local Postgres source. **This is the
  path exercised end to end against synthetic local data in this pass**
  (see "Current status" below).

- **`supabase-managed`** (`executor: "host-supabase-cli"`) — the
  project-pinned Supabase CLI's own `supabase db dump --db-url
  <passwordless-url>`, invoked directly on the host, never inside the
  toolbox container:

  ```
  roles.sql:  supabase db dump --db-url <passwordless-url> --workdir <tmp> -f <path> --role-only
  schema.sql: supabase db dump --db-url <passwordless-url> --workdir <tmp> -f <path>
  data.sql:   supabase db dump --db-url <passwordless-url> --workdir <tmp> -f <path> --data-only --use-copy \
                -x "storage.buckets_vectors" -x "storage.vector_indexes"
  ```

  **No `supabase link`. No `--linked`. No `SUPABASE_ACCESS_TOKEN`.** An
  earlier version of this adapter ran `supabase link --project-ref <ref>`
  before dumping. That was withdrawn: `link` is **not** a guaranteed
  read-only operation — observed Supabase CLI behaviour includes issuing
  statements such as `CREATE SCHEMA IF NOT EXISTS supabase_migrations`
  and `CREATE TABLE IF NOT EXISTS
  supabase_migrations.schema_migrations ...` (and later CLI versions may
  also ensure/alter migration-history columns) as a side effect of
  linking. **A Production database BACKUP tool must not modify
  Production migration metadata as a side effect of preparing to read
  it.** This adapter now invokes exactly two Supabase CLI subcommands
  anywhere in the backup path: `init` (purely local — writes
  `supabase/config.toml` into a temporary workspace, contacts no
  project) and `db dump --db-url ...` (a read/export operation). It
  never invokes `link`, `db push`, `db pull`, `db reset`, `migration
  repair`, `migration up`, `config push`, `projects create`/`delete`, or
  any Storage-mutating command — locked with a regression-guard test
  (`scripts/backupCreation/supabaseCliExecutor.test.ts`).

  The vector-table exclusion flags (current Supabase CLI syntax: `-x`/
  `--exclude`, not the nonexistent `--exclude-table`) apply to the
  **data** dump only — the schema dump intentionally carries no
  exclusion flags, matching current guidance. `--use-copy` (COPY
  statements rather than individual INSERTs) is current Supabase
  guidance's recommended data-dump mode. **This tool deliberately does
  not hand-roll a list of Supabase-reserved roles or internal schemas to
  strip** — that list belongs to Supabase to define and maintain, and a
  raw, unfiltered `pg_dumpall --roles-only` against a real Supabase
  project is not equivalent to `supabase db dump --role-only` and must
  never be used as the Production Supabase path. Excluding the two
  vector tables above does not change the separate, unchanged fact that
  Storage object *bytes* are never covered by any database backup — see
  "What this tooling does NOT do" below.

  **Pinned CLI, not an unpinned download.** The Supabase CLI is an
  explicit `devDependency` (`"supabase"` in `package.json`, exact-pinned,
  tracked in `package-lock.json`) — the tool resolves
  `node_modules/.bin/supabase[.cmd]` directly, never an ad hoc `npx
  supabase` (which would silently run whatever the latest published
  version happens to be at execution time).

  **Passwordless `--db-url` + `PGPASSWORD`.** The pinned CLI's own `db
  dump --db-url <url>` ultimately parses that URL with a
  libpq-compatible connection-string parser, which honours the normal
  `PG*` environment variables — including `PGPASSWORD` — whenever the
  URL itself supplies no password. `scripts/backupCreation/supabaseDatabaseUrl.ts`
  builds that PASSWORDLESS url (e.g.
  `postgresql://user@host:5432/db?sslmode=require`) from the raw source
  connection string — allowlisting only the one query parameter this
  tool has reviewed (`sslmode`; anything else, including
  credential/file-redirection parameters like `passfile`/`servicefile`,
  causes the tool to refuse rather than silently strip or pass it
  through) — and the real password reaches the CLI subprocess only via
  that subprocess's own `PGPASSWORD` environment variable, never as a
  `--password`/`-p` CLI flag and never embedded in `--db-url` itself.
  **Verified directly against this repository's own pinned CLI, not
  merely assumed from documentation** — see "Current status" below for
  the `SUPABASE_CLI_DIRECT_RUNTIME_TEST: PASS` result. No
  `SUPABASE_ACCESS_TOKEN` and no separate `SUPABASE_DB_PASSWORD`
  environment variable is required for database backup creation — the
  one authoritative source credential remains
  `BACKUP_SOURCE_DATABASE_URL` (preferred) / `DATABASE_URL` (fallback).

  **Temporary, isolated workspace.** `supabase init`/`db dump` load
  local CLI config from a Supabase project directory. Every
  `supabase-managed` command therefore runs against `--workdir <dir>`,
  where `dir` is a fresh `fs.mkdtemp`-created directory **outside this
  repository** (under the OS temp directory) — never this repository's
  own working directory, which has no Supabase configuration of its own
  to protect but must never gain one as a side effect of running a
  backup. `supabase init --force --yes --workdir <dir>` populates that
  directory's own local `supabase/config.toml` — purely local
  scaffolding, no network contact, no project link, nothing persisted
  outside the temporary directory. That temporary workspace is removed
  unconditionally (`finally`) whether the dump sequence succeeds or
  fails, and is never committed.

  **Fail-closed preflight**, checked before any temporary workspace is
  created and before any Supabase project is contacted
  (`scripts/backupCreation/supabaseCliExecutor.ts`,
  `preflightSupabaseManagedExecution`): (1) Docker is installed and (2)
  its daemon is running — the Supabase CLI's own `db dump` uses Docker
  internally to run its managed pg_dump environment, so Docker's absence
  must fail BEFORE any remote connection attempt begins, not be
  discovered partway through; (3) the pinned CLI binary exists and (4)
  reports a version; (5) the source connection has a non-empty password;
  (6) a safe, passwordless `--db-url` can be built from the raw source
  connection string. (The source connection string's own
  well-formedness, and the output destination's own path-safety
  validation, are both already checked once by `main()` — shared by both
  source adapters — before either adapter's own execution begins.) Any
  failure stops the run before remote contact, with a clear
  operator-facing error. Never logs the password.

  Each dump stage writes its output file directly to its final path
  inside the in-progress backup bundle — unlike `local-generic`, there
  is no intermediate `docker cp` step for this adapter.

  **`SUPABASE_MANAGED_PRODUCTION_RUNTIME_TEST: DEFERRED`** — this
  adapter's command construction
  (`scripts/backupCreation/sourceAdapters.test.ts`) and its execution
  boundary — preflight gating, the `init`-then-dump sequence,
  temporary-workspace cleanup on both success and failure — are
  unit-tested against an injected fake CLI runner
  (`scripts/backupCreation/supabaseCliExecutor.test.ts`). The full
  mechanism has additionally been exercised end to end against a
  **disposable local Postgres container** using this repository's own
  pinned CLI — see "Current status" below for
  `SUPABASE_CLI_DIRECT_RUNTIME_TEST: PASS`. What remains untested is a
  real **Production Supabase project** — no Production contact is
  permitted, and this repository does not create or use a sandbox
  Supabase project. Do not treat either the `local-generic` synthetic
  exercise or the disposable-Postgres `supabase-managed` runtime test as
  proof that this adapter works against a real managed Production
  project's own hosted infrastructure — both prove the mechanism,
  neither proves Production compatibility.

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
| **DATABASE BACKUP CREATION TOOLING** | **IMPLEMENTED** |
| **LOCAL-GENERIC END-TO-END** | **VERIFIED** — `local-generic` adapter exercised end to end against a disposable, synthetic local Postgres database, including the hardened source-password handling and Production-confirmation casing gate (see `docs/backup-and-disaster-recovery-runbook-v1.md`'s Section 8 for the exact local test result) |
| **PINNED SUPABASE CLI DIRECT DUMP PATH** | **VERIFIED AGAINST DISPOSABLE LOCAL POSTGRES** — `SUPABASE_CLI_DIRECT_RUNTIME_TEST: PASS`. The real pinned Supabase CLI (2.115.0), run via the exact temporary-workspace → `supabase init` → passwordless `--db-url` + `PGPASSWORD` → `db dump` mechanism this tool uses, was exercised twice (reproducibility check) against a disposable local Postgres 16 container seeded with 1 table/2 rows via `npm run backup:create -- --source-type supabase-managed`, with neither `SUPABASE_ACCESS_TOKEN` nor `SUPABASE_DB_PASSWORD` set — see `docs/backup-and-disaster-recovery-runbook-v1.md`'s Section 8 for the exact result and the one known cross-version restore limitation found (Supabase's own internal dump uses Postgres 17's `pg_dump`, whose output is not restorable by this tool's Postgres-16 disposable restore toolbox) |
| **SUPABASE MANAGED PRODUCTION RUNTIME** | **NOT YET EXECUTED** — `SUPABASE_MANAGED_PRODUCTION_RUNTIME_TEST: DEFERRED`. Never executed against a real Supabase Production project — no Production contact is permitted, and no sandbox Supabase project is used by this repository |
| **PRODUCTION BACKUP** | **NOT YET EXECUTED** — this tool has never been run with `--environment production --confirm-production` against a real Production database |
| **OFF-PROJECT COPY** | **OPEN** — PRE-PILOT OFF-PROJECT COPY GATE: OPEN, no destination selected or tested |
| **BACKUP CADENCE** | **OPEN** — PRE-PILOT BACKUP CADENCE DECISION: OPEN, no cadence approved |
| **RPO/RTO** | **UNCOMMITTED** — no contractual RPO or RTO is committed by this document |
| PRE-PILOT BACKUP GATE (overall) | **OPEN** — the tooling gap is closed for the `local-generic` path and, separately, the `supabase-managed` mechanism itself is now runtime-verified against a disposable Postgres source; the operational gap (a real, verified, off-project, restore-tested **Production** backup) is not closed either way |
