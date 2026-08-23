# Tether Data & Privacy Register (v1)

**This is an internal technical register, not legal advice or a
compliance claim.** It documents what data this system actually collects,
why, who can see it, and what happens to it today, grounded directly in
the current schema and code (`prisma/schema.prisma`, cited per section).
It does not assert compliance with GDPR, the Privacy Act, FERPA, or any
other framework — those determinations require legal review this
document does not perform, and no such claim is made here.

## Core principle (applies to every data type below)

Every integrity-related signal collected by this system exists to
**support a human lecturer's review**. None of it is designed, or should
ever be described, as automatically determining misconduct. See
`docs/tether-pilot-support-runbook.md`'s "Core principles" for the
corresponding operational-language rules.

## Data types

### 1. Screen evidence

- **Category:** Image (still frame), captured during an active exam
  session when screen-sharing is required by exam policy.
- **Why/when collected:** To provide visual evidence of what was
  displayed on the student's screen during a monitored exam, for lecturer
  review — see `docs/screen-share-evidence-v1.md`.
- **Source:** The Tether client's screen-share stream, captured
  client-side and uploaded via `POST /api/submissions/[id]/screen-evidence`.
- **Who can view:** Stored as an `IntegrityEvidenceAsset` row (`kind:
  "SCREEN_SHARE_EVIDENCE_FRAME"`, `prisma/schema.prisma:1079`), resolved
  only through the authenticated, audited
  `GET /api/integrity-evidence/[evidenceAssetId]` route — never returned
  inline to any client, never embedded in `IntegrityEvent.metadataJson`.
  Access is scoped to lecturers/staff with legitimate access to the
  submission's institution/exam.
- **Influences integrity review:** Yes — as evidence a lecturer reviews,
  never as an automatic determination.
- **Retention/deletion today:** No `expiresAt`/`retainUntil` field exists
  on `IntegrityEvidenceAsset` (only `capturedAt`/`createdAt`). No
  scheduled deletion runs automatically. A manual, operator-triggered
  retention runner (`npm run evidence:retention`, age-based on
  `capturedAt`, default 180-day window) now exists — see
  `docs/tether-evidence-retention-plan.md` — but must be deliberately
  invoked, and `--execute` requires an explicit `--institution-id` and
  `--retention-days` (no deployment-wide destructive path); nothing
  deletes this data on its own.
- **Sensitivity:** High — may capture anything visible on the student's
  screen, potentially including unrelated personal content if the student
  had other windows/content open.
- **Known gap:** No AUTOMATIC retention policy is enforced (manual tool
  only). `redactionMode` exists on the schema (`LOW_RES_FULL_FRAME`
  default) but is a capture-time quality setting, not a privacy
  redaction of content.

### 2. Camera evidence

- **Category:** Image (still frame), captured during camera-monitored
  exams.
- **Why/when collected:** Captured only when
  `secureSettings.captureAiViolationEvidence` is enabled AND a
  `POSSIBLE_PHONE_VISIBLE` or `POSSIBLE_SECOND_PERSON_VISIBLE` event is
  logged — never on every frame, never continuous video (see
  `docs/on-device-ai-integrity-detection-v1.md`).
- **Source:** On-device AI classification in the student's browser/Tether
  client, uploaded via
  `POST /api/submissions/[id]/integrity-events/[eventId]/evidence-frame`.
- **Who can view:** Same `IntegrityEvidenceAsset` model (`kind:
  "AI_CAMERA_EVIDENCE_FRAME"`), same access-controlled resolution route
  as screen evidence above.
- **Influences integrity review:** Yes — as evidence for lecturer review.
  The schema's own doc comment on the neighboring AI-use-review model is
  explicit that this system is "NOT an AI detector" in the sense of an
  automatic verdict — every capture is an explainable signal, not a
  finding.
- **Retention/deletion today:** Same manual retention runner as screen
  evidence above (both share the `IntegrityEvidenceAsset` model, and the
  runner does not distinguish `kind` — both are covered by the same
  `npm run evidence:retention` sweep).
