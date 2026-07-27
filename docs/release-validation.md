# Release validation (`npm run release:validate`)

Automated, repeatable reproduction of the manual disposable-database
validation workflow (see docs/migration-ledger.md and
`src/lib/secureClientRunner.disposable.test.ts`) as a single operator
command. **Never reads from, writes to, or modifies the shared
Preview/Production Supabase database** — every database-backed stage runs
against a throwaway local Docker Postgres container created at the start
of the run and destroyed at the end, on success, on failure, and on
Ctrl+C.

## 1. Prerequisites

- Node.js and the project's npm dependencies already installed
  (`npm install`).
- **Docker Desktop**, installed and running, with the current Windows
  user able to run `docker` commands (no `sudo`/elevation dance needed —
  if `docker ps` works in your terminal today, this will work).
- No other process already bound to an arbitrary local TCP port — the
  runner asks the OS for a free port itself, so this is only a concern if
  your machine is unusually port-starved.
- Nothing else required. No Supabase, Vercel, Anthropic, or Canvas
  credentials are needed — see "Why Supabase and remote databases are
  rejected" below.

## 2. Docker Desktop requirement

This workflow **fails closed** if Docker is not installed or the Docker
daemon is not running — it will not silently fall back to any other
database, including your own local Postgres if you happen to have one
outside Docker, and it will not use the shared Supabase database as a
substitute. If you see a "Docker does not appear to be installed" or
"Docker is installed but the daemon is not running" message, start Docker
Desktop and re-run the command — see "Troubleshooting" below.

## 3. Exact command

```bash
npm run release:validate
```

This is the only command an operator needs to run. It takes no
arguments and requires no environment variables to be set beforehand.

## 4. Stages performed

In order, each one gating the next:

1. Verify Docker is installed.
2. Verify the Docker daemon is running.
3. Allocate a free local TCP port.
4. Start a disposable PostgreSQL container bound to that port, with a
   unique name, database, username, and generated password for this run
   only.
5. Run the database-safety guard against the constructed connection
   string (see below) — before any Prisma/psql command is ever issued.
6. Wait for PostgreSQL to accept connections (bounded timeout).
7. Apply the current `prisma/schema.prisma` to the disposable database
   (`prisma db push`).
8. Run `prisma/seed.ts` against the disposable database (default
   Institution + a synthetic LTI platform fixture — see below).
9. Apply the small, fixed set of partial indexes `prisma db push` cannot
   express (see below), and read back each one to confirm it landed as a
   genuinely partial index.
10. Run the full Vitest suite (`npm run validate:tests`) against the
    disposable database.
11. Run `npm run validate:typecheck` (`tsc --noEmit`).
12. Run `npm run validate:lint` (`eslint`).
13. Run `npm run validate:build` (`next build`) — the disposable
    container is kept alive through this stage (see "Build environment"
    in the implementation notes below).
14. Remove the disposable container.

Any stage failing stops the run immediately, still runs cleanup, and
exits non-zero.

## 5. Database safety guarantees

Implemented in `scripts/releaseValidation/dbSafetyGuard.ts`
(unit-tested in the adjacent `dbSafetyGuard.test.ts` — run it directly
with `npx vitest run scripts/releaseValidation/dbSafetyGuard.test.ts`).
Every connection string this workflow will ever use must pass
`assertDisposableDatabaseUrl` (and, immediately before any schema-mutating
command, `assertMatchesExpectedPort` too):

- **Only** `localhost`, `127.0.0.1`, or `::1` are accepted as the host.
- **Only** the `postgres://` / `postgresql://` protocol is accepted.
- Any hostname or full connection string containing `supabase.com`,
  `pooler.supabase.com`, or the production project reference
  (`ugckdvbjzauvcovcqebw`) is rejected outright, checked against both the
  parsed hostname and the raw URL (Supabase's connection pooler embeds
  the project reference in the **username**, not the hostname, so a
  hostname-only check would miss it).
- An empty, missing, or malformed URL is rejected.
- The port must match the exact port this run allocated for its own
  container — a stale leftover container's port, or a typo, can never be
  silently targeted instead.
- Error messages never include the raw URL, username, or password —
  only a generic, safe description.

This workflow never sets `DATABASE_URL` on `.env`, `.env.local`, or this
process's own `process.env` (and therefore never on the parent
PowerShell session) — the disposable connection string is constructed
once, in memory, and passed only via the `env` option of each child
process it spawns (`prisma db push`, the seed script, the partial-index
setup, Vitest, and the build).

## 6. Why Supabase and remote databases are rejected

Preview and Production share **one** Supabase database (see
docs/migration-ledger.md). Any schema-mutating command
(`prisma db push`, `prisma migrate *`) or database-backed test run
against that shared database would risk corrupting real institutional
data, applying an untracked schema change outside the project's
hand-written migration-ledger process, or leaving test fixtures in a
database real users depend on — exactly the incident this workflow exists
to make structurally impossible, not just discouraged by convention.

