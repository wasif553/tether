# Tether Broad-Rollout Readiness Register (v1)

Distinct from `docs/tether-v1.7.2-pilot-release-readiness.md` (the P0
gate for STARTING a controlled pilot). This register tracks what's
needed to go from a successful controlled pilot to **broad commercial
rollout** (`GENERAL_AVAILABILITY` per `docs/tether-release-management.md`).

**Column definitions:** *Commercial blocker* — `CONTROLLED PILOT BLOCKER`
(already gates pilot start, tracked in the pilot readiness register, not
duplicated in detail here), `BROAD COMMERCIAL BLOCKER` (must be resolved
before `GENERAL_AVAILABILITY`), or `LATER IMPROVEMENT` (valuable, not a
hard gate).

| Requirement | Status | Evidence | Remaining work | Severity | Commercial blocker | Owner/action |
|---|---|---|---|---|---|---|
| Physical Windows acceptance | NOT COMPLETE | 12-test checklist in `docs/tether-v1.7.2-pilot-release-readiness.md`, all `NOT TESTED` | Run the 12 physical tests on real Windows hardware | High | CONTROLLED PILOT BLOCKER | Operator, in person |
| Pilot results (real cohort outcomes) | NOT STARTED | N/A — pilot hasn't run yet | Complete a full pilot exam cycle with real students; record incident rate, support-case volume, unresolved defects | High | BROAD COMMERCIAL BLOCKER | Institution + operator, after pilot start |
| Windows code signing | NOT DONE | `docs/tether-windows-code-signing-plan.md` — planning complete, no certificate purchased | Purchase certificate (EV preferred), solve the winCodeSign build-host extraction blocker, wire signing into CI | Medium (pilot), High (broad rollout) | BROAD COMMERCIAL BLOCKER | Institution (budget decision) + release engineer |
| Installer publication | NOT DONE | `TETHER_INSTALLER_DOWNLOAD_URL` unset; distribution UX is implementation-ready (`docs/tether-release-management.md`) | Publish the (ideally signed) installer somewhere `TETHER_INSTALLER_DOWNLOAD_URL` can point to | High | CONTROLLED PILOT BLOCKER (needed before pilot students can self-install) | Operator |
| Minimum-version policy | SAFE DEFAULT IN PLACE | `minimumSupportedTetherVersion()` = 1.5.0; structurally cannot trap a student (`resolveTetherCompatibilityState`'s invariant) | Raise once v1.7.2 (or later) is genuinely published and physically accepted | Low | LATER IMPROVEMENT | Release owner, per `docs/tether-release-management.md` |
| Evidence retention activation | MANUAL TOOL EXISTS, NOT SCHEDULED | `npm run evidence:retention` (`docs/tether-evidence-retention-plan.md`) — dry-run by default, manual `--execute` only | Institutional decision on retention period; deliberate decision on whether/how to schedule it (this pass does not add a scheduler) | Medium | BROAD COMMERCIAL BLOCKER (an institution running exams at scale needs an actual retention policy, not just a manual tool) | Institution (policy) + engineer (scheduling mechanism, if approved) |
| Backup automation/verification | VERIFICATION TOOL EXISTS, CREATION NOT AUTOMATED | `npm run backup:verify` (`docs/production-backup-restore-runbook.md`) verifies a dump that already exists; nothing in this repo creates backups on a schedule | Confirm Supabase's own backup schedule/retention meets institutional requirements; run `backup:verify` against a real Production backup at least once | Medium | BROAD COMMERCIAL BLOCKER | Operator (Supabase config) |
| Operational alerting | RECOMMENDATIONS DOCUMENTED, NOT WIRED UP | `docs/tether-production-observability.md`'s 9 recommended alerts; underlying data now exists (`GET /api/platform/operational-health`) | Wire recommendations into a real alerting channel once one is chosen | Medium | BROAD COMMERCIAL BLOCKER | Operator (tooling choice + budget) |
| Regional alignment (Vercel/Supabase) | DOCUMENTED, NOT RESOLVED | `docs/tether-production-observability.md`, "Region follow-up" — `iad1` ↔ `AP-Northeast` cross-Pacific latency, mitigated (not eliminated) by the P2028 transaction-scope fix | Revisit once real usage data shows where the student/lecturer population is concentrated | Medium | LATER IMPROVEMENT (acceptable at pilot scale per the P2028 fix's margin) | Release engineer, data-driven |
| External penetration/security assessment | NOT DONE | No third-party assessment on record | Commission an external pentest before broad rollout, especially of the secure-launch/attestation cryptographic paths | High | BROAD COMMERCIAL BLOCKER | Institution (procurement) |
| Signing-key rotation | GAP DOCUMENTED, HARD-CUTOVER ONLY | `docs/secure-launch-signing-key-runbook.md` — `keyId` exists but isn't wired to actual key selection; no safe overlapping-verification window | Implement `(keyId -> publicKey)` trusted-set verification if genuine zero-disruption rotation is required at scale | Medium | LATER IMPROVEMENT for pilot (small blast radius due to short TTLs); reconsider before broad rollout if rotation cadence needs to increase | Engineer, scoped design work |
| Privacy/legal review | INTERNAL REGISTER ONLY, NO LEGAL DETERMINATION | `docs/tether-data-and-privacy-register.md` — explicitly not a compliance claim | A qualified legal/compliance review (GDPR, Privacy Act, FERPA, or whatever applies to the institution's jurisdiction) using this register as a starting technical inventory | High | BROAD COMMERCIAL BLOCKER | Institution (legal counsel) |
| Update mechanism | NOT DONE | "No auto-update — every install requires a freshly built installer" (`known-limitations.md`) | Design and build an update-check/prompt mechanism (out of scope for this pass — Electron changes) | Medium | BROAD COMMERCIAL BLOCKER | Engineer, Electron work (explicitly deferred by this pass's global safety rules) |
| Institution configuration | AUDITED, MOSTLY REQUIRES SCHEMA | `docs/tether-institution-configuration.md` — only a global support-contact env var implemented; per-institution release policy/retention/defaults/guidance all require a new `InstitutionSettings` model | Build the `InstitutionSettings` model + resolution layering once broad multi-institution rollout is real | Medium | BROAD COMMERCIAL BLOCKER (a single-tenant-shaped config story doesn't scale to many differently-configured institutions) | Engineer, schema change (explicitly deferred by this pass's global safety rules) |
| Support process | RUNBOOK EXISTS, UNTESTED AT SCALE | `docs/tether-pilot-support-runbook.md` — 16 cases, written but not yet exercised against real support volume | Run it through an actual pilot cohort; refine based on real cases encountered | Medium | CONTROLLED PILOT BLOCKER is too strong — this exists and is usable; refinement is BROAD COMMERCIAL | Institution support staff, after pilot |
| Performance/scaling | DASHBOARD SCALING DONE THIS PASS; NO LOAD TEST | `src/app/api/exams/available/route.ts` / `src/app/api/exams/route.ts` now DB-bound for history (Part A of this pass); no index added (deferred — see below); no load test performed at any point in this project's history | Add `@@index` on `Exam(createdById, availableUntil)` / equivalent once a real migration is justified; run a load test at realistic broad-rollout volume | Medium | BROAD COMMERCIAL BLOCKER | Engineer, schema change + load test (explicitly deferred by this pass's global safety rules — see the note on `Exam` having no `createdById`/`availableUntil` index in the dashboard pagination work) |
| Disaster recovery | BACKUP VERIFICATION EXISTS; NO DOCUMENTED DR DRILL | `docs/production-backup-restore-runbook.md` covers backup verification; no end-to-end "how do we actually recover Production if it's lost" drill/runbook exists | Write and rehearse a real DR runbook (who has access, how long restore takes, what the acceptable data-loss window is) | High | BROAD COMMERCIAL BLOCKER | Operator + institution (business continuity requirement) |

## Summary

- **Controlled pilot blockers remaining:** 3 — physical Windows
  acceptance (the pilot readiness register's own 12-test checklist),
  installer publication (needed before pilot students can self-install),
  and (loosely) support-process refinement, though the runbook itself is
  already usable as-is.
- **Broad commercial blockers:** 11 — code signing, pilot results
  themselves, evidence retention activation policy, backup
  automation/verification against a real Production backup, operational
  alerting wired to a real channel, external penetration assessment,
  privacy/legal review, update mechanism, institution configuration
  schema, performance/scaling (index + load test), and disaster recovery
  drill.
- **Later improvements:** 3 — minimum-version policy raise (safe as-is,
  raise only once justified), regional alignment (acceptable at pilot
  scale), signing-key rotation overlap window (small blast radius at
  pilot scale).

None of these are addressed by rebuilding the Electron client, applying
SQL, deploying, or publishing anything — consistent with this pass's
global safety rules. Several items explicitly require a schema change or
Electron work that this pass deliberately stopped short of and documented
here instead of attempting speculatively.
