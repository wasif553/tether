# Production Environment Configuration Register (v1)

Enumerates every environment variable this codebase reads, by name and
purpose only. **No secret values appear in this document, ever.** Backed
by the presence-only, never-return-a-value checks in
`src/lib/env/readiness.ts` (`GET /api/readiness` exposes the safe boolean
form of the checks marked below).

## Classification legend

- **REQUIRED** — the standalone app (web platform + Secure Exam Mode,
  without Canvas/LTI or Tether) will not function correctly without this.
- **OPTIONAL** — enables a specific, non-core capability. Its absence
  degrades gracefully (the capability is unavailable, nothing else
  breaks) — see each entry for the specific fail-safe behavior.
- **DEVELOPMENT ONLY** — must never be set to an enabling value in
  Production. See "Dangerous combinations" below for which of these are
  now actively detected.
- **DEPRECATED** — no longer read by any code path; safe to remove from
  a deployment's configuration once confirmed unused elsewhere.

## Core / required

| Variable | Purpose | Classification |
|---|---|---|
| `DATABASE_URL` | Postgres connection string (Prisma) | REQUIRED |
| `AUTH_SECRET` | NextAuth session signing secret | REQUIRED |
| `APP_URL` | Public base URL of the deployment (canonical-origin validation, absolute links) | REQUIRED |
| `NEXT_PUBLIC_APP_URL` | Client-exposed counterpart of `APP_URL` (Next.js `NEXT_PUBLIC_*` convention — bundled into client JS, never a place for a secret) | REQUIRED |
| `DATABASE_POOL_MAX` | Prisma connection pool size override | OPTIONAL — safe default applied if unset (`src/lib/prisma.ts`) |

## Secure Exam Mode / integrity signal secrets

| Variable | Purpose | Classification |
|---|---|---|
| `EXAM_BINDING_HMAC_SECRET` | HMAC key for exam-session binding tokens (`src/lib/sessionBinding.ts`) | REQUIRED for Secure Exam Mode's session-binding integrity signal |
| `NETWORK_EVIDENCE_SALT` | Salt for hashed IP storage (`src/lib/networkEvidence.ts`) | REQUIRED for network evidence hashing to be non-reversible without a fixed/guessable salt |

## Tether secure-launch signing

| Variable | Purpose | Classification |
|---|---|---|
| `TETHER_SECURE_CLIENT_SIGNING_PRIVATE_KEY` | Ed25519 private key signing launch manifests/challenges | REQUIRED if this deployment supports Tether at all (see `docs/secure-launch-signing-key-runbook.md`) |
| `TETHER_SECURE_CLIENT_SIGNING_PUBLIC_KEY` | Matching public key, used for verification | REQUIRED alongside the private key — see "Dangerous combinations" |
| `TETHER_SECURE_CLIENT_SIGNING_KEY_ID` | Label embedded in issued manifests/challenges (defaults to `"dev-key-1"` if unset) | OPTIONAL, but see "Dangerous combinations" — setting this without the matching keys is a real misconfiguration |

## Tether release / distribution metadata

| Variable | Purpose | Classification |
|---|---|---|
| `TETHER_INSTALLER_DOWNLOAD_URL` | Real, published installer URL — absent means downloads stay disabled (`src/lib/tetherReleaseMetadata.ts`) | OPTIONAL — deliberately unset until a real installer is published |
| `TETHER_RELEASE_STATUS` | `INTERNAL` (default) / `PILOT` / `GENERAL_AVAILABILITY` | OPTIONAL, safe default |
| `TETHER_RELEASE_NOTES_URL` | Optional release-notes link | OPTIONAL |
| `TETHER_MINIMUM_SUPPORTED_VERSION` | Real, enforced minimum Tether client version (default `"1.5.0"`) | OPTIONAL, safe default — see `docs/tether-release-management.md` for when to change this |
| `TETHER_SUPPORT_CONTACT` | Deployment-wide support contact string (new this pass — `src/lib/institutionSupportContact.ts`) | OPTIONAL |

## Tether exam-session behavior

