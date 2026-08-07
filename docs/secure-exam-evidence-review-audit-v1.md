# Secure Exam Evidence Review — End-to-End Audit v1

An end-to-end trace of the "Secure Exam Evidence Review" workflow — student
verification through camera/screen-share monitoring, Tether (Electron)
lockdown signals, evidence capture, and lecturer review — against the
intended model:

- deterministic lockdown and integrity signals;
- periodic and event-triggered screenshots, never continuous recording;
- lecturer review, never automatic misconduct determination;
- no AI screen monitoring in the core workflow.

This audit is read-only in intent: findings are graded, and only
**confirmed defects** (a field or behaviour that contradicts its own
documented/adjacent contract, verified directly in source) are fixed. Gaps
that reflect a genuine, undocumented product decision are recorded here for
follow-up, not silently patched.

## How to read the matrix

Each row is one of the 14 traced areas. Each column is a layer. A cell
holds one status tag:

| Tag | Meaning |
| --- | --- |
| **Working** | Implemented and connected end to end at this layer. |
| **Not connected** | Code exists at this layer but does not reach the next layer in practice. |
| **Warning-only** | Recorded, but never becomes a reviewable signal (e.g. logged/console only). |
| **Missing** | No implementation at this layer. |
| **Not visible** | Reaches storage but is not surfaced to a lecturer anywhere. |
| **N/A** | This layer does not apply to this area. |

"Not covered by tests" is noted separately per row, since it is orthogonal
to implementation status.

## Acceptance matrix

| # | Area | Student | Tether (Electron) | API | Database | Lecturer review | Tests |
| - | ---- | ------- | ------------------ | --- | -------- | ---------------- | ----- |
| 1 | Student verification | Working (self-attestation checkbox) | N/A | Working | Working (`IntegrityEvent`) | Working (timeline row) | Covered |
| 2 | Camera permission/preview/heartbeat | Working (gate + preview + client heartbeat) | N/A | Working | Working | Working | Partially — see below |
| 3 | Entire-screen sharing requirement | Working (gate blocks Start) | N/A | Working (policy snapshot) | Working | Working (policy shown) | Covered |
| 4 | Screen-sharing interruption detection | Working (state machine) | N/A | Working | Working | Working (counts) but not previously proven | **Fixed — test added** |
| 5 | Periodic screen-evidence capture | Working | N/A | Working (interval/max enforced) | Working | Working | Covered |
| 6 | Event-triggered screen-evidence capture | Working (INTERRUPTION/RESTORATION triggers) | N/A | Working | Working | Working | Covered |
| 7 | Prohibited-process evidence | N/A | Working (detection) | Working (`integrity-events`) | Working (`IntegrityEvent`) | **Was not visible — fixed** | **Fixed — test added** |
| 8 | Display-change evidence | N/A | Working (detection) | Working (`secure-client/.../events`) | Working (`SecureClientEvent`) | **Not visible** (documented gap, not fixed) | Not covered |
| 9 | Remote-session evidence | N/A | **Not connected** (preflight-only; never polled mid-exam) | Working (preflight only, audit-log only) | `PlatformAuditLog` only | **Not visible** (documented gap, not fixed) | Not covered |
| 10 | Secure-client disconnect and recovery | Working (banners) | Working | Working | Working | **Not visible** on the per-submission evidence page (list-page badge only; documented, by design) | Covered (recovery-specific suite) |
| 11 | Autosave and submission | Working | N/A | Working (idempotent) | Working | **Not visible** (silent by design — no integrity signal for retries) | Covered (recovery-specific suite) |
| 12 | Lecturer evidence timeline and review UI | N/A | N/A | Working | Working | Working (5-state review workflow) | Covered |
| 13 | Evidence retention and deletion | N/A | N/A | Missing (no delete route) | Cascade-delete only; **no time-based retention job exists** | N/A | **Fixed — cascade test added** |
| 14 | Human review and decision recording | N/A | N/A | Working | Working (immutable status history) | Working | Covered |

## Findings by area

### 1. Student verification

`Exam.secureSettings.requireStudentVerification` gates a confirmation
checkbox (`src/app/student/exams/[id]/page.tsx`, `handleConfirmVerification`)
that records `STUDENT_VERIFICATION_CONFIRMED` (`IntegrityEvent`, `INFO`).
**This is self-attestation, not identity verification** — no photo/ID
capture, no biometric comparison. This is explicitly and correctly
documented already (`docs/on-device-ai-integrity-detection-v1.md`,
`docs/known-limitations.md:29`: "Does not verify student identity."). Not a
defect — the feature does exactly what it is named and documented to do;
the naming risk (a lecturer assuming "verification" means identity) is
already called out in `docs/known-limitations.md`.

