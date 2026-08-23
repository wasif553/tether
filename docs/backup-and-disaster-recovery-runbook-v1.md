# Tether Backup & Disaster Recovery Runbook v1

**This is the umbrella Tether disaster-recovery (DR) document — operations
and governance, not legal advice.** It sits above
[`docs/production-backup-restore-runbook.md`](production-backup-restore-runbook.md),
which remains the detailed, technical **database backup verification**
sub-runbook and is not replaced, weakened, or duplicated by this
document. Where the two overlap, this document defers to that one for
exact tool behaviour and cross-links it rather than restating it.

This package also includes two companion, fillable operational
documents: [`docs/restore-test-record-v1.md`](restore-test-record-v1.md)
(one record per restore test/exercise) and
[`docs/dr-exercise-checklist-v1.md`](dr-exercise-checklist-v1.md) (the
step-by-step checklist an operator follows during an actual DR exercise
or real disaster).

---

## 1. Purpose

This runbook exists so that, if Tether's Production database, evidence
storage, application deployment, or configuration is lost, corrupted, or
made unavailable, there is a single, consistent, human-authorised
process to:

1. accurately identify what has actually happened, and what has not;
2. contain further damage without destroying the evidence needed to
   diagnose and recover;
3. recover the database, evidence storage, application, and
   configuration using the real capability that exists today — not
   capability this document wishes existed;
4. validate that recovery actually restored a working, correct,
   privacy-compliant service before reopening it to students and
   lecturers;
5. reconcile privacy and retention obligations that a restore can
   disturb; and
6. record what happened, and what still needs to be built before this
   is a fully pilot-ready DR posture.

## 2. Scope

Covers the standalone Tether exam platform's Production infrastructure:
the Supabase Postgres database, Supabase Storage evidence objects, the
Vercel application deployment, its configuration/environment variables,
and the Tether Secure Browser installer/release artifacts. It does not
cover an institution's own systems (LMS, SIS, identity provider), which
remain that institution's responsibility, and it does not change any
product/application behaviour — this is a process document.

This runbook governs **recovery**, not day-to-day retention deletion
(that remains
[`docs/evidence-retention-operations-v1.md`](evidence-retention-operations-v1.md))
and not privacy/security incident response in general (that remains
[`docs/australian-incident-ndb-procedure-v1.md`](australian-incident-ndb-procedure-v1.md)).
A single real disaster is very likely to require all three documents
together — see Section 30.

## 3. Recovery principles

1. **Diagnose before restoring.** A restore is a significant, sometimes
   destructive action — understand what actually broke before acting.
2. **Never restore Production impulsively.** Every Production restore
   requires the approval boundary in Section 23, not just technical
   capability to run the command.
3. **Preserve the damaged/current state where feasible before
   overwriting it.** A corrupted database or a partially-lost bucket may
   itself be evidence of what happened — capture it (exports, snapshots,
   error logs) before an irreversible recovery action erases the trail.
4. **Stop further destructive changes where appropriate.** If writes are
   actively making things worse (e.g. a bad deployment still processing
   requests), stopping them can be more urgent than starting recovery.
5. **Identify the intended recovery point explicitly** before recovering
   — see Section 20. An ambiguous recovery point is a stop condition
   (`docs/dr-exercise-checklist-v1.md`).
6. **Verify backup integrity before restore** — Section 21, using
   `npm run backup:verify` (`docs/production-backup-restore-runbook.md`).
7. **Rehearse the restore in disposable/non-production infrastructure
   first, wherever feasible**, before touching Production — Section 22.
8. **Database recovery and Storage-object recovery are separate
   domains.** A database backup does not restore evidence bytes — see
   Sections 9–10 and 26. Treating them as one operation is the single
   most likely mistake in a real Tether recovery.
9. **Recovered evidence must be cryptographically/metadata verified
   where supported** — the existing evidence-archive tooling's
   SHA-256/manifest verification (Section 9), not a visual "looks fine"
   check.
10. **Reopening service requires validation, not merely "the restore
    command completed."** See Section 31.
11. **No secret values in DR records.** Every template in this package
    (this runbook's Configuration Recovery Register, the Restore Test
    Record, the DR Exercise Checklist) records environment-variable
    **names** and **locations**, never values.
12. **Recovery actions must be timestamped and attributable.** Who did
    what, when — recorded in the Restore Test Record or, for a real
    disaster, the equivalent live record.
13. **Privacy and retention obligations continue during DR.** A disaster
    does not suspend `docs/privacy-and-evidence-retention-v1.md` or
    active legal/academic holds — see Section 29.
14. **A restore must not silently undo approved retention deletion or an
    active legal hold.** Section 29 requires reconciliation before
    normal operation resumes, never an assumption that "restored data is
    automatically fine to keep."
15. **DR is human-authorised, not automatic.** No step in this runbook,
    or in any tool it references, runs itself against Production without
    a person deliberately invoking it — see Section 13 of
    `docs/australian-incident-ndb-procedure-v1.md` for the equivalent
    principle in incident response, which this runbook mirrors.

## 4. Current infrastructure recovery baseline

**These are the actual, current facts this runbook is built on — not
targets, not assumptions.**

- **Supabase**: the Tether Postgres database and primary evidence
  storage bucket are hosted in a Supabase project on the **Free**
  organisation plan. Current official Supabase documentation states Free
  projects do **not** include automatic database backups; paid
  Pro/Team/Enterprise plans support daily database backups, and
  point-in-time recovery (PITR) is a separate paid capability on top of
  that. **Tether does not currently rely on any provider-managed
  Production database backup.** Manual logical backup remains possible
  today using the Supabase CLI's `db dump` or plain `pg_dump` against the
  project's connection string.
- Supabase database backups, whether provider-managed or manual
  `pg_dump`, **do not contain Supabase Storage object bytes** — a
  database backup may contain *metadata* referencing a storage object,
  never the object's actual bytes. See Sections 9–10.
- **Vercel**: Tether is deployed as a Next.js project on Vercel, on the
  **Hobby** team plan, from the `wasif553/tether` GitHub repository. This
  runbook does **not** assume any Pro/Enterprise-only instant or
  specific-deployment rollback capability is available on Hobby unless
  independently verified at the time of use — see Section 12.
- **Evidence archive**: `docs/tether-evidence-archive-plan.md` and
  `npm run evidence:archive` implement a real, tested architecture for
  copying verified evidence to a *separate* Supabase project for
  disaster recovery — but, as of this pass, **no real archive Supabase
  project has been provisioned, no archive credentials are configured in
  Vercel, and no Production evidence has ever been archived.** This
  remains a **PRE-PILOT EVIDENCE-RECOVERY GATE** (Section 37) unchanged
  by this task.
- **Database backup verification**: `npm run backup:verify`
  (`docs/production-backup-restore-runbook.md`) is a real, tested tool
  that verifies an *existing* dump file and can rehearse restoring it
  into a disposable local container — it does **not** create backups and
  has never been run against a real Production dump as of this pass
  (only synthetic/local dumps in its own tests).

**Bottom line:** Tether today has strong *tooling* for verifying a
backup and for restoring individual evidence objects once an archive
exists, but has **no scheduled, verified, currently-operating Production
backup**, and **no provisioned off-project evidence archive**. This
runbook documents the real recovery *process* around that tooling and
names the gaps precisely (Section 37) rather than describing a posture
that does not exist yet.

## 5. Recovery capability matrix

