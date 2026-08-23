# Evidence Retention — Implementation Record (v1)

## Audit findings (before this pass)

Per `docs/secure-exam-evidence-review-audit-v1.md` (area 13) and direct
schema audit, confirmed accurate as of this pass:

1. **No `expiresAt`/`retainUntil` column exists** on `IntegrityEvidenceAsset`,
   `IntegrityEvent`, or `NetworkEvidence` — only `capturedAt`/`createdAt`/
   `occurredAt`.
2. **No scheduler/cron exists anywhere in this codebase** — confirmed by
   the absence of any cron/background-job infrastructure in the
   repository (no `node-cron`, no Vercel Cron config, no equivalent).
3. **`EvidenceStorageAdapter.delete()` was implemented but never called**
   from any application code path — a dead capability.
4. **No delete route existed** for an individual evidence asset.

## Decision: a safe lifecycle WAS implementable without a schema or scheduling change

Because eligibility can be computed entirely from the existing
`capturedAt` timestamp plus a configurable retention window (no stored
expiry needed), and because a reusable runner can be exposed as a
manually-invoked script rather than requiring a new scheduler dependency,
a genuine, safe retention lifecycle was implementable within this pass's
constraints (no schema change, no raw SQL migration, no external
scheduler, no dangerous Production mutation). This is the "implement and
test the reusable retention runner ONLY" branch, not the "write a plan
instead" branch — both were in scope depending on the audit outcome, and
the audit outcome was the former.

## What was built

- **`src/lib/evidenceRetentionRunner.ts`** — the reusable runner:
  - `resolveEvidenceRetentionDays()` — env-var + typed-resolver
    (`EVIDENCE_RETENTION_DAYS`, default **180 days** — raised from an
    earlier 90-day default to match the approved pilot Class A fallback
    in `docs/privacy-and-evidence-retention-v1.md`, Section 18),
    following this repo's established convention (see
    `systemCheckConfig.ts`).
  - `findEligibleEvidenceAssetsForDeletion(retentionDays, now)` — pure
    read, age-based on `capturedAt`.
  - `deleteEvidenceAsset(asset)` — deletes the storage object first, then
    the database row (see the module's own doc comment for the safety
    reasoning behind that ordering — briefly: a storage-delete failure
    leaves a retryable row; a DB-delete failure after a successful
    storage delete leaves a harmless orphan row pointing at an
    already-gone object, never a sensitive file with no remaining
    reference).
  - `runEvidenceRetentionSweep(options)` — the orchestrator, `dryRun:
    true` by default at the call-site convention used by the CLI script
    below (evaluates and reports, never deletes unless explicitly told
    not to dry-run).
- **`scripts/run-evidence-retention.ts`** — `npm run evidence:retention`,
  a manual CLI tool. Dry-run by default; requires an explicit `--execute`
  flag to actually delete anything. **`--execute` additionally requires**
  an explicit `--institution-id <id>` (a specific id — `all` is refused)
  **and** an explicit `--retention-days <n>` — there is no
  deployment-wide destructive path in this CLI. Argument parsing and this
  fail-closed gate live in `scripts/evidenceRetention/cliArgs.ts`, kept
  as a pure, dependency-free module specifically so it can be
  unit-tested without a database.
- **`src/lib/evidenceRetentionRunner.test.ts`** — DB-backed tests
  covering: default(180)/malformed/valid retention-days resolution,
  eligibility for old/recent/exactly-at-boundary assets, single-asset
  deletion, full dry-run vs. execute sweep behavior, and the no-eligible-
  assets no-op case.
- **`scripts/evidenceRetention/cliArgs.test.ts`** — unit tests (no
  database) covering argument parsing and the `--execute` fail-closed
  gate: missing `--institution-id`, missing `--retention-days`, both
  missing, `--institution-id all` rejected, and the happy path where
  both are supplied.

## What was deliberately NOT done in this pass

- **Not wired into any automatic trigger.** No cron, no route, no build
  step, no server-startup hook calls `runEvidenceRetentionSweep`. Running
  it is always a deliberate, manual operator action (`npm run
  evidence:retention`), exactly like `npm run seed` already is in this
  repo. Activating scheduled deletion in Production is an institutional
  policy decision (what retention period is actually appropriate or
  legally required) that this pass does not make.
- **Scoped to `IntegrityEvidenceAsset` only** (screen + camera evidence
  images — the highest-sensitivity data type per
  `docs/tether-data-and-privacy-register.md`). `IntegrityEvent` and
  `NetworkEvidence` rows are NOT covered by this runner. Extending
  coverage to those would need a separate design decision: `IntegrityEvent`
  rows are the primary lecturer-review surface and carry review-workflow
  state (`reviewStatus`, comments) that a naive age-based delete could
  destroy mid-review; `NetworkEvidence` retention policy may reasonably
  differ from image-evidence policy. Left as a follow-up scoping decision,
  not implemented speculatively.
- **No default retention period is activated.** `EVIDENCE_RETENTION_DAYS`
  defaults to 180 purely as a safe pilot fallback if the script is ever
  run without configuring it explicitly — this is not a claim that 180
  days is every institution's correct policy, only that it matches the
  conservative Class A pilot fallback documented in
  `docs/privacy-and-evidence-retention-v1.md`, Section 18. The
  institution should set this deliberately via `--retention-days` before
  ever running the script with `--execute` — indeed, `--execute` will
  refuse to run at all unless `--retention-days` (and `--institution-id`)
  are supplied explicitly; there is no "confirm the default is
  acceptable and just run `--execute`" path any more.

## How to use this

See `docs/tether-data-and-privacy-register.md` for the data-type context,
and the doc comments in `src/lib/evidenceRetentionRunner.ts` /
`scripts/run-evidence-retention.ts` for usage. In short:

```bash
# Report what would be deleted, deployment-wide, using the configured/default
# retention window — deletes nothing.
npm run evidence:retention

# Preview a single institution's eligible assets at its approved retention window.
npm run evidence:retention -- --institution-id <institution-id> --retention-days 180

# Actually delete evidence assets for one institution, at its approved retention
# window. Both flags are REQUIRED for --execute — omitting either aborts with no
# deletion (see docs/evidence-retention-operations-v1.md for the full authorised
# process this must follow: hold check, authorisation, target confirmation).
npm run evidence:retention -- --execute --institution-id <institution-id> --retention-days 180
```

There is no unscoped/deployment-wide `--execute` command — `npm run
evidence:retention -- --execute` with no further arguments exits
non-zero and deletes nothing, by design.
