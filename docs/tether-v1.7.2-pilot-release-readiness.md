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

**How to read this table.** "Automated test evidence" means a test exists
in this repository and passes. "Physical evidence" means a human or an
agent actually exercised the real behaviour end-to-end (a real Windows
launch, a real browser session, a real exam). An automated test passing
is never treated as physical evidence on its own — where physical
evidence has not actually been captured, the row says **NEEDS PHYSICAL
CONFIRMATION**, not PASS.

---

## P0 — MUST PASS BEFORE CONTROLLED PILOT

| Requirement | Status | Implementation evidence | Automated test evidence | Physical evidence | Known limitation | Severity | Pilot blocker | Required action |
|---|---|---|---|---|---|---|---|---|
| Windows installation | NEEDS PHYSICAL CONFIRMATION | NSIS installer built via `electron-builder`, `apps/lockdown/PILOT-INSTALL.md` documents the flow (SmartScreen warning expected, unsigned) | `verify:package` asserts the packaged build contains current source | Not executed this pass — no fresh NSIS install/uninstall was run | Unsigned/unnotarized (by design for pilot) | Medium | No (documented, expected pilot behaviour) | Operator runs one real install/uninstall cycle before exam day, per `PILOT-INSTALL.md` |
| Manual startup → Home | PASS (logic) / NEEDS PHYSICAL CONFIRMATION (visual) | `apps/lockdown/src/lockdownStartupRouting.ts` — persisted `lastExamId` fallback removed; `resolveStartupLoadUrl(null, ...)` always resolves to `/student` | `lockdownStartupRouting.test.ts` (15 tests) | Partial: a real unpacked-build launch was confirmed via OS APIs to reach the live server over HTTPS with no crash, but Tether's own `setContentProtection(true)` blocked every available screen-capture method (including direct Win32 `PrintWindow`), so the rendered page could not be visually confirmed | Content protection (intentional anti-leak behaviour) prevents remote visual verification of this exact app | Low (root cause fixed; only visual confirmation is outstanding) | No | One physical confirmation: launch from Start Menu, look at the actual screen (not a remote capture) |
| Secure exam deep link | NEEDS PHYSICAL CONFIRMATION | `registerDeepLinkProtocol`/`handleDeepLink`, `resolveInitialExamIdFromArgv` | Pure tests for parsing/routing | Not executed — requires a live Chrome session against production and a real Tether-required exam | None known | Medium | Yes, until confirmed | Run Test 2 from the prior physical-testing pass (Chrome → Open Tether Secure Browser → confirm correct exam opens) |
| Signed launch manifest | PASS | Ed25519 sign/verify in `secureLaunchManifest.ts`; `validateManifestContext` checked before transactional mutation | `secureClientRunner.disposable.test.ts` (invalid-signature-rejected-before-mutation, etc.) | Exercised indirectly by every real launch; not separately re-verified this pass | None known | — | No | — |
| Installation verification | PASS | v2 attestation in `tetherAttestationRunner.ts`, installation binding in `secureClientRunner.ts` | Extensive existing suite | Not re-verified this pass | None known | — | No | — |
| Secure launch consume (P2028 fix) | PASS (code) / NEEDS PHYSICAL CONFIRMATION (prod) | Transaction scope reduced (crypto/audit logging moved outside the interactive transaction); explicit 10s timeout, env-overridable | 8 new concurrency tests incl. simulated transaction failure, `release:validate` full suite green | Not yet deployed — no production Vercel log confirms P2028 stopped recurring | Cross-region latency (Vercel iad1 ↔ Supabase AP-Northeast) is a real, unresolved contributing factor — not fixed, only mitigated | Medium | No (fix merged, awaiting deploy confirmation) | After deploy, confirm no further P2028 in Vercel logs |
| Recovery (preflight-recovery-trap fix) | PASS (code) / NEEDS PHYSICAL CONFIRMATION (prod) | `tetherRecovery.ts` — LEGACY-mode unbound retry no longer forces `MANUAL_REVIEW_REQUIRED`; DUAL/V2_REQUIRED strictness unchanged | `tetherRecovery.test.ts`, `tetherRecovery.routes.test.ts`, `secureClientRunner.disposable.test.ts` — comprehensive | Not re-verified live | None known | Medium | No | Confirm the previously-reported stuck submission resolves after deploy (see prior task's Part I finding: no manual reset expected to be needed) |
| Entire Screen sharing | PASS (code) / NOT EXECUTED (physical) | `screenShareRequestHandler.ts` registers `setDisplayMediaRequestHandler`, restricted to `types: ["screen"]` only (never `"window"`) | `screenShareRequestHandler.test.ts`, `screenShareLifecycle.test.ts` | Not executed — no real exam with a live screen-share attempt was run | Possible interaction with content protection (see below) not resolved | Medium | Yes, until confirmed | Run Test 4 from the prior physical-testing pass |
| Screen evidence | NOT EXECUTED (physical) | Pre-existing capture pipeline, unmodified this pass | Existing tests | Not executed | Same content-protection interaction risk as above | Medium | Yes, until confirmed | Confirm a captured evidence frame is not a black rectangle (see "Known cross-cutting risk" below) |
| Camera where enabled | NOT VERIFIED THIS PASS | Pre-existing, untouched by any change in this pass | Existing tests | Not executed | None known beyond pre-existing scope | Low | No | — |
| Prohibited-process initial detection | PASS | Pre-existing (Windows Lockdown Hardening v1) | Existing tests | Not re-verified this pass | None known | — | No | — |
| Prohibited-process continuous detection | PASS (code) / NOT EXECUTED (physical) | Fixed `.finally()`-identity bug in `processDetection.ts` | `processDetection.test.ts` (regression-specific) | Not executed | None known | Low | No | — |
| Display initial detection | PASS | Pre-existing | Existing tests | Not re-verified this pass | None known | — | No | — |
| Display continuous detection | PASS (code) / NOT EXECUTED (physical) | Fixed identical `.finally()`-identity bug in `displayEnforcement.ts` | `displayEnforcement.test.ts` (11 tests) | Not executed | None known | Low | No | — |
| Mid-exam remote-session detection | PASS (code) / NOT EXECUTED (physical) | New `RemoteSessionMonitor`, reuses existing event types | `remoteSessionMonitor.test.ts`, `remoteSessionMonitorLogic.test.ts`, `remoteSessionMonitorWiring.test.ts` | Not executed — requires a real RDP connection | None known | Medium | Yes, until confirmed | Run Test 5 from the prior physical-testing pass (real RDP session) |
| Duplicate-event prevention | PASS | Dedup logic in `remoteSessionMonitorLogic.ts`/`processDetectionLogic.ts` | Covered by the above test files | Not re-verified live | None known | — | No | — |
| "Remote session ended" transition | PASS | `integrityEventLabels.ts` + 4 call sites + status-runner badge | Existing tests | Not re-verified live | None known | — | No | — |
| Clean exit/restoration | PASS | `lockdownLifecycle.ts`/`lockdownRestorationController.ts`; destroyed-window crash fix (v1.7.1) | Existing regression tests | Not re-verified live | None known | — | No | — |
| Lecturer evidence visibility | PASS | Existing evidence pages; this pass fixed a raw-enum display bug and a missing back-link on the secure-client session page | `pilotUiTerminology.test.ts` | Verified in a local dev-server browser session (see below) — production not re-checked | None known | — | No | — |
| Lecturer recovery workflow | PASS | `issueRecoveryGrant`/override, `tetherRecoveryRunner.ts` | `tetherRecovery.routes.test.ts` | Not re-verified live | None known | — | No | — |
| Student dashboard usability | PASS | Rewritten `src/app/student/page.tsx` — Action Required / Available Now / Upcoming / Recently Completed / Exam History, capped at 5 recent + expandable history | `studentDashboardGrouping.test.ts` (10 tests), `pilotDashboards.routes.test.ts` (4 tests) | **Verified in a real local browser session** (seeded lecturer/student accounts, exams in every state) — all 5 sections rendered correctly, "Show all completed examinations" expansion confirmed working | None known | — | No | — |
| Lecturer dashboard usability | PASS | Rewritten `src/app/lecturer/page.tsx` — summary tiles, Needs Your Attention, Active/Upcoming/Drafts, Recent/Older examinations | `lecturerDashboardGrouping.test.ts` (9 tests), `pilotDashboards.routes.test.ts` (4 tests) | **Verified in a real local browser session** — Needs Your Attention correctly isolated the exam with an unreviewed integrity signal, summary tiles matched, "Show all older examinations" expansion confirmed working | None known | — | No | — |
| Canonical navigation / no 404s | PASS | `/student/dashboard` removed repo-wide (prior pass); `ManualReviewNotice` confirmed pointing at `/student`; added a back-link on the secure-client session detail page | `studentDashboardRoute.test.ts`, `pilotUiTerminology.test.ts` (navigation section) | Confirmed via live browser session (dashboard → exam link → back navigation) | None known | — | No | — |
| Controlled installer distribution | PASS | `PILOT-INSTALL.md` updated with current version/capability summary | — | Hash-verified this pass (see below) | Not code-signed (by design for pilot) | Low | No | — |
| Pilot support instructions | PASS (partial) | `PILOT-INSTALL.md` and `docs/known-limitations.md` updated to reflect 1.7.2 capabilities; `controlled-pilot-operator-guide.md`/`student-test-instructions.md`/`docs/lockdown-browser-known-limitations.md` reviewed, found not incorrect (no stale version/claims), left unchanged | — | Not re-verified live | Those three docs don't yet mention the newest monitoring capabilities explicitly (not wrong, just not updated) | Low | No | Optional follow-up: extend those 3 docs with the same capability summary added to `known-limitations.md` |

**Known cross-cutting risk (not a P0 blocker on its own, but relevant to
two rows above):** Tether's `setContentProtection(true)` makes its own
window invisible to *any* screen-capture API, including its own
`desktopCapturer`-based Entire Screen sharing. This was discovered
empirically this session (a direct Win32 `PrintWindow` capture of the
live Tether window returned solid black). If an exam requires both
content protection (always on) and screen-share evidence, the captured
evidence frame may be black. This needs a real physical test (Test 4) to
confirm whether it's an actual problem in practice, and if so, a
follow-up decision (not implemented in this pass, to avoid weakening
either control without the deliberate policy call the earlier task
explicitly deferred to you).

---

## P1 — REQUIRED BEFORE BROAD COMMERCIAL ROLLOUT

| Requirement | Status | Notes |
|---|---|---|
| Windows code signing | NOT DONE | Installer currently unsigned/unnotarized — acceptable for controlled pilot only |
| Evidence-retention automation | NOT DONE | No automated retention/expiry policy for integrity evidence assets |
| Automated/verified backups | NOT DONE | No confirmed Supabase backup/restore drill on record in this repo |
| Production observability | PARTIAL | `logServerTetherDiagnostic`/`diagnosticLog` exist but are opt-in/bounded, not a full observability stack (no metrics/alerting) |
| Vercel/Supabase region optimisation | NOT DONE | Confirmed real: Vercel functions run in `iad1` (platform default, no `regions`/`preferredRegion` config), Supabase is `AP-Northeast` — flagged, not resolved, in the prior transaction-latency fix |
| Formal release/version lifecycle | PARTIAL | This register is a first step; no formal versioning/changelog process yet |
| Installer update mechanism | NOT DONE | "No auto-update — every pilot requires a freshly built installer" (per `known-limitations.md`) |
| External security assessment | NOT DONE | No third-party pentest/audit on record |
| Signing-key lifecycle | PARTIAL | `TETHER_SECURE_CLIENT_SIGNING_*` keys exist and are used; no documented rotation/revocation procedure |
| Privacy/governance package | NOT DONE | `docs/privacy/student-exam-notice` page exists; no full data-protection/DPIA package confirmed |

---

## P2 — LATER

- macOS production client (installer packaging exists per `PILOT-INSTALL.md`, but is dev/unverified relative to Windows)
- Advanced analytics
- Optional AI evidence triage
- Additional Canvas convenience features
- AI marking (exists as an optional, human-approved draft-score feature — broader/more automated marking is out of scope)
- AI question generation (exists as an optional feature — this row tracks any *further* expansion)

---

## Installer freeze (Part I)

```
PS> Get-FileHash apps/lockdown/release/Tether-Secure-Browser-1.7.2-win-x64.exe -Algorithm SHA256
```

Result: `2295DEEB6D78FF3F42911D2C0AF904355E9CBD7048505C14A60E7A7072FAED2D`
— matches the known tested hash exactly. **Not rebuilt, not modified.**
No Electron source file changed in this pass (`git status apps/lockdown/`
was clean before this commit).

---

## Summary

- **P0 PASS (code + physical or not applicable to physical verification):** 15
- **P0 PASS (code) but NEEDS PHYSICAL CONFIRMATION:** 8
- **P0 remaining blockers (pilot must not start until confirmed):** 4 — secure exam deep link, Entire Screen sharing, screen evidence, mid-exam remote-session detection (all four require a real Windows machine, a real exam, and — for remote-session detection — a real RDP connection; none can be verified remotely)

This document should be re-run/updated after each physical confirmation
session, and before every future release candidate.