| Component | Current primary | Current backup/recovery mechanism | Verified? | Automatic? | Known gap | Pre-pilot action |
|---|---|---|---|---|---|---|
| A. Application source | GitHub (`wasif553/tether`) | Git history itself is the recovery mechanism — every commit is a full, independently-checkable snapshot | Yes (inherent to Git) | N/A | Repository availability itself depends on GitHub | None beyond normal GitHub account hygiene |
| B. Vercel deployment/runtime | Vercel (Hobby plan) | Redeploy from a known-good Git commit | Not independently verified on the current plan | No | Hobby-plan rollback/promotion capability not confirmed | Verify actual Hobby-plan redeploy path before pilot (Section 12) |
| C. Supabase Postgres database | Supabase (Free plan, `AP-Northeast`) | None provider-managed on Free plan; `npm run backup:create` tooling now exists (`docs/database-backup-operations-v1.md`) but has never been run against this Production project | No — no backup has ever been produced and verified against this Production project as of this pass | No | **No scheduled Production backup cadence exists — tooling gap closed, operational gap (real backup + off-project copy + cadence) remains open** | **PRE-PILOT BACKUP GATE** (Section 37) |
| D. Supabase Storage primary evidence objects | Supabase Storage (same project as C) | None dedicated — not covered by database backups at all | No | No | Same failure domain as C; no independent copy | **PRE-PILOT EVIDENCE ARCHIVE GATE** (Section 37) |
| E. `IntegrityEvidenceAsset` relational metadata | Postgres row (same database as C) | Covered by whatever database backup exists (i.e. currently none scheduled) | No | No | Same as C; also: metadata alone is useless without the bytes it references (Section 10) | Same as C |
| F. Separate evidence archive | Not provisioned | `npm run evidence:archive` architecture exists in code but has no real target project | No | No | **Architecturally implemented, cloud recovery path not yet activated or tested** | **PRE-PILOT EVIDENCE ARCHIVE GATE** (Section 37) |
| G. Environment configuration/secrets | Vercel project environment variables | No documented authoritative recovery source beyond "however they were originally set" | No | No | **No documented secret-recovery source of truth** | **PRE-PILOT CONFIGURATION RECOVERY GATE** (Section 37) |
| H. Secure Browser installers/release hashes | Installer file hosted wherever `TETHER_INSTALLER_DOWNLOAD_URL` points; version/hash metadata split across three sources that currently disagree — `apps/lockdown/src/shared.ts` (`LOCKDOWN_VERSION = "1.7.6"`), `src/lib/tetherReleaseMetadata.ts` (release-candidate/distribution metadata still at `1.7.4`), and `docs/tether-release-management.md` (release record still at `1.7.2`) | Whatever redundancy the operator hosting the file happens to have | No | No | Only an operator/local copy is documented to definitely exist for any of these versions; no independent backup store confirmed. **The three sources describe three different versions, not conflicting hashes for one version** — the authoritative release-artifact record has not been reconciled after the subsequent native-client releases | **PRE-PILOT SECURE-BROWSER RELEASE-METADATA RECONCILIATION GATE** and **PRE-PILOT RELEASE-ARTIFACT BACKUP GATE** (Section 37) |
| I. Domain/DNS configuration | Vercel-managed (assumed; not independently verified in this pass) | Vercel project settings | Not verified in this pass | N/A | Not audited in this pass | Confirm DNS/domain configuration recovery source before pilot |
| J. Optional Anthropic/AI integration | Anthropic API (external dependency, not Tether-controlled) | N/A — this is dependency continuity, not a Tether backup domain | N/A | N/A | Provider outage handling only (Section 15) | Not a backup gate — see note below |
| K. Transactional email provider (Resend) | Resend API (external dependency, not Tether-controlled) | N/A — dependency continuity, not a backup domain | N/A | N/A | Provider outage handling only (Section 15) | Not a backup gate — see note below |

**Note on J and K:** ordinary third-party service availability is not
treated as a "backup" in this matrix — Anthropic and Resend being
temporarily unavailable is a dependency-continuity concern (Section 15),
not something Tether backs up or restores, since Tether holds no copy of
their internal state to recover.

## 6. Data/service criticality

Ranked by what a real Tether disaster would put at risk, informing
severity/urgency during a real event (mirrors the operations-only
severity framing of `docs/australian-incident-ndb-procedure-v1.md`
Section 6 — criticality here is about recovery urgency, not a privacy or
legal determination):

1. **Integrity evidence and assessment records mid-exam or awaiting
   review** — the highest-consequence loss, since it may be
   unrecoverable and directly affects academic-integrity outcomes.
2. **Submitted, graded assessment records** (Class B,
   `docs/privacy-and-evidence-retention-v1.md` Section 4) — institution
   academic records depend on these.
3. **Active exam sessions** — a live exam interrupted by an outage has
   immediate student-facing impact even before any data-loss question.
4. **Account/tenancy data** (Class D) — needed to resume normal
   operation at all.
5. **Operational/security logs** (Class C, `PlatformAuditLog`) — lower
   immediate urgency, but needed for post-incident review (Section 27 of
   the NDB procedure) and this runbook's own recordkeeping (Section 34).

## 7. Backup domains

This runbook treats these as **distinct recovery domains**, each with
its own mechanism, verification, and (where applicable) gate — never
conflated:

- **Database** (Section 8) — Postgres logical dump.
- **Evidence storage** (Section 9) — Supabase Storage object bytes.
- **Application/code** (Section 11) — Git history.
- **Vercel deployment configuration** (Section 12).
- **Configuration/secrets** (Section 13).
- **Secure Browser release artifacts** (Section 14).

## 8. Database backup strategy

**Current real capability:** the repository already contains
`npm run backup:verify` and its detailed documentation in
[`docs/production-backup-restore-runbook.md`](production-backup-restore-runbook.md).
That tool:

- does **not** create a backup;
- accepts an existing database dump file;
- checks the file exists and is a plausible size (≥10,000 bytes);
- computes and records its SHA-256;
- detects whether it is a recognised `pg_dump` custom-format or
  plain-SQL dump;
- can, with `--restore`, additionally rehearse restoring that dump into
  a **disposable local Docker Postgres container** and run basic
  schema/data sanity checks;
- can output a standard JSON verification report with `--report <path>`;
- is **structurally incapable** of targeting Production for its restore
  rehearsal — the same `requireDisposableDatabaseUrl` guard
  `npm run release:validate` uses (`scripts/releaseValidation/dbSafetyGuard.ts`)
  is reused directly, with no flag or environment variable able to
  redirect it elsewhere.

**This is a strong verification control. It is not a backup
scheduling/creation system**, and this runbook does not describe it as
one.

**Backup CREATION tooling now exists**, closing the tooling portion of
this section's own gate: `npm run backup:create` (see
[`docs/database-backup-operations-v1.md`](database-backup-operations-v1.md)
for the full operator runbook) produces a logical backup **bundle**
(`roles.sql`, `schema.sql`, `data.sql`, `manifest.json`) via
`pg_dump`/`pg_dumpall` run inside a throwaway toolbox Docker container,
and integrates directly with a bundle-aware counterpart to the existing
verifier, `npm run backup:verify-bundle`. Defaults to a dry run;
`--execute` requires an explicit `--environment` and `--output-dir`, and
`--environment production` additionally requires a separate, explicit
`--confirm-production` flag — never inferred from the connection
string. **DATABASE BACKUP CREATION TOOLING: IMPLEMENTED AND LOCALLY
VERIFIED.** Local-test result (disposable, synthetic data only — no
Production contact): a disposable local Postgres container was seeded
with 2 synthetic tables and 4 rows; `npm run backup:create -- --execute
--environment local-test ...` produced a `COMPLETE` bundle (`roles.sql`
671 bytes, `schema.sql` 4063 bytes, `data.sql` 1512 bytes, each hashed);
`npm run backup:verify-bundle -- <bundle> --restore` recomputed and
matched every file's SHA-256, then rehearsed a full restore (roles →
schema → data) into a **second**, independent disposable container,
finding the same 2 tables and 4 rows — `overallPassed: true`. A genuine
bug was found and fixed during this exercise: `pg_dump --schema-only`'s
default `CREATE SCHEMA public;` statement collided with the "public"
schema every fresh Postgres database already has; fixed by adding
`--clean --if-exists` to the schema dump so the restore is idempotent
against a fresh target (see `scripts/create-database-backup.ts`'s own
comment on that line). The tool's fail-closed paths were also exercised
for real: an unreachable source correctly produced a `FAILED` bundle
(diagnostic preserved, redacted, no partial `COMPLETE` bundle), and
`--environment production` without `--confirm-production` was refused
before any Docker/network action. **This is a tooling gap closed, not
the PRE-PILOT BACKUP GATE itself closed** — see the status line
immediately below.

