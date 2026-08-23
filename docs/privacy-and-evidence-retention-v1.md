# Tether Privacy + Evidence Retention Package v1

**This is an internal product-governance source of truth, not legal
advice and not a compliance certification.** It is written to support an
APP-aligned (Australian Privacy Principles) privacy approach and to form
the basis of customer-facing privacy schedules later. **Institutions must
confirm the privacy, education, records-management and other legal
requirements that actually apply to them** — those determinations require
each institution's own legal review, which this document does not
perform and does not substitute for. Tether is not necessarily governed
by, and does not assert, the same privacy legislation as every customer
or every institution.

This package is built directly from current source (`prisma/schema.prisma`,
API routes, and the feature docs cited throughout) and from two existing,
already-audited internal documents this pass treats as authoritative and
extends rather than duplicates:

- [`docs/tether-data-and-privacy-register.md`](tether-data-and-privacy-register.md) —
  the detailed, schema-grounded data-type-by-data-type register (what is
  collected, source, viewer, current retention state, sensitivity, known
  gap). This document's own Data Inventory (Section 4) summarises that
  register; the register itself remains the authoritative per-field
  detail.
- [`docs/tether-evidence-retention-plan.md`](tether-evidence-retention-plan.md) and
  [`docs/tether-evidence-archive-plan.md`](tether-evidence-archive-plan.md) — the
  existing, tested, manually-invoked evidence tooling (`npm run
  evidence:retention`, `npm run evidence:archive`) this document's
  retention/deletion sections build on.

---

## 1. Purpose and scope

This package exists to give Tether and its institutional customers an
accurate, current, honest account of:

1. what Tether actually collects today, and what it does not;
2. how ordinary assessment records differ from integrity evidence, and
   why that distinction matters for retention;
3. a conservative, workable v1 retention policy;
4. the current (manual, not automated) state of retention/deletion
   enforcement;
5. institutional and Tether responsibilities; and
6. the specific gaps that must be closed before Tether is used in an
   external institutional pilot.

Scope: the standalone Tether exam platform as it exists in this
repository today, including Secure Browser, session binding,
camera/screen integrity features, autosave/recovery, and the AI-assisted
features described below. It does not cover any institution's own
systems (LMS, SIS, identity provider), which remain that institution's
responsibility.

## 2. Privacy principles

Tether's product design is intended to support an **APP-aligned privacy
approach**, informed by the OAIC's Australian Privacy Principles as a
governance baseline:

- **Open and transparent management** (APP 1) — this package, the
  student-facing notice, and the data register are the mechanism for
  this; they are kept current as the product changes.
- **Collection** (APP 3) — Tether collects personal information only
  where a feature is enabled for a specific exam and only what that
  feature's documented design specifies; every optional monitoring
  feature is off by default (Section 6).
- **Notification of collection** (APP 5) — the student-facing exam
  privacy notice (Section 26) is shown before or at the start of an
  exam, describing what will be collected for that specific attempt.
- **Use and disclosure** (APP 6) — integrity evidence and assessment
  data are used only for exam delivery, integrity review, and grading;
  see Section 15 for the human-review boundary and Section 5 for
  purpose-by-data-class.
- **Security and destruction** (APP 11) — reasonable protection of held
  personal information, and reasonable steps to destroy or de-identify
  it once no longer needed, subject to lawful retention requirements —
  see Sections 18–21 for what "reasonable steps" means concretely in
  Tether's current (manual) v1 state.
- **Access and correction** (APP 12/13) — see Section 22.

This document does not reproduce APP text or OAIC guidance; it states
how Tether's actual design and operations relate to those principles.
**Institutions must independently confirm which privacy, education, and
records-management laws apply to their own use of Tether** (which may
include the Privacy Act, state/territory legislation, sector-specific
education-records rules, or non-Australian frameworks) — this document
does not make that determination on an institution's behalf.

## 3. Roles and responsibilities

