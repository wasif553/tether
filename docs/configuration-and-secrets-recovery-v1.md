# Configuration & Secrets Recovery v1

**This closes the DOCUMENTATION/TOOLING portion of the PRE-PILOT
CONFIGURATION RECOVERY GATE (`docs/backup-and-disaster-recovery-runbook-v1.md`,
Section 13/37) — it does NOT by itself close the gate.** The gate closes
only once a real, approved recovery source holds the recoverable secret
material and a real recovery has been tested against it — neither of
which this pass performs. See "Pre-pilot gates" at the end of this
document.

**No secret VALUE appears anywhere in this document, the canonical
register, or the audit tool's output.** Every reference below is to a
variable NAME, a category, or a status — never a value.

---

## 1. Purpose and scope

This document exists so that, if Tether's Production/Preview
configuration and secrets are lost (an operator laptop is destroyed, a
Vercel project's environment variables are wiped, a credential is
accidentally rotated with no record of the old value), there is a
consistent process to:

1. know exactly WHICH configuration items exist and what each one is
   for — the canonical register (Section 3);
2. know, for each one, HOW it would be reconstructed after loss — its
   recovery class (Section 4);
3. know WHERE the actual recoverable material is independently held —
   today, `AUTHORITATIVE RECOVERY SOURCE: NOT YET SELECTED` for every
   real secret (Section 3);
4. distinguish a genuine loss from a suspected compromise, since the
   correct response is different (Section 6);
5. reconstruct a clean deployment's configuration without reading the
   old one (Section 7, `docs/configuration-reconstruction-checklist-v1.md`);
6. record what was tested, honestly, including what was NOT tested
   (Section 20, `docs/configuration-recovery-test-record-v1.md`).

**Scope:** this covers the standalone Tether exam platform's own
configuration and secrets (Vercel environment variables, the values this
codebase reads via `process.env`). It does not cover an institution's
own Canvas/LMS configuration, and it does not change any application
behaviour — this is a process and tooling document.

**Deliberately left OPEN by this pass — not decided here:**

1. **Which encrypted secret-management/recovery vault or provider will
   become the authoritative recovery source** (Section 19 defines
   REQUIREMENTS for that future choice; it does not select a vendor).
2. **Which authorised people/roles will ultimately hold recovery
   access.** This document uses the role **"Authorised platform
   owner/operator"** wherever an owner must be referenced — a specific
   name/identity is a PRE-PILOT OPERATIONAL DECISION, not made here.
3. **A real Production configuration reconstruction exercise.** Only a
   local, synthetic exercise was performed in this pass (Section 12 of
   the accompanying implementation, recorded in Section 20 below) — see
   `CONFIGURATION_RECOVERY_SYNTHETIC_EXERCISE` for its result.

---

## 2. Three different concepts this document keeps separate

An earlier version of the Configuration Recovery Register
(`docs/backup-and-disaster-recovery-runbook-v1.md`, Section 13)
partially conflated these. Every entry in the canonical register
(Section 3) keeps them as three independent fields:

1. **Runtime source** — where the RUNNING service currently reads the
   value from TODAY. For almost every configuration item in this
   register, that is a Vercel project environment variable.