**Current Supabase Free-plan boundary — state this clearly, do not
soften it:** automatic provider-managed backup coverage is **not**
currently relied upon, because the observed Tether Supabase organisation
is on the Free plan, which current official Supabase documentation
states does not include automatic database backups. **Therefore Tether
currently has no documented, verified, scheduled Production
database-backup cadence.**

- **PRODUCTION BACKUP: NOT YET EXECUTED / VERIFIED** — `npm run
  backup:create` has never been run with `--environment production
  --confirm-production` against a real Production database.
- **OFF-PROJECT COPY: NOT YET SELECTED / VERIFIED** — see
  `docs/database-backup-operations-v1.md`'s own PRE-PILOT OFF-PROJECT
  COPY GATE.
- **PRODUCTION BACKUP GATE: OPEN.** Writing and locally verifying this
  tooling does not, by itself, close this gate — it closes only once a
  real, authorised Production backup has been created, copied
  off-project, verified, and restore-tested.

Before a real institutional pilot, choose and implement a Production
database backup strategy. Possible future strategies (not decided or
purchased by this task):

- **A.** A paid Supabase plan with provider-managed backups, plus an
  independent, off-project verification/safeguard step.
- **B.** Operator-controlled scheduled logical backups using the
  now-implemented `npm run backup:create` tooling (or the Supabase
  CLI/`pg_dump` directly), stored securely outside the primary Supabase
  project — the creation and verification tooling for this strategy now
  exists; the operational decision to actually run it against
  Production, on what cadence, and where the off-project copy goes, does
  not yet exist.
- **C.** Another reviewed combination of A and B.

This runbook does not decide between them.

## 9. Evidence-storage backup strategy

**Lock this clearly: Supabase database backups do not restore Storage
object bytes.** The relational database may contain *metadata*
referencing a Storage object (a `storageKey`, a `sha256`, a `byteSize`),
but the actual camera/screen-share evidence bytes are a **separate**
recovery domain, governed by Supabase Storage, not Postgres.

Tether already has evidence-archive architecture and code
(`docs/tether-evidence-archive-plan.md`, `npm run evidence:archive`,
`src/lib/evidenceArchive.ts`, `src/lib/evidenceArchiveStorage.ts`) that:

- verifies source SHA-256/size before archiving;
- writes to a separate archive storage adapter;
- verifies archive bytes after upload;
- maintains a canonical-JSON manifest per archived object;
- can restore one missing/corrupt evidence asset back to primary storage
  (two supported scenarios only: primary object missing with the
  database row still present, or primary object present but failing
  SHA-256 verification — a healthy, verified-correct primary object is
  always refused, never overwritten);
- has hardened Production-confirmation guards
  (`assertSupabaseArchiveOperationSafe`, requiring
  `--confirm-production-archive`/`--confirm-production-restore` derived
  solely from actual environment configuration, never a caller flag).

**But no real archive Supabase project is currently provisioned, no
archive credentials are configured in Vercel, and no Production evidence
has ever been archived.** Evidence-storage DR is therefore:

**ARCHITECTURALLY IMPLEMENTED, BUT CLOUD RECOVERY PATH NOT YET ACTIVATED
OR TESTED.**

**PRE-PILOT EVIDENCE-RECOVERY GATE** (Section 37).

## 10. Evidence metadata vs evidence bytes

These are two different things that can independently succeed or fail to
recover, and a real Tether restore must check both, separately:

- An `IntegrityEvidenceAsset` **row** (institutionId, examId,
  submissionId, kind, storageKey, sha256, byteSize, capturedAt, ...) —
  recovered, if at all, as part of the **database** recovery domain
  (Section 8/24).
- The **bytes** the row's `storageKey` points to in Supabase Storage —
  recovered, if at all, as part of the **evidence-storage** recovery
  domain (Section 9/25), currently only via the not-yet-provisioned
  archive.

A recovered database row with no corresponding recoverable bytes is a
**metadata-only** evidence record — genuinely reduced evidentiary value
for academic-integrity review, and this must be disclosed, not silently
treated as "the evidence is fine." See Section 26 for reconciliation.

## 11. Application/code recovery

GitHub (`wasif553/tether`) is the primary source of truth for
application code. Every commit is an independently-verifiable, complete
snapshot — there is no separate "code backup" beyond ordinary Git/GitHub
availability. Recovery path: identify a known-good commit, inspect the
actual change between it and the current (bad) state, and redeploy
through the normal, controlled Git → Vercel path (Section 12) — never by
hand-editing Production.

## 12. Vercel recovery

Three distinct scenarios, not to be conflated:

- **Bad application deployment** (the code itself is broken, Vercel
  platform is fine): baseline recovery is a known-good Git commit plus
  redeployment/promotion through whatever path the **current Hobby
  plan** actually supports. This runbook does not state a specific
  Pro/Enterprise-only instant-rollback capability as available, since it
  has not been independently verified on Hobby as of this pass —
  confirm the actual current capability before relying on it during a
  real event, and record what was confirmed in the Restore Test
  Record/DR Exercise Checklist. Practical sequence: identify the
  known-good commit → inspect the diff to the bad state → redeploy via
  the normal controlled Git/Vercel path → validate (Section 28/31)
  before reopening.
- **Vercel platform outage** (Vercel itself is down, code is fine): no
  action Tether can take restores Vercel's own availability — this is
  dependency continuity (Section 15), tracked and communicated, not
  "recovered" by this runbook.
- **Loss of Vercel project configuration** (the deployment target itself
  is misconfigured or gone): requires reconstructing, at minimum: the
  project's framework/build configuration, environment variable
  **names** (Section 13 — never values from this runbook), configured
  domains, build/runtime settings, and the GitHub repository
  integration. This runbook does not copy actual secret values into
  itself under any circumstance.

## 13. Configuration and secrets recovery

**Configuration Recovery Register** — names and locations only, never
values:

| Configuration item | System | Environment | Required for service? | Recovery owner | Authoritative source/location | Last verification | Recovery notes |
|---|---|---|---|---|---|---|---|
| `DATABASE_URL` | Postgres/Prisma | Production | Yes | *(not yet assigned — PRE-PILOT OPERATIONAL DECISION)* | Vercel project environment variables | Not verified in this pass | Connection string to primary Supabase project |
| `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL` | Supabase | Production | Yes | *(PRE-PILOT OPERATIONAL DECISION)* | Vercel project environment variables | Not verified in this pass | |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase | Production | Yes | *(PRE-PILOT OPERATIONAL DECISION)* | Vercel project environment variables | Not verified in this pass | Highest-sensitivity credential in this table |
| `AUTH_SECRET` | NextAuth | Production | Yes | *(PRE-PILOT OPERATIONAL DECISION)* | Vercel project environment variables | Not verified in this pass | Rotating invalidates all active sessions |
| `EVIDENCE_STORAGE_PROVIDER`, `EVIDENCE_STORAGE_BUCKET` | Evidence storage | Production | Yes | *(PRE-PILOT OPERATIONAL DECISION)* | Vercel project environment variables | Not verified in this pass | Selects/targets the primary evidence bucket |
| `EXAM_BINDING_HMAC_SECRET` | Session binding | Production | Yes | *(PRE-PILOT OPERATIONAL DECISION)* | Vercel project environment variables | Not verified in this pass | Session-binding hashes become unverifiable if lost and rotated without a migration plan |
| `NETWORK_EVIDENCE_SALT` | Network evidence | Production | Yes | *(PRE-PILOT OPERATIONAL DECISION)* | Vercel project environment variables | Not verified in this pass | |
| `RESEND_API_KEY`, `PASSWORD_RESET_FROM_EMAIL` | Email (Resend) | Production | Yes (for password reset/notifications) | *(PRE-PILOT OPERATIONAL DECISION)* | Vercel project environment variables | Not verified in this pass | |
| `ANTHROPIC_API_KEY` | Optional AI features | Production | Only if AI features enabled | *(PRE-PILOT OPERATIONAL DECISION)* | Vercel project environment variables | Not verified in this pass | |
| `ARCHIVE_STORAGE_PROVIDER`, `ARCHIVE_SUPABASE_URL`, `ARCHIVE_SUPABASE_SERVICE_ROLE_KEY`, `ARCHIVE_STORAGE_BUCKET`, `ARCHIVE_SOURCE_ENVIRONMENT`, `ARCHIVE_EXPECTED_PRIMARY_PROJECT_REF` | Evidence archive | Not yet configured anywhere | Not yet — archive not provisioned (Section 9) | *(PRE-PILOT OPERATIONAL DECISION)* | Documented only in `docs/tether-evidence-archive-plan.md` — **not present in `.env.example`** | N/A — not yet in use | Will need adding to the canonical env template once the archive project exists |
| `TETHER_SECURE_CLIENT_SIGNING_PRIVATE_KEY` / `_PUBLIC_KEY` / `_KEY_ID` | Secure-client launch-manifest signing | Production | Yes, if Secure Browser mode used | *(PRE-PILOT OPERATIONAL DECISION)* | Vercel project environment variables | Not verified in this pass | See `docs/secure-launch-signing-key-runbook.md` for this key's own dedicated runbook |
| `TETHER_SEB_KEY_ENCRYPTION_KEYS_JSON` / `_ACTIVE_KEY_ID` | SEB config encryption | Production | Yes, if SEB experimental mode used | *(PRE-PILOT OPERATIONAL DECISION)* | Vercel project environment variables | Not verified in this pass | |
| `TETHER_INSTALLER_DOWNLOAD_URL`, `TETHER_RELEASE_STATUS` | Secure Browser release | Production | Yes, for Secure Browser distribution | *(PRE-PILOT OPERATIONAL DECISION)* | Vercel project environment variables | Not verified in this pass | See Section 14 |

**This runbook does not state that GitHub is an acceptable secret-value
backup** — none of these variables are committed to the repository
(confirmed: every sensitive entry in `.env.example` is blank/placeholder,
and `.gitignore` excludes all `.env*` files except `.env.example`
itself). **The authoritative secret-management source of truth is
currently undocumented** — marked **PRE-PILOT OPERATIONAL DECISION**
throughout this table, and consolidated as the **PRE-PILOT CONFIGURATION
RECOVERY GATE** (Section 37).

## 14. Secure Browser release artifact recovery

Tether is not only a web application — the Tether Secure Browser
installer is a separate recoverable artifact.

**Audited current state — three sources, three different versions, not
reconciled:**

1. The native client source itself currently identifies as **v1.7.6**
   (`LOCKDOWN_VERSION = "1.7.6"` in `apps/lockdown/src/shared.ts`),
   which also contains the actual v1.7.5 and v1.7.6 change history.
2. `src/lib/tetherReleaseMetadata.ts` — the release-candidate/
   distribution metadata actually served to clients — still identifies
   the current release candidate as **v1.7.4**
   (`CURRENT_RELEASE_CANDIDATE_VERSION`, `CURRENT_INSTALLER_FILENAME =
   "Tether-Secure-Browser-1.7.4-win-x64.exe"`, and its own v1.7.4
   SHA-256).
3. `docs/tether-release-management.md` — the release-management
   document's own release table — still identifies **v1.7.2** as the
   release candidate, with the v1.7.2 installer filename and SHA-256.

**This is not merely a hash mismatch for one installer.** An earlier
pass of this runbook mischaracterised it that way — it is corrected
here: these are three different version numbers from three different
sources, meaning **the authoritative release-artifact record has not
yet been reconciled after the subsequent native-client releases** (the
native source moved from 1.7.2 → 1.7.4 → 1.7.6 without the
distribution-metadata and release-management sources being updated to
match). This runbook does not silently pick one of the three versions
as "correct," does not copy or touch the installer, and does not modify
`apps/lockdown` or update any release-metadata constant — resolving
which version is actually the accepted one is a release-management
decision outside this runbook's scope.

The installer file itself, for whichever version is eventually
established as authoritative, is hosted wherever the
`TETHER_INSTALLER_DOWNLOAD_URL` environment variable points — the
release-management process (`docs/tether-release-management.md`)
requires this to exist before a version is published, but does not
document any specific redundant or backed-up hosting location beyond
"the actual `.exe`, hosted somewhere `TETHER_INSTALLER_DOWNLOAD_URL` can
point to." **This runbook does not invent a redundant artifact store
that does not exist.**

**Before pilot, Tether must establish ONE authoritative release record**
for the accepted Secure Browser version, containing:

- **exact version**;
- **installer filename**;
- **SHA-256**;
- **source/build provenance** (the exact commit the installer was built
  from);
- **physical acceptance status** (per `docs/tether-release-management.md`'s
  own PHYSICAL ACCEPTANCE stage — never inferred from automated tests or
  code review alone);
- **code-signing status** (signed/unsigned, and if unsigned, that this
  is a deliberate pilot-stage decision per
  `docs/tether-windows-code-signing-plan.md`, not an oversight);
- **release notes** (what changed since the previous published
  version);
- **recoverable artifact location** (where the actual `.exe` can be
  retrieved from, distinct from where it is currently distributed).

Two related but distinct gates follow from this — do not conflate them:

- **PRE-PILOT SECURE-BROWSER RELEASE-METADATA RECONCILIATION GATE** —
  *which* version/hash/artifact is actually authoritative? (This is the
  gap described above.)
- **PRE-PILOT RELEASE-ARTIFACT BACKUP GATE** — once that is answered,
  *can* the authoritative installer actually be recovered if its current
  hosting/local copy is lost? (Unresolved either way — only an
  operator/local copy is documented to definitely exist for any of the
  three versions above; no independent backup store is confirmed.)

This runbook does not rebuild, resign, or modify the Secure Browser
installer, and does not update any release-metadata constant — that
remains the release-management process's own responsibility.

## 15. External provider outage handling

For a provider outage that is not itself a Tether data-loss event
(Vercel, Supabase, Anthropic, the email provider) — track it, do not
attempt to "recover" the provider's own infrastructure:

1. Confirm the outage is provider-side, not a Tether-side
   misconfiguration mistaken for one.
2. Check the provider's own status page/communication for scope and
   estimated resolution.
3. Communicate to affected users factually (mirrors
   `docs/australian-incident-ndb-procedure-v1.md` Section 25's
   communications-control principle) — what is known, what is not, no
   speculation about resolution time beyond what the provider has
   actually stated.