Summarised here; the full, customer-facing version is
[`docs/institution-privacy-responsibilities-v1.md`](institution-privacy-responsibilities-v1.md).
This document deliberately does **not** assign formal "controller" /
"processor" (or equivalent) terminology to either party — that
determination depends on contract terms not yet settled, and asserting
it here would be exactly the kind of invented legal role this package
must avoid.

- **Institution**: decides which integrity features are appropriate for
  a given exam, determines its own lawful basis and student-notification
  requirements, owns academic-integrity review/appeals and final
  decisions, sets its own retention period, and manages accommodation,
  complaints, and legal-hold processes.
- **Tether**: operates the configured product controls as documented,
  maintains tenant/institution isolation, protects held data using the
  safeguards actually implemented, never silently enables optional
  monitoring, keeps the student-facing notice accurate, preserves the
  human-review boundary, and supports agreed operational
  deletion/offboarding processes.

## 4. Data inventory

This is a summary. **[`docs/tether-data-and-privacy-register.md`](tether-data-and-privacy-register.md)
is the authoritative per-field detail** (source file/line references,
exact retention state, sensitivity rating, and known gap per data type)
and should be read alongside this table.

| Data category | Examples | Feature that creates it | Purpose | Always / optional | Who can review | Proposed retention class | Current deletion enforcement | Notes / limitations |
|---|---|---|---|---|---|---|---|---|
| Account identifiers | User id, name, institutional student id, email | Signup / SSO | Identify the student/lecturer | Always | Self; institution admin | Class D | Tied to account lifecycle; no automated erasure | Never shown in full on the exam watermark — see Section 26 notice text |
| Answers & submission state | `Answer.response`, `Submission.status`, `currentQuestionIndex` | Exam-taking flow | The assessment itself | Always | Owning lecturer; institution admin | Class B | Tied to submission lifecycle (cascade only) | Never blurred with Class A retention (Section 19) |
| Timing information | `startedAt`, `submittedAt` | Exam-taking flow | Enforce time limit; timing-anomaly review | Always | Owning lecturer; institution admin | Class B | Tied to submission lifecycle | — |
| Integrity events | `IntegrityEvent` (type, severity, message, bounded metadata) | Secure Browser, camera, screen-share, session-binding, navigator, etc. | Review signals for lecturer decision-making | Always when the parent feature is enabled | Owning lecturer; `PLATFORM_ADMIN`; never other students | Class A | No independent expiry; cascade-only | Structurally rejects any image/frame/base64 metadata (Section 6) |
| Network/IP evidence | `NetworkEvidence.ipAddress` (raw), `.ipHash`, user-agent, browser/OS, `.country/.region/.city` (only if a geolocation provider is configured), `.vpnOrProxySignal`, `.networkChanged` | Exam start + exam submit | Detect anomalous network/location change between open and submit | Always (location fields only if provider configured) | Owning lecturer; `PLATFORM_ADMIN` | Class A | No independent expiry; cascade-only | **Raw IP is currently stored** alongside a hash — see Section 6, Section 27 item 1 |
| Session/device binding evidence | `ExamAttemptSession`, `SessionIntegritySignal` — hashed browser-session/device-token/network-prefix, coarse device profile | First exam heartbeat onward | Detect concurrent sessions / device or network changes mid-attempt | Always | Owning lecturer; `PLATFORM_ADMIN` (safe fields only — hashes never returned) | Class A | No independent expiry; cascade-only | **Raw IP is never stored by this feature** — only an HMAC-hashed `/24`/`/48` prefix (distinct from Network/IP evidence above) |
| Camera permission/health events | `CAMERA_PERMISSION_GRANTED/DENIED`, `CAMERA_STARTED/STOPPED`, `CAMERA_HEARTBEAT_MISSED` | Camera Monitoring v1 | Confirm camera availability during a monitored exam | Optional (lecturer-enabled) | Owning lecturer; `PLATFORM_ADMIN` | Class A | No independent expiry; cascade-only | Status only — no image, no video |
| On-device AI camera integrity signals | Confidence score, confidence band, model name/version, detection interval (numeric/text metadata only) | On-device AI camera checks | Flag possible phone / second person / no person / blocked / dark camera for review | Optional (lecturer-enabled) | Owning lecturer; `PLATFORM_ADMIN` | Class A | No independent expiry; cascade-only | Runs entirely in-browser; pixel data never leaves the device for this signal |
| Camera evidence stills | `IntegrityEvidenceAsset` (`kind: AI_CAMERA_EVIDENCE_FRAME`) — one low-resolution JPEG/WebP still, ≤300KB | Optional evidence-frame capture | Give a human reviewer a still image alongside a phone/second-person signal | Optional — requires a **second**, separately-enabled setting on top of AI camera checks | Owning lecturer; `PLATFORM_ADMIN`, via an audited view route only | Class A | **Manual retention tool exists** (`npm run evidence:retention`) — see Section 20 | Captured only for `POSSIBLE_PHONE_VISIBLE`/`POSSIBLE_SECOND_PERSON_VISIBLE`, once per logged event, never continuous |
| Screen-share lifecycle evidence | `SCREEN_SHARE_STARTED/INTERRUPTED/RESTORED/...` events | Screen-share evidence mode | Review signal for sharing interruptions | Optional (lecturer-enabled) | Owning lecturer; `PLATFORM_ADMIN` | Class A | No independent expiry; cascade-only | No audio; no continuous recording |
| Screen-share evidence stills | `IntegrityEvidenceAsset` (`kind: SCREEN_SHARE_EVIDENCE_FRAME`) — bounded still frames, ≤500KB each, 1–50 per attempt | Optional screen evidence capture | Give a human reviewer periodic/interruption-triggered screen stills | Optional — nested under the screen-share requirement | Owning lecturer; `PLATFORM_ADMIN`, via an audited view route only | Class A | **Manual retention tool exists** (same runner as camera stills) — see Section 20 | Highest-sensitivity data type — may show unrelated content visible on screen |
| AI brainstorming interactions | `AiAssistanceInteraction` — student prompts, verified/approved responses | Controlled AI Brainstorming Assistance | Part of the assessment record when the assistant is used as intended | Optional (lecturer-enabled) | Owning lecturer, same as answers | Class B | Tied to submission lifecycle | Treated as assessment record, not integrity evidence — using it as intended is not an integrity concern |
| AI draft marking data | AI-suggested essay score/feedback, always labelled "AI draft" until a lecturer approves | AI-assisted marking | Speed up marking; never a final grade on its own | Optional (lecturer-enabled) | Owning lecturer | Class B | Tied to submission lifecycle | Lecturer must review/approve/change before a grade is finalised |
| Answer-development/provenance records | `AnswerDevelopmentVersion/Event/Artifact` — readable answer checkpoints, paste/edit size metadata, optional outline/calculation/code workspaces | Answer-Development Provenance (opt-in, default OFF) | Process evidence of how an answer developed, for lecturer review | Optional (lecturer-enabled) | Owning lecturer | Class A (process evidence) or B (where it forms part of the graded record, per institution configuration) | No independent expiry; cascade-only | Never keystroke-level; never full clipboard capture — see `docs/answer-development-provenance-v1.md` |
| Secure-client/session operational evidence | `SecureClientSession`, `SecureClientEvent`, `TetherClientInstallation`, `SecureClientAttestation` | Tether Secure Browser session lifecycle | Confirm a genuine, current secure-client session; enable device-change/recovery decisions | Always when Secure Browser mode is used | Owning lecturer; `PLATFORM_ADMIN` | Class A/C mix (see register) | Installation rows are revoked, never hard-deleted (known gap — Section 27) | Private keys never leave the student device; server holds only public-key fingerprints |
| Platform audit logs | `PlatformAuditLog` | Security/administrative actions across the platform | Accountability trail, not exam-integrity evidence itself | Always | Institution/platform administrators only | Class C | No independent expiry; persists indefinitely | Not visible to students or lecturers reviewing exams |

