# Tether Attestation v2 — SQL Rollout Manifest

Authoritative, single-document inventory of **every** database object the
complete Tether System Check + Secure Client Attestation v2 feature
requires, across every commit on `feature/tether-system-check-readiness-v1`
since it diverged from `origin/main` — not merely the two files mentioned
in commit `5f285ec`. Produced by inspecting:

```bash
git diff --name-only origin/main...HEAD -- docs/sql
git log --name-status --oneline origin/main..HEAD -- docs/sql
git diff origin/main...HEAD -- prisma/schema.prisma
git diff -- prisma/schema.prisma   # uncommitted, this pass
```

**Scope note.** `git diff --name-only origin/main...HEAD -- docs/sql`
also returns `add-camera-stream-unavailable-integrity-event.sql` and
`add-camera-visibility-restored-integrity-event.sql`. Both were reviewed
and confirmed to belong to the unrelated on-device camera-integrity
feature (new `IntegrityEventType` string values only — no table, no
column touched by anything in this document) that also happens to live
on this same long-running branch. They are **out of scope** for this
manifest and are not part of the Tether attestation rollout.

**Confirmation: Preview and Production share ONE Supabase database** (see
`docs/migration-ledger.md`). Every file below must be applied exactly
once, manually, through the Supabase SQL Editor, against that single
shared database — there is no separate Preview database to rehearse
against first. **Do not run `prisma db push`, `prisma migrate dev`,
`prisma migrate deploy`, or `prisma migrate resolve` against it, ever.**
Nothing in this document was applied by the assistant that generated it.

---

## 1–2. File inventory and required execution order

| # | File | New table or ALTER | Idempotent |
| --- | --- | --- | --- |
| 1 | `docs/sql/add-tether-system-check-readiness.sql` | CREATE `TetherSystemCheckRun` | Yes |
| 2 | `docs/sql/add-tether-client-installation.sql` | CREATE `TetherClientInstallation` | Yes |
| 3 | `docs/sql/add-system-check-secure-client-verification.sql` | CREATE `SystemCheckSecureClientVerification` | Yes |
| 4 | `docs/sql/add-tether-installation-registration-challenge.sql` | CREATE `TetherInstallationRegistrationChallenge` | Yes |
| 5 | `docs/sql/add-secure-client-session-installation-attestation.sql` | ALTER `SecureClientSession` (pre-existing, already-live table) | Yes |

Apply in the numeric order above. File 5 has a **hard** dependency on
file 2 (its new foreign key references `TetherClientInstallation.id` —
the `ADD CONSTRAINT` step will fail with an undefined-table error if
file 2 has not been applied first). Files 1, 3, and 4 have no hard
foreign-key dependency on one another or on file 2 (every cross-table
reference among them — `SystemCheckSecureClientVerification.installationId`,
`TetherInstallationRegistrationChallenge.publicKeyFingerprint` — is an
**advisory pointer**, plain text, no `REFERENCES` clause), but applying
them in this order keeps the rollout narrative coherent and matches how
they were actually built. All five may safely be run back-to-back in one
Supabase SQL Editor session, or on separate days — none of them locks or
blocks on any of the others.

