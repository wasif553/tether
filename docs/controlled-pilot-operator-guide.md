# Safe Exam System — Controlled Pilot Operator Guide

This guide covers everything the operator (the person running SES on
behalf of the institution) needs to prepare, run, and close out the
first real-student pilot. Read it alongside
`docs/pilot-proposal-template.md` and share relevant sections with the
lecturer and students before exam day.

## 1. Pilot scope

| Parameter | Recommended | Hard limit |
|-----------|-------------|------------|
| Students per exam | 10–30 | 40 concurrent |
| Exams per pilot | 1–3 | — |
| Lecturers | 1–3 | — |
| Institutions | 1 | — |
| Pilot duration | 2–4 weeks | — |

**Keep the first pilot to a single institution.** Multi-institution
isolation is implemented and tested, but running support across multiple
institutions simultaneously has not been rehearsed.

**40 concurrent students is the safe ceiling** on the current Vercel +
Supabase free tier. 50 students were load-tested at 94–96% success
rate; above 40 is a known risk zone. If the pilot will have more
students, upgrade to Vercel Pro + Supabase Pro before the exam and
retest.

**Electron Lockdown Browser** is optional for the first pilot. If the
institution wants to require it, communicate this policy to students
before exam day — the platform currently shows a "Lockdown Browser
Active" badge when the app is in use but does not hard-block students
who open the exam in a regular browser. Enforcement of the lockdown
browser requirement is currently an institutional policy matter, not
an automatic technical gate.

---

## 2. Roles and responsibilities

### Platform Admin (operator)
- Creates the institution in SES
- Invites lecturers and students
- Handles account issues on exam day
- Monitors `/api/health` and `/api/readiness`
- Shares temporary passwords securely (out of band — SES has no email
  sending in v1)
- Is the escalation point for anything the lecturer cannot resolve

### Lecturer
- Creates, configures, and publishes the exam
- Sets the access code and shares it with students only at exam start
- Monitors submissions during the exam window
- Reviews integrity events after the exam
- Grades essay questions
- Downloads evidence reports and analytics
- Makes all final academic integrity decisions

### Student
- Signs in with credentials provided by the operator
- Reads the privacy notice before starting
- Enters the access code when instructed by the lecturer
- Takes the exam in a stable, distraction-free environment
- Contacts the operator or lecturer if they cannot log in

### Support/operator on exam day
- Reachable by the lecturer for account issues
- Can reset a student's password by updating it via the PLATFORM_ADMIN
  invite flow (create a new account with the same email — if blocked by
  409, contact the operator to update the account directly)
- Does **not** need to be physically present; a direct-message channel
  with the lecturer is sufficient for a small pilot

---

## 3. Pre-pilot checklist

Complete this at least 24 hours before the exam, not on exam day.

### Platform setup
- [ ] `GET https://tether-murex.vercel.app/api/health` returns
      `database: "ok"`
- [ ] `GET https://tether-murex.vercel.app/api/readiness` shows all
      core booleans true

### Institution and accounts
- [ ] Sign in as PLATFORM_ADMIN and open `/platform/institutions`
- [ ] Create the pilot institution (name, slug, plan = `"pilot"`)
- [ ] Invite the lecturer: name, email, temporary password (8+ chars)
- [ ] Invite each student: name, email, temporary password (8+ chars)
- [ ] Confirm audit log shows `institution.create`, `lecturer.invite`,
      and one `student.invite` per student
- [ ] Share each credential **securely** — use a password manager,
      encrypted message, or in-person handover; never plain email or
      chat

### Exam setup (lecturer task — verify before exam day)
- [ ] Lecturer signs in and creates the exam with the correct duration
- [ ] All question types present (MCQ, short answer, essay as needed)
- [ ] Secure Exam Mode configured (fullscreen required recommended;
      camera optional — requires webcam)
- [ ] Access code set (4+ characters; the code is never stored
      in plaintext; the lecturer must remember it or note it securely)
- [ ] Exam published — confirm "Published" status on exam detail page
- [ ] Lecturer visits `/lecturer/pilot-readiness` and confirms no
      unexpected red items in core section

### Optional: SES Secure Exam Browser (Electron Lockdown Browser)
- [ ] If required, build the pilot installer (`apps/lockdown` —
      `npm run dist:win` on Windows, `npm run dist:mac` on macOS; see
      `apps/lockdown/PILOT-INSTALL.md`) and distribute it to students
      through an approved channel before exam day