4. If the outage is prolonged and materially affects an active exam
   window, escalate to the recovery roles in Section 16 for a
   service-level decision (e.g. extending an affected exam's window) —
   this is a product/academic-operations decision, not one this runbook
   makes unilaterally.
5. Resume normal operation once the provider confirms resolution and
   Tether's own post-outage validation (Section 28) passes.

## 16. Recovery roles and authority

Mirrors `docs/australian-incident-ndb-procedure-v1.md` Section 7's
pattern deliberately, so the same people/process can carry a real event
across both documents without re-learning a different role model. This
document deliberately does **not** name specific individuals — role
assignment is an institutional/operational decision to be made before
external pilot (Section 37).

- **Reporter** — whoever first notices or is told about a possible
  disaster. Never gatekept.
- **Recovery lead** — coordinates a specific recovery end to end:
  diagnosis, containment, recovery sequencing, and the Restore Test
  Record/live-event record. One recovery lead per event.
- **Restore approval authority** — the person(s) who may actually
  approve a **Production** restore (Section 23). No Production restore
  proceeds without this explicit sign-off — the human checkpoint Section
  18 (Phase 13 of the source task, "no live incident automation")
  exists to protect, mirrored here for DR.
- **Privacy/retention reviewer** — engaged for Section 29's post-restore
  reconciliation.
- **Incident/NDB liaison** — engaged whenever Section 30 applies.

## 17. Disaster declaration

A "disaster" for this runbook's purposes is any event where Production
data, evidence, application availability, or configuration is lost,
corrupted, or unavailable beyond what ordinary operational
troubleshooting resolves quickly. The recovery lead (Section 16) makes
the declaration, which starts this runbook's process (and the Restore
Test Record / live-event equivalent) — declaring is cheap and reversible
if the event turns out to be minor; failing to declare and losing time
is not.

## 18. Immediate containment / stop-write decision

If active writes are making the situation worse (a bad deployment still
serving traffic, an ongoing unauthorised-access event, a runaway
process), the recovery lead decides whether to stop them **before**
beginning recovery — mirroring Section 9 of the NDB procedure
("containment must never silently destroy forensic evidence"). Record
the decision and its timing.

## 19. Preserve current damaged state

Before any recovery action that would overwrite or destroy the current
(damaged) state, capture what can reasonably be captured: error logs,
a description of the observed failure, timestamps, and — for a database
issue — an export of the current (even if damaged) state if that is
itself safely obtainable, since it may be needed to diagnose root cause
or may itself be more recent than the best available backup.

## 20. Choose recovery point

Explicitly identify **which** recovery point is being targeted (a
specific backup file, a specific Git commit, a specific point in time)
before proceeding — an ambiguous recovery point is a stop condition
(`docs/dr-exercise-checklist-v1.md`). Record the chosen recovery point
and the reasoning (most recent verified backup vs. a deliberately
earlier one, e.g. to exclude a known-bad write).

## 21. Verify backup before restore

Run `npm run backup:verify -- <dump-file>` (file-level checks only) or
`npm run backup:verify -- <dump-file> --restore --report <path>` (adds
the disposable restore rehearsal and a JSON report) before ever
attempting a Production restore. See
[`docs/production-backup-restore-runbook.md`](production-backup-restore-runbook.md)
for the exact tool behaviour. **If file-level verification fails,
restore rehearsal never runs, even with `--restore` passed** — this is
enforced in the tool itself, not merely a recommendation.

## 22. Disposable restore rehearsal

Wherever feasible, rehearse the restore in disposable, non-production
infrastructure first — `npm run backup:verify -- <dump-file> --restore`
does exactly this, into a throwaway local Docker Postgres container that
is structurally guaranteed (via the same `requireDisposableDatabaseUrl`
guard `npm run release:validate` uses) never to be Production. A
successful disposable rehearsal is a precondition for Production restore
confidence, not a substitute for the Production restore itself needing
separate approval (Section 23).

## 23. Production restore approval boundary

**No Production restore proceeds without explicit sign-off from restore
approval authority (Section 16), recorded with**: who approved, when,
which recovery point, and confirmation that Sections 19–22 were
followed. This mirrors the NDB procedure's "notification decision
authority" checkpoint (Section 7/18 of that document) — a deliberate,
consistent pattern across Tether's governance documents: destructive or
high-consequence actions always have a named human checkpoint, never an
automatic trigger.

## 24. Database recovery sequence

1. Confirm backup verified (Section 21) and, where feasible, rehearsed
   (Section 22).
2. Confirm Production restore approval (Section 23).
3. Confirm the actual target `DATABASE_URL`/environment about to be
   restored into — this runbook does not provide a Production-target
   safety rail beyond this manual confirmation step, mirroring the same
   documented gap already called out for the evidence-retention CLI
   (`docs/privacy-and-evidence-retention-v1.md` Section 20's
   PRE-PILOT GATE on Production-target confirmation) — this is a
   pattern this repository is honest about repeating rather than
   silently assuming solved.
4. Execute the restore using the verified backup file and the
   Supabase-provided or `pg_restore`/`psql` mechanism appropriate to the
   dump format, against the actual Production database — **this is the
   one step in this runbook that legitimately targets Production**, and
   only after 1–3 above.
5. Run post-restore validation (Section 28) before proceeding to
   application/evidence reconciliation.

## 25. Evidence recovery sequence

1. Determine which evidence assets are actually affected (missing or
   corrupt primary object) — via `IntegrityEvidenceAsset` rows and,
   where available, monitoring/error signals.
2. **If a real evidence archive exists at the time of the event** (not
   the case as of this pass — Section 9), use
   `npm run evidence:archive -- --restore-asset <id> --confirm-restore
   [--confirm-production-restore]` per its own documented safety gates
   in `docs/tether-evidence-archive-plan.md` — only for the two
   supported scenarios (missing object with row present; corrupt object
   failing SHA-256 verification with row present). A healthy, verified
   object is always refused, never overwritten.
3. **If no archive exists** (the current actual state), the evidence
   bytes for an affected asset are likely unrecoverable — document this
   honestly in the Restore Test Record / live-event record rather than
   implying a recovery path that does not exist.
4. Do not delete or modify the archive copy of any object during this
   process — the archive adapter has no `delete()` capability at all,
   by design, so this is also structurally prevented.

## 26. Evidence metadata reconciliation

A database restore and an evidence-storage recovery can produce
inconsistent states — document supported current behaviour honestly,
without inventing automation that does not exist:

- **Database restored to an earlier point than evidence storage** (e.g.
  database reflects Tuesday, but evidence objects created Wednesday
  still physically exist in the primary bucket): those Wednesday objects
  now have **no corresponding database row** — they are orphaned bytes,
  invisible to the application, requiring **manual investigation**
  before deciding whether to re-create context for them or treat them as
  lost from the application's perspective.
- **Database row exists, primary evidence bytes are missing**: the
  metadata-only situation described in Section 10 — attempt archive
  recovery (Section 25) if an archive exists; otherwise document as
  evidence loss for that specific asset.
- **Primary bytes exist, restored database no longer contains the
  metadata row** (e.g. database restored to before that row was
  created): the bytes are orphaned in storage with no application-level
  reference — again, **manual investigation required**.
- **If Postgres is restored to an older state and later archive objects
  have no corresponding relational rows**, this runbook does **not**
  claim any automated reconstruction exists. `docs/tether-evidence-archive-plan.md`
  is explicit that relational-metadata reconstruction from archive
  manifests is **not implemented** — `restoreEvidenceAsset()` only
  restores bytes for a row that already exists; it never creates
  `IntegrityEvidenceAsset`/`IntegrityEvent`/`Submission`/`Exam` rows.
  **MANUAL INVESTIGATION / RECONCILIATION REQUIRED** in every such case.