## 7. Disposable schema setup

`prisma db push --url <disposable-url> --accept-data-loss` is used —
**only** because the target is always a throwaway local Docker database
that gets destroyed at the end of the run, never a database with
history worth preserving. This is explicitly **not** permitted (and never
used) against the shared database; the project's migration-ledger process
(hand-written SQL, one operator-applied file per feature) remains the
only way schema changes ever reach Preview/Production. This workflow
never creates or alters Production migration history, and never touches
`prisma/migrations`.

Before running `db push`, the runner prints only a safe, generic
description:

```
Applying schema to disposable PostgreSQL on localhost.
```

— never the port, username, or password.

## 8. Synthetic seed setup

`prisma/seed.ts` requires a handful of LTI platform configuration values
(`LTI_PLATFORM_ISSUER`, `LTI_CLIENT_ID`, `LTI_PLATFORM_OIDC_AUTH`,
`LTI_TOKEN_ENDPOINT`, `LTI_PLATFORM_JWKS`, `LTI_DEPLOYMENT_ID`) to seed
the one Canvas LTI platform fixture row
(`seedCanvasPlatform()` in `src/lib/lti/seedPlatform.ts`). That function
only ever stores these as plain string columns — it makes no real network
call against them at seed time. The runner supplies clearly-synthetic
placeholder values (e.g. `https://lti-disposable.release-validate.invalid`)
for these, so this workflow never depends on real Canvas credentials.
`PLATFORM_ADMIN_EMAIL`/`PLATFORM_ADMIN_PASSWORD` are explicitly left
blank, so no platform-admin account is ever created for a disposable
database regardless of what the ambient environment might otherwise
provide.

## 9. Partial-index setup

`prisma db push` applies everything expressible in Prisma's schema DSL,
but Prisma has no `@@unique`/`@@index` equivalent for a **partial**
(`WHERE`-clause) index. Exactly four such indexes exist in this
codebase's confirmed-applied migration history (see
`docs/migration-ledger.md` rows 13/14) and are required by the current
test suite:

| Index | Table | Source migration |
|---|---|---|
| `AnswerDevelopmentArtifact_answer_type_key` | `AnswerDevelopmentArtifact` | `docs/answer-development-provenance-v1-migration.sql` |
| `AnswerDevelopmentArtifact_submission_type_key` | `AnswerDevelopmentArtifact` | `docs/answer-development-provenance-v1-migration.sql` |
| `SecureClientConfiguration_exam_provider_active_key` | `SecureClientConfiguration` | `docs/secure-client-foundation-seb-v1-migration.sql` |
| `SecureClientSession_submission_nonterminal_key` | `SecureClientSession` | `docs/secure-client-foundation-seb-v1-migration.sql` |

These four `CREATE UNIQUE INDEX ... WHERE ...` statements (transcribed
verbatim from the two migration files above — see
`scripts/releaseValidation/disposableSchema.ts`,
`REQUIRED_PARTIAL_INDEXES`) are applied directly via a `pg` client
connection, then read back from `pg_indexes` to confirm each one landed
as a genuinely partial index (its `indexdef` still shows the `WHERE`
clause), not just a same-named plain index. This is deliberately narrow:
it does **not** replay every historical shared-database migration file's
`CREATE TABLE`/`ALTER TABLE` statements — those are already covered by
`prisma db push` against the current schema. Only the specific indexes
`db push` cannot create are replayed, and only from migrations the ledger
already confirms were actually applied to the real shared database.

## 10. Test execution model

`npm run validate:tests` runs `npm run test` (`vitest run`), using the
repository's default `vitest.config.ts` — the same configuration already
proven to pass safely against a disposable database
(`fileParallelism: false`, so DB-backed suites run serially rather than
racing each other for connections/shared fixture rows — see the comment
in `vitest.config.ts`). `*.disposable.test.ts` files remain excluded from
this default run (unchanged) — they require their own explicit
`DATABASE_URL` override and are not part of this workflow.

No real Anthropic or Canvas credentials, Vercel, Supabase, or other
external network service is required anywhere in this run — every route
test that would otherwise need one already uses its existing
deterministic mock (see e.g. `src/lib/aiAssistance.routes.test.ts`, which
mocks `isAnthropicConfigured()`/`generateBrainstormResponse` and
separately re-verifies the real fail-closed 503 path) or exercises the
already-shipped fail-safe behaviour directly.

## 11. Cleanup behaviour

The disposable container is removed:

- after a successful run;
- after a failed run, at whichever stage it failed;
- on `Ctrl+C` (`SIGINT`) or `SIGTERM` — a signal handler awaits the same
  cleanup path before the process exits.

Cleanup (`docker rm -f <container>`) is safe to call even if the
container was already removed or never successfully created — it is
never itself a source of a confusing secondary error.

## 12. Expected duration