A second, unrelated mechanism — `SecureClientSession.verificationStatus`
— proves environment/software attestation (SEB/Tether compatibility, VM/
remote-session detection, client signature), never identity. No change
made; both mechanisms already work exactly as documented.

### 2. Camera permission, preview and heartbeat

Gated the same way as screen-share (`cameraGateSatisfied`, page.tsx:3315),
with a persistent local preview (`showCameraPreview` setting) and a
client-side heartbeat (`cameraHeartbeatEnabled`/`cameraHeartbeatIntervalSeconds`,
default disabled/30s) that reports `CAMERA_HEARTBEAT_MISSED` on a stale
track. `src/lib/cameraIntegrityDetection.ts` (750 lines, pure logic)
computes stream health/frame quality/person-visibility, feeding real
`IntegrityEvent`s. Working end to end.

**Not covered by tests:** the client-side heartbeat `useEffect`
(page.tsx:2313-2339) and `session-heartbeat/route.ts`'s
`cameraPermissionState` handling have no dedicated test — this repo has no
component-testing setup for the 4000+-line exam page, so this is a
structural limitation, not a new gap introduced here. Left undisturbed;
out of scope for a defects-only pass.

### 3-6. Screen-share requirement, interruption detection, periodic and
event-triggered capture

All four match `docs/screen-share-evidence-v1.md` closely, verified line
by line in `src/lib/screenSharePolicy.ts`,
`src/app/api/submissions/[id]/screen-evidence/route.ts`,
`src/hooks/useScreenShareLifecycle.ts`, and `src/lib/screenShareLifecycle.ts`.
Concurrency (atomic slot reservation), idempotency (`clientRequestId`),
MIME/size limits, minimum capture gap, and rate limiting are all
implemented and unit-tested (`screenSharePolicy.test.ts`,
`screenShareEvidence.routes.test.ts`). No defect found.

**One test gap confirmed and fixed:** nothing proved that a
`SCREEN_SHARE_INTERRUPTED` event actually surfaces through the lecturer
review workflow with `reviewStatus: NEEDS_REVIEW` (the generic
"every `IntegrityEvent` defaults to `NEEDS_REVIEW`" mechanism has no
type-specific exclusion, but was never asserted for this specific event
type). See "Tests added" below.

### 7. Prohibited-process evidence

Electron's `processDetection.ts` matches running processes against
`lockdownCapabilityRegistry.ts`; a detected capability's `category` maps to
an `IntegrityEventType` via `integrityEventTypeForCapabilityCategory()`
(`src/lib/lockdownEventClassification.ts`) and is posted through the
existing `POST /api/submissions/[id]/integrity-events` route — a real,
reviewable `IntegrityEvent`, confirmed end to end.

**Confirmed defect #1 — wrong category.** `REMOTE_DESKTOP_SESSION`'s
registry entry had `category: "VIRTUALIZATION"`, but its own
`configToggle: "TETHER_BLOCK_REMOTE_CONTROL"` and its own
`auditEvidenceBehavior` doc string both say it should produce
`REMOTE_CONTROL_SOFTWARE_DETECTED` — which only happens for
`category: "REMOTE_CONTROL"` (`VIRTUALIZATION` maps to the generic
`PROHIBITED_APPLICATION_DETECTED`). Fixed in
`apps/lockdown/src/lockdownCapabilityRegistry.ts`. (This capability's
detection method, `WINDOWS_SESSION_API`, is also never actually invoked by
the during-exam poll loop — see area 9 below; the category fix corrects
the metadata truthfully regardless of whether/when that path is exercised.)

