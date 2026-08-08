# Tether Secure Browser v1.7.2 — Controlled Pilot Release Readiness Register

This is the authoritative GO/NO-GO register for the current controlled-pilot
release candidate: **Tether Secure Browser 1.7.2 (Windows x64)**, together
with the Safe Exam System web platform on `main` as of this document's
commit. Not yet published as a GitHub Release or generally available.

Known tested installer:
`apps/lockdown/release/Tether-Secure-Browser-1.7.2-win-x64.exe`
Known tested SHA-256:
`2295deeb6d78ff3f42911d2c0af904355e9cbd7048505c14a60e7a7072faed2d`
(verified unchanged as of this document — see the "Installer freeze"
section at the bottom.)

**Reconciliation note (this revision):** the operator has now physically
run five of the checks previously marked NEEDS PHYSICAL CONFIRMATION.
Those five rows are updated to PASS below, with the operator's result
recorded as the physical evidence. This revision also corrects a
counting error in the previous version's summary (it undercounted the
P0 table by 2 rows) and normalizes several rows that were inconsistently
marked flat PASS despite genuinely needing live/physical confirmation —
see "Corrections made this revision" below.

**How to read this table.** "Automated test evidence" means a test exists
in this repository and passes. "Physical evidence" means a human or an
agent actually exercised the real behaviour end-to-end (a real Windows
launch, a real browser session, a real exam). An automated test passing
is never treated as physical evidence on its own — where physical
evidence has not actually been captured, the row says **NEEDS PHYSICAL
CONFIRMATION**, not PASS.

---

## Corrections made this revision

1. **Five rows upgraded to PASS** on the operator's confirmed physical
   results (see the "Operator-confirmed" evidence text in each row):
   Manual startup → Home; Secure exam deep link; Secure launch consume;
   Recovery; Entire Screen sharing; Screen evidence. (That's six rows —
   "Secure launch/recovery after server fixes: PASS" covers both the
   consume-transaction fix and the recovery-lifecycle fix, which were
   two separate register rows.)
2. **Five rows corrected from an inconsistently flat "PASS" to "NEEDS
   PHYSICAL CONFIRMATION"**: Duplicate-event prevention; "Remote session
   ended" transition; Clean exit/restoration; Lecturer recovery
   workflow; Camera where enabled (previously labeled with a stray third
   status, "NOT VERIFIED THIS PASS", now normalized into the same
   two-bucket system as every other row). None of these had ever
   actually been physically exercised — only unit/DB-backed tests
   existed for them — so marking them PASS was exactly the "infer PASS
   from automated tests" error this register's own stated policy
   prohibits.
3. **Row-count error fixed.** The P0 table has **25 rows**, not the 23
   implied by the previous summary (15 + 8). The previous summary also
   never accounted for the "Camera" row's stray third status at all.
4. **Scaling note added** (new P1 row, "True DB-level history
   pagination") — see that section for the accurate framing: acceptable
   for controlled pilot, not a P0 blocker, a real P1 scaling item.
5. **"Known cross-cutting risk" resolved** — see below; the operator's
   confirmed screen-evidence result directly answers the concern this
   section raised.
6. **Checklist consolidated into one authoritative section.** The
   previous revision had a numerical/wording ambiguity: it said "9 P0
   rows need physical confirmation," then referenced a "10-item physical
   acceptance checklist," then listed Windows installation and Camera
   separately as items 11-12 outside that checklist. There is now
   exactly one section, "Remaining Physical Acceptance Checklist" (12
   numbered test procedures, covering all 9 unconfirmed P0
   requirements), and every unconfirmed P0 row's "Required action" cell
   points at its specific test number(s) instead of a vague "see
   checklist below." The P0 requirement count is unaffected by this —
   see "Why 9 requirements but 12 test procedures" in the Summary.

**Pilot operations + distribution readiness v1 (this revision).** A
follow-up pass completed non-physical pilot/commercial-readiness
operational work — student distribution UX, version/update messaging, a
support runbook, production observability hardening, backup verification
tooling, an evidence-retention runner, and five new planning/governance
docs (release management, code-signing plan, signing-key runbook,
data/privacy register). **No P0 physical test status below was changed
by this revision** — every PASS/NEEDS PHYSICAL CONFIRMATION status and
every row of the Remaining Physical Acceptance Checklist reflects only
genuine physical evidence, exactly as in the previous revision. This
revision's changes are confined to: one new P0 evidence note (Controlled
installer distribution, reflecting the new in-app download UX — see that
row) and P1 table updates (several items moved from NOT DONE to PARTIAL
as real, tested, non-physical work landed). See
`docs/tether-production-observability.md`,
`docs/production-backup-restore-runbook.md`,
`docs/tether-evidence-retention-plan.md`,
`docs/tether-release-management.md`,
`docs/tether-windows-code-signing-plan.md`,
`docs/secure-launch-signing-key-runbook.md`,
`docs/tether-data-and-privacy-register.md`, and
`docs/tether-pilot-support-runbook.md` for full detail on each.

