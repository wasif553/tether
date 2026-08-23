# Evidence Retention Operations v1

**Operations runbook, not code.** This is the manual process an
authorised administrator follows around the existing technical tools
(`npm run evidence:retention`, `npm run evidence:archive` —
`src/lib/evidenceRetentionRunner.ts`, documented in
`docs/tether-evidence-retention-plan.md`), which by themselves have **no
awareness of legal holds, active appeals, or Production-target
confirmation**. This runbook is what supplies that missing judgement
until (and unless) it is built into the tooling itself.

**This runbook does not grant a generic operator permission to delete
production evidence.** Destruction requires the explicit,
authorised administrative process below — never an ad hoc decision by
whoever happens to run the CLI.

## Scope

Applies to `IntegrityEvidenceAsset` rows (camera and screen-share
evidence stills) — the only data type the existing retention runner
covers. `IntegrityEvent` and `NetworkEvidence` rows have **no deletion
tooling today**; see
[`docs/privacy-and-evidence-retention-v1.md`](privacy-and-evidence-retention-v1.md),
Section 20, item 3. A retention register entry should still be kept for
these once tooling exists — record their existence as a known gap in
the register in the meantime, not a silent omission.

## Retention register

Maintain one register (spreadsheet or equivalent, access-restricted to
authorised administrators) with one row per **retention sweep**, not per
asset:

| Field | Description |
|---|---|
| Sweep date | When the sweep was run |
| Institution(s) in scope | Which institution's data was evaluated (or "all," at current pilot scale) |
| Retention window used | `EVIDENCE_RETENTION_DAYS` value for this sweep |
| Cutoff date | The computed cutoff (`report.cutoff` from the runner's own output) |
| Eligible count | `report.evaluatedCount` from the dry run |
| Hold-check performed by | Named administrator who confirmed no eligible asset is under an active hold |
| Hold-check result | Clear / N assets excluded (list exam/submission ids excluded and why) |
| Authorised by | Named administrator who approved proceeding to `--execute` |
| Executed by | Named administrator who ran `--execute` |
| Deleted count / failed count | From the runner's own output |
| Verification performed by | Named administrator who confirmed the reported deletions (Section "Deletion verification" below) |
| Notes/exceptions | Anything unusual |

## Review cadence

A quarterly cadence is a reasonable v1 starting point for a controlled
pilot, adjusted to the institution's own agreed retention period.
Running the dry-run report more frequently is safe (it deletes nothing)
and can inform whether a shorter cadence is warranted as evidence volume
grows.

## Step-by-step process

### 1. Dry run

```bash
npm run evidence:retention
```

This reports what **would** be deleted — nothing is deleted. Record the
eligible count and cutoff in the retention register.

### 2. Evidence eligibility decision

Review the dry-run's list of eligible assets (id, kind, `capturedAt`).
Confirm the retention window used matches the institution's agreed
policy (Section 18 of the privacy package) — override with
`--retention-days N` only for a deliberate, documented reason.

### 3. Active-case / appeal / hold check

**Before any `--execute` run**, an authorised administrator must
manually confirm that none of the eligible assets belong to a
submission that is:

- under active academic-integrity review or appeal;
- subject to a legal hold (Section 19 of the privacy package); or
- part of an open security/fraud investigation.

Because the runner itself has no hold-awareness, this check is
currently the **only** thing standing between an age-eligible asset and
deletion. If any eligible asset is excluded for this reason, do not run
`--execute` for the full eligible set — this v1 tooling has no per-asset
exclusion flag, so an excluded case must be handled as a documented
exception (defer the entire sweep, or coordinate a scoped
`--retention-days`/`institutionId`-based dry run that excludes it,
recording the reasoning in the register). Do not improvise a
workaround that deletes the excluded asset anyway.

### 4. Authorisation required before destruction

A **different** authorised administrator (or the same one, per your
institution's own separation-of-duties policy) must explicitly approve
proceeding, recorded in the register, before `--execute` is run. This
runbook does not name who that is — that is an institutional decision.

### 5. Production-target confirmation

**PRE-PILOT GATE** — the retention CLI has no built-in check that it is
pointed at the intended (and not an unintended) database. Before running
`--execute` against any real institutional data, the executing
administrator must manually confirm the `DATABASE_URL`/environment the
command will run against, and record that confirmation in the register.
Do not run `--execute` from an environment whose target you have not
personally verified.

### 6. Destruction execution

```bash
npm run evidence:retention -- --execute
```

This deletes the storage object for each eligible asset first, then its
database row, and writes a `PlatformAuditLog` entry
(`INTEGRITY_EVIDENCE_RETENTION_DELETED`) atomically with each row
deletion. Record the reported deleted/failed counts in the register.

### 7. Deletion verification

Confirm the reported outcome: for a healthy run, `deleted count` should
equal the eligible count from step 1 (accounting for anything
deliberately excluded in step 3). Investigate and record any failure —
the runner reports each failed asset individually and leaves it eligible
for the next sweep (see `docs/tether-evidence-retention-plan.md` for why
a failure never leaves a "half-deleted" state).

### 8. Evidence-storage object consideration

The storage object is deleted **before** the database row in this
tooling's own design — confirm no separate copy of the object exists
outside the primary evidence-storage bucket that this process is
unaware of (e.g. an ad hoc export) before treating the sweep as complete
for that asset.

### 9. Database-record consideration

The database row is the authoritative record of whether an asset still
exists — once it is deleted, there is no in-application way to prove the
image ever existed beyond the audit-log entry (which never contains the
image itself).

### 10. Backup consideration

**Deletion via this tooling does not remove any copy that may exist in
a database backup or in the separate evidence-archive tool
(`npm run evidence:archive` — see `docs/tether-evidence-archive-plan.md`,
which has no delete capability at all by design).** Backup/archive
destruction timing must be aligned with the Backup/DR Runbook, a
**separate release-readiness item** — do not assume a deleted evidence
asset is unrecoverable from every location until that runbook is in
place and followed.

### 11. Audit record of destruction

The runner's own `PlatformAuditLog` entry is the system-of-record for
*that* deletion. The retention register (this document) is the
system-of-record for *why* the sweep was authorised, who performed each
step, and what was excluded and why — the two are complementary, not
duplicates.

### 12. Exception handling

- **An eligible asset is under a hold** — see step 3. Never delete it;
  document the exception and re-evaluate at the next cadence.
- **A sweep partially fails** (some deletions succeed, some fail) — the
  runner reports each outcome individually; failed assets remain
  eligible for retry at the next sweep. Do not re-run `--execute`
  repeatedly in the same session hoping for a different result without
  investigating the failure reason first.
- **The retention window itself is disputed** (e.g. an institution
  believes 90 days is too short/long for a specific exam) — resolve the
  policy question first (Section 18 of the privacy package); do not run
  `--execute` with an ad hoc `--retention-days` value to work around a
  disagreement.

## Destructive execution step — current status

**NOT YET AUTOMATED / REQUIRES APPROVED ADMINISTRATIVE PROCEDURE.**

The technical capability to delete an evidence asset exists and is
tested (`npm run evidence:retention -- --execute`). What does **not**
exist is a self-service, hold-aware, Production-safety-railed workflow —
every real execution today depends on a human following steps 1–7 above
in full. This is the accurate, honest state of the tooling as of this
pass, and is preferable to describing a safer workflow than actually
exists.