**Confirmed defect #2 — invisible in practice.** All five lockdown
detection event types (`REMOTE_CONTROL_SOFTWARE_DETECTED`,
`SCREEN_CAPTURE_SOFTWARE_DETECTED`, `DEBUGGING_TOOL_DETECTED`,
`PROHIBITED_APPLICATION_DETECTED`, `PROHIBITED_APPLICATION_CLOSED`) reach
`IntegrityEvent` but had **no friendly label** in
`src/lib/integrityEventLabels.ts` (displayed as the raw enum string) and
**no category** (fell into the generic "Info events" bucket, alongside
truly informational signals, despite being `MEDIUM`-severity reviewable
detections). Fixed: added labels, a new `lockdown` category/filter, and a
compact "Lockdown detection signals" summary section to
`src/lib/evidenceReport.ts` and
`src/app/lecturer/submissions/[id]/evidence/page.tsx`, mirroring the
existing camera/screen-share summary pattern exactly. Also fixed in the
same pass: `screenShareIntegritySummary` was silently missing from the CSV
export (`evidenceReportToCsv`) — a pre-existing, same-class omission,
corrected alongside the new lockdown summary's CSV block.

### 8. Display-change evidence

`displayEnforcement.ts`/`windowsDisplayTopology*.ts` detect topology
changes and relay them via `POST /api/secure-client/sessions/[sessionId]/events`
to `recordSecureClientEvent()`, which writes to `SecureClientEvent` — a
**third** table, neither `IntegrityEvent` nor `PlatformAuditLog`. No
lecturer page, no platform-admin page, reads this table anywhere in the
codebase.

**Not fixed.** Building lecturer visibility for `SecureClientEvent` would
mean designing a new read path and UI section for a table with no existing
review precedent, and no documentation states whether display-topology
changes were ever intended to be lecturer-reviewable evidence (as opposed
to a technical signal for the recovery/session-integrity system that
already consumes `SecureClientEvent` elsewhere). Recorded here as a
confirmed, real gap for a deliberate product decision, not patched blind.

### 9. Remote-session evidence

The registry's own `REMOTE_DESKTOP_SESSION` entry claims "Reviewable
IntegrityEvent... while an exam is active," but `ProcessDetection.pollOnceNow()`
— the only during-exam scan loop — filters to
`detectionMethod === "PROCESS_NAME_MATCH"` only; `REMOTE_DESKTOP_SESSION`'s
`detectionMethod` is `WINDOWS_SESSION_API`, so it can **never** be evaluated
during an active exam. The only real call site
(`tether-launch/page.tsx`) checks remote-session status once, at preflight,
before a final exam, and reports the outcome only to
`/api/tether/lockdown/audit-event` (`PlatformAuditLog`, platform-admin
only).

**Not fixed.** Widening `pollOnceNow()`'s during-exam scan to include
`WINDOWS_SESSION_API`/`WINDOWS_SYSTEM_INFO` capabilities is a real
behavioural change to what Tether actively monitors and how often —
exactly the kind of change this audit's constraints ask to be cautious
about ("do not weaken **or** [implicitly] casually strengthen without
review" — a monitoring-scope change deserves its own explicit sign-off,
not a silent expansion inside a defects-only audit pass). Recorded here as
a confirmed "implemented but not connected end to end" + "not visible to
lecturers" gap. The category-field fix in area 7 corrects what
*would* happen if this is wired up later, without changing behaviour today.

### 10-11. Secure-client disconnect/recovery, autosave and submission

Both are correctly, robustly implemented (`tetherRecovery.ts`,
`tetherRecoveryRunner.ts`, the `/answers` and `/submit` routes'
idempotency keys) and heavily tested
(`tetherRecovery.routes.test.ts`, 925 lines). By explicit design
(`docs/tether-secure-resume-recovery-v1.md`), disconnect/crash/relaunch/
resume/autosave-retry never produce an `IntegrityEvent` — verified by this
repo's own tests asserting `integrityEvent.count === 0` after a recovery
flow. The only lecturer-facing trace is a compact `RecoveryBadge` on the
exam-wide **submissions list** page
(`src/app/lecturer/exams/[id]/submissions/page.tsx`) — not part of the
per-submission evidence/integrity-review timeline.

**Not fixed.** This is explicit, tested, documented design intent (not an
oversight), so it does not meet the "confirmed defect" bar. Recorded here
because it is one of the audit's 14 required trace points and the
per-submission invisibility is real, even if intentional.

### 12. Lecturer evidence timeline and review UI

The 5-state review workflow (`docs/evidence-review-workflow-v1.md`) —
`NEEDS_REVIEW → REVIEWED_NO_CONCERN | REVIEWED_CONCERN_REMAINS | ESCALATED
| RESOLVED`, immutable status history, reviewer comments, bulk
"no concern" action, server-derived reviewer identity — is fully
implemented and matches its own spec exactly. No defect found.