| Variable | Purpose | Classification |
|---|---|---|
| `TETHER_EXAM_ATTESTATION_MODE` | `LEGACY` (default/safe) / `DUAL` / `V2_REQUIRED` | OPTIONAL, safe default |
| `TETHER_MAX_ACTIVE_INSTALLATIONS_PER_USER` | Multi-device registration limit (default 2) | OPTIONAL, safe default |
| `TETHER_HEARTBEAT_INTERVAL_SECONDS` | Session heartbeat cadence | OPTIONAL, safe default |
| `TETHER_OFFLINE_CONTINUE_MINUTES` | How long a session stays trusted after contact goes stale | OPTIONAL, safe default |
| `TETHER_AUTOSAVE_RETRY_MAX_SECONDS` | Autosave retry bound | OPTIONAL, safe default |
| `TETHER_PENDING_SAVE_RETENTION_HOURS` | Pending-autosave retention window | OPTIONAL, safe default |
| `TETHER_SECURE_LAUNCH_CONSUME_TRANSACTION_TIMEOUT_MS` | Interactive-transaction timeout for manifest consume (see the P2028 fix) | OPTIONAL, safe default with min/max clamps |
| `TETHER_BLOCK_DEBUG_TOOLS` / `TETHER_BLOCK_REMOTE_CONTROL` / `TETHER_BLOCK_SCREEN_CAPTURE_TOOLS` / `TETHER_BLOCK_VIRTUAL_MACHINES` | Lockdown capability toggles | OPTIONAL, safe defaults |
| `TETHER_SEB_EXPERIMENTAL_ENABLED` | Gates the experimental Safe Exam Browser compatibility path | OPTIONAL — off by default |
| `TETHER_SEB_REQUIRED_ALLOWED_INSTITUTION_SLUGS` | Institution allow-list for the above | OPTIONAL |
| `TETHER_CLIENT_OPTIONAL_ENABLED` / `TETHER_CLIENT_REQUIRED_DISABLED` | Delivery-mode availability toggles | OPTIONAL, safe defaults |
| `TETHER_SYSTEM_CHECK_MODE` | `WARN` (default/safe) / stricter modes | OPTIONAL, safe default |
| `TETHER_SYSTEM_CHECK_VALIDITY_HOURS` | How long a stored system-check result stays valid (default 24h) | OPTIONAL, safe default |

## DEVELOPMENT ONLY — must never enable in Production

| Variable | Purpose | Now actively detected? |
|---|---|---|
| `TETHER_MOCK_SECURE_CLIENT_ENABLED` | Enables the non-cryptographic mock secure-client path (dev simulator) | **Yes** — `MOCK_SECURE_CLIENT_ENABLED_IN_PRODUCTION` (see below) |
| `TETHER_MOCK_CLIENT_ALLOWED_INSTITUTION_SLUGS` | Institution allow-list for the mock client | Covered indirectly — the mock client itself is gated by the flag above |
| `TETHER_SECURE_CLIENT_BYPASS_ENABLED` | Developer bypass for `TETHER_CLIENT_REQUIRED` exams | **Yes** — `SECURE_CLIENT_BYPASS_ENABLED_IN_PRODUCTION` (see below) |
| `TETHER_SECURE_CLIENT_BYPASS_ALLOWED_INSTITUTION_SLUGS` | Institution allow-list for the above | Covered indirectly |
| `TETHER_DIAGNOSTIC_LOGGING_ENABLED` | Verbose launch-pipeline tracing | Not separately detected here — already structurally impossible in production regardless of this flag's value, since `isServerTetherDiagnosticLoggingEnabled` hardcodes `deploymentEnvironment() !== "production"` as a precondition (`src/lib/tetherDiagnosticLog.ts`) |
| `VITEST` | Set by the Vitest runner itself | N/A — never set manually |
| `RELEASE_VALIDATE_FORCE_FAIL_AT` | Internal test-only escape hatch for `release-validate.ts`'s own cleanup-on-failure test | N/A — undocumented on purpose (see that script's own comment); never set outside a deliberate test of the validator itself |

## Optional integrations (Canvas/LTI)

| Variable | Purpose | Classification |
|---|---|---|
| `LTI_PRIVATE_KEY` / `LTI_PRIVATE_KEY_B64` / `LTI_PRIVATE_KEY_PATH` | LTI 1.3 signing private key (any one of the three forms) | OPTIONAL |
| `LTI_PUBLIC_KEY` / `LTI_PUBLIC_KEY_B64` / `LTI_PUBLIC_KEY_PATH` | Matching public key | OPTIONAL |
| `LTI_CLIENT_ID` | Canvas Developer Key client ID | OPTIONAL |
| `LTI_DEPLOYMENT_ID` | Canvas deployment ID | OPTIONAL |
| `LTI_PLATFORM_ISSUER` | Canvas platform issuer | OPTIONAL |
| `LTI_PLATFORM_OIDC_AUTH` | Canvas OIDC authorize URL | OPTIONAL |
| `LTI_PLATFORM_JWKS` | Canvas JWKS URL | OPTIONAL |
| `LTI_TOKEN_ENDPOINT` | Canvas AGS token endpoint | OPTIONAL |
| `LTI_TOOL_NAME` / `LTI_TOOL_DESCRIPTION` | Cosmetic tool registration metadata | OPTIONAL |

**Confirmed:** a missing/incomplete LTI configuration never marks
standalone Tether (or the rest of the platform) unavailable —
`GET /api/readiness` reports `ltiKeysConfigured` as an independent
boolean, never combined into `secureLaunchSigningConfigured` or any other
Tether-specific field (see Part J below).

## Optional integrations (AI features)