## 27. Application recovery sequence

1. Identify the known-good commit (Section 11).
2. Inspect the actual diff between it and the current (bad) state.
3. Redeploy through the normal, controlled Git/Vercel path appropriate
   to the current Hobby plan (Section 12) — never a manual, undocumented
   change to Production.
4. Validate before reopening (Section 28/31).

## 28. Post-restore validation

Do not equate "the restore command completed" with "service recovered."
Required checks, scoped to what the specific recovery touched:

- database reachable;
- schema present (matches `prisma/schema.prisma` expectations at a
  structural level);
- critical rows/data present (spot-check, not exhaustive);
- authentication works;
- tenant/institution isolation works (no cross-institution data
  visible);
- exam content accessible;
- submission/answer data correctly associated with the right
  student/exam;
- integrity events readable;
- sample evidence metadata is internally consistent (Section 26);
- required evidence bytes are actually accessible for a sample of
  assets, not merely their metadata rows;
- application health/readiness endpoints pass;
- the known-good application version is actually the one active.

## 29. Privacy/retention reconciliation after restore

**This is important — a restore is not privacy-neutral.** A backup
restore may reintroduce evidence that had already reached retention
expiry, metadata for already-deleted evidence, old raw IP/network
evidence, old account records, or records affected by a currently-active
legal/academic hold.

**Therefore, after any database restore: do not immediately run broad
deletion.** Instead:

1. Establish the actual restored recovery point (the date/time the
   restored data reflects).
2. Compare it against retention/hold records
   (`docs/evidence-retention-operations-v1.md`'s retention register and
   any active holds under
   `docs/privacy-and-evidence-retention-v1.md` Section 19).
3. Identify data potentially resurrected by the restore (anything that
   should have already been deleted between the recovery point and now).
4. Preserve anything subject to an active incident, legal, or academic
   hold — never destroy it as part of "cleaning up" the restore.
5. Reconcile retention obligations deliberately, following the existing
   manual retention process — never an ad hoc, unreviewed deletion.
6. Document the corrective cleanup: what was resurrected, what was
   reviewed, what (if anything) was subsequently and deliberately
   removed following the normal retention process, and by whom.

Cross-reference: `docs/privacy-and-evidence-retention-v1.md`,
`docs/evidence-retention-operations-v1.md`,
`docs/australian-incident-ndb-procedure-v1.md`.

## 30. Incident/NDB coordination

If the disaster involved unauthorised access, unauthorised disclosure,
loss, or corruption of personal information with a plausible privacy
impact, this runbook's recovery process runs **alongside** — not instead
of — `docs/australian-incident-ndb-procedure-v1.md`. That procedure's
own Section 29 ("Privacy/retention implications") already establishes
this document is where the detailed privacy-recovery reconciliation
belongs; this runbook is that cross-referenced detail. Do not treat a
successful technical restore as closing out a privacy incident on its
own — the incident procedure's assessment (Sections 11–18 of that
document) is a separate, required track.

## 31. Service reopening criteria

Do not reopen service on "the restore completed" alone. Before
reopening, require, appropriate to the scenario:

- database reachable, schema present, critical rows/data present;
- authentication works, tenant/institution isolation works;
- exam content accessible, answer/submission data correctly associated;
- integrity events readable, sample evidence metadata consistent;
- required evidence bytes accessible for a representative sample;
- no obvious cross-student/cross-institution leakage;
- application health/readiness passes;
- the known-good application version is active;
- major recovery findings are documented (Restore Test Record or
  live-event equivalent);
- an incident/privacy assessment has been considered (Section 30), even
  if the conclusion is "not applicable";
- restore approval authority (Section 16) explicitly approves reopening.

**No automatic reopening.**

## 32. RPO / RTO framework

**RPO (Recovery Point Objective)** = the maximum targeted tolerable
data-loss window. **RTO (Recovery Time Objective)** = the target time to
restore service. **No numbers are committed in this pass.**

| Metric | Status |
|---|---|
| Database RPO | **NOT YET CONTRACTUALLY COMMITTED OR VERIFIED** |
| Database RTO | **NOT YET CONTRACTUALLY COMMITTED OR VERIFIED** |
| Evidence RPO | **NOT YET CONTRACTUALLY COMMITTED OR VERIFIED** |
| Full-service RTO | **NOT YET CONTRACTUALLY COMMITTED OR VERIFIED** |

Reason: there is no verified Production backup cadence yet (Section 8),
no end-to-end Production-equivalent DR exercise on record yet (Section
33), and the separate evidence archive is not yet provisioned (Section
9). Committing a number without evidence behind it would be exactly the
kind of invented guarantee this package must avoid.

Fields for future use, populated only after a real recovery exercise
produces evidence — **left blank in this pass**:

| Field | Value |
|---|---|
| Candidate pilot RPO (database) | |
| Measured test RPO (database) | |
| Candidate pilot RTO (database) | |
| Measured test RTO (database) | |
| Candidate pilot RPO (evidence) | |
| Measured test RPO (evidence) | |
| Candidate pilot RTO (full service) | |
| Measured test RTO (full service) | |
| Approved commitment | |
| Approval date | |

## 33. DR testing cadence framework

**PRE-PILOT GATE** — no cadence has been agreed as of this pass, since
no DR exercise (Section 37, `docs/dr-exercise-checklist-v1.md`) has been
run yet to inform what a realistic cadence looks like. A reasonable v1
starting point, to be confirmed once at least one exercise has actually
run: a tabletop exercise quarterly, and a disposable-infrastructure
restore/evidence-recovery rehearsal at least once before pilot and
periodically thereafter (frequency to be set after the first rehearsal
shows how long it actually takes).

## 34. Recovery evidence / records

Every DR exercise or real recovery event produces:

- one completed (or in-progress) `docs/restore-test-record-v1.md` copy;
- the completed `docs/dr-exercise-checklist-v1.md` used, with each step
  actually checked off, not filled in retroactively from memory;
- any `backup:verify --report` JSON output produced during the exercise,
  retained alongside the record (outside this repository, per Section
  11's "no secrets in DR records" — a verification report itself
  contains no secrets, but keep it with the record for traceability);
- for a real incident with privacy impact, the corresponding
  `docs/data-breach-assessment-record-v1.md`.

## 35. Failure scenarios

For each: **Trigger**, **Immediate action**, **Restore/recovery path**,
**Validation**, **Escalation**, **Known limitation**.

**1. Bad Vercel/application deployment**
- *Trigger:* a newly deployed version is broken (errors, wrong
  behaviour) but Vercel platform and the database are healthy.
- *Immediate action:* recovery lead confirms scope; consider stopping
  further traffic to the bad version if the current plan supports it.
- *Restore path:* Section 27 — known-good commit, inspect diff, redeploy
  via the controlled Git/Vercel path for the current Hobby plan.
- *Validation:* Section 28, scoped to application-layer checks.
- *Escalation:* recovery lead; privacy/incident review only if the bad
  deployment itself caused data exposure.
- *Known limitation:* Hobby-plan-specific rollback speed/mechanism not
  independently verified as of this pass.

**2. Vercel temporary outage**
- *Trigger:* Vercel platform itself is down or degraded.
- *Immediate action:* confirm via Vercel's own status channel; do not
  attempt to "fix" what is not a Tether-side problem.
- *Restore path:* Section 15 — track and communicate; no Tether action
  restores Vercel's own availability.
- *Validation:* application responds normally once Vercel confirms
  resolution.
- *Escalation:* recovery lead decides on any exam-window accommodation
  if the outage is prolonged.
