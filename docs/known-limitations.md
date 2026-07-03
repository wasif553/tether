# Safe Exam System — Known Limitations v1

This document is the single source of truth for what SES does and does
not do today. Share it with any prospective pilot partner alongside
docs/pilot-proposal-template.md.

## Browser-based secure mode

SES Secure Exam Mode runs inside a normal web browser. This means:

- SES can block copy/paste, right-click, and selected keyboard shortcuts
  inside the exam page (best-effort)
- SES cannot close other browser tabs
- SES cannot prevent a student from opening a new window before the exam
  starts
- SES cannot block OS-level application switching
- Full lockdown requires a dedicated lockdown browser (planned as a
  future optional mode)

## Camera monitoring

Camera Monitoring v1 checks camera availability only:

- Confirms camera permission is granted
- Monitors camera availability during the exam via a heartbeat check
- Does not record video
- Does not store images
- Does not perform face recognition
- Does not verify student identity
- Does not detect phone usage
- Does not track eye gaze

Persistent Camera Preview v1 keeps a live, local-only preview of the
student's own camera visible (and minimizable) for the whole exam, not
just the pre-exam check:

- The preview is rendered entirely in the student's browser — no video
  or image is ever sent to the server, recorded, or stored
- Minimizing/restoring the preview is local UI state only; it never
  pauses camera monitoring or the heartbeat, and never creates an
  integrity event or affects a student's risk score
- Only a real interruption to the camera itself — the stream stopping,
  permission being revoked, the video track going inactive, or a missed
  heartbeat — produces an integrity event

Safe Exam Deep Link v1 lets a lecturer share a direct link to a
published exam:

- The link is a convenience shortcut only — it runs through the exact
  same institution/course/assignment/availability checks as the normal
  dashboard, and still requires login and (if configured) the access
  code
- It grants no access beyond what the student's existing enrolment or
  assignment already permits

Real-device camera hardware verification (actual preview rendering,
minimize/restore, camera-loss event) is still pending human signoff —
see docs/camera-preview-and-deep-link-pilot-signoff.md.

## Live proctoring (not implemented)

SES does not currently support live proctoring. Camera Monitoring v1
and Persistent Camera Preview v1 are both **local-only** — a
student's camera stream never leaves their own browser today; no one
else can view it live. A future Live Proctoring v1 (authorised
proctors viewing a student's live camera and screen, nothing
recorded) would require external WebRTC/SFU media infrastructure that
does not exist in this codebase, plus its own privacy review and
vendor/sub-processor approval, before any implementation begins. See
docs/live-proctoring-v1-design-audit.md for the full design audit —
design only, not built, and not scheduled ahead of the first
controlled pilot unless a confirmed pilot partner requires it.

## Capacity

- Recommended: 30–40 students per exam on the current Vercel + Supabase
  free tier
- 50 students tested: 94–96% success rate under simultaneous load
- 50+ students: upgrade to Vercel Pro + Supabase Pro and retest before
  running

See docs/concurrent-exam-pilot-capacity.md for the full load test
results and methodology.

## Multi-tenancy

Multi-Tenant Architecture v1 is implemented (see
docs/multi-tenant-migration.md for the schema, scoping helpers, and routes
involved):

- `User`, `Exam`, and `LtiPlatform` carry a nullable `institutionId`;
  application code (`src/lib/institutionScope.ts`) treats it as required
  and fails loudly (re-login prompt) rather than silently scoping to
  nothing when it's missing.
- Lecturers and students only see exams, submissions, analytics, and
  evidence reports within their own institution. A `PLATFORM_ADMIN` role
  can bypass institution scoping for support/operations purposes.
- Models without their own `institutionId` column (`Submission`,
  `Answer`, `IntegrityEvent`, `CanvasGradePassback`, `LtiLaunch`,
  `LtiExamLink`) are scoped by joining to their parent (`exam.institutionId`
  or `platform.institutionId`) rather than duplicating the column.
- All existing single-institution pilot deployments keep working
  unchanged: a one-time seed backfills every existing row into a single
  "default" institution, and self-signup defaults new users into it.

Platform Admin Onboarding v2 is implemented (see
docs/platform-admin-onboarding.md):

- A `PLATFORM_ADMIN` can create institutions, list them with counts,
  activate/deactivate them, and invite lecturers directly into a
  specific institution from `/platform/institutions`.