- [ ] Test the installer yourself at least 24 hours before exam day —
      it is unsigned and will trigger a SmartScreen/Gatekeeper warning
      (expected; documented in `apps/lockdown/PILOT-INSTALL.md`)
- [ ] Complete the physical sign-off checklist in
      `apps/lockdown/PILOT-INSTALL.md` → "Pre-pilot sign-off" by
      physically viewing a real screen — remote/automated testing
      cannot verify this app's on-screen behavior because content
      protection excludes its window from screenshots and screen-share
- [ ] Test that the "SES Lockdown Browser Active" badge appears on the
      exam page when the app is running
- [ ] Communicate to students whether the app is required, how to
      install it, and the SmartScreen/Gatekeeper warning they'll see

### Final pre-flight
- [ ] Confirm a direct support channel between operator and lecturer
      is open (messaging app, phone, etc.)
- [ ] Note the exam start time and duration; calculate the latest
      acceptable start time for stragglers
- [ ] Run one last health check: `GET /api/health`

---

## 4. Exam-day operating procedure

### Before exam time (30 minutes early)
1. Operator signs in as PLATFORM_ADMIN — confirm dashboard loads
2. Lecturer signs in and opens the exam detail page — confirm
   "Published" status
3. Lecturer confirms the access code is ready to share (do not share
   it yet)
4. Run health check: `GET /api/health` → `database: "ok"`

### When students arrive
5. Students sign in with their provided credentials
6. Students open "My Exams" — the pilot exam should appear with an
   "Access code required" badge
7. Students do **not** start yet — they wait for the access code

### Exam start
8. At the scheduled start time, the lecturer shares the access code
   verbally or via the room's display (do not send it via chat before
   the exam window opens)
9. Students enter the code and click "Start exam"
10. The pre-exam checklist runs (camera grant if required, fullscreen
    if required) — students work through it before answers are accepted
11. Timer starts on first answer submission, not on "Start exam" click

### During the exam
12. Operator remains reachable but does not need to monitor actively
13. Lecturer does not need to watch the screen — submissions auto-save
14. If a student reports a network drop: their answers are preserved;
    they reload and resume without re-entering the access code
    (existing submission is detected automatically)

### After submission
15. Lecturer opens Submissions tab as students finish
16. Confirm submission count matches expected student count
17. Flag any missing submissions for follow-up

---

## 5. Student troubleshooting

**Cannot log in**
- Check email address matches exactly what was entered during invite
  (case-sensitive)
- Check password was copied correctly (no leading/trailing space)
- If still blocked: operator invites the student again with a new
  temporary password and the student uses that

**Wrong institution / no exam visible**
- The student account may have been created in the wrong institution
  or in Default Institution via self-signup
- Operator checks: sign in as PLATFORM_ADMIN → `/platform/institutions`
  → confirm the student appears under the correct institution
- If in wrong institution: create a new account with the correct
  institution; the old account cannot be moved in v1

**Access code rejected**
- Confirm the student is entering the exact code — no extra spaces,
  correct case (codes are case-sensitive)
- Confirm the lecturer has not changed the code since sharing it
- If the lecturer changed it: share the new code

**Camera permission denied**
- The student must click "Allow" in the browser permission dialog
  that appears when camera is required
- If they clicked "Block" previously: they need to reset camera
  permissions in browser settings (Settings → Privacy/Site Settings →
  Camera → find the SES URL → Allow)
- Camera is optional — if the institution does not require it, the
  lecturer can disable it in the exam's Secure Exam Mode settings

**Fullscreen warning**
- Expected behaviour when the student exits fullscreen
- Student clicks "Return to fullscreen" on the warning overlay
- This is a reminder, not a block — the exam continues regardless

**Electron app not opening**
- Confirm the student downloaded the correct build for their OS
- The app is not yet code-signed for broad distribution — on macOS,
  the student may need to right-click → Open to bypass Gatekeeper on
  first launch
- If the app cannot be opened: the student can take the exam in a
  regular browser; the lockdown badge will not appear but the exam
  will work normally

**Remote support during an active exam in SES Secure Exam Browser**
- The app's window will not appear in screen-sharing or remote-support
  tools — this is caused by intentional content-protection behavior
  (`setContentProtection(true)`), not a crash or blank screen. See
  `apps/lockdown/PILOT-INSTALL.md` → "Remote support limitation."