## 5. Collection purpose by data class

- **Class A (integrity evidence)** exists to give a human reviewer
  context for a specific, logged signal. It is never collected as a
  general surveillance stream — every optional capture is scoped to a
  specific triggering condition (Section 6).
- **Class B (assessment records)** exists because it *is* the assessment
  — answers, timing, and (where enabled) AI-assistance interactions that
  are part of how the response was produced.
- **Class C (operational/security logs)** exists for platform
  accountability and troubleshooting, not for academic-integrity review.
- **Class D (account/tenancy data)** exists to operate the service
  relationship itself.

## 6. Collection minimisation

Every optional monitoring feature (camera monitoring, AI camera checks,
camera/screen evidence stills, screen-share requirement, session
binding's coarse fingerprinting, answer-development provenance, AI
brainstorming) is **off by default** and must be explicitly enabled per
exam by the institution/lecturer. Enabling a feature never retroactively
applies to an exam already in progress or already taken. `POST
/api/submissions/[id]/integrity-events` structurally rejects any request
whose metadata contains an image/frame/screenshot/base64/blob-shaped key
or value — this is enforced in code, not only by convention.

**Free-text and metadata fields.** A small number of fields accept
free-text input capable of containing personal information beyond what
this document otherwise enumerates, each with a bounded purpose:
submitted answer text (assessment content, Class B); lecturer/reviewer
comments on an integrity review (`IntegrityReviewComment.comment`) and
integrity-review status-change reasons, both scoped to authorised
reviewers of that institution; AI brainstorming prompts and their
verified responses, recorded as part of the assessment record when that
feature is enabled; AI draft-marking feedback/response text, visible
only to the lecturer until finalised; and a `reason` field on academic
holds and similar status changes. None of these are redesigned in this
pass — they are documented here as existing, purpose-bound fields, not
as a defect. Institutions and reviewers should avoid entering
unnecessary personal information about third parties into free-text
review fields, since this document cannot enforce that at the field
level.