2. **Recovery method** — HOW the value/configuration would be
   reconstructed after loss (Section 4's recovery classes).
3. **Authoritative recovery source** — where the recoverable material is
   INDEPENDENTLY held, separate from the runtime. For every real secret
   in this register today, that is
   **`AUTHORITATIVE RECOVERY SOURCE: NOT YET SELECTED`**.

**A Vercel environment variable is a runtime source, never an
independent recovery source merely because it currently holds the
value** — if the Vercel project itself is lost, destroyed, or its
environment variables are wiped, that "recovery source" is gone too. It
protects against nothing.

**GitHub is never treated as a secret-value recovery source at all.**
Nothing in this repository's `.gitignore`-excluded `.env*` handling, nor
any doc in this package, claims otherwise — every sensitive entry in
`.env.example` is blank or an obviously-synthetic placeholder (verified
by `npm run config:recovery-audit` and by `register.test.ts`'s own
secret-leak tests).

---

## 3. Canonical register

`scripts/configurationRecovery/register.ts` is the machine-readable,
VALUE-FREE source of truth — built from actual `process.env.<NAME>` read
sites in this repository (cross-referenced against
`docs/production-environment-register.md`'s own independent
enumeration), never guessed from a plausible-sounding name. Each entry
records: name (+ known alias/fallback representations), category,
secret sensitivity, environment, runtime source, recovery class,
required/optional status, affected capability, loss impact, rotation
impact, a recovery dependency on another entry (if any), whether the
name is expected in `.env.example`, a source code/doc reference, and
the authoritative recovery source status.

**Categories:**

| Category | Meaning |
|---|---|
| `ACTIVE_PRODUCTION_RUNTIME` | Core-required — the standalone app does not function correctly without it. |
| `OPTIONAL_PRODUCTION_RUNTIME` | Enables a specific, non-core capability; absence degrades gracefully. |
| `OPERATOR_MAINTENANCE_ONLY` | Read only by a manually-run operator tool (a `scripts/` CLI or `prisma/seed.ts`) — never by the live request path. |
| `LOCAL_DEVELOPMENT_ONLY` | Must never be set to an enabling value in Production. |
| `PROVIDER_PLATFORM_SUPPLIED` | Set automatically by Vercel/Node — never something an operator sets by hand. |
| `FUTURE_NOT_PROVISIONED` | The architecture exists in code, but no real destination has been provisioned — see Section 15's evidence-archive note. |
| `DEPRECATED_DOCUMENTED_NOT_USED` | A name that appears in documentation but has no current `process.env.<NAME>` read site — kept in the register precisely so it is not silently reintroduced as if it were active. |

**Query the register directly** (never hand-copy it into another
document, which would immediately drift):

```ts
import { CONFIGURATION_RECOVERY_REGISTER, getConfigRecoveryEntry } from "../scripts/configurationRecovery/register";
```

---

## 4. Recovery classes

| Class | Meaning | When to use |
|---|---|---|
| `PRESERVE_EXACT_VALUE` | Value continuity matters — loss + replacement makes existing hashed/encrypted/signed historical data unusable or uncomparable. | `EXAM_BINDING_HMAC_SECRET`, `NETWORK_EVIDENCE_SALT`, `TETHER_SEB_KEY_ENCRYPTION_KEYS_JSON`. |
| `ROTATE_OR_REISSUE` | The provider/admin can issue a replacement; a documented, bounded rotation impact applies but no permanent historical-data loss. | `AUTH_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, the Tether/LTI signing keypairs. |
| `RECONSTRUCT_CONFIGURATION` | Non-secret configuration, rebuildable from documented source (a URL, a well-known default, a numeric setting). | `APP_URL`, most `TETHER_*` tuning variables. |
| `PROVIDER_LOOKUP` | An identifier/public value retrievable from the provider's own dashboard or the institution's own records. | `LTI_CLIENT_ID`, `EVIDENCE_STORAGE_BUCKET`, `SUPABASE_URL`. |
| `BOOTSTRAP_ONLY` | Used only for setup/seed — should not itself become a long-term retained secret. | `PLATFORM_ADMIN_PASSWORD`. |
| `FUTURE_NOT_PROVISIONED` | Architecture exists, capability is not active — not applicable to recover something that was never provisioned. | The `ARCHIVE_*` group. |

The question asked for every entry: **"If the original value is lost
and replaced, what historical functionality/data becomes unavailable or
inconsistent?"** — recorded accurately in each entry's `lossImpact`, not
guessed.

---

## 5. Secret handling rules

- **Never** write a secret value into a Git commit, a chat message, this
  repository's documentation, the Restore Test Record, the
  Configuration Recovery Test Record, or any exercise log — names and
  locations only.
- **Never** print a secret value from `npm run config:recovery-audit` —
  it is repository/static-analysis only and structurally cannot read a
  live deployment's values (see Section 3 of the accompanying
  implementation — it never calls `process.env` for a real deployment
  read).
- `.env.example` holds NAMES with blank or unquestionably-synthetic
  placeholder values only (`npm run config:recovery-audit` checks this).
- A rejected/malformed configuration value is refused before use — never
  silently accepted or logged "for debugging."

---

## 6. Loss vs suspected-compromise procedure

**These are different problems with different correct responses. Do not
default to "just restore the old value" for a suspected compromise.**

### Scenario A — configuration lost, not compromised

The objective may be to recover/preserve the EXACT value where
continuity requires it (a `PRESERVE_EXACT_VALUE` item):

1. Identify the item(s) via the canonical register.
2. Check whether the authoritative recovery source (Section 3) actually
   holds the value — today, it does not for any real secret (`NOT YET
   SELECTED`). If it doesn't, the exact value cannot be recovered — see
   whether a `ROTATE_OR_REISSUE` fallback is acceptable given the actual
   loss impact, or whether this becomes a genuine, documented data-loss
   event.
3. Reconstruct/reissue per the item's recovery class.
4. Validate (Section 20).
5. Record the exercise.

### Scenario B — credential may be compromised

**Do NOT blindly restore/reuse the old value.**

1. Revoke/rotate the credential where the provider supports it —
   immediately, accepting the documented rotation impact (Section 4).
2. Identify every system/feature the credential affects (the register's
   `affectedCapability` field).
3. Establish a new credential.
4. Update the runtime configuration safely — never by pasting the value
   into a chat, a ticket, or a commit.
5. Validate (Section 20).
6. Apply `docs/australian-incident-ndb-procedure-v1.md` if personal
   information or a security exposure may be involved — this document
   does not replace that one.
7. Preserve OLD encryption/decryption key material only where required
   for historical data (e.g. a retired
   `TETHER_SEB_KEY_ENCRYPTION_KEYS_JSON` entry) and only where safe —
   with explicit key-rotation handling (never delete a retired key id
   from that JSON map until nothing is encrypted under it any more).

---

## 7. Clean-environment reconstruction process

See `docs/configuration-reconstruction-checklist-v1.md` for the full
step-by-step checklist. Summary: identify the approved Git commit →
create/reconnect the deployment target → configure framework/build
settings → recover non-secret configuration (Section 4's
`RECONSTRUCT_CONFIGURATION`/`PROVIDER_LOOKUP` items) → recover or
reissue required secrets → configure the database connection → evidence
storage → authentication → optional integrations only if enabled →
validate Preview/Production separation (Section 17) → verify
server-only secrets are never exposed as `NEXT_PUBLIC_*` → verify
critical application flows → verify backup tooling configuration
separately (Section 15) → verify logs never expose a credential → record
the outcome (Section 20).

---

## 8. Credential rotation/reissue process

For a `ROTATE_OR_REISSUE` item: identify it in the register → confirm
whether this is Scenario A or B above → obtain the new value from the
provider's own console/dashboard (never invent one, never derive it from
the old value) → update the runtime configuration → redeploy where the
platform requires it for the new value to take effect (Vercel bakes
environment variables in at build time — see
`docs/deployment-vercel-supabase.md`'s troubleshooting section) →
validate → record the rotation (old identifier if any, new identifier,
reason, timestamp, who performed it) — this codebase does not emit an
automatic audit-log entry for most configuration rotations (the
exception is documented per-item in the register's `sourceReference`,
e.g. the secure-launch signing key's own dedicated runbook), so this
step is a manual/operational record, not an automated guarantee.

---

## 9. Key-preservation requirements

For every `PRESERVE_EXACT_VALUE` item: never remove a retired
representation until nothing depends on it any more.
`TETHER_SEB_KEY_ENCRYPTION_KEYS_JSON` is the clearest example — every
retired key id must remain in that JSON map until every SEB key ever
encrypted under it has itself been re-encrypted or deleted; removing an
id early permanently destroys access to whatever was encrypted under it.
`EXAM_BINDING_HMAC_SECRET` and `NETWORK_EVIDENCE_SALT` have no
"retired-value" concept (they're single scalars, not a keyed map) — for
these, the only preservation requirement is: do not rotate casually,
because there is no way to keep BOTH the old and new value simultaneously
verifiable the way the SEB keyring can.

---

## 10. Vercel reconstruction boundary

Vercel holds the RUNTIME values for every `VERCEL_ENVIRONMENT_VARIABLE`
entry in the register — but see Section 2: this is a runtime source, not
a recovery source. If the Vercel project itself is lost:

- The Vercel project can be recreated from this Git repository (the
  application code is not lost — it lives in Git, per
  `docs/backup-and-disaster-recovery-runbook-v1.md` Section 11).
- Every environment variable previously set in that project must be
  reconstructed per its own recovery class — Vercel does not export a
  lost project's own environment variables anywhere else; there is no
  "undo" for a deleted Vercel project's configuration.
- `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_GIT_COMMIT_SHA`,
  `VERCEL_BUILD_TIMESTAMP` are supplied automatically by the platform at
  build/runtime — never set these by hand, and they require no recovery
  action of their own.

## 11. Supabase reconstruction boundary

`DATABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` both originate from the
Supabase project's own dashboard. If the Supabase project itself is
lost, see `docs/backup-and-disaster-recovery-runbook-v1.md` (database
backup/restore) — this document covers only the CONNECTION
CONFIGURATION, not the data. A lost/forgotten database password can be
reset from the Supabase dashboard without affecting existing data (see
`docs/deployment-vercel-supabase.md`'s troubleshooting section); a lost
service-role key can be regenerated the same way, but every deployment
holding the OLD key loses Storage access the instant it's regenerated —
coordinate the update.

## 12. Resend / Anthropic / other optional-provider boundaries

`RESEND_API_KEY`, `ANTHROPIC_API_KEY`, `GEOLOCATION_API_KEY` are all
independent, provider-issued API keys with no cross-dependency on each
other or on any other secret in this register. Each can be reissued from
its own provider console independently; losing one never affects the
others, and the app degrades gracefully (a clear "not configured" error
for the specific feature) rather than failing entirely.

## 13. Canvas/LTI optional integration boundary

The LTI signing keypair (`LTI_PRIVATE_KEY_B64`/`LTI_PUBLIC_KEY_B64`, or
their `_PATH`/raw fallbacks) can be freshly regenerated and
re-registered with the institution's Canvas Developer Key — LTI JWTs are
short-lived, so no historical data depends on the exact old key value.
`LTI_CLIENT_ID`/`LTI_DEPLOYMENT_ID`/platform endpoint URLs are all
retrievable from the Canvas Developer Key configuration itself — this
tool never needs to "recover" them independently, only look them up
again.

## 14. Evidence-storage configuration boundary

`EVIDENCE_STORAGE_PROVIDER`/`EVIDENCE_STORAGE_BUCKET`/`SUPABASE_URL`/
`SUPABASE_SERVICE_ROLE_KEY` configure WHERE evidence frame bytes are
written — see Section 11 above for the Supabase-specific pieces. This is
a completely separate recovery domain from the DATABASE backup covered
by `docs/backup-and-disaster-recovery-runbook-v1.md` Sections 9–10 —
losing this configuration does not lose already-written evidence bytes
(those remain in the bucket, addressable once the configuration is
restored), but does mean capture cannot be enabled again until
reconfigured.

## 15. Backup operator configuration boundary

`BACKUP_SOURCE_DATABASE_URL` (falls back to `DATABASE_URL`) is read only
by `npm run backup:create` — never the running application. The
`ARCHIVE_*` group (evidence backup/archive) is `FUTURE_NOT_PROVISIONED`
— its architecture exists (`docs/tether-evidence-archive-plan.md`) but
no real archive Supabase project has been created, and this pass does
NOT add those variable names to `.env.example` merely because the
architecture exists (`npm run config:recovery-audit` actively fails if
that ever happens by mistake — see
`FUTURE_ITEM_PRESENT_IN_TEMPLATE`).

## 16. Secure Browser/secure-client cryptographic configuration

Covered in detail by `docs/secure-launch-signing-key-runbook.md`
(`TETHER_SECURE_CLIENT_SIGNING_PRIVATE_KEY`/`_PUBLIC_KEY`/`_KEY_ID`) and
`src/lib/secureClient/sebKeyEncryption.ts`'s own doc comment
(`TETHER_SEB_KEY_ENCRYPTION_KEYS_JSON`/`_ACTIVE_KEY_ID`) — this document
cross-links rather than duplicates either. The signing key's known
architectural gap (no overlapping-verification window during rotation —
see that runbook's "The gap" section) is unchanged by this pass.

## 17. Preview vs Production separation

`VERCEL_ENV` (never `NODE_ENV`, which is `"production"` for both Preview
and Production builds on Vercel) is the actual Production-detection
signal (`src/lib/secureClientAvailability.ts`'s `deploymentEnvironment()`).
A clean-environment reconstruction must set every Preview-only
dev/bypass flag (`TETHER_SECURE_CLIENT_BYPASS_ENABLED`,
`TETHER_MOCK_SECURE_CLIENT_ENABLED`, `TETHER_DIAGNOSTIC_LOGGING_ENABLED`)
to its safe default, and confirm — via `GET /api/readiness`'s
`dangerousEnvCombinations` field — that no dangerous combination
(`MOCK_SECURE_CLIENT_ENABLED_IN_PRODUCTION`,
`SECURE_CLIENT_BYPASS_ENABLED_IN_PRODUCTION`,
`PRODUCTION_ORIGIN_MISSING`, `SIGNING_KEY_ID_WITHOUT_MATCHING_KEYS`) is
present after reconstruction.

## 18. Authorised operator/access model

Use the role **"Authorised platform owner/operator"** wherever this
document, or a document it cross-links, needs to reference the person
who holds recovery access — a specific name/identity is a PRE-PILOT
OPERATIONAL DECISION, not made by this pass (see the top of this
document). No separate key-custody tier currently exists for any one
secret specifically (e.g. the secure-launch signing key is held by
"whoever holds deploy access to the production environment's secret
store" — see `docs/secure-launch-signing-key-runbook.md`).

## 19. Eventual recovery-vault requirements

**This document does not select a secret-management vendor.** It
defines REQUIREMENTS a future authoritative recovery source must meet
before it can close the PRE-PILOT CONFIGURATION RECOVERY GATE:

- **Encryption at rest.**
- **Strong account authentication/MFA** for anyone with access.
- **Secure secret sharing/access delegation** — not "one person's
  personal password manager with no organisational continuity."
- **Auditability** — who accessed/changed what, when.
- **A documented recovery/export procedure** — not merely "secrets go
  in," but a tested way to get them back OUT during a real recovery.
- **Support for multiline PEM/private-key material** (the Ed25519/RSA
  signing keys in this register are multiline PEM).
- **Support for structured JSON secret material**
  (`TETHER_SEB_KEY_ENCRYPTION_KEYS_JSON` is a JSON object, not a scalar).
- **Version/history where appropriate** — so a rotation doesn't
  permanently destroy the ability to see what the prior value's
  identifier/metadata was (never the value itself, once retired and
  confirmed unnecessary).
- **Emergency/break-glass recovery** — access must not depend on exactly
  one person's continued availability.
- **Separation from the application runtime's own failure domain** — the
  same principle already applied to the evidence archive (Section 15;
  `docs/tether-evidence-archive-plan.md`'s "Option A... shares the exact
  blast radius" rejection) applies here: a vault that lives inside the
  same Vercel/Supabase project it's meant to help recover is not an
  independent recovery source.

**Explicitly UNACCEPTABLE as the ONLY recovery source, regardless of
convenience:**

- This Git repository (or any Git repository).
- A plaintext file on an operator's laptop.
- The same laptop that holds the working repository checkout.
- The same Vercel project alone.
- A public OR private source-control commit of any kind.
- An email draft.
- A chat conversation (including this one).
- An unencrypted cloud-drive file.

## 20. Verification procedure

Use `docs/configuration-recovery-test-record-v1.md` (one copy per
exercise) alongside `docs/configuration-loss-dr-exercise-checklist-v1.md`
for a full exercise, or `docs/configuration-reconstruction-checklist-v1.md`
for a scoped clean-deployment build. At minimum: run
`npm run config:recovery-audit` (structural register/template
validation — never touches a real environment), confirm the register's
own secret-leak tests still pass (`scripts/configurationRecovery/register.test.ts`),
and record the result as PASS / PARTIAL / FAIL, honestly — never mark a
step PASS that wasn't actually exercised.

**Observed exercise duration may later inform an RTO figure — it is
never itself a contractual RTO.** (Same discipline as
`docs/backup-and-disaster-recovery-runbook-v1.md` Section 32's own RPO/RTO
framework.)

## 21. Known limitations

- **No authoritative recovery source is selected yet** — every real
  secret in the register is `NOT_YET_SELECTED`. This is the single
  largest open item this document does not close.
- **No real Production configuration reconstruction has ever been
  performed** — only the local synthetic exercise recorded in Section
  20/22 below.
- **The secure-launch signing key has no safe-rotation overlap window**
  (see `docs/secure-launch-signing-key-runbook.md`, "The gap") — a
  documented, unchanged limitation, not something this pass fixes.
- **The canonical register's `docs/production-environment-register.md`
  cross-check surfaces some informational false positives** — a handful
  of backticked identifiers in that document are enum values or
  detection-reason codes (e.g. `GENERAL_AVAILABILITY`, `V2_REQUIRED`,
  `MOCK_SECURE_CLIENT_ENABLED_IN_PRODUCTION`), not env var names — these
  show as `INFO`-severity findings from `npm run config:recovery-audit`,
  never `ERROR`, and are expected, not a defect.

## 22. Pre-pilot gates

**`DATABASE BACKUP CREATION TOOLING`** — out of scope for this document;
see `docs/database-backup-operations-v1.md`.

- **`CONFIGURATION RECOVERY INVENTORY/TOOLING: IMPLEMENTED`** — the
  canonical register, the audit tool, and this documentation package now
  exist.
- **`CONFIGURATION RECOVERY SYNTHETIC EXERCISE:`** — see
  `docs/backup-and-disaster-recovery-runbook-v1.md` Section 13 for the
  actual recorded `CONFIGURATION_RECOVERY_SYNTHETIC_EXERCISE` result
  from this pass.
- **`AUTHORITATIVE SECRET RECOVERY SOURCE: NOT YET SELECTED`**
- **`REAL PRODUCTION CONFIGURATION RECOVERY TEST: NOT YET EXECUTED`**
- **`PRE-PILOT CONFIGURATION RECOVERY GATE: OPEN`** — the framework now
  exists, but recoverable real secret material has not yet been escrowed
  in an approved independent recovery source and tested. Writing this
  documentation does not, by itself, close this gate.
