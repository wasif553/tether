# Restore Test Record v1 (Fillable Template)

**Use one copy of this template per restore test or exercise.** See
[`docs/backup-and-disaster-recovery-runbook-v1.md`](backup-and-disaster-recovery-runbook-v1.md)
for the full runbook this record supports, and
[`docs/production-backup-restore-runbook.md`](production-backup-restore-runbook.md)
for the exact `npm run backup:verify` behaviour referenced below.

**Do not put secret values in this record** — no passwords, connection
strings, API keys, or service-role keys, even redacted-looking ones.
Reference environment-variable **names** or configuration locations,
never values.

---

## Identification

| Field | Value |
|---|---|
| Exercise/Test ID | |
| Date | |
| Operator | |
| Reviewer | |
| Environment | *(e.g. disposable local Docker Postgres — see "Disposable target confirmed?" below)* |

## Backup source

| Field | Value |
|---|---|
| Backup source | |
| Backup creation timestamp | |
| Backup filename/reference | |
| Backup format | CUSTOM / PLAIN_SQL / DIRECTORY_OR_TAR / UNKNOWN |
| Backup file size | |
| SHA-256 | |
| Database source | |
| Recovery target | |
| Production data involved? | YES / NO |
| Disposable target confirmed? | YES / NO *(must be YES for any non-Production rehearsal — see the runbook's Section 22 and `docs/production-backup-restore-runbook.md`'s `requireDisposableDatabaseUrl` guarantee)* |

## Restore purpose

*(Why this test/exercise is being run — routine DR exercise, pre-pilot
gate closure, real recovery event, etc.)*

## Recovery point

| Field | Value |
|---|---|
| Expected recovery point | |
| Actual recovery point | |
| RPO measured | *(only after this test actually produces a number — do not pre-fill)* |
| RTO measured | *(only after this test actually produces a number — do not pre-fill)* |

## Timing

| Field | Value |
|---|---|
| Restore started at | |
| Restore completed at | |
| Validation completed at | |

## Backup file verification

*(Corresponds to `npm run backup:verify`'s file-level checks — see
`docs/production-backup-restore-runbook.md`.)*

| Check | Result |
|---|---|
| Exists? | YES / NO |
| Plausible size (≥10,000 bytes)? | YES / NO |
| Format recognised? | YES / NO |
| SHA-256 recorded? | YES / NO |
| `backup:verify` result | PASS / FAIL |

## Disposable restore

*(Corresponds to `npm run backup:verify -- --restore`'s rehearsal —
structurally guaranteed non-Production, per the same
`requireDisposableDatabaseUrl` guard `npm run release:validate` uses.)*

| Check | Result |
|---|---|
| Restore attempted? | YES / NO |
| Restore succeeded? | YES / NO |
| Schema sanity? | YES / NO |
| Row/data sanity? | YES / NO |
| Critical table checks? | YES / NO |
| Unexpected errors? | *(describe, or "none")* |

## Application validation

*(See the runbook's Section 28 — do not equate "restore completed" with
"service recovered.")*

| Check | Result |
|---|---|
| Application boots? | YES / NO |
| Authentication? | YES / NO |
| Institution isolation? | YES / NO |
| Exam retrieval? | YES / NO |
| Submission retrieval? | YES / NO |
| Answer data? | YES / NO |
| Integrity events? | YES / NO |
| Network evidence metadata? | YES / NO |

## Evidence validation

*(See the runbook's Sections 9–10, 25–26 — database and evidence-byte
recovery are separate domains; check both explicitly.)*

| Check | Result |
|---|---|
| Metadata rows present? | YES / NO |
| Sample primary evidence available? | YES / NO |
| SHA-256 matches? | YES / NO |
| Archive sample tested, if applicable? | YES / NO / N/A *(archive not yet provisioned — see runbook Section 9)* |
| Missing/corrupt objects identified? | *(list, or "none")* |

## Post-restore privacy checks

*(See the runbook's Section 29 — a restore is not privacy-neutral.)*

| Check | Result |
|---|---|
| Retention reconciliation required? | YES / NO |
| Legal/academic hold present? | YES / NO |
| NDB/incident procedure required? | YES / NO |

## Result

*(Select one.)*

- [ ] PASS
- [ ] PASS WITH CONDITIONS
- [ ] FAIL

## Findings

## Corrective actions

| Field | Value |
|---|---|
| Owner | |
| Due date | |
| Retest required? | YES / NO |

## Closure

| Field | Value |
|---|---|
| Reviewer approval | |
| Closure date | |