## 7. Camera monitoring

Base Camera Monitoring v1 (camera-required exams without the AI
integrity-check feature): checks camera availability at exam start,
monitors availability during the exam, and records status events only
(`CAMERA_PERMISSION_GRANTED/DENIED`, `CAMERA_STARTED/STOPPED`,
`CAMERA_HEARTBEAT_MISSED`). It does **not** record, stream, or store
video or images, and does not use facial recognition. The camera stream
is requested video-only (`getUserMedia({ video: true, audio: false })`)
— camera audio is never requested.

## 8. AI camera integrity checks

Optional, lecturer-enabled, runs entirely on the student's own device
against the same camera stream already used for the preview. Produces
only numeric/text signals (confidence score, confidence band, model
name/version, detection interval) sent as `IntegrityEvent` metadata —
raw pixel data never leaves the browser as part of this signal. Does
not use facial recognition, biometric templates, gaze tracking, or
emotion detection, and never makes an automatic misconduct
determination. See `docs/on-device-ai-integrity-detection-v1.md`.

## 9. Camera evidence frames

A **second**, independently-enabled, opt-in setting on top of Section 8.
When enabled, exactly one low-resolution still (≤300KB, JPEG/WebP,
downscaled to at most 640×360) is captured per newly-logged
`POSSIBLE_PHONE_VISIBLE`/`POSSIBLE_SECOND_PERSON_VISIBLE` event — never
continuous, never a video, never the exam screen. Image bytes are never
stored inline in the database; only an opaque `storageKey` is stored,
resolved server-side only through an authenticated, ownership-checked,
audit-logged view route. See `docs/on-device-ai-integrity-detection-v1.md`,
"Evidence Frames v1."

