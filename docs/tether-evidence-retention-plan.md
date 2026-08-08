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
    (`EVIDENCE_RETENTION_DAYS`, default 90 days), following this repo's
    established convention (see `systemCheckConfig.ts`).
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
  flag to actually delete anything.
- **`src/lib/evidenceRetentionRunner.test.ts`** — DB-backed tests
  covering: default/malformed/valid retention-days resolution,
  eligibility for old/recent/exactly-at-boundary assets, single-asset
  deletion, full dry-run vs. execute sweep behavior, and the no-eligible-
  assets no-op case.

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
  defaults to 90 purely as a safe fallback if the script is ever run
  without configuring it explicitly — this is not a claim that 90 days is
  the institutionally correct policy. The institution should set this
  deliberately (or confirm 90 is acceptable) before ever running the
  script with `--execute`.

## How to use this

See `docs/tether-data-and-privacy-register.md` for the data-type context,
and the doc comments in `src/lib/evidenceRetentionRunner.ts` /
`scripts/run-evidence-retention.ts` for usage. In short:

```bash
# Report what would be deleted — deletes nothing.
npm run evidence:retention

# Actually delete evidence assets older than the configured/default retention window.
npm run evidence:retention -- --execute

# Override the retention window for one run.
npm run evidence:retention -- --execute --retention-days 60
```
