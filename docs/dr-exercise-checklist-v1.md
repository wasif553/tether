# DR Exercise Checklist v1

**Step-by-step checklist for an actual DR exercise or a real recovery
event.** See
[`docs/backup-and-disaster-recovery-runbook-v1.md`](backup-and-disaster-recovery-runbook-v1.md)
for the full runbook this checklist operationalises. Use one copy of
this checklist per exercise/event, alongside a
[`docs/restore-test-record-v1.md`](restore-test-record-v1.md).

**Fail closed.** Any STOP CONDITION below halts the exercise/event at
that point — do not improvise a workaround.

---

## Exercise type

*(Select one before proceeding.)*

- [ ] Tabletop only
- [ ] Database backup verification
- [ ] Disposable database restore
- [ ] Evidence single-asset restore rehearsal
- [ ] Vercel/application recovery tabletop
- [ ] Configuration-loss tabletop
- [ ] Full-service DR tabletop
- [ ] Production-equivalent recovery rehearsal

**"Restore directly into Production" is not a routine exercise type and
does not appear above.** A real Production restore only ever happens
under the runbook's Section 23 approval boundary, during an actual
declared disaster — never as a drill.

## A. Exercise preparation

- [ ] Exercise/Test ID assigned, matching the `docs/restore-test-record-v1.md`
      copy being used alongside this checklist.
- [ ] Operator and reviewer identified (runbook Section 16 roles).
- [ ] Scope of this exercise agreed (which recovery domain(s), Section
      7 of the runbook).
- [ ] Environment for this exercise confirmed disposable/non-production,
      unless this is a real declared disaster.

## B. Scenario declaration

- [ ] Scenario/trigger described (tabletop narrative, or the actual
      real-event trigger — runbook Section 35 for reference scenarios).
- [ ] Runbook Section 17 disaster-declaration step followed, if this is
      a real event.

## C. Safety checks

**STOP if any of these cannot be confirmed:**

- [ ] Backup source can be identified.
- [ ] Checksum/format verification will be possible for the backup in
      use.
- [ ] The requested recovery point is unambiguous.
- [ ] The restore destination can be proven non-production during
      rehearsal (or, for a real event only, Section 23's Production
      restore approval is in hand).
- [ ] Required credential ownership is clear.
- [ ] The evidence archive and primary storage do not resolve to the
      same failure domain, where separation is required for this
      exercise.
- [ ] Legal/privacy hold status is known, if affected data could be
      overwritten or deleted.
- [ ] This exercise will not contact a real student or institution
      unexpectedly.

## D. Backup identification

- [ ] Backup file/reference identified and recorded in the Restore Test
      Record.
- [ ] Backup creation timestamp recorded.

**STOP if the backup source cannot be identified.**

## E. Backup verification

- [ ] `npm run backup:verify -- <dump-file>` run (file-level checks).
- [ ] Result recorded in the Restore Test Record's "Backup file
      verification" section.

**STOP if checksum/format verification fails.**

## F. Disposable database restore