On a typical development machine, end-to-end: **roughly 2–4 minutes**
(container start + readiness: a few seconds; schema push: 5–15s; seed:
a few seconds; partial indexes: under a second; the full Vitest suite:
60–120s; typecheck: 5–10s; lint: 15–35s; production build: 30–60s).
Most of the time is the Vitest suite and the production build.

## 13. Successful output summary

```
[release:validate] ▶ Docker installed
[release:validate] ✓ Docker installed (...)
...
[release:validate] ✓ Production build (...)
[release:validate] Removing disposable container "tether-release-validate-<id>"...
[release:validate] Disposable container removed.
[release:validate] ── Summary ──────────────────────────────────────
[release:validate]   ✓ Docker installed — ...ms
[release:validate]   ✓ Docker daemon running — ...ms
[release:validate]   ✓ Allocate local port — ...ms
[release:validate]   ✓ Start disposable PostgreSQL container — ...ms
[release:validate]   ✓ Validate disposable DATABASE_URL safety guard — ...ms
[release:validate]   ✓ Wait for PostgreSQL readiness — ...ms
[release:validate]   ✓ Apply Prisma schema (db push) — ...ms
[release:validate]   ✓ Run synthetic seed (prisma/seed.ts) — ...ms
[release:validate]   ✓ Apply required partial indexes — ...ms
[release:validate]   ✓ Run full Vitest suite (against disposable database) — ...ms
[release:validate]   ✓ Typecheck — ...ms
[release:validate]   ✓ Lint — ...ms
[release:validate]   ✓ Production build — ...ms
[release:validate] release:validate PASSED
[release:validate] ─────────────────────────────────────────────────
```

No password, connection string, or other secret ever appears in this
output.

## 14. Troubleshooting

**Docker unavailable (not installed)**
`docker --version` fails. Install Docker Desktop:
https://www.docker.com/products/docker-desktop/

**Docker daemon not running**
`docker info` fails even though `docker --version` succeeds. Start
Docker Desktop and wait for it to report "running" in its own UI, then
re-run.

**Port allocation failure**
Extremely rare (the runner asks the OS for a free port immediately
before use). Re-run the command — if it persists, check whether another
process is aggressively binding ports on your machine.

**PostgreSQL readiness timeout**
The container started but Postgres never accepted a connection within
30 seconds. Check Docker Desktop has enough resources allocated, and
inspect the container's logs (see "How to inspect Docker container
logs safely" below) for a crash-on-startup reason.

**Schema push failure**
`prisma db push` reported a non-zero exit code — check the printed
Prisma output above the failure line; it almost always names the
specific schema issue. This stage runs against the disposable database
only, so a failure here cannot have touched shared data.

**Seed failure**
`prisma/seed.ts` reported a non-zero exit code — check the printed
output above the failure line. If it's a "Missing required environment
variable" error for an LTI variable, check
`scripts/releaseValidation/disposableSchema.ts`'s `SYNTHETIC_LTI_ENV` —
`seedCanvasPlatform()` may have gained a new required field since this
workflow was written.

**Test failure**
A real test failed against a database with the current schema, seed,
and partial indexes applied — treat this the same as any other test
failure; it means something in the codebase (or the test itself) needs
attention before this change is release-ready. Re-run just that file
against a manually-created disposable database (see
`src/lib/secureClientRunner.disposable.test.ts`'s own header for the
exact manual commands) if you want to iterate faster than a full
`release:validate` cycle per attempt.

**Stale container**
If a previous run was killed in a way that bypassed cleanup (e.g. a
hard process kill that isn't `SIGINT`/`SIGTERM`, or a host crash), a
container named `tether-release-validate-<id>` may be left running. See
"How to manually remove a stale validation container" below.

**Build failure**
`next build` reported a non-zero exit code — check the printed output;
this is the same build a `npm run build` would produce locally, so any
existing Next.js troubleshooting applies.

## 15. How to inspect Docker container logs safely

While a run is in progress (or immediately after a failure, before the
next run's cleanup removes it), find the container name from the
runner's own log line (`Start disposable PostgreSQL container` /
`Removing disposable container "..."`), then:

```bash
docker logs tether-release-validate-<id>
```

This never prints the container's password — Postgres's own startup
log does not echo `POSTGRES_PASSWORD`.

## 16. How to manually remove a stale validation container

List every container this workflow has ever created (by name prefix):

```bash
docker ps -a --filter "name=tether-release-validate-" --format "{{.Names}}"
```

Remove a specific one:

```bash
docker rm -f tether-release-validate-<id>
```

This only ever matches containers this workflow created — never the
shared database (which is not, and can never be, a Docker container in
this project), and never an unrelated container on your machine (the
name prefix is unique to this tool).

## 17. `.env.local` guarantee

This workflow never opens `.env` or `.env.local` for writing, and never
sets `DATABASE_URL` (or anything else) on its own `process.env` — every
value it needs is either generated in memory for the disposable
container or passed explicitly via the `env` option of each child
process it spawns. A byte-for-byte comparison of `.env.local` from
before and after a full `release:validate` run (including a deliberately
failed run) shows no change.