- There is still no email-sending flow — invited lecturers' temporary
  passwords must be shared with them out of band by the platform admin.
- A minimal `PlatformAuditLog` records institution create/update,
  lecturer-invite, and student-invite actions (actor, action, target,
  institution, timestamp). It is not a full compliance audit trail.
- Still not implemented: billing, enterprise SSO, student bulk import,
  institution deletion.

Student Onboarding and Exam Access v1 is implemented (see
docs/student-onboarding-and-exam-access.md):

- A `PLATFORM_ADMIN` can invite students directly into a selected
  institution (`POST /api/platform/institutions/[id]/invite-student`),
  the same way lecturers are invited — no email sending, temporary
  password shared out of band.
- A lecturer can optionally set a per-exam access code; only the hash is
  stored (bcrypt), never the plaintext. A student must enter the correct
  code before a submission is created for that exam. Access code is
  independent of course/enrolment visibility — see
  docs/course-enrolment-and-exam-assignment.md.

Course, Enrolment, Exam Assignment, Scheduling v1 is implemented (see
docs/course-enrolment-and-exam-assignment.md):

- Lecturers can create courses, enrol students, and assign an exam to a
  whole course or to selected students within it.
- Exams support explicit `availableFrom`/`availableUntil` scheduling,
  independent of the pre-existing exam-duration fields.
- Exams with no course (`courseId: null`) remain visible institution-
  wide exactly as before this feature — no existing published exam
  became invisible when this shipped.
- Not implemented: bulk/CSV student enrolment, course archival/term
  rollover, per-course analytics, and Canvas course auto-mapping (the
  Canvas mapping fields on Course exist but are not yet wired to any
  LTI launch behavior).

Assessment Operations v1 is implemented (see
docs/assessment-operations-v1.md):

- Students have an optional `institutionStudentId`, set only via the
  platform-admin invite-student flow — not a login credential, not
  unique-constrained at the database level in v1 (deferred rather than
  enforced; see that doc for why).
- Lecturers can paste multiple questions at once ("Add multiple
  questions" on the exam edit page) with row-level preview/validation
  before saving; an invalid batch is never partially saved.
- Lecturers can export final marks/results per exam as a full CSV/Excel
  report, a minimal Canvas/IRM-upload-ready CSV/Excel file, or a PDF
  report — all three use the exact same ownership/institution access
  check as the existing analytics and evidence exports.
- Not implemented: bulk/CSV student ID import (IDs are entered one at a
  time via invite-student), a dedicated student-ID uniqueness
  constraint, and a CSV-paste bulk-question format (only the structured
  text format is implemented in v1).

## Tether Secure Browser (Electron lockdown client)

Electron Packaging v1 produces pilot installers (Windows NSIS, macOS
DMG) from `apps/lockdown` — see `apps/lockdown/PILOT-INSTALL.md`:

- Unsigned, unnotarized — Windows SmartScreen and macOS Gatekeeper will
  warn on install. Suitable for controlled pilot distribution only, not
  public distribution.
- Detection and soft enforcement only — the app itself performs no
  hard OS-level blocking, no kiosk mode, and does not claim to prevent
  cheating. See `docs/lockdown-browser-known-limitations.md`.
- No auto-update — every pilot requires a freshly built installer.
- No MDM/managed deployment path.
- Placeholder app icons — production branding assets not yet created.

## Controlled pilot

For operating a real-student pilot within the known limitations above,
see `docs/controlled-pilot-operator-guide.md`. It covers pre-pilot
setup, exam-day procedure, student and lecturer troubleshooting,
post-pilot evidence collection, and the go/no-go capacity and policy
conditions for scaling up.

## Canvas/LTI

- Canvas integration is optional
- Grade passback architecture is complete
- A real Canvas `SENT` status requires a live Canvas sandbox with a
  registered Developer Key
- Moodle and Blackboard are not yet supported

## AI features

- AI is optional — the app works fully without it
- Requires `ANTHROPIC_API_KEY` to be configured
- AI question generation and essay marking are available
- AI essay marking provides draft scores only — the lecturer must
  approve all final grades

## Compliance

- Not SOC 2 certified
- Not ISO 27001 certified
- Not IRAP assessed
- A privacy notice is provided for students
  (`/privacy/student-exam-notice`)
- The institution is responsible for compliance with local privacy laws
  (FERPA, GDPR, Australian Privacy Act)
