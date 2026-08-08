# Tether Institution Configuration Audit (v1)

Audit of whether existing institution/config structures can safely
represent common per-institution pilot settings. `Institution`
(`prisma/schema.prisma`) currently has only `id`, `name`, `slug`,
`domain`, `plan`, `active` — no settings/preferences columns of any kind.
This document classifies each candidate setting and implements only what
is genuinely safe to do without a schema change.

## Classification

| Setting | Classification | Notes |
|---|---|---|
| Support contact | **CAN BE ENV/CONFIG-BASED (implemented this pass)** | No per-institution field exists. A single, deployment-wide `TETHER_SUPPORT_CONTACT` env var now exists (`src/lib/institutionSupportContact.ts`) as a safe stopgap — genuinely PER-institution contact info still requires a schema change. |
| Tether release policy | **SUPPORTED TODAY (global only)** | `TETHER_RELEASE_STATUS` / `TETHER_INSTALLER_DOWNLOAD_URL` (`src/lib/tetherReleaseMetadata.ts`) already exist and work — but as ONE global policy for the whole deployment, not per-institution. A genuinely per-institution release policy (e.g. institution A pilots v1.7.2 while institution B stays on an older approved version) REQUIRES SCHEMA. |
| Evidence retention policy | **REQUIRES SCHEMA (for per-institution differentiation)** | The retention runner (`src/lib/evidenceRetentionRunner.ts`, `docs/tether-evidence-retention-plan.md`) already supports a single global `EVIDENCE_RETENTION_DAYS`. Different institutions legitimately needing different retention periods (e.g. differing local record-keeping requirements) would need a per-institution column — not implemented here, since faking this via env vars would be actively misleading (there is exactly one value, applied to every institution, regardless of how it's presented). |
| Default secure-exam settings | **REQUIRES SCHEMA (for per-institution differentiation); global default is CAN BE ENV/CONFIG-BASED but NOT implemented this pass** | `DEFAULT_SECURE_SETTINGS` (`src/lib/secureExam.ts`) is a single hardcoded, app-wide default applied to every new exam unless a lecturer overrides it. Making this env-configurable globally is technically possible without a schema change, but touches every new exam's default security posture — a genuinely per-institution version needs its own column. Deliberately NOT implemented in this pass: this default is security-relevant, and changing how it resolves — even to a config-driven value — is exactly the kind of low-value-but-security-adjacent change this task's own safety rules caution against making speculatively ("do not weaken authorization/security controls," and more broadly, do not touch security-relevant defaults without a specific, justified need). |
| Institution-specific student guidance (custom text) | **REQUIRES SCHEMA** | No field exists to store institution-authored text (e.g. "Contact the IT Help Desk at ext. 4400"). A global fallback string is possible via the same pattern as support contact above, but distinguishing "generic Tether guidance" from "this institution's own guidance" meaningfully requires a per-institution text field. Not implemented — the support-contact resolver above is the closest safe analog already covered. |

## What was implemented this pass

Only the support-contact resolver (`resolveInstitutionSupportContact()`
in `src/lib/institutionSupportContact.ts`), reading `TETHER_SUPPORT_CONTACT`
with a safe `null` fallback. This is deliberately the ONLY item promoted
from "audited" to "implemented" — every other candidate either already
has adequate global-only support (Tether release policy, evidence
retention) or would require either a schema change (institution-specific
differentiation) or touching a security-relevant default without a
concrete, justified need (secure-exam settings).

## What genuinely requires schema (deferred, not implemented)

A real "institution settings" feature — per-institution support contact,
Tether release policy, evidence retention days, default secure-exam
settings, and custom student guidance text — would need a new model, e.g.:

```
model InstitutionSettings {
  id                        String   @id @default(cuid())
  institutionId             String   @unique
  institution               Institution @relation(fields: [institutionId], references: [id])
  supportContact            String?
  tetherReleaseStatusOverride String?
  evidenceRetentionDays     Int?
  defaultSecureSettingsJson Json?
  studentGuidanceText       String?
  createdAt                 DateTime @default(now())
  updatedAt                 DateTime @updatedAt
}
```

This is a genuine, non-trivial schema addition — a new table, a new
relation, and (for `defaultSecureSettingsJson`/`tetherReleaseStatusOverride`)
new resolution logic that would need to correctly layer institution
overrides on top of the existing global env-var defaults without
silently changing behavior for institutions that never configure
anything. Per this task's own global safety rules, this STOPS here as a
documented, deferred item rather than being implemented speculatively.
