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

## Capacity

- Recommended: 30–40 students per exam on the current Vercel + Supabase
  free tier
- 50 students tested: 94–96% success rate under simultaneous load
- 50+ students: upgrade to Vercel Pro + Supabase Pro and retest before
  running

See docs/concurrent-exam-pilot-capacity.md for the full load test
results and methodology.

## Multi-tenancy

- The current deployment is single-tenant
- All lecturer data is isolated by account
- Enterprise multi-institution isolation is not yet implemented
- Suitable for single-institution pilots only

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
