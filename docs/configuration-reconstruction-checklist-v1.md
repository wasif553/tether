# Configuration Reconstruction Checklist v1

**Scenario:** a clean replacement deployment must be reconstructed after
the original operator laptop and Vercel project configuration are
unavailable. See
[`docs/configuration-and-secrets-recovery-v1.md`](configuration-and-secrets-recovery-v1.md)
for the full concepts (runtime source vs recovery method vs
authoritative recovery source) this checklist operationalises, and the
canonical register (`scripts/configurationRecovery/register.ts`) for
every variable's own recovery class.

**Do NOT execute any step of this checklist against Production in a
rehearsal.** Use a fresh, disposable Vercel project (or a tabletop
walk-through) unless this is a real, declared recovery event under
`docs/backup-and-disaster-recovery-runbook-v1.md`'s own approval
boundary (Section 23).

**No secret VALUE is ever written into this checklist or its
corresponding Configuration Recovery Test Record** — names and
locations only.

---

## A. Preparation

- [ ] Exercise/Test ID assigned, matching the
      `docs/configuration-recovery-test-record-v1.md` copy used
      alongside this checklist.
- [ ] Authorised platform owner/operator identified for this exercise.
- [ ] Confirmed this is a rehearsal (disposable target) — or, for a real
      event only, that the runbook's disaster-declaration step has been
      followed.

## B. Identify the approved Git commit

- [ ] The exact commit/tag to deploy from is identified and recorded.
- [ ] Confirmed the application code itself is not lost — it lives in
      Git (`docs/backup-and-disaster-recovery-runbook-v1.md` Section
      11), separate from this configuration-recovery concern entirely.

## C. Create/reconnect the deployment target

- [ ] New Vercel project created (or existing one reconnected), pointed
      at the identified commit/branch.
- [ ] Framework/build settings configured (Next.js defaults apply per
      `docs/deployment-vercel-supabase.md`).

## D. Recover NON-SECRET configuration

*(RECONSTRUCT_CONFIGURATION / PROVIDER_LOOKUP items — see the
register.)*

- [ ] `APP_URL` set to the new deployment's own HTTPS domain.
- [ ] Every `TETHER_*` tuning variable either left at its safe default
      or explicitly set per prior institutional decisions (record which,
      never invent new values silently).
- [ ] `EVIDENCE_STORAGE_PROVIDER`/`EVIDENCE_STORAGE_BUCKET` set once the
      Supabase bucket (Section F) exists.

## E. Recover or reissue required SECRETS

*(PRESERVE_EXACT_VALUE / ROTATE_OR_REISSUE items — see the register and
`docs/configuration-and-secrets-recovery-v1.md` Section 6 for the
loss-vs-compromise distinction.)*

- [ ] `AUTH_SECRET` — reissued (accepting all active sessions are
      invalidated) unless the exact old value is genuinely recoverable
      from an approved authoritative source.
- [ ] `EXAM_BINDING_HMAC_SECRET` / `NETWORK_EVIDENCE_SALT` — **the exact
      old value recovered if at all possible** (PRESERVE_EXACT_VALUE —
      rotating these breaks historical evidence comparability). If
      genuinely unrecoverable, this is recorded as a real, honest
      data-continuity loss, not silently reissued as if equivalent.
- [ ] `TETHER_SEB_KEY_ENCRYPTION_KEYS_JSON` / `_ACTIVE_KEY_ID` — **every
      retired key id preserved** if any existing SEB key material must
      remain decryptable.
- [ ] `TETHER_SECURE_CLIENT_SIGNING_PRIVATE_KEY` / `_PUBLIC_KEY` —
      reissued as a pair if the old pair is unrecoverable (accepting the
      documented in-flight-manifest disruption —
      `docs/secure-launch-signing-key-runbook.md`).
- [ ] `SUPABASE_SERVICE_ROLE_KEY` — recovered from the Supabase
      dashboard or regenerated (coordinated, since regenerating
      invalidates every deployment still holding the old value).

## F. Configure the database connection

- [ ] `DATABASE_URL` set to the Supabase project's own pooled connection
      string (port 6543) — see `docs/deployment-vercel-supabase.md`.
- [ ] Confirmed this step does NOT run `prisma db push`/migrate against
      Production without deliberate, explicit intent — this checklist
      is about configuration, not schema/data recovery (see
      `docs/backup-and-disaster-recovery-runbook-v1.md` for that).

## G. Configure evidence storage