| Variable | Purpose | Classification |
|---|---|---|
| `ANTHROPIC_API_KEY` | AI question generation / essay-marking assistance | OPTIONAL |

## Evidence storage

| Variable | Purpose | Classification |
|---|---|---|
| `EVIDENCE_STORAGE_PROVIDER` | `local_dev` (default outside production) / `supabase_storage` / `vercel_blob` (stub) / `s3` (stub) | REQUIRED (as `supabase_storage` or another real provider) in Production if camera/screen evidence capture is enabled — `local_dev` fails closed in production (`src/lib/evidenceStorage.ts`) |
| `EVIDENCE_STORAGE_BUCKET` | Supabase Storage bucket name | REQUIRED alongside `EVIDENCE_STORAGE_PROVIDER=supabase_storage` |
| `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL (either form accepted) | REQUIRED alongside `EVIDENCE_STORAGE_PROVIDER=supabase_storage` |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only Supabase service-role key (bypasses bucket RLS — never exposed client-side) | REQUIRED alongside `EVIDENCE_STORAGE_PROVIDER=supabase_storage` |
| `EVIDENCE_RETENTION_DAYS` | Manual retention-runner window (default 90) | OPTIONAL, safe default — see `docs/tether-evidence-retention-plan.md` |

## Geolocation (network evidence)

| Variable | Purpose | Classification |
|---|---|---|
| `GEOLOCATION_PROVIDER` | Coarse-geolocation lookup provider | OPTIONAL |
| `GEOLOCATION_API_KEY` | Provider API key | OPTIONAL |
| `GEOLOCATION_TIMEOUT_MS` | Lookup timeout | OPTIONAL, safe default |

## Platform admin bootstrap

| Variable | Purpose | Classification |
|---|---|---|
| `PLATFORM_ADMIN_EMAIL` | Seed-time platform admin account email | DEVELOPMENT/SEED ONLY — used by `prisma/seed.ts`, not read by any production request path |
| `PLATFORM_ADMIN_PASSWORD` | Seed-time platform admin account password | DEVELOPMENT/SEED ONLY — same as above; never log or commit a real value even for local seeding |

## Build/deployment metadata (informational only)

| Variable | Purpose | Classification |
|---|---|---|
| `NODE_ENV` | Standard Node environment marker | REQUIRED (set automatically by the runtime/build tooling, not something an operator sets by hand) |
| `VERCEL_ENV` | `production` / `preview` / `development`, read by `deploymentEnvironment()` | Set automatically by Vercel — REQUIRED for correct environment detection when deployed there |
| `VERCEL_GIT_COMMIT_SHA` / `GIT_COMMIT_SHA` | Build commit SHA, surfaced by `GET /api/version` | OPTIONAL — informational only |
| `VERCEL_BUILD_TIMESTAMP` | Build timestamp, surfaced by `GET /api/version` | OPTIONAL — informational only |

## Dangerous combinations — now actively detected

`detectDangerousEnvCombinations()` (`src/lib/env/readiness.ts`), surfaced
via `GET /api/readiness`'s `dangerousEnvCombinations` field (bounded
reason codes + severity, never a raw value):

| Code | Severity | Detected when |
|---|---|---|
| `PRODUCTION_ORIGIN_MISSING` | HIGH | `deploymentEnvironment() === "production"` and `APP_URL` is unset |
| `SIGNING_KEY_ID_WITHOUT_MATCHING_KEYS` | HIGH | `TETHER_SECURE_CLIENT_SIGNING_KEY_ID` is set but the private and/or public key is missing (any environment) |
| `MOCK_SECURE_CLIENT_ENABLED_IN_PRODUCTION` | HIGH | `TETHER_MOCK_SECURE_CLIENT_ENABLED=true` in production |
| `SECURE_CLIENT_BYPASS_ENABLED_IN_PRODUCTION` | HIGH | `TETHER_SECURE_CLIENT_BYPASS_ENABLED=true` in production |

Two combinations named in this audit's original request are **not**
separately detected here because they are already structurally
impossible by construction (verified by existing tests), not merely
unlikely:

- **"Download enabled without URL"** — `resolveTetherReleaseMetadata()`'s
  `downloadsEnabled` field is derived as `installerUrl != null`; there is
  no code path producing `downloadsEnabled: true` with a null URL.
- **"Update required with unavailable download"** —
  `resolveTetherCompatibilityState()` never returns `UPDATE_REQUIRED`
  unless `downloadsEnabled` is true (see its own doc comment and the
  dedicated property-style test in `tetherReleaseMetadata.test.ts`).

## Deprecated

None found. Every environment variable referenced in the codebase (via
`process.env.*` or a typed `env.*` parameter) as of this audit maps to a
live code path — see `src/lib/env/readiness.test.ts` and this document's
own enumeration for how it was compiled (a full-repo grep for
`process\.env\.[A-Z_]+` and `\benv\.[A-Z_]+`, cross-referenced against
each usage site).