- Do not ask a student to screen-share the exam window for
  troubleshooting — it will appear black/empty to you even though the
  student sees it normally. Ask the student to describe what they see
  verbally instead, or use the pilot's established out-of-band support
  channel.
- Before distributing the installer for any pilot, an operator must
  have physically verified the app's on-screen behavior (login,
  lockdown badge, warning banner, event counter, exam submit, evidence
  review) on a real screen — see `apps/lockdown/PILOT-INSTALL.md` →
  "Pre-pilot sign-off." Remote or automated testing cannot substitute
  for this.

**Network issue during exam**
- Auto-save runs on every answer change
- If the connection drops, the student's in-memory answers are held
  and retried on reconnect
- The student should not close the browser tab during a drop — if
  they do, their last auto-saved state is preserved and they can
  resume by reopening the exam

---

## 6. Lecturer troubleshooting

**Exam not visible to students**
- Confirm the exam is published (Exam detail page → "Published" status)
- Confirm students are in the same institution as the exam — students
  from another institution will not see it even if published

**Access code not working**
- The code is case-sensitive
- If the wrong code was shared, the lecturer sets a new one on the
  exam detail page (old code is immediately invalidated)
- Students who already started (existing submission) are never
  re-prompted — only new starts require the code

**Submission not appearing**
- Submissions appear as soon as the student passes the access code
  check and clicks "Start exam" — even before they answer anything
- If a student reports they started but the submission is missing:
  check whether they used a different account or a different browser

**Integrity event review**
- Open the exam → Integrity review tab
- Each event shows the student, event type, timestamp, and severity
- Click "Review event" to mark it as reviewed; add notes
- Download the evidence report per student for formal records
- Risk scores (CLEAN / LOW / MEDIUM / HIGH) are advisory signals —
  the lecturer makes all final academic integrity determinations

**Evidence report loading slowly**
- Expected for exams with many events — the report compiles all events
  per student
- If it times out: try the CSV export from the Integrity review tab
  instead; it contains the same data in tabular form

**Grading essay responses**
- Open a submission → click the essay answer → enter a score
- If `ANTHROPIC_API_KEY` is configured, an AI draft mark appears
  below the answer — it is clearly labelled as a draft; the lecturer
  must click "Accept" to copy it to the score field, then save
- The final grade is never set automatically; the lecturer must save
  explicitly

---

## 7. Security and privacy messaging

Share this with students and the institution before the pilot.

**SES is cheat-resistant, not cheat-proof.**
Browser-level controls reduce the ease of common cheating behaviours
(tab switching, copy/paste, right-click) but cannot prevent a student
who is determined to use a phone, a second device, or notes on paper.
The Electron Lockdown Browser adds OS-level detection on top of the
browser layer but remains a v1 implementation — it detects and logs
significant signals rather than hard-blocking every possible action.

**Integrity events are evidence signals, not automatic verdicts.**
Every recorded event (tab switch, fullscreen exit, copy/paste attempt,
etc.) is reviewed by the lecturer. SES never automatically flags a
student as having cheated. The lecturer reviews the signals, considers
context (a single accidental tab switch is not the same as repeated
copy/paste attempts during the essay), and makes all final academic
integrity decisions.

**Camera monitoring in v1 checks availability only.**
When camera monitoring is enabled, SES confirms that the student's
camera is on and available throughout the exam. It does not record
video, take screenshots, perform face recognition, or verify student
identity. Students are informed of this via the privacy notice before
the exam starts.

**What is stored:**
- Exam answers and autosave history
- Integrity event timestamps and types (not screen content)
- Camera availability signals (not video or images)
- Submission status and timing

**What is not stored:**
- Video or audio recordings
- Screenshots of the student's screen
- Keystroke content outside the answer fields
- Identity verification data

The institution is responsible for compliance with applicable privacy
laws (FERPA, GDPR, Australian Privacy Act, etc.). The student privacy
notice is available at `/privacy/student-exam-notice` and is linked
from the exam-taking page before the student starts.

---

## 8. Post-pilot checklist

Complete this within 48 hours of the last exam.

### Evidence and records
- [ ] Lecturer downloads evidence report for any students of concern
- [ ] Lecturer exports analytics CSV (exam detail → Analytics → Export)
- [ ] Lecturer exports integrity events CSV (Integrity review → Export)
- [ ] Operator exports `GET /api/platform/audit-logs` for the pilot
      institution for platform-level records