*(Skip if this exercise's type does not include a database restore.)*

- [ ] `npm run backup:verify -- <dump-file> --restore --report <path>`
      run.
- [ ] Confirmed this ran against a disposable container, per the
      runbook's Section 22 guarantee — never assume, verify the tool's
      own output.
- [ ] Result recorded in the Restore Test Record's "Disposable restore"
      section.

**STOP if the destination cannot be proven non-production.**

## G. Database validation

- [ ] Schema sanity checked.
- [ ] Row/data sanity checked.
- [ ] Critical table checks run.
- [ ] Application validation checks run (runbook Section 28) and
      recorded in the Restore Test Record.

## H. Evidence-storage recovery exercise

*(Skip if this exercise's type does not include evidence recovery.)*

- [ ] Affected/sample evidence asset(s) identified.
- [ ] If an archive exists at exercise time: single-asset restore
      rehearsed per `docs/tether-evidence-archive-plan.md`'s documented
      scenarios only (missing object with row present, or corrupt object
      with row present) — never attempted against a healthy object.
- [ ] If no archive exists (the current actual state): recorded as such
      in the Restore Test Record — do not simulate a recovery that does
      not exist.
- [ ] SHA-256 verification checked for any restored sample.

**STOP if the evidence archive and primary storage resolve to the same
failure domain where this exercise requires them to be separate.**

## I. Application recovery exercise

*(Skip if this exercise's type does not include application recovery.)*

- [ ] Known-good commit identified.
- [ ] Diff to the bad/current state inspected.
- [ ] Redeploy path for the current Vercel plan confirmed (tabletop:
      described; real event: executed only through the normal
      controlled Git/Vercel path).

## I2. Secure Browser release-artifact recovery exercise

*(Tabletop/checklist item only — this exercise does not modify
`apps/lockdown`, copy an installer, or update release-metadata
constants. See the runbook's Section 14 for the current
release-metadata reconciliation gap this item exists to surface.)*

- [ ] Authoritative Secure Browser release version/hash record
      reconciled? *(As of this pass: NO — the native source
      (`apps/lockdown/src/shared.ts`), distribution metadata
      (`src/lib/tetherReleaseMetadata.ts`), and release-management
      documentation (`docs/tether-release-management.md`) identify
      three different versions. This item is expected to fail until the
      PRE-PILOT SECURE-BROWSER RELEASE-METADATA RECONCILIATION GATE is
      closed — record that honestly rather than picking one source.)*
- [ ] Installer artifact retrievable, for whichever version is
      currently treated as authoritative?
- [ ] Retrieved installer's SHA-256 matches the authoritative release
      record? *(Not just "matches one of the three sources" — matches
      the single record established by the reconciliation gate above.)*

## J. Configuration recovery review

- [ ] Configuration Recovery Register (runbook Section 13) consulted for
      the variables relevant to this exercise's scope.
- [ ] Confirmed no secret **values** were written into this checklist,
      the Restore Test Record, or any exercise notes — names/locations
      only.

## K. Privacy/retention reconciliation

- [ ] Runbook Section 29 sequence followed: recovery point established,
      compared against retention/hold records, potentially-resurrected
      data identified.
- [ ] Any active legal/academic/privacy hold checked and, if present,
      confirmed preserved (not overridden by this exercise).

**STOP if legal/privacy hold status is unknown when affected data could
be overwritten or deleted.**

## L. Incident/NDB decision

- [ ] Considered whether `docs/australian-incident-ndb-procedure-v1.md`
      applies to this scenario (real event) or should be referenced as
      part of the exercise narrative (tabletop).
- [ ] Recorded the conclusion, even if "not applicable."

## M. RPO/RTO measurement

- [ ] Restore started-at / completed-at timestamps recorded.
- [ ] Measured RPO and RTO recorded in the Restore Test Record —
      **measured only, never a pre-committed target** (runbook Section
      32).

## N. Service reopening decision

*(Real event only — a tabletop does not reopen a real service.)*

- [ ] Runbook Section 31's full checklist reviewed against the actual
      recovery performed.
- [ ] Restore approval authority (runbook Section 16) explicitly
      approves reopening.

**No automatic reopening.**

## O. Exercise closeout

- [ ] Restore Test Record completed and reviewed.
- [ ] Result recorded: PASS / PASS WITH CONDITIONS / FAIL.
- [ ] Findings documented.

## P. Corrective actions

- [ ] Corrective actions assigned an owner and due date.
- [ ] Retest requirement decided.
- [ ] Reviewer approval and closure date recorded.

---

## Restore stop conditions (summary)

Any of the following halts the exercise/event immediately, at whatever
step it is discovered — fail closed, do not improvise a workaround:

- Backup source cannot be identified.
- Checksum/format verification fails.
- The requested recovery point is ambiguous.
- The destination cannot be proven non-production during rehearsal.
- Restoring would overwrite healthy Production without explicit disaster
  authority (runbook Section 23).
- Required credential ownership is unclear.
- The evidence archive and primary storage resolve to the same failure
  domain where separation is required.
- Legal/privacy hold status is unknown when affected data could be
  overwritten or deleted.
- The exercise begins contacting a real student or institution
  unexpectedly.