## 10. Screen-share evidence

Optional, lecturer-enabled, `REQUIRED` mode only (entire-screen sharing,
started by a direct student click). No microphone or system audio is
ever captured. No continuous screen recording is retained or uploaded —
the `MediaStream` itself is never piped to a recorder. Lifecycle events
(started/interrupted/restored/etc.) are always recorded when the feature
is on; a **nested**, separately-enabled setting additionally allows
bounded still frames (≤500KB each, 1–50 per attempt, minimum 30-second
interval) for lecturer review. See `docs/screen-share-evidence-v1.md`.

## 11. Network/location evidence

Recorded once at exam start and once at submission: IP address (raw,
stored — see Section 27 item 1 — plus a separate HMAC-SHA256 hash),
user-agent, parsed browser/OS/device type, and (only when an operator
has configured `GEOLOCATION_PROVIDER`; the default is `none`) approximate
country/region/city/timezone and a VPN/proxy signal. Not GPS. Location
accuracy is affected by VPNs, mobile networks, campus NAT, and ISP
routing. This is a distinct system from Section 12's session-binding
evidence, which never stores a raw IP. See
`docs/network-evidence-and-ip-location.md`.

## 12. Secure Browser/session evidence

Exam-attempt session binding uses two server-issued, HMAC-hashed,
first-party cookies (a short-lived browser-session token and a
longer-lived device token) plus a coarse device-profile fingerprint
(browser/OS family, device category, bucketed screen size, language,
timezone — never canvas/WebGL/audio fingerprinting, never exact screen
dimensions). **No raw IP is ever stored by this feature** — only an
HMAC-hashed network prefix (`/24` IPv4, `/48` IPv6). Tether Secure
Browser session lifecycle (installation attestation, launch manifests,
heartbeats) is covered under "secure-client/session operational
evidence" in the data inventory. See `docs/exam-session-binding-v1.md`.

## 13. Assessment/answer records

Answers, grades, feedback, and (where the institution's exam design
enables it) AI-assistance interactions and answer-development
provenance that form part of the graded record are **Class B**, governed
by the institution's own academic-record retention requirements and
contract — never automatically subject to the Class A integrity-evidence
schedule (Section 19).

## 14. Optional AI functionality

Two independent, both lecturer-enabled, both off by default:

- **AI-assisted draft marking** — an AI-suggested score/feedback for
  essay questions, always labelled "AI draft," never a final grade; a
  lecturer must review, approve, or change it.
- **Controlled AI Brainstorming Assistance** ("Tether Controlled AI") —
  a heavily restricted assistant that cannot supply answers, MCQ
  options, submission-ready prose, or complete code; every response is
  independently verified before being shown to the student. Prompts and
  approved responses are recorded as part of the assessment record. See
  `docs/controlled-ai-brainstorming-assistance-v1.md`.

## 15. Human review and decision making

**Tether does not automatically determine academic misconduct.** Every
integrity signal, evidence frame, and review-workflow status
(`NEEDS_REVIEW`/`REVIEWED_NO_CONCERN`/`REVIEWED_CONCERN_REMAINS`/
`ESCALATED`/`RESOLVED`) exists to support a human reviewer's judgement.
The evidence-review workflow's own recommendation function outputs only
`NO_IMMEDIATE_ACTION | LECTURER_REVIEW_RECOMMENDED |
ORAL_VERIFICATION_RECOMMENDED | ESCALATION_RECOMMENDED` — never an
automatic finding. Final academic and integrity decisions belong to the
institution. See `docs/evidence-review-workflow-v1.md`.

## 16. Access control

- **Lecturer (exam owner)** and **`PLATFORM_ADMIN`**, same institution,
  can review integrity events, network evidence, session-binding
  signals, and evidence frames for exams they own or administer.
- **Students** receive 401/403 on every evidence-review route and can
  never view another student's submission, integrity evidence, or
  network evidence.