### Review
- [ ] Lecturer completes brief feedback: what worked, what didn't,
      what would have helped
- [ ] Operator reviews support issues from exam day: how many students
      needed help, for what reasons, how long resolution took
- [ ] Note any submission failures or errors that occurred during
      the exam window

### Debrief items to record
- [ ] Total students invited vs. total who completed the exam
- [ ] Any access-code issues (wrong code shared, code changed, etc.)
- [ ] Any login failures and root causes
- [ ] Any integrity events that required lecturer follow-up
- [ ] Lecturer assessment of the grading and integrity workflow
- [ ] Student feedback on the exam experience (optional survey)

### SES Secure Exam Browser uninstall (if used)
- [ ] Confirm whether this pilot/institution has any further SES exams
      scheduled — if yes, instruct students to **keep the app
      installed** rather than uninstalling
- [ ] If this was the student's final SES exam for the pilot, notify
      students it is now safe to uninstall (see
      `apps/lockdown/PILOT-INSTALL.md` → "Install/uninstall lifecycle")
- [ ] BYOD devices: students uninstall manually via their OS's normal
      uninstall path
- [ ] Managed/IT-fleet devices: institution IT/MDM handles removal —
      do not expect students on managed devices to self-uninstall
- [ ] The app does not auto-uninstall — do not tell students to expect
      it to remove itself

### Fixes for next sprint
- [ ] List any issues that would be blockers for the next pilot
- [ ] List any issues that are high-priority polish
- [ ] Share this list with the development team before the next sprint
      is planned

---

## 9. Known limitations

These are documented constraints for the current v1 release. They are
not bugs — they are the agreed scope of the pilot. See
`docs/known-limitations.md` for the full list.

**No email sending.** Temporary passwords and access codes must be
shared with students and lecturers by the operator out of band (password
manager, encrypted message, in-person). SES will not email credentials
automatically.

**No bulk student import.** Students are invited one at a time via the
platform admin UI or API. A CSV import flow is deferred to a future
sprint.

**No course/cohort enrolment model.** All published exams in an
institution are visible to all students in that institution. An access
code adds a gate in front of *starting* the exam, but does not restrict
*visibility*. A student who has the correct code can start the exam —
per-student enrolment or cohort restrictions are not yet implemented.

**Access code is a single shared secret.** Any student in the
institution who has the code can start the exam. It is not per-student.
The code should be shared verbally in the exam room at the start time,
not sent digitally in advance.

**SES Secure Exam Browser pilot installers are unsigned.** Electron
Packaging v1 (`apps/lockdown`) produces a Windows NSIS installer and
macOS DMG for controlled pilot distribution — not signed, not
notarized, not for public distribution. Windows SmartScreen and macOS
Gatekeeper will warn on install; see `apps/lockdown/PILOT-INSTALL.md`
for the exact steps students/operators need to proceed. The app itself
is detection and soft enforcement: it detects and logs significant
OS-level signals (window switch, fullscreen exit) and queues them for
upload, but does not hard-block every possible OS action, has no kiosk
mode, and has no auto-update. The "Lockdown Browser Active" badge is
informational.

**No SSO.** All users authenticate with email/password. SAML/OIDC
is not implemented.

**No billing.** The `plan` field on an institution is a label only;
there are no usage limits, payment flows, or automatic tier enforcement.

**Recommended concurrency limit: 40 students.** Above this, upgrade
the hosting tier before running the exam.

**IP geolocation is disabled by default.** The network evidence feature
records IP addresses and browser metadata at exam open and submit.
Country, region, and city fields show `UNAVAILABLE` unless an operator
explicitly configures a geolocation provider. Enabling a provider sends
student IP addresses to a third-party service — this requires institutional
privacy approval before activation. See
`docs/network-evidence-and-ip-location.md` for the pre-activation
checklist. For this pilot, leave `GEOLOCATION_PROVIDER=none`.

---

*For technical reference, see `docs/platform-admin-onboarding.md`,
`docs/student-onboarding-and-exam-access.md`, and
`docs/known-limitations.md`. For the Canvas/LTI setup, see
`docs/canvas-sandbox-test-guide.md` (Canvas is optional and not
required for this pilot).*