- **Sensitivity:** Very high — biometric-adjacent (a person's face/room),
  though the schema explicitly notes this is never used for face
  recognition or biometric identification, only presence/visibility
  classification.
- **Known gap:** Only manually-triggered retention exists (no automatic
  schedule) — the inherently higher sensitivity of camera imagery
  specifically warrants prioritizing an automatic schedule for this data
  type first, if/when one is built.

### 3. Integrity events

- **Category:** Structured metadata (event type, severity, message,
  bounded JSON metadata, timestamps) — never image/video/frame data
  itself (see `metadataContainsMediaData` in
  `src/app/api/submissions/[id]/integrity-events/route.ts`, which
  structurally rejects any metadata key/value that looks like embedded
  media).
- **Why/when collected:** Records discrete integrity-relevant occurrences
  during an exam (fullscreen exit, window blur, prohibited application
  detected, remote session detected, etc.) — see `IntegrityEvent`
  (`prisma/schema.prisma:759`).
- **Source:** Client-reported (browser or Tether Electron client),
  written server-side via the integrity-events API.
- **Who can view:** Lecturers/staff with access to the exam, via the
  evidence-review workflow (`reviewStatus`, `reviewedBy`, comments —
  `docs/evidence-review-workflow-v1.md`).
- **Influences integrity review:** Yes — this IS the primary review
  surface; each event carries a `reviewStatus` (`NEEDS_REVIEW` by
  default) that a lecturer explicitly transitions.
- **Retention/deletion today:** No expiry field; deleted only via
  cascade if the parent `Submission` is deleted (`onDelete: Cascade`).
  No standalone deletion API for an individual event.
- **Sensitivity:** Medium — behavioral metadata about the student's exam
  session, not raw personal content.
- **Known gap:** Same lack of an independent retention lifecycle as the
  evidence-asset types above.

### 4. Process/application signals

- **Category:** Structured metadata — which application/process was
  detected (e.g. `PROHIBITED_APPLICATION_DETECTED`,
  `REMOTE_CONTROL_SOFTWARE_DETECTED`), never full process listings or
  arbitrary system state.
- **Why/when collected:** Enforces the exam's prohibited-application
  policy — see `docs/tether-windows-lockdown-hardening-v1.md`.
- **Source:** Tether Electron client's own process-detection logic
  (`apps/lockdown/src/processDetectionLogic.ts`), reported as
  `IntegrityEvent` rows (event types above).
- **Who can view:** Same as integrity events generally.
- **Influences integrity review:** Yes, as a review signal.
- **Retention/deletion today:** Same as integrity events (no independent
  expiry).
- **Sensitivity:** Low-medium — application names only, not file
  contents or arbitrary system data.
- **Known gap:** None specific beyond the general retention gap.

### 5. Display topology

- **Category:** Structured metadata — display count/classification
  (single vs. multi-display), used for `SINGLE_DISPLAY_REQUIRED` policy
  enforcement.
- **Why/when collected:** Enforces single-display exam policy; recorded
  as part of attestation (`SecureClientAttestation.displayCount`,
  `SystemCheckSecureClientVerification.displayTopologyClassification`).
- **Source:** Tether client-reported, cryptographically signed as part
  of installation attestation for the v2 EXAM_SESSION path (
  `tetherAttestationRunner.ts`).
- **Who can view:** Lecturers/staff via the same review surfaces; also
  used server-side as a direct policy gate (`DISPLAY_POLICY_VIOLATION`).
- **Influences integrity review:** Both a direct policy gate AND a review
  signal.
- **Retention/deletion today:** Tied to the lifetime of the
  `SecureClientAttestation`/`SystemCheckSecureClientVerification` rows —
  no independent expiry.
- **Sensitivity:** Low — hardware configuration fact, not personal
  content.
- **Known gap:** None specific.

### 6. Remote-session signals

- **Category:** Boolean/classification — whether a Remote Desktop/remote-
  access session was detected, and the signal source.
- **Why/when collected:** Prevents remote-assisted exam-taking — see
  Case 11 of `docs/tether-pilot-support-runbook.md`.
- **Source:** Tether Electron client's own OS-level detection, reported
  via `getRemoteSessionStatus()`/attestation.
- **Who can view:** Same as process/application signals.
- **Influences integrity review:** Yes, and can directly block exam entry
  for final examinations (fail-closed — see
  `checkLockdownPreflight` in `tether-launch/page.tsx`).
- **Retention/deletion today:** Same general gap.
- **Sensitivity:** Low-medium.
- **Known gap:** None specific.

### 7. Network/IP evidence

- **Category:** IP address (raw and/or hashed), user agent, browser/OS
  name, coarse geolocation (country/region/city/timezone), VPN/proxy
  signal.
- **Why/when collected:** Captured at exam start and exam submit
  (`NetworkEvidence.source: "EXAM_START" | "EXAM_SUBMIT"`,
  `prisma/schema.prisma:1031`) to support review of anomalous
  location/network changes mid-exam.
- **Source:** Server-derived from the request (IP, headers) at those two
  points — not continuously tracked throughout the exam.
- **Who can view:** Lecturers/staff with legitimate access to the
  submission.
- **Influences integrity review:** Yes, as a review signal
  (`networkChanged`, `vpnOrProxySignal` flags).
- **Retention/deletion today:** No expiry field; no independent deletion
  API.
- **Sensitivity:** High — IP address and coarse location are personal
  data in most privacy frameworks. Both a raw `ipAddress` field AND a
  separate `ipHash` field exist on the model — this register does not
  assert which one, if either, is actually populated in current code
  without further verification, but flags the coexistence of raw and
  hashed forms as worth resolving explicitly (prefer the hash where the
  raw value isn't operationally required) as part of any future privacy
  hardening pass.
- **Known gap:** Retention gap, plus the raw-vs-hashed-IP ambiguity noted
  above.

### 8. Device/session identifiers

- **Category:** Opaque database identifiers (`SecureClientSession.id`,
  `clientInstallationIdHash`), never raw device hardware identifiers
  (serial numbers, MAC addresses) beyond what's described in installation
  identifiers below.
- **Why/when collected:** Session lifecycle management, recovery, and
  binding an exam session to a specific installation.
- **Source:** Server-generated (session ids) or derived from the
  installation's public-key fingerprint (`clientInstallationIdHash`).
- **Who can view:** Lecturers/admins via secure-client session management
  UI; not exposed to other students.
- **Influences integrity review:** Indirectly — used for
  device-change/recovery decisions, not itself a misconduct signal.
- **Retention/deletion today:** Tied to submission lifetime.
- **Sensitivity:** Low — opaque identifiers, not directly identifying on
  their own.
- **Known gap:** None specific.

### 9. System-check info

- **Category:** Structured metadata — platform, OS version, client
  version, per-check pass/fail statuses (display, remote session, virtual
  machine, process, capture protection, clipboard/printing/navigation
  policy, configuration verification, client signature).
- **Why/when collected:** Pre-exam readiness verification — see
  `docs/tether-system-check-v1.md`.
- **Source:** Client-reported, some fields cryptographically attested
  (v2 installation-bound path).
- **Who can view:** The student themselves (their own result), and
  lecturers/staff for review purposes.
- **Influences integrity review:** Indirectly — gates exam entry, and the
  resulting `SecureClientAttestation`/`SystemCheckSecureClientVerification`
  rows are visible evidence of the client's reported state at that time.
- **Retention/deletion today:** No independent expiry.
- **Sensitivity:** Low — device/software configuration facts.
- **Known gap:** None specific.

### 10. Installation identifiers

- **Category:** Public key, public-key fingerprint, key algorithm/
  protection level, client version, platform (`TetherClientInstallation`,
  `prisma/schema.prisma:2576`). The private key never leaves the
  student's device and is never transmitted or stored server-side.
- **Why/when collected:** Enables per-installation attestation and
  independent revocation (registered once per Tether installation).
- **Source:** Student's own Tether client, via the registration/proof-of-
  possession flow.
- **Who can view:** The student themselves (`listOwnedInstallations` —
  privacy-preserving: id/dates/status only, never the public key or
  fingerprint, per that function's own doc comment); institution staff
  for administrative purposes.
- **Influences integrity review:** Indirectly — enables device-change
  detection for recovery decisions.
- **Retention/deletion today:** Revoked (soft-deleted via `status:
  "REVOKED"`, `revokedAt`, `revocationReason`) but never hard-deleted —
  the row persists indefinitely as a historical record.
- **Sensitivity:** Low-medium — a public key alone is not sensitive, but
  the installation history (client version, platform, timestamps) is a
  device-usage record.
- **Known gap:** No hard-deletion path exists even for a student who
  wants their installation history fully removed (e.g. after leaving the
  institution) — only revocation.

### 11. Audit logs

- **Category:** Structured action records (`PlatformAuditLog`,
  `prisma/schema.prisma:186`) — actor, action, target type/id,
  institution, bounded metadata.
- **Why/when collected:** Accountability trail for security-relevant
  actions (installation registration/revocation, recovery grants/denials,
  etc.) — written via `createPlatformAuditLog` throughout the secure-
  client code paths.
- **Source:** Server-generated at the moment of the action.
- **Who can view:** Institution/platform administrators, not students.
- **Influences integrity review:** No — this is an operational/security
  trail, not exam-integrity evidence itself.
- **Retention/deletion today:** No independent expiry; persists
  indefinitely.
- **Sensitivity:** Low-medium — records actions, not content.
- **Known gap:** None specific — audit logs are conventionally expected
  to be long-retained, so the absence of a deletion path here is less of
  a gap than for the evidence types above.

## Summary of cross-cutting known gaps

1. **No retention/expiry mechanism existed for any evidence type**
   (screen, camera, network, integrity events) as of the start of this
   pass. A manual, operator-triggered retention runner now exists for
   `IntegrityEvidenceAsset` (screen + camera evidence images) specifically
   — see `docs/tether-evidence-retention-plan.md` for what was built, its
   deliberately-scoped limits, and why it is not wired into any automatic
   trigger. `IntegrityEvent` and `NetworkEvidence` remain unaddressed —
   see that document's "What was deliberately NOT done" section.
2. **Raw vs. hashed IP address coexistence** in `NetworkEvidence` is
   worth resolving explicitly in a future privacy hardening pass (prefer
   the hash unless the raw value is operationally required).
3. **No hard-deletion path for installation history** even after
   revocation.

None of these gaps are addressed by a schema or data change in this pass
— they are documented here as the accurate current state, per this
task's audit-first, no-fabricated-compliance-claims requirement.