- **Cross-institution isolation** is enforced through a centralised
  institution-scoping module (`src/lib/institutionScope.ts`) used
  consistently across lecturer and evidence-review routes — a session
  from one institution cannot read another institution's exam,
  submission, or evidence rows.
- **Evidence-frame image views are audit-logged.** Every successful
  `GET /api/integrity-evidence/[evidenceAssetId]` call is recorded to
  `PlatformAuditLog` (action `VIEW_AI_CAMERA_EVIDENCE_FRAME`, actor,
  role, submission/exam ids, evidence asset id — never the image
  itself). Review-status changes and reviewer comments are separately
  audit-logged (Section 4 of `docs/evidence-review-workflow-v1.md`).
  This document does not claim that every ordinary read (e.g. loading
  the evidence report page itself) is separately audit-logged beyond
  the standard authorisation check — only the specific actions named
  above are confirmed to write an audit row.

## 17. Storage/provider boundaries

Evidence images are stored in a provider-abstracted evidence-storage
layer (`src/lib/evidenceStorage.ts`). In production, the supported
provider is a **private** Supabase Storage bucket, accessed only with a
server-only service-role key never exposed to the client; the
`local_dev` filesystem provider must never be used in production.
Storage keys are opaque and never returned to any client. See Section 24
for the cross-border/subprocessor register this section feeds into.

## 18. Retention schedule

**Retention target, not a claim of automated enforcement.** See Section
20 for exactly what is and is not automated today.

### Class A — Integrity evidence

Includes: integrity-event metadata, network integrity evidence, camera
evidence stills, screen-share evidence stills and lifecycle evidence,
and relevant secure-session integrity evidence.

**Target retention:** the institution's applicable
assessment/academic-integrity review and appeal period, **plus 30
days**. Where no institution-specific period has been agreed for a
controlled pilot, **180 days after final submission** is the proposed
operational fallback, subject to institution approval.

**Current v1 enforcement is manual/operational, not automated.** See
Section 20.

### Class B — Assessment records

Includes: answers, grades, feedback, allowed AI-assistance interactions
that form part of the assessment record, and answer-development
provenance where configured as part of the graded record.

**Retention:** governed by the institution's academic-record
requirements and contract. The Class A destruction schedule must never
be automatically applied to Class B records — see Section 19.

### Class C — Operational/security logs

**Target:** 90 days, unless needed for an active security incident,
troubleshooting, a fraud/security investigation, or a legal obligation
or hold. This document only describes logs actually known to exist
(`PlatformAuditLog`) — it does not assert coverage of infrastructure
logs outside this codebase's control (e.g. hosting-provider platform
logs), which are governed by that provider's own terms.

### Class D — Account/tenancy data

**Retention** governed by the active service relationship, institution
offboarding, applicable contract, and legal retention requirements. No
account-erasure automation is implemented or claimed.

## 19. Legal/academic-integrity holds

A hold must:

- apply only to the specific records actually needed for the matter;
- have a documented reason;
- have a named owner;
- have a start date;
- have a review date;
- prevent ordinary destruction only for the affected records, never a
  blanket freeze on unrelated data; and
- be released, and the affected records returned to the ordinary
  retention schedule, once no longer needed.

**No database legal-hold feature is implemented in this pass.** A hold
today is an operational commitment (recorded in the retention register —
Section 20, and `docs/evidence-retention-operations-v1.md`) checked
manually before any destruction step, not a system-enforced block.

## 20. Manual deletion process — current v1

**Automated, scheduled expiry/deletion is not implemented.** There is no
cron job, no scheduler, and no route in this codebase that deletes
evidence on a timer.

**What does exist**, and should be described accurately rather than
either overstated or ignored:

- A tested, manually-invoked retention runner
  (`npm run evidence:retention`) exists for **`IntegrityEvidenceAsset`
  rows only** — the camera and screen-share evidence stills (Sections 9
  and 10). It is age-based on `capturedAt`, defaults to a 90-day window
  (`EVIDENCE_RETENTION_DAYS`), is **dry-run by default**, requires an
  explicit `--execute` flag to delete anything, deletes the storage
  object before the database row, and writes a `PlatformAuditLog` row
  (`INTEGRITY_EVIDENCE_RETENTION_DELETED`) atomically with each
  deletion. See `docs/tether-evidence-retention-plan.md` and
  `src/lib/evidenceRetentionRunner.ts`.
- This runner has **no awareness of legal/academic holds or active
  appeals** — eligibility is purely age-based. An operator must manually
  confirm (via the retention register process in
  `docs/evidence-retention-operations-v1.md`) that no eligible asset is
  under an active hold before ever running `--execute`.
  **IMPLEMENTATION GAP — hold-aware, self-service retention enforcement
  is not yet implemented; every `--execute` run today depends on a
  human operator's manual check.**
  **IMPLEMENTATION GAP — safe administrative evidence-destruction
  workflow required before automated/self-service retention claims can
  be made.**
- This runner does **not** cover `IntegrityEvent` rows or
  `NetworkEvidence` rows — those have no deletion tooling at all today,
  automated or manual, beyond cascade-on-parent-deletion (Section 21).
  Extending coverage is a deliberate future scoping decision, not an
  oversight — see `docs/tether-evidence-retention-plan.md`, "What was
  deliberately NOT done in this pass."
- This runner has **no built-in Production-target safety rail** — unlike
  `npm run release:validate`'s disposable-database guard, it will run
  against whatever `DATABASE_URL` is configured, and relies entirely on
  the operator having deliberately pointed their environment correctly.
  **PRE-PILOT GATE — a Production-target confirmation step should be
  added before this tool is used operationally against a real
  institution's data.**

Do not read the existence of this tool as a claim that retention is
enforced today — it is a real, tested capability that requires a human
to run it deliberately, following the register process in
`docs/evidence-retention-operations-v1.md`.

## 21. Backup/deletion boundary

Deletion/destruction treatment for **backups** must be aligned with the
Backup/DR Runbook, which is a **separate release-readiness item** not
covered by this package. This document does not claim that deleting a
row/object via the retention runner immediately removes it from any
backup or archive copy.

A separate, tested, manually-invoked **evidence archive** tool exists
(`npm run evidence:archive`) that copies verified evidence objects to a
second, independent storage location for disaster-recovery purposes —
see `docs/tether-evidence-archive-plan.md`. The archive adapter has **no
`delete()` capability at all** (by design), so archiving evidence is not
the same operation as retiring it, and running the retention runner does
**not** remove any already-archived copy. No real archive project has
been provisioned and no Production evidence has been archived or
restored as of this pass.

## 22. Access/correction requests

- **Student**: the institution is the first point of contact for exam
  records, integrity review, and any access/correction or academic-
  decision request.
- **Institution**: can escalate platform-data questions to Tether
  through the agreed support channel.
- **Tether**: responds according to the applicable contract and privacy
  requirements once that channel exists — see Section 25 for the
  current gap (no live support channel/contact is invented here).

## 23. Security incident cross-reference

Suspected unauthorised access, disclosure, or loss of personal
information must enter Tether's incident-response process. Any
applicable Notifiable Data Breaches (NDB) scheme assessment or
notification obligation is handled under a **separate**
`AUSTRALIAN_INCIDENT_NDB_PROCEDURE_V1` release-readiness item, not yet
written. This package does not itself determine whether any given
incident is an eligible data breach, and does not overstate what
protection currently exists.

## 24. Cross-border/subprocessor disclosure

**Pre-pilot register template** — to be populated with verified facts
only, never assumed. This is required because APP 5 notices may need to
describe likely overseas disclosures where applicable.