- *Known limitation:* no Tether-controlled mitigation for this scenario
  exists or is being proposed here.

**3. Supabase database unavailable**
- *Trigger:* the Postgres database is unreachable (not corrupted —
  simply unavailable).
- *Immediate action:* confirm via Supabase's own status channel versus a
  Tether-side connectivity/credential issue.
- *Restore path:* if provider-side, track per Section 15; if
  Tether-side (e.g. credential issue), Section 13's configuration
  recovery register.
- *Validation:* Section 28 database checks.
- *Escalation:* recovery lead; privacy/incident review not applicable
  unless data was actually exposed or lost.
- *Known limitation:* no independent Tether-side failover database
  exists.

**4. Accidental database corruption**
- *Trigger:* a bad migration, bad manual query, or application bug
  corrupts data in place (not deleted, but wrong).
- *Immediate action:* Section 18 — consider stopping further writes to
  the affected tables if feasible; Section 19 — preserve the current
  (corrupted) state if a diagnostic export is safely obtainable.
- *Restore path:* Section 24, using the most recent verified backup
  predating the corruption (Section 20 — explicit recovery point).
- *Validation:* Section 28, with specific attention to the
  previously-corrupted data.
- *Escalation:* restore approval authority (Section 23); privacy/NDB
  review if the corruption affected personal information's integrity in
  a way relevant to that procedure.
- *Known limitation:* any writes between the backup's point-in-time and
  the corruption are lost on restore (Section 32 — RPO not yet
  committed).

**5. Accidental table/row deletion**
- *Trigger:* an operator or bug deletes rows that should not have been
  deleted (distinct from approved retention deletion, Section 20 of
  `docs/privacy-and-evidence-retention-v1.md`).
- *Immediate action:* Section 18/19 as above.
- *Restore path:* Section 24, using a backup predating the deletion —
  for a narrow, well-understood deletion, a targeted re-insert from the
  disposable-rehearsed backup may be more appropriate than a full
  Production restore; recovery lead decides and documents the reasoning.
- *Validation:* Section 28, confirming the specific deleted data is
  correctly restored and nothing else regressed.
- *Escalation:* restore approval authority if a full restore is chosen.
- *Known limitation:* no row-level point-in-time recovery exists on the
  current Free plan.

**6. Complete Supabase project loss/deletion**
- *Trigger:* the entire Supabase project becomes unavailable or is
  deleted.
- *Immediate action:* Section 17 — declare a disaster; this is the most
  severe database-domain scenario.
- *Restore path:* requires the most recent verified backup (Section
  21/24) restored into a **new** Supabase project — this is the scenario
  that most starkly illustrates why the **PRE-PILOT BACKUP GATE**
  (Section 8/37) matters: without a verified, current backup, this
  scenario has no database recovery path at all today.
- *Validation:* Section 28, full scope.
- *Escalation:* restore approval authority; incident/NDB review very
  likely required (Section 30).
- *Known limitation:* as of this pass, **no verified Production backup
  exists to restore from** — this scenario is currently the clearest
  illustration of the PRE-PILOT BACKUP GATE's real consequence.

**7. Primary evidence-storage object missing**
- *Trigger:* an `IntegrityEvidenceAsset` row exists but its storage
  object is gone.
- *Immediate action:* confirm via a direct `get()` against the primary
  storage adapter, not just application-layer symptoms.
- *Restore path:* Section 25 — archive restore if an archive exists
  (not the case as of this pass); otherwise document as evidence loss
  for that asset.
- *Validation:* SHA-256 of any restored object matches the row's
  recorded `sha256`.
- *Escalation:* privacy/incident review if the missing object affects an
  active academic-integrity review.
- *Known limitation:* **no archive currently exists — this scenario is
  currently unrecoverable** for any asset not otherwise separately
  copied.

**8. Primary evidence-storage object corrupt**
- *Trigger:* the object exists but fails SHA-256 verification against
  the row's recorded hash.
- *Immediate action:* same as scenario 7 — confirm via direct
  verification.
- *Restore path:* Section 25 — this is the second of the two scenarios
  `restoreEvidenceAsset()` actually supports (once an archive exists);
  currently unrecoverable in practice for the same reason as scenario 7.
- *Validation:* SHA-256 match post-restore.
- *Escalation:* same as scenario 7.
- *Known limitation:* same as scenario 7.

**9. Evidence metadata exists but object missing**
- *Trigger:* identical framing to scenario 7 — included separately here
  because Section 10 treats "metadata vs. bytes" as the core conceptual
  distinction this whole domain rests on.
- *Immediate action / Restore path / Validation / Escalation:* as
  scenario 7.
- *Known limitation:* a metadata-only record has reduced evidentiary
  value and must be disclosed as such during any academic-integrity
  review that relies on it, not silently treated as complete evidence.

**10. Archive object exists but database metadata no longer exists after
a database rollback**
- *Trigger:* a database restore to an earlier point removes the row for
  an asset that was archived after that point.
- *Immediate action:* Section 26 — identify the orphaned archive
  object(s) via manifest comparison.
- *Restore path:* **manual investigation/reconciliation required** — no
  automated relational reconstruction exists (Section 9/26).
- *Validation:* N/A until a human decision is made about how to handle
  the orphan.
- *Escalation:* recovery lead plus privacy/retention reviewer.
- *Known limitation:* this is a structural gap in the current tooling,
  not an oversight in this runbook — `docs/tether-evidence-archive-plan.md`
  explicitly scopes reconstruction out of v1.

**11. Compromised database/service-role credential**
- *Trigger:* `DATABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` is suspected
  compromised.
- *Immediate action:* this is a security incident, not primarily a
  backup/DR event — invoke
  `docs/australian-incident-ndb-procedure-v1.md` immediately (its
  scenario B is exactly this case); rotate the credential per Section
  13's configuration recovery process alongside the incident process.
- *Restore path:* credential rotation, not a data restore, unless the
  compromise also caused data loss/corruption, in which case the
  relevant scenario above additionally applies.
- *Validation:* confirm the old credential no longer grants access.
- *Escalation:* incident/NDB procedure is the primary track here; this
  runbook is secondary/supporting.
- *Known limitation:* none specific to this runbook — see the incident
  procedure's own known limitations.

**12. Lost or corrupted environment configuration**
- *Trigger:* Vercel project environment variables are lost, wrong, or
  corrupted.
- *Immediate action:* Section 13 — consult the Configuration Recovery
  Register for what needs restoring (names only).
- *Restore path:* re-enter each required variable from its actual
  authoritative source — **currently undocumented, PRE-PILOT
  OPERATIONAL DECISION** (Section 13/37).
- *Validation:* application boots and each dependent feature
  (auth, evidence storage, session binding, email) functions.
- *Escalation:* recovery lead; this scenario's severity depends entirely
  on whether the authoritative source-of-truth gate has been closed
  before it happens.
- *Known limitation:* **no authoritative secret-recovery source is
  currently documented** — this is the scenario the PRE-PILOT
  CONFIGURATION RECOVERY GATE exists to close before it can occur for
  real.

**13. GitHub/source repository unavailable**
- *Trigger:* GitHub itself is down, or the repository becomes
  inaccessible.
- *Immediate action:* confirm scope via GitHub's own status channel.
- *Restore path:* Section 15-style dependency-continuity handling — no
  Tether action restores GitHub's own availability; any local clones
  team members hold remain usable for inspection in the interim.
- *Validation:* repository access restored.
- *Escalation:* recovery lead only, unless prolonged enough to block an
  otherwise-necessary application recovery (Section 27), in which case
  escalate accordingly.