- [ ] Supabase Storage bucket confirmed to exist (private, not public —
      see `docs/deployment-vercel-supabase.md`'s bucket-setup steps) if
      evidence capture will be enabled.
- [ ] `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
      `EVIDENCE_STORAGE_BUCKET` all set together — the adapter fails
      closed if any is missing.

## H. Configure authentication

- [ ] `AUTH_SECRET` set (see Section E).
- [ ] `APP_URL` set (see Section D) — required for correct cookie/origin
      behaviour.

## I. Configure optional integrations — only if actually enabled

*(Skip any of these the deployment does not use.)*

- [ ] Canvas/LTI: `LTI_CLIENT_ID`/`LTI_DEPLOYMENT_ID`/platform
      endpoints/signing keypair reconstructed per Section 13 of the main
      recovery document — re-registered with Canvas afterward.
- [ ] AI: `ANTHROPIC_API_KEY` reissued from the Anthropic Console.
- [ ] Password reset: `RESEND_API_KEY` + `PASSWORD_RESET_FROM_EMAIL` set
      together (both required, or neither takes effect).
- [ ] Geolocation: left at the safe default (`GEOLOCATION_PROVIDER=none`)
      unless an institutional privacy-review decision to enable it has
      already been made and documented — never enabled by default during
      a reconstruction.

## J. Validate Preview/Production separation

- [ ] `VERCEL_ENV` resolves correctly for this deployment (Vercel sets
      this automatically — never set by hand).
- [ ] `GET /api/readiness`'s `dangerousEnvCombinations` field is empty —
      specifically confirm none of `PRODUCTION_ORIGIN_MISSING`,
      `SIGNING_KEY_ID_WITHOUT_MATCHING_KEYS`,
      `MOCK_SECURE_CLIENT_ENABLED_IN_PRODUCTION`,
      `SECURE_CLIENT_BYPASS_ENABLED_IN_PRODUCTION` are present.
- [ ] Every dev/bypass flag (`TETHER_SECURE_CLIENT_BYPASS_ENABLED`,
      `TETHER_MOCK_SECURE_CLIENT_ENABLED`,
      `TETHER_DIAGNOSTIC_LOGGING_ENABLED`) is at its safe/off default for
      a Production target.

## K. Validate server-only secrets are not exposed as NEXT_PUBLIC_*

- [ ] Confirmed no SECRET-classified register entry (`SUPABASE_SERVICE_ROLE_KEY`,
      `AUTH_SECRET`, `TETHER_SECURE_CLIENT_SIGNING_PRIVATE_KEY`,
      `TETHER_SEB_KEY_ENCRYPTION_KEYS_JSON`, `ANTHROPIC_API_KEY`,
      `RESEND_API_KEY`, `EXAM_BINDING_HMAC_SECRET`,
      `NETWORK_EVIDENCE_SALT`, LTI private key, `GEOLOCATION_API_KEY`) was
      ever set with a `NEXT_PUBLIC_` prefix in the new deployment's
      environment variables. (`register.test.ts`'s own
      `[18]` test locks this at the register-definition level; this step
      confirms the ACTUAL deployment's variable names match.)
- [ ] `npm run config:recovery-audit` run against the reconstructed
      repository checkout — `PASSED`.

## L. Verify critical application flows

- [ ] Application boots (readiness endpoint responds).
- [ ] Authentication (login) works.
- [ ] Institution isolation holds.
- [ ] Exam retrieval works.
- [ ] Submission retrieval works.
- [ ] If Canvas/LTI enabled: a test launch succeeds.
- [ ] If evidence capture enabled: a test capture round-trips.

## M. Verify backup tooling configuration — separately

- [ ] `BACKUP_SOURCE_DATABASE_URL` (or its `DATABASE_URL` fallback)
      confirmed distinct from the app's own runtime pool where
      applicable — see `docs/database-backup-operations-v1.md`.
- [ ] This step does NOT run `npm run backup:create -- --execute`
      against Production as part of this checklist — that is a separate,
      deliberate operator action under its own runbook.

## N. Verify logs do not expose credentials

- [ ] Spot-checked recent server logs (or a test request's logging
      output) for any accidental credential exposure — this codebase's
      existing redaction (`redactConnectionStrings`,
      `scripts/backupCreation/connectionRedaction.ts`, and the general
      convention of never logging a secret value) is expected to hold,
      but a reconstruction is a good moment to actually verify it, not
      just assume it.

## O. Record outcome

- [ ] Every applicable field of
      `docs/configuration-recovery-test-record-v1.md` completed.
- [ ] Result recorded: PASS / PARTIAL / FAIL, honestly — a skipped
      optional-integration step is recorded as "not applicable," never
      silently omitted as if it passed.
- [ ] Observed duration recorded (start/end timestamps) — never
      converted into a contractual RTO by this checklist alone.