Every file is independently idempotent (`CREATE TABLE IF NOT EXISTS`,
`CREATE INDEX IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, and a
`DO $$ ... IF NOT EXISTS (SELECT 1 FROM pg_constraint ...)` guard around
every `ADD CONSTRAINT`) — re-running any file after a partial or full
success is safe and a no-op.

---

## 3. File-by-file detail

### 1. `add-tether-system-check-readiness.sql`

- **Creates:** `TetherSystemCheckRun` — one row per completed
  system-check run (`id`, `userId`, `overallStatus`, `sourceClientType`,
  `clientVersion`, `operatingSystem`, `operatingSystemVersion`,
  `secureClientSessionId` (advisory, no FK), `checkedAt`, `expiresAt`,
  `resultsJson` JSONB, `createdAt`, `updatedAt`).
- **Indexes:** `TetherSystemCheckRun_pkey` (PK on `id`),
  `TetherSystemCheckRun_userId_checkedAt_idx`,
  `TetherSystemCheckRun_userId_expiresAt_idx`,
  `TetherSystemCheckRun_secureClientSessionId_idx`.
- **Foreign keys:** `TetherSystemCheckRun_userId_fkey` → `User.id`,
  `ON DELETE CASCADE`.
- **Dependencies:** none (only references the pre-existing `User` table).
- **Pre-application verification:**
  ```sql
  SELECT to_regclass('public."TetherSystemCheckRun"') AS existing_table;
  -- Expected: NULL
  ```
- **Post-application verification:**
  ```sql
  SELECT to_regclass('public."TetherSystemCheckRun"') AS created_table;
  -- Expected: "TetherSystemCheckRun"
  SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='TetherSystemCheckRun' ORDER BY indexname;
  -- Expected: TetherSystemCheckRun_pkey, TetherSystemCheckRun_secureClientSessionId_idx,
  --           TetherSystemCheckRun_userId_checkedAt_idx, TetherSystemCheckRun_userId_expiresAt_idx
  SELECT conname FROM pg_constraint WHERE conname='TetherSystemCheckRun_userId_fkey'; -- Expected: 1 row
  SELECT count(*) FROM "public"."TetherSystemCheckRun"; -- Expected: 0
  ```
- **Compatibility before/after:** Before applying, every route under
  `src/app/api/tether/system-check/` that reads/writes this table 500s
  (table absent) — the student-facing page shows "could not be saved"
  but every OTHER check still displays locally; nothing else in the
  application is affected. After applying, those routes work normally.
  The web app may be deployed before or after this file with no
  ordering requirement either way.
- **Rollback:** Revert the web app deployment — nothing reads/writes
  this table once the code is gone. Dropping the table itself is a
  separate, manually-reviewed `DROP TABLE IF EXISTS` decision, never
  bundled with this file, and should not be done without a fresh backup
  check.

### 2. `add-tether-client-installation.sql`

- **Creates:** `TetherClientInstallation` — one row per registered
  per-installation keypair (`id`, `userId`, `institutionId`, `publicKey`,
  `publicKeyFingerprint`, `keyAlgorithm`, `keyProtectionLevel`,
  `clientVersion`, `platform`, `status`, `installedAt`, `lastAttestedAt`,
  `revokedAt`, `revocationReason`, `createdAt`, `updatedAt`).
- **Indexes:** `TetherClientInstallation_pkey`,
  `TetherClientInstallation_publicKeyFingerprint_key` (UNIQUE),
  `TetherClientInstallation_userId_publicKeyFingerprint_key` (UNIQUE),
  `TetherClientInstallation_userId_status_idx`.
- **Foreign keys:** `TetherClientInstallation_userId_fkey` → `User.id`,
  `ON DELETE CASCADE`.
- **Dependencies:** none (only references `User`). Required as a
  **prerequisite** for file 5 (`SecureClientSession.clientInstallationId`
  references this table's `id`).
- **Pre-application verification:**
  ```sql
  SELECT to_regclass('public."TetherClientInstallation"') AS existing_table;
  -- Expected: NULL
  ```
- **Post-application verification:**
  ```sql
  SELECT to_regclass('public."TetherClientInstallation"') AS created_table;
  -- Expected: "TetherClientInstallation"
  SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='TetherClientInstallation' ORDER BY indexname;
  -- Expected: TetherClientInstallation_pkey, TetherClientInstallation_publicKeyFingerprint_key,
  --           TetherClientInstallation_userId_publicKeyFingerprint_key, TetherClientInstallation_userId_status_idx
  SELECT conname FROM pg_constraint WHERE conname='TetherClientInstallation_userId_fkey'; -- Expected: 1 row
  SELECT count(*) FROM "public"."TetherClientInstallation"; -- Expected: 0
  SELECT count(*) FROM "public"."SecureClientSession"; -- provably untouched, compare before/after
  ```
- **Compatibility before/after:** Before applying, every installation
  registration/revocation/list route 500s; no student can register a
  device yet, but this has **zero effect** on the legacy exam-launch
  attestation flow — it is a completely separate, newer table. After
  applying, registration works.
- **Rollback:** Same pattern as file 1 — revert the deploy; table drop
  is a separate, manually-reviewed decision.

### 3. `add-system-check-secure-client-verification.sql`

- **Creates:** `SystemCheckSecureClientVerification` — one row per
  successful purpose-bound (`SYSTEM_CHECK` or `EXAM_SESSION`)
  challenge/verify round trip (`id`, `userId`, `institutionId`,
  `purpose`, `attestationProtocolVersion`, `installationId` (advisory,
  NOT a foreign key — see below), `clientType`, `verificationStatus`,
  `clientVersion`, `platform`, `displayTopologyClassification`,
  `nonceHash` UNIQUE, `challengeHash`, `issuedAt`, `expiresAt`,
  `verifiedAt`, `createdAt`, `updatedAt`).
- **Indexes:** `SystemCheckSecureClientVerification_pkey`,
  `SystemCheckSecureClientVerification_nonceHash_key` (UNIQUE — the
  replay-protection guard),
  `SystemCheckSecureClientVerification_userId_createdAt_idx`,
  `SystemCheckSecureClientVerification_expiresAt_idx`,
  `SystemCheckSecureClientVerification_installationId_idx`.
- **Foreign keys:** `SystemCheckSecureClientVerification_userId_fkey` →
  `User.id`, `ON DELETE CASCADE`. `installationId` is deliberately
  **advisory** (no `REFERENCES` clause) — mirrors the same
  no-hard-FK-for-cross-table-pointer convention already used elsewhere
  in this schema, so a later installation revocation/replacement never
  needs to touch historical verification rows.
- **Dependencies:** none enforced at the database level; logically
  follows file 2 (the installation this row's `installationId` points
  at should already exist by the time verifications are written, but
  nothing prevents applying this file first).
- **History note:** this file has been updated in place across FOUR
  commits (`eb2d33f` created it; `da00df8` added
  `displayTopologyClassification`; `a0be316` added the required
  `installationId` column; `5f285ec` added
  `attestationProtocolVersion`) rather than accumulating separate ALTER
  files, because **the table itself has never been applied to
  Preview/Production** — see "Application compatibility" below for why
  that made in-place edits safe.
- **Pre-application verification:**
  ```sql
  SELECT to_regclass('public."SystemCheckSecureClientVerification"') AS existing_table;
  -- Expected: NULL
  ```
- **Post-application verification:**
  ```sql
  SELECT to_regclass('public."SystemCheckSecureClientVerification"') AS created_table;
  -- Expected: "SystemCheckSecureClientVerification"
  SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='SystemCheckSecureClientVerification' ORDER BY indexname;
  -- Expected: SystemCheckSecureClientVerification_expiresAt_idx, SystemCheckSecureClientVerification_installationId_idx,
  --           SystemCheckSecureClientVerification_nonceHash_key, SystemCheckSecureClientVerification_pkey,
  --           SystemCheckSecureClientVerification_userId_createdAt_idx
  SELECT conname FROM pg_constraint WHERE conname='SystemCheckSecureClientVerification_userId_fkey'; -- Expected: 1 row
  SELECT count(*) FROM "public"."SystemCheckSecureClientVerification"; -- Expected: 0
  ```
- **Compatibility before/after:** Before applying, SYSTEM_CHECK and
  EXAM_SESSION challenge/verify routes 500. This is genuinely additive —
  nothing in the exam-launch/content-delivery path (`secureClientRunner.ts`,
  `POST /api/exams/[id]/start`, `GET /api/submissions/[id]`) reads this
  table at all (structural, not a runtime check — see
  `docs/tether-system-check-v1.md`, "Compatibility and rollout").
- **Rollback:** Same pattern as file 1.

### 4. `add-tether-installation-registration-challenge.sql` *(new this pass)*

- **Creates:** `TetherInstallationRegistrationChallenge` — records ONLY
  the atomic consumption of a registration challenge (`id`, `userId`,
  `publicKeyFingerprint`, `nonceHash` UNIQUE, `consumedAt`, `createdAt`).
  Deliberately minimal: no public key, no signature, no reusable token.
- **Indexes:** `TetherInstallationRegistrationChallenge_pkey`,
  `TetherInstallationRegistrationChallenge_nonceHash_key` (UNIQUE — the
  single-use guard), `TetherInstallationRegistrationChallenge_userId_createdAt_idx`.
- **Foreign keys:** `TetherInstallationRegistrationChallenge_userId_fkey`
  → `User.id`, `ON DELETE CASCADE`.
- **Dependencies:** none enforced (only references `User`); logically
  related to file 2 (this table's `publicKeyFingerprint` corresponds to
  a `TetherClientInstallation` row created in the SAME transaction that
  consumes the challenge — see `registerInstallation` in
  `tetherAttestationRunner.ts` — but there is no `REFERENCES` clause).
- **Pre-application verification:**
  ```sql
  SELECT to_regclass('public."TetherInstallationRegistrationChallenge"') AS existing_table;
  -- Expected: NULL
  ```
- **Post-application verification:**
  ```sql
  SELECT to_regclass('public."TetherInstallationRegistrationChallenge"') AS created_table;
  -- Expected: "TetherInstallationRegistrationChallenge"
  SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='TetherInstallationRegistrationChallenge' ORDER BY indexname;
  -- Expected: TetherInstallationRegistrationChallenge_nonceHash_key, TetherInstallationRegistrationChallenge_pkey,
  --           TetherInstallationRegistrationChallenge_userId_createdAt_idx
  SELECT conname FROM pg_constraint WHERE conname='TetherInstallationRegistrationChallenge_userId_fkey'; -- Expected: 1 row
  SELECT count(*) FROM "public"."TetherInstallationRegistrationChallenge"; -- Expected: 0
  SELECT count(*) FROM "public"."TetherClientInstallation"; -- provably untouched, compare before/after
  ```
- **Compatibility before/after:** Before applying, `registerInstallation`
  (`POST /api/tether/installation/register`) throws on the missing table
  — no installation can be registered, identical in effect to file 2 not
  yet being applied. **File 2 and file 4 should be applied together** in
  practice (registration cannot complete with only one of the two), even
  though neither enforces a hard FK on the other. After applying both,
  registration — including single-use challenge consumption — works.
- **Rollback:** Same pattern as file 1. Note that reverting the CODE
  without dropping this table is always safe (an unused additive table);
  reverting the code while KEEPING an already-applied file 5 (see below)
  would leave `SecureClientSession.attestationRequirement` writes/reads
  removed from the app but the column itself harmlessly idle — also
  safe.

### 5. `add-secure-client-session-installation-attestation.sql`

- **Alters:** the **pre-existing, already-live** `SecureClientSession`
  table (part of the original baseline schema — the only file in this
  manifest that is not a `CREATE TABLE`). Adds six additive,
  nullable-or-defaulted columns: `clientInstallationId` (TEXT, nullable —
  the real relation, see "Session model" in
  `docs/tether-system-check-v1.md`), `installationAttestationVerified`
  (BOOLEAN NOT NULL DEFAULT false), `installationAttestationVerifiedAt`
  (TIMESTAMP, nullable), `installationAttestationFailureReason` (TEXT,
  nullable), `installationVerificationId` (TEXT, nullable, advisory
  pointer), and `attestationRequirement` (TEXT, nullable — the
  pre-Preview-safety-pass immutable per-session snapshot; see
  "Immutable per-session attestation requirement" in
  `docs/tether-system-check-v1.md`).
- **Indexes:** `SecureClientSession_clientInstallationId_idx`.
- **Foreign keys:** `SecureClientSession_clientInstallationId_fkey` →
  `TetherClientInstallation.id`, `ON DELETE SET NULL ON UPDATE CASCADE`
  — the ONLY hard foreign-key dependency among all five files in this
  manifest.
- **Dependencies: HARD — must be applied AFTER file 2.** The
  `ADD CONSTRAINT ... FOREIGN KEY ... REFERENCES "TetherClientInstallation"("id")`
  step fails with a Postgres "relation does not exist" error if file 2
  has not already been applied.
- **Pre-application verification:**
  ```sql
  SELECT column_name FROM information_schema.columns
  WHERE table_schema='public' AND table_name='SecureClientSession'
    AND (column_name LIKE 'installation%' OR column_name IN ('clientInstallationId','attestationRequirement'))
  ORDER BY column_name;
  -- Expected: zero rows
  ```
- **Post-application verification:**
  ```sql
  SELECT column_name, data_type, column_default FROM information_schema.columns
  WHERE table_schema='public' AND table_name='SecureClientSession'
    AND column_name IN ('clientInstallationId','installationAttestationVerified',
      'installationAttestationVerifiedAt','installationAttestationFailureReason',
      'installationVerificationId','attestationRequirement')
  ORDER BY column_name;
  -- Expected: six rows
  SELECT count(*) FROM "public"."SecureClientSession" WHERE "attestationRequirement" IS NOT NULL; -- Expected: 0
  SELECT count(*) FROM "public"."SecureClientSession" WHERE "installationAttestationVerified" = true; -- Expected: 0
  SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='SecureClientSession'
    AND indexname='SecureClientSession_clientInstallationId_idx'; -- Expected: 1 row
  SELECT conname FROM pg_constraint WHERE conname='SecureClientSession_clientInstallationId_fkey'; -- Expected: 1 row
  SELECT count(*) FROM "public"."SecureClientSession"; -- provably unchanged row count, compare before/after
  SELECT count(*) FROM "public"."Submission"; -- provably untouched, compare before/after
  ```
- **Compatibility before/after — the highest-stakes file in this
  manifest, because it touches a table with real, live student data.**
  Before applying: the web app code that reads these six columns
  (`getOrCreateSessionCore` writing `attestationRequirement`,
  `verifyExamSessionAttestation` writing the five evidence columns,
  `resolveEffectiveTetherVerification` reading `attestationRequirement`
  via `parseAttestationRequirement`) would throw on any INSERT/UPDATE
  that references a column which doesn't exist yet — **this file MUST
  be applied before deploying the web app code that depends on it**,
  unlike files 1–4, which tolerate either deploy order. After applying:
  every EXISTING in-progress `SecureClientSession` row gets
  `attestationRequirement = NULL`, which every reader in the codebase
  (`parseAttestationRequirement`) treats as `"LEGACY"` — i.e. those
  sessions keep behaving exactly as they did before this column existed
  (`resolveEffectiveTetherVerification` under `LEGACY` reads only
  `verificationStatus`, unchanged). No existing student's access is
  retroactively altered.
- **Rollback:** Reverting the web app deployment is safe — the six
  columns become unused but harmless. If the columns themselves ever
  need to be dropped, that is a separate, manually-reviewed
  `ALTER TABLE ... DROP COLUMN` decision (never bundled with an ADD, and
  dropping `attestationRequirement` specifically should only be
  considered after confirming no session still relies on its stored
  snapshot) — not included in this file, and not something to run
  without a fresh backup check first.

---

## 9. Expected final schema state (summary)

| Table | Kind | Rows expected immediately after full rollout |
| --- | --- | --- |
| `TetherSystemCheckRun` | new | 0 |
| `TetherClientInstallation` | new | 0 |
| `SystemCheckSecureClientVerification` | new | 0 |
| `TetherInstallationRegistrationChallenge` | new | 0 |
| `SecureClientSession` | altered (6 new columns) | unchanged row count; every existing row has `attestationRequirement IS NULL` and `installationAttestationVerified = false` |

## 10. Prohibitions (repeated from every individual file, restated here for a single point of reference)

- Do **not** run `prisma db push`.
- Do **not** run `prisma migrate dev`.
- Do **not** run `prisma migrate deploy`.
- Do **not** run `prisma migrate resolve`.
- Apply every file **manually**, through the Supabase SQL Editor, after
  human review — never by an automated agent, never by this assistant.
- Preview and Production are **the same database** — there is no
  separate environment to "test" a migration against first. Treat every
  application as a Production change.

## 11. Rollback plan summary

Every file in this manifest is additive (new table, or new
nullable/defaulted columns on an existing table) — reverting the WEB APP
CODE deployment is always sufficient and always safe; none of these five
files needs to be reversed merely because a code deploy is rolled back.
Dropping a table or column is always a separate, manually-reviewed,
backup-checked decision, intentionally never bundled into any file here.

## 12. Emergency disable (no SQL rollback needed)

- `TETHER_EXAM_ATTESTATION_MODE=LEGACY` (or unset) — the safe default;
  immediately reverts every session's effective-verification decision to
  the legacy `recordAttestation()` flow alone.
- `TETHER_SYSTEM_CHECK_MODE=OFF` — immediately stops the system-check
  feature from blocking anything.
- Neither requires a code deploy or any SQL change.