| Provider | Service / purpose | Data categories handled | Configured region | Possible overseas processing/access | Contractual/privacy terms reviewed | Status |
|---|---|---|---|---|---|---|
| Vercel | Application hosting | All request/response data in transit; no independent storage | Not verified from deployment configuration in this pass | Not verified | Not verified | **PRE-PILOT GATE** |
| Supabase | Database + evidence storage | All Class A/B/C/D data at rest | Not verified from deployment configuration in this pass | Not verified | Not verified | **PRE-PILOT GATE** |
| Anthropic | AI-assisted draft marking; Controlled AI Brainstorming Assistance (only when enabled) | Question text, student prompts/answers submitted for AI processing, when the relevant optional feature is enabled | Not verified from deployment configuration in this pass | Not verified | Not verified | **PRE-PILOT GATE** |
| Geolocation provider (optional, `GEOLOCATION_PROVIDER`) | IP-based coarse location | IP address, when the provider is enabled (default: not enabled) | Not verified | Not verified | Not verified | **PRE-PILOT GATE — provider must remain `none` until the existing pre-activation checklist in `docs/network-evidence-and-ip-location.md` is complete** |

No processing country, data-residency claim, or subprocessor beyond the
providers actually identifiable from this codebase's own configuration
is asserted. Every row above is a **PRE-PILOT GATE** until verified
against actual deployment configuration and reviewed against each
provider's own terms.

## 25. Institution responsibilities

See `docs/institution-privacy-responsibilities-v1.md` for the full,
customer-facing version.

## 26. Student transparency

The student-facing notice lives at `/privacy/student-exam-notice`
(`src/app/privacy/student-exam-notice/page.tsx`) and is updated as part
of this pass — see the change summary in this task's final report. It
is deliberately plain-language and is not a substitute for an
institution's own privacy policy, which may also apply.

## 27. Known gaps / pre-pilot gates

Consolidated from the sections above, plus items identified during this
pass's data-minimisation review (Section 6):

1. **Raw IP retention.** `NetworkEvidence` currently stores both
   `ipAddress` (raw) and `ipHash`. **PRE-PILOT GATE** — confirm whether
   retaining raw IP after coarse-location/network-integrity processing
   is necessary for the defined purpose, or whether hash/coarse-derived
   evidence is sufficient. Not changed in this pass.
2. **Evidence-image retention automation.** A manual, tested tool exists
   for `IntegrityEvidenceAsset` only (Section 20); it is not
   hold-aware and has no Production-target safety rail.
   **IMPLEMENTATION GAP.**
3. **`IntegrityEvent`/`NetworkEvidence` retention.** No deletion tooling
   of any kind, beyond cascade-on-parent-deletion. **IMPLEMENTATION
   GAP.**
4. **No hard-deletion path for `TetherClientInstallation` history** even
   after revocation — see `docs/tether-data-and-privacy-register.md`
   item 10.
5. **Subprocessor/cross-border register unpopulated** — Section 24 is a
   template only; every row is a **PRE-PILOT GATE**.
6. **Legal entity and privacy contact not yet registered** — see Section
   25 and the student notice's own "Questions or concerns" section,
   which deliberately keeps institution-first contact wording until a
   legal entity, privacy contact, and full platform privacy policy
   exist. **PRE-PILOT GATE.**
7. **NDB/incident procedure not yet written** — Section 23.
   **PRE-PILOT GATE.**
8. **Legal-hold enforcement is manual only** — Section 19.
   **IMPLEMENTATION GAP.**
9. **Backup/DR runbook is a separate, not-yet-written release-readiness
   item** — Section 21. **PRE-PILOT GATE.**

## 28. Version/change control

| Version | Date | Change |
|---|---|---|
| v1 | 2026-08-23 | Initial package: this document, `docs/institution-privacy-responsibilities-v1.md`, `docs/evidence-retention-operations-v1.md`, and the student-facing notice update (`compliance/privacy-evidence-retention-v1` branch). No schema, migration, or evidence-collection behaviour changed. |