- *Known limitation:* no alternative source-of-truth repository is
  maintained.

**14. Secure Browser installer unavailable**
- *Trigger:* the hosted `.exe` at `TETHER_INSTALLER_DOWNLOAD_URL` becomes
  unavailable.
- *Immediate action:* Section 14 — confirm whether a backup/operator
  copy exists.
- *Restore path:* re-host from the operator copy if one exists;
  otherwise, this is currently the PRE-PILOT RELEASE-ARTIFACT BACKUP GATE
  materialising in practice.
- *Validation:* re-hosted installer's SHA-256 matches the authoritative
  release record for whichever version is actually accepted (Section
  14's release-metadata reconciliation gate must be resolved first —
  there is currently no single authoritative version/hash to validate
  against).
- *Escalation:* recovery lead; product/release owner.
- *Known limitation:* no independently verified redundant hosting
  location is currently documented, and the authoritative
  version/hash itself is not yet reconciled across sources.

**15. Simultaneous database + evidence-storage recovery**
- *Trigger:* both domains are affected at once (e.g. the complete
  Supabase project loss of scenario 6, which takes both the database and
  the primary evidence bucket with it, since they are in the same
  project/failure domain).
- *Immediate action:* Section 17/18, at the highest urgency this runbook
  describes.
- *Restore path:* Sections 24 and 25 run in parallel where possible, but
  Section 26's reconciliation only makes sense once both are as
  recovered as they are going to be — do not attempt reconciliation
  mid-recovery.
- *Validation:* Section 28, full scope, plus Section 26 reconciliation
  explicitly before reopening.
- *Escalation:* restore approval authority, privacy/retention reviewer,
  and incident/NDB liaison, all engaged.
- *Known limitation:* this scenario is the sharpest illustration of why
  Section 9's evidence-archive gate and Section 8's database-backup gate
  are both PRE-PILOT BLOCKERS, not independent nice-to-haves — today,
  the primary database and primary evidence bucket share one failure
  domain with no independent backup for either.

**16. Restore resurrects information that should already have been
deleted under retention policy**
- *Trigger:* the backup being restored predates an approved retention
  deletion that has since occurred.
- *Immediate action:* Section 29 — do **not** run broad deletion
  immediately after restore.
- *Restore path:* Section 29's full reconciliation sequence.
- *Validation:* resurrected records are identified, reviewed, and
  handled through the normal retention process, not an ad hoc sweep.
- *Escalation:* privacy/retention reviewer.
- *Known limitation:* the existing retention runner has no
  restore-awareness of its own — this reconciliation is entirely a
  manual process today.

**17. Restore intersects with an active academic/legal/privacy hold**
- *Trigger:* the restored data includes records currently subject to an
  active hold (`docs/privacy-and-evidence-retention-v1.md` Section 19).
- *Immediate action:* Section 29, step 4 — preserve anything subject to
  an active hold; never let restore-driven cleanup override a hold.
- *Restore path:* the hold continues to apply to the restored records
  exactly as it applied before the disaster — a restore does not reset
  or clear a hold.
- *Validation:* confirm the held records are still correctly excluded
  from any subsequent retention action.
- *Escalation:* privacy/retention reviewer; whoever owns the underlying
  hold.
- *Known limitation:* no database-enforced hold mechanism exists (per
  the privacy package's own Section 19) — this is checked manually, same
  as in ordinary (non-DR) operation.

## 36. Known limitations

- No scheduled, verified Production database backup exists today
  (Section 8).
- No provisioned, tested evidence archive exists today (Section 9).
- No automated relational-metadata reconstruction from archive exists,
  or is planned for this pass (Section 26).
- No independently verified Vercel Hobby-plan rollback capability is
  assumed (Section 12).
- No documented authoritative configuration/secret recovery source
  exists (Section 13).
- No independently verified redundant Secure Browser installer hosting
  location exists, and the authoritative release version/hash itself is
  not reconciled — the native source (v1.7.6), distribution metadata
  (v1.7.4), and release-management documentation (v1.7.2) currently
  identify three different versions as current (Section 14).
- No RPO/RTO numbers are committed (Section 32).
- No DR exercise has been run against this runbook as of this pass
  (Section 33/37).

## 37. Pre-pilot recovery gates

Writing this documentation does **not** close any of these gates —
each requires an actual action, verified and recorded, before it can be
marked complete:

1. **PRE-PILOT BACKUP GATE** — the backup-creation *tooling* now exists
   and is locally verified (`npm run backup:create`,
   `docs/database-backup-operations-v1.md`), but the gate itself
   requires an actual, authorised Production backup to be created,
   copied off-project, verified, and restore-tested (Section 8).
2. **PRE-PILOT OFF-PROJECT COPY GATE** — ensure the critical database
   backup does not depend solely on the same primary-project failure
   domain it is meant to protect against; no destination has been
   selected or tested (`docs/database-backup-operations-v1.md`).
3. **PRE-PILOT EVIDENCE ARCHIVE GATE** — provision the approved separate
   evidence-archive location; archive representative evidence; test one
   verified restore (Section 9/25).
4. **PRE-PILOT RESTORE TEST GATE** — produce an authorised database
   backup/export, verify it, restore it into non-production/disposable
   infrastructure, and complete a
   [`docs/restore-test-record-v1.md`](restore-test-record-v1.md).
5. **PRE-PILOT RPO/RTO DECISION GATE** — set candidate targets only
   after a measured recovery test provides evidence (Section 32).
6. **PRE-PILOT CONFIGURATION RECOVERY GATE** — establish the
   authoritative secret/config recovery source of truth (Section 13).
7. **PRE-PILOT SECURE-BROWSER RELEASE-METADATA RECONCILIATION GATE** —
   establish one authoritative version/hash/artifact record for the
   accepted Secure Browser release, reconciling the native source
   (currently v1.7.6), distribution metadata (currently v1.7.4), and
   release-management documentation (currently v1.7.2), which today
   identify three different versions (Section 14).
8. **PRE-PILOT RELEASE ARTIFACT GATE** — once the version above is
   reconciled, ensure the accepted installer, its correct hash, and
   release metadata have a genuinely recoverable source (Section 14).
9. **PRE-PILOT DR TABLETOP GATE** — run at least one full DR tabletop
   exercise using [`docs/dr-exercise-checklist-v1.md`](dr-exercise-checklist-v1.md).

## 38. Version control

| Version | Date | Change |
|---|---|---|
| v1 | 2026-08-23 | Initial package: this document, `docs/restore-test-record-v1.md`, `docs/dr-exercise-checklist-v1.md`, and small cross-linking updates to `docs/production-backup-restore-runbook.md`, `docs/privacy-and-evidence-retention-v1.md`, and `docs/australian-incident-ndb-procedure-v1.md` (`compliance/backup-disaster-recovery-v1` branch). No schema, migration, or application-behaviour change. No Production contact, restore, or evidence deletion performed. No cloud resource created. |
| v1.1 | 2026-08-23 | Corrected Section 5/14's Secure Browser characterisation from a single hash discrepancy to a three-source version-reconciliation gap (`compliance/backup-disaster-recovery-v1` branch, later merged). |
| v1.2 | 2026-08-23 | Section 5 (matrix row C), Section 8, and Section 37 (gates 1–2) updated: database backup **creation** tooling (`npm run backup:create`, `npm run backup:verify-bundle`) now exists and is locally verified — see `docs/database-backup-operations-v1.md`. The PRE-PILOT BACKUP GATE and PRE-PILOT OFF-PROJECT COPY GATE remain explicitly OPEN; only the tooling portion is closed (`operations/production-database-backup-v1` branch). No schema, migration, or application-behaviour change. No Production contact or Production backup performed. |