### 13. Evidence retention and deletion

`IntegrityEvidenceAsset` has `onDelete: Cascade` from `IntegrityEvent`,
`Submission`, and `Exam` (`prisma/schema.prisma:1082-1086`) — a real,
enforced deletion rule, now proven by a new test (see below). **No
time-based retention window is implemented anywhere** — no delete route,
no scheduler/cron, `EvidenceStorageAdapter.delete()` is never called from
application code. This is explicitly, repeatedly documented as a known,
deferred v1 limitation across four docs
(`docs/on-device-ai-integrity-detection-v1.md`,
`docs/deployment-vercel-supabase.md`, `docs/privacy-and-student-notice.md`,
`docs/answer-development-provenance-v1.md`) — not a silent gap, and
building a retention scheduler is a substantial, separate feature
decision, not a "confirmed defect" fix. Left as documented.

### 14. Human review and decision recording

Fully implemented per `docs/evidence-review-workflow-v1.md` — reviewer
identity always server-derived, immutable status history, policy
interpretation computed fresh on every read (never cached/stored), and
`calculateCombinedReviewRecommendation()` only ever outputs one of
`NO_IMMEDIATE_ACTION | LECTURER_REVIEW_RECOMMENDED |
ORAL_VERIFICATION_RECOMMENDED | ESCALATION_RECOMMENDED` — never an
automatic misconduct determination. Already well tested
(`combinedReviewRecommendation.test.ts`), including the specific rule that
every `EVIDENCE`-category signal is always "limited alone." No defect
found.

## Confirmed defects fixed

1. `apps/lockdown/src/lockdownCapabilityRegistry.ts` — `REMOTE_DESKTOP_SESSION.category`
   corrected from `"VIRTUALIZATION"` to `"REMOTE_CONTROL"`, matching its
   own `configToggle` and `auditEvidenceBehavior` documentation.
2. `src/lib/integrityEventLabels.ts` — added lecturer-friendly labels and a
   new `lockdown` category for the five lockdown detection event types.
3. `src/lib/evidenceReport.ts` + `src/app/lecturer/submissions/[id]/evidence/page.tsx`
   — added a "Lockdown detection signals" summary (JSON API + UI),
   mirroring the existing camera/screen-share summary pattern.
4. `src/lib/evidenceReport.ts` (`evidenceReportToCsv`) — added the
   pre-existing missing `screenShareIntegritySummary` CSV block, and the
   new lockdown-detection CSV block.

No enforcement, detection, or secure-client control behaviour was changed
by any of the above — every fix is a metadata correction or an
already-collected-signal visibility improvement.

## Confirmed gaps recorded, not fixed (need a product decision, not a bug fix)

- Display-topology-change events (`SecureClientEvent`) have no lecturer or
  platform-admin visibility anywhere.
- Remote-session/VM detection is never evaluated during an active exam
  (preflight-only), contradicting the capability registry's own inline
  documentation.
- No time-based evidence retention/deletion job exists (cascade-on-parent-
  delete is the only enforced rule).
- Secure-client recovery and autosave/submission activity is invisible on
  the per-submission evidence page (list-page badge only) — this is
  explicit, tested design intent, not an oversight.

## Tests added

See the corresponding `*.test.ts` files for the full list; summary:

- `apps/lockdown/src/lockdownCapabilityRegistry.test.ts` — a new
  regression test asserting every capability's `category` is consistent
  with its `configToggle` (would have caught defect #1).
- `src/lib/integrityEventLabels.test.ts` — labels/category coverage for
  the five lockdown detection event types.
- `src/lib/evidenceReport.test.ts` (new file) — `lockdownDetectionSummary`
  computation and CSV export, including the previously-missing
  `screenShareIntegritySummary` CSV block.
- `src/lib/screenShareEvidence.routes.test.ts` — interruption events reach
  the integrity-review workflow as `NEEDS_REVIEW`; a lecturer from a
  different institution cannot view evidence; a storage-adapter failure
  returns 503 without creating an orphaned event/asset or exposing exam
  content.
- `src/lib/evidenceRetention.test.ts` (new file) — cascade-delete proof:
  deleting a `Submission` removes its `IntegrityEvidenceAsset` rows.
- `src/lib/combinedReviewRecommendation.test.ts` — an additional
  screen-share/lockdown-specific "never automatic misconduct" case.