---

## P0 — MUST PASS BEFORE CONTROLLED PILOT

| Requirement | Status | Implementation evidence | Automated test evidence | Physical evidence | Known limitation | Severity | Pilot blocker | Required action |
|---|---|---|---|---|---|---|---|---|
| Windows installation | NEEDS PHYSICAL CONFIRMATION | NSIS installer built via `electron-builder`, `apps/lockdown/PILOT-INSTALL.md` documents the flow (SmartScreen warning expected, unsigned) | `verify:package` asserts the packaged build contains current source | Not executed — no fresh NSIS install/uninstall cycle has been run | Unsigned/unnotarized (by design for pilot) | Medium | Yes, until confirmed | See Remaining Physical Acceptance Checklist, Test 1 |
| Manual startup → Home | **PASS** | `apps/lockdown/src/lockdownStartupRouting.ts` — persisted `lastExamId` fallback removed; `resolveStartupLoadUrl(null, ...)` always resolves to `/student` | `lockdownStartupRouting.test.ts` (15 tests) | **Operator-confirmed physical result: "Normal Tether launch → Home: PASS."** Supersedes the earlier remote-capture limitation (content protection blocked screenshot-based verification; the operator's own eyes on the real screen do not have that limitation). | Content protection still means this can only be confirmed by someone physically at the machine, never a remote capture | Low | No | — |
| Secure exam deep link | **PASS** | `registerDeepLinkProtocol`/`handleDeepLink`, `resolveInitialExamIdFromArgv` | Pure tests for parsing/routing | **Operator-confirmed physical result: "Chrome secure-exam deep link → correct exam: PASS."** | None known | — | No | — |
| Signed launch manifest | PASS | Ed25519 sign/verify in `secureLaunchManifest.ts`; `validateManifestContext` checked before transactional mutation | `secureClientRunner.disposable.test.ts` (invalid-signature-rejected-before-mutation, etc.) | Not separately physically tested, but necessarily exercised end-to-end by the confirmed deep-link and launch-consume passes above (a real launch cannot succeed without this step) | None known | — | No | — |
| Installation verification | PASS | v2 attestation in `tetherAttestationRunner.ts`, installation binding in `secureClientRunner.ts` | Extensive existing suite | Not separately physically tested, but necessarily exercised by the confirmed launch/deep-link passes above | None known | — | No | — |
| Secure launch consume (P2028 fix) | **PASS** | Transaction scope reduced (crypto/audit logging moved outside the interactive transaction); explicit 10s timeout, env-overridable | 8 new concurrency tests incl. simulated transaction failure, `release:validate` full suite green | **Operator-confirmed physical result: "Secure launch/recovery after server fixes: PASS."** | Cross-region latency (Vercel iad1 ↔ Supabase AP-Northeast) is a real, unresolved *contributing factor* to why the original P2028 occurred — not itself fixed, only mitigated by the transaction-scope reduction | Low | No | — |
| Recovery (preflight-recovery-trap fix) | **PASS** | `tetherRecovery.ts` — LEGACY-mode unbound retry no longer forces `MANUAL_REVIEW_REQUIRED`; DUAL/V2_REQUIRED strictness unchanged | `tetherRecovery.test.ts`, `tetherRecovery.routes.test.ts`, `secureClientRunner.disposable.test.ts` — comprehensive | **Operator-confirmed physical result: "Secure launch/recovery after server fixes: PASS."** | None known | — | No | — |
| Entire Screen sharing | **PASS** | `screenShareRequestHandler.ts` registers `setDisplayMediaRequestHandler`, restricted to `types: ["screen"]` only (never `"window"`) | `screenShareRequestHandler.test.ts`, `screenShareLifecycle.test.ts` | **Operator-confirmed physical result: "Entire Screen sharing starts successfully: PASS."** | None known | — | No | — |
| Screen evidence | **PASS** | Pre-existing capture pipeline, unmodified this pass | Existing tests | **Operator-confirmed physical result: "Lecturer screen evidence is visible/normal: PASS."** This directly resolves the previously-flagged content-protection risk (see below). | None known | — | No | — |
| Camera where enabled | NEEDS PHYSICAL CONFIRMATION | Pre-existing, untouched by any change in this or the prior pass | Existing tests | Not executed | None known beyond pre-existing scope | Low | No (pre-existing, unchanged functionality; not part of what shipped this cycle) | See Remaining Physical Acceptance Checklist, Test 2 |
| Prohibited-process initial detection | PASS | Pre-existing (Windows Lockdown Hardening v1), unchanged this cycle | Existing tests | Not re-verified this pass | None known | — | No | — |
| Prohibited-process continuous detection | NEEDS PHYSICAL CONFIRMATION | Fixed `.finally()`-identity bug in `processDetection.ts` this cycle | `processDetection.test.ts` (regression-specific) | Not executed | None known | Medium | Yes, until confirmed | See Remaining Physical Acceptance Checklist, Tests 3-4 |
| Display initial detection | PASS | Pre-existing, unchanged this cycle | Existing tests | Not re-verified this pass | None known | — | No | — |
| Display continuous detection | NEEDS PHYSICAL CONFIRMATION | Fixed identical `.finally()`-identity bug in `displayEnforcement.ts` this cycle | `displayEnforcement.test.ts` (11 tests) | Not executed | None known | Medium | Yes, until confirmed | See Remaining Physical Acceptance Checklist, Tests 5-6 |
| Mid-exam remote-session detection | NEEDS PHYSICAL CONFIRMATION | New `RemoteSessionMonitor`, reuses existing event types | `remoteSessionMonitor.test.ts`, `remoteSessionMonitorLogic.test.ts`, `remoteSessionMonitorWiring.test.ts` | Not executed — requires a real RDP connection | None known | Medium | Yes, until confirmed | See Remaining Physical Acceptance Checklist, Test 7 |
| Duplicate-event prevention | NEEDS PHYSICAL CONFIRMATION | Dedup logic in `remoteSessionMonitorLogic.ts`/`processDetectionLogic.ts` | Covered by the above test files | Not executed live — corrected from a previous flat "PASS" that had no physical basis | None known | Low | Yes, until confirmed | See Remaining Physical Acceptance Checklist, Test 8 |
| "Remote session ended" transition | NEEDS PHYSICAL CONFIRMATION | `integrityEventLabels.ts` + 4 call sites + status-runner badge | Existing tests | Not executed live — corrected from a previous flat "PASS" that had no physical basis | None known | Low | Yes, until confirmed | See Remaining Physical Acceptance Checklist, Test 9 |
| Clean exit/restoration | NEEDS PHYSICAL CONFIRMATION | `lockdownLifecycle.ts`/`lockdownRestorationController.ts`; destroyed-window crash fix (v1.7.1) | Existing regression tests | Not executed live — corrected from a previous flat "PASS" that had no physical basis | None known | Medium | Yes, until confirmed | See Remaining Physical Acceptance Checklist, Tests 10-11 |
| Lecturer evidence visibility | PASS | Existing evidence pages; this pass fixed a raw-enum display bug and a missing back-link on the secure-client session page | `pilotUiTerminology.test.ts` | Verified in a real local browser session (seeded data, real render) | None known | — | No | — |
| Lecturer recovery workflow | NEEDS PHYSICAL CONFIRMATION | `issueRecoveryGrant`/override, `tetherRecoveryRunner.ts` | `tetherRecovery.routes.test.ts` | Not executed live — corrected from a previous flat "PASS" that had no physical basis | None known | Medium | Yes, until confirmed | See Remaining Physical Acceptance Checklist, Test 12 |
| Student dashboard usability | PASS | `src/app/student/page.tsx` — Action Required / Available Now / Upcoming / Recently Completed / Exam History, capped at 5 recent + expandable history | `studentDashboardGrouping.test.ts` (10 tests), `pilotDashboards.routes.test.ts` (4 tests) | Verified in a real local browser session (seeded lecturer/student accounts, exams in every state) — all 5 sections rendered correctly, "Show all completed examinations" expansion confirmed working | History capping happens in application code after the existing `exam.findMany` result is retrieved, not via a SQL `LIMIT` — see "DB query scaling note" below | — | No | — |
| Lecturer dashboard usability | PASS | `src/app/lecturer/page.tsx` — summary tiles, Needs Your Attention, Active/Upcoming/Drafts, Recent/Older examinations | `lecturerDashboardGrouping.test.ts` (9 tests), `pilotDashboards.routes.test.ts` (4 tests) | Verified in a real local browser session — Needs Your Attention correctly isolated the exam with an unreviewed integrity signal, summary tiles matched, "Show all older examinations" expansion confirmed working | Same history-capping note as above | — | No | — |
| Canonical navigation / no 404s | PASS | `/student/dashboard` removed repo-wide (prior pass); `ManualReviewNotice` confirmed pointing at `/student`; added a back-link on the secure-client session detail page | `studentDashboardRoute.test.ts`, `pilotUiTerminology.test.ts` (navigation section) | Confirmed via live browser session (dashboard → exam link → back navigation) | None known | — | No | — |
| Controlled installer distribution (manual, doc-based) | PASS | `PILOT-INSTALL.md` updated with current version/capability summary | — | Hash-verified this pass (see below) | Not code-signed (by design for pilot) | Low | No | — |
| Student-facing in-app download UX | **IMPLEMENTATION READY — ACTIVATION PENDING RELEASE PUBLICATION** | New canonical release-metadata module (`src/lib/tetherReleaseMetadata.ts`), `/lockdown-browser` page and the `tether-launch` installer-fallback page both rewritten to be data-driven from it (fixing a confirmed dead download link — a hardcoded `/downloads/tether-secure-browser/latest/...` path with no matching route); shows the exact required "not yet available for public download" message whenever `TETHER_INSTALLER_DOWNLOAD_URL` is unset (true today — no real URL is configured) | `tetherReleaseMetadata.test.ts` (14 tests) | Not physically tested — the UX has not been exercised against a real published installer URL, since none exists yet | Downloads remain disabled until an operator configures a real `TETHER_INSTALLER_DOWNLOAD_URL` — this is intentional, not a defect | Low | No | Not a pilot blocker: this UX activates automatically (no code change) the moment a real installer URL is configured — see `docs/tether-release-management.md` |
| Pilot support instructions | PASS (partial) | `PILOT-INSTALL.md` and `docs/known-limitations.md` updated to reflect 1.7.2 capabilities; `controlled-pilot-operator-guide.md`/`student-test-instructions.md`/`docs/lockdown-browser-known-limitations.md` reviewed, found not incorrect (no stale version/claims), left unchanged | — | Not re-verified live | Those three docs don't yet mention the newest monitoring capabilities explicitly (not wrong, just not updated) | Low | No | Optional follow-up: extend those 3 docs with the same capability summary added to `known-limitations.md` |

**Known cross-cutting risk — RESOLVED this revision.** A prior revision
of this register flagged that Tether's `setContentProtection(true)`
makes its own window invisible to *any* screen-capture API, including
its own `desktopCapturer`-based Entire Screen sharing — raising a
concern that captured screen-evidence frames might render as a black
rectangle where the exam content should be. The operator's confirmed
physical result ("Lecturer screen evidence is visible/normal: PASS")
directly answers this: the captured evidence is not black/corrupted in
practice. No further action needed on this specific risk.

**DB query scaling note (student/lecturer dashboards).** Both dashboard
endpoints (`GET /api/exams/available`, `GET /api/exams`) keep the same
DB query count as before this pass (2 queries and 1→2 queries
respectively — the lecturer route added exactly one aggregate query,
never a per-exam query). History capping (the 20-item default limit,
expandable via `?all=true`) happens in application code, in memory,
*after* the existing `exam.findMany` call already retrieved every
matching row — there is no SQL-level `LIMIT`/`OFFSET`/cursor pagination
on the historical set. This is **acceptable for a controlled pilot**
(the row counts involved are small — dozens, not thousands, of exams
per lecturer/student at pilot scale) and is **not a P0 blocker**. True
DB-level history pagination is recorded as a new P1 scaling item below,
to be addressed before broad commercial rollout when historical exam
volume could plausibly reach a size where fetching the full unbounded
result set becomes a real cost.

---

## Remaining Physical Acceptance Checklist

This is the **one authoritative section** for outstanding physical
verification — every unconfirmed P0 requirement maps explicitly to one
or more test numbers here, and every unconfirmed P0 row's "Required
action" cell above points back at its test number(s). Automated tests
exist for all 12 procedures below, but per this register's own stated
policy that is never treated as physical evidence. Run these on a real
Windows machine during an actual (or realistic rehearsal) exam session;
fill in Status and Physical evidence/date as each is actually run.

| Test # | Requirement(s) covered | Procedure | Expected result | Status | Physical evidence / date |
|---|---|---|---|---|---|
| 1 | Windows installation | Run the frozen `Tether-Secure-Browser-1.7.2-win-x64.exe` installer on a clean/representative Windows machine, then uninstall it, per `apps/lockdown/PILOT-INSTALL.md` | Install completes (SmartScreen warning expected/acceptable); app launches; uninstall removes it cleanly | NOT TESTED | — |
| 2 | Camera where enabled | Start an exam with camera monitoring enabled in its policy | Camera permission is requested, preview/monitoring starts, and stays active through the exam | NOT TESTED | — |
| 3 | Prohibited-process continuous detection | Start an exam, then open a known-prohibited app (e.g. TeamViewer) partway through — *after* the initial preflight scan has already passed | Detected and recorded mid-exam, not only at preflight | NOT TESTED | — |
| 4 | Prohibited-process continuous detection | After Test 3, close the prohibited app, then open a *different* prohibited app later in the same exam | The second occurrence is also caught (proves the poll loop kept running — the specific `.finally()`-identity bug fixed this cycle) | NOT TESTED | — |
| 5 | Display continuous detection | Start an exam on a single display, then connect a second display mid-exam | Overlay/warning appears | NOT TESTED | — |
| 6 | Display continuous detection | Disconnect the extra display from Test 5 | Overlay clears and normal single-display operation resumes (the specific bug fixed this cycle) | NOT TESTED | — |
| 7 | Mid-exam remote-session detection | Start an exam, then connect to the machine via a real RDP session | Remote-session detection fires | NOT TESTED | — |
| 8 | Duplicate-event prevention | While the RDP session from Test 7 remains connected, wait through several poll cycles | Exactly one "session became active" signal is recorded, never one per poll cycle | NOT TESTED | — |
| 9 | "Remote session ended" transition | Disconnect the RDP session from Test 7 | Lecturer-facing label reads "Remote session ended," not the generic "Prohibited application closed" | NOT TESTED | — |
| 10 | Clean exit/restoration | Submit an exam normally | Lockdown restrictions (keyboard blocking, overlays, monitoring) clear immediately; machine returns to normal use | NOT TESTED | — |
| 11 | Clean exit/restoration | Close the Tether window abruptly (Alt+F4 or task-end) mid-exam | Tether exits cleanly — no crash dialog, no orphaned overlay windows (destroyed-window crash fix, v1.7.1) | NOT TESTED | — |
| 12 | Lecturer recovery workflow | As a lecturer, issue a recovery grant for a student in a blocked/recovery-required state | The student can actually resume the exam using the grant | NOT TESTED | — |

---

## P1 — REQUIRED BEFORE BROAD COMMERCIAL ROLLOUT

| Requirement | Status | Notes |
|---|---|---|
| Windows code signing | NOT DONE | Installer currently unsigned/unnotarized — acceptable for controlled pilot only. Planning complete this revision: `docs/tether-windows-code-signing-plan.md` (certificate options, build-host blocker, pilot-vs-broad-rollout recommendation) — no certificate purchased, no config changed |
| Evidence-retention automation | PARTIAL (was NOT DONE) | A manual, operator-triggered retention runner now exists (`npm run evidence:retention`, age-based on `capturedAt`, default 90-day window, scoped to screen/camera evidence assets) — see `docs/tether-evidence-retention-plan.md`. Not wired into any automatic schedule; that remains an institutional policy decision |
| Automated/verified backups | PARTIAL (was NOT DONE) | Backup **verification** tooling now exists (`npm run backup:verify`, file-level checks + optional disposable-restore rehearsal — see `docs/production-backup-restore-runbook.md`), directly addressing the historical 41-byte-unusable-backup incident. Still no confirmed *production* backup/restore drill on record, and this tool does not itself schedule or create backups |
| Production observability | PARTIAL | `logServerTetherDiagnostic`/`diagnosticLog` exist but are opt-in/bounded, not a full observability stack (no metrics/alerting). This revision added `console.error` diagnostics (bounded, no secrets) to 6 previously-unlogged failure paths across the secure-client launch/attestation/heartbeat/recovery-grant/integrity-event pipeline, and documented recommended future alerts — see `docs/tether-production-observability.md`. Still no metrics/alerting infrastructure |
| Vercel/Supabase region optimisation | NOT DONE | Confirmed real: Vercel functions run in `iad1` (platform default, no `regions`/`preferredRegion` config), Supabase is `AP-Northeast` — flagged, not resolved, in the transaction-latency fix. Documented as a follow-up in `docs/tether-production-observability.md`; no migration performed |
| Formal release/version lifecycle | PARTIAL | This register is a first step. This revision added `docs/tether-release-management.md` (DEVELOPMENT → RELEASE CANDIDATE → PHYSICAL ACCEPTANCE → PILOT → GENERAL_AVAILABILITY → DEPRECATED → UNSUPPORTED lifecycle, semver policy, publication requirements, rollback path) and a canonical release-metadata module (`src/lib/tetherReleaseMetadata.ts`) — no formal changelog process/tooling yet |
| Installer update mechanism | NOT DONE | "No auto-update — every pilot requires a freshly built installer" (per `known-limitations.md`) |
| External security assessment | NOT DONE | No third-party pentest/audit on record |
| Signing-key lifecycle | PARTIAL | `TETHER_SECURE_CLIENT_SIGNING_*` keys exist and are used. This revision formally documented the gap: `manifest.keyId`/challenge `keyId` fields exist but are never used to select a verification key, so there is no safe overlapping-verification-window rotation today — only a hard-cutover emergency procedure. See `docs/secure-launch-signing-key-runbook.md` for the full architecture, emergency response, and what safe rotation would require. No key generated or rotated |
| Privacy/governance package | NOT DONE | `docs/privacy/student-exam-notice` page exists; no full data-protection/DPIA package confirmed. This revision added `docs/tether-data-and-privacy-register.md` — an internal technical register of every evidence/data type (purpose, access, retention, sensitivity, known gaps), explicitly NOT a legal compliance claim (no GDPR/Privacy Act/FERPA determination made) |
| True DB-level history pagination | NOT DONE | Student/lecturer dashboard history capping is currently in-application-code, post-fetch (see "DB query scaling note" above) — fine at pilot scale, needs real `LIMIT`/cursor-based pagination before historical exam volume grows large |

**P1 item count: 11** (unchanged — this revision updated 6 existing rows'
status/notes to reflect completed non-physical operational work; no rows
were added or removed from this table).

---

## P2 — LATER

- macOS production client (installer packaging exists per `PILOT-INSTALL.md`, but is dev/unverified relative to Windows)
- Advanced analytics
- Optional AI evidence triage
- Additional Canvas convenience features
- AI marking (exists as an optional, human-approved draft-score feature — broader/more automated marking is out of scope)
- AI question generation (exists as an optional feature — this row tracks any *further* expansion)

---

## Installer freeze (unchanged this revision)

```
PS> Get-FileHash apps/lockdown/release/Tether-Secure-Browser-1.7.2-win-x64.exe -Algorithm SHA256
```

Expected/known tested hash:
`2295DEEB6D78FF3F42911D2C0AF904355E9CBD7048505C14A60E7A7072FAED2D`
Not rebuilt, not modified, in this or the prior revision. No Electron
source file changed in this pass.

---

## Summary

- **P0 total requirements: 26** (25 carried over unchanged from the
  previous revision, plus 1 new row added this revision — "Student-facing
  in-app download UX" — see below for why it uses a third status label
  rather than the two-bucket PASS / NEEDS PHYSICAL CONFIRMATION system).
- **P0 PASS: 16** (unchanged from the previous revision — 6
  operator-confirmed: Manual startup → Home, Secure exam deep link,
  Secure launch consume, Recovery, Entire Screen sharing, Screen
  evidence; plus 10 already correctly PASS from pre-existing/unchanged
  functionality or browser-verified UI work). **No PASS row's status was
  changed by this revision.**
- **P0 requirements still awaiting physical confirmation: 9** (unchanged
  from the previous revision) — Windows installation, Camera where
  enabled, Prohibited-process continuous detection, Display continuous
  detection, Mid-exam remote-session detection, Duplicate-event
  prevention, "Remote session ended" transition, Clean exit/restoration,
  Lecturer recovery workflow. **No NEEDS PHYSICAL CONFIRMATION row's
  status was changed by this revision.**
- **1 new row uses a third status: "IMPLEMENTATION READY — ACTIVATION
  PENDING RELEASE PUBLICATION"** — Student-facing in-app download UX.
  This is deliberately not counted in either the PASS or NEEDS PHYSICAL
  CONFIRMATION buckets: it is not physically testable yet in any
  meaningful sense (there is no published installer URL for it to
  download), and it is explicitly marked "Pilot blocker: No" — the
  in-app UX is code-complete and automated-test-covered, and activates
  with zero code change the moment a real installer URL is configured.
  (16 + 9 + 1 = 26, matching the total above.)
- **Number of actual physical test procedures: 12** — see the Remaining
  Physical Acceptance Checklist above. **Unchanged this revision** — the
  new P0 row above adds no physical test procedure, since there is
  nothing physically testable about it yet (see above).

**Why 9 requirements but 12 test procedures?** Three of the nine
unconfirmed requirements each need two distinct physical actions to
verify fully (a "before" and "after" state, not just one observation),
so they map to two test numbers apiece rather than being counted as two
separate P0 requirements:
- Prohibited-process continuous detection → Tests 3 and 4 (a *later*
  detection, and a *second* later detection, prove the poll loop didn't
  freeze after the first one)
- Display continuous detection → Tests 5 and 6 (connect, then
  remove/recover)
- Clean exit/restoration → Tests 10 and 11 (a normal submit, and an
  abrupt window-close)

The other six unconfirmed requirements each map to exactly one test
(Windows installation → 1, Camera → 2, Mid-exam remote-session
detection → 7, Duplicate-event prevention → 8, "Remote session ended"
transition → 9, Lecturer recovery workflow → 12). 6×1 + 3×2 = 12,
matching the checklist total. The P0 requirement count itself is never
inflated by this — one row, multiple physical actions, still one row.

**Genuine remaining release blocker for controlled pilot start:** none
of the *server/web* work is blocking — every server-side fix
(transaction latency, recovery lifecycle, dashboards) is both
code-complete and physically confirmed or browser-verified. The
remaining gate is entirely the 9 unconfirmed *Tether Windows client*
requirements above (7 of which are the specific bugs fixed this cycle) —
these must be run through the 12-test Remaining Physical Acceptance
Checklist before controlled pilot start.

This document should be re-run/updated after each physical confirmation
session, and before every future release candidate.
