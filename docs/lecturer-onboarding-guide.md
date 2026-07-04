# SES Lecturer Onboarding Guide

A step-by-step guide for a lecturer joining a Safe Exam System pilot.

## Getting started

- Receive your lecturer account credentials from your SES operator
- Log in at https://tether-murex.vercel.app
- You will land on the lecturer dashboard

## Creating your first exam

1. Click "New exam" or "Create exam"
2. Enter the exam title, subject, and duration
3. Add questions one at a time, or use "Add multiple questions" to paste
   several at once — see "Adding questions in bulk" below
4. Configure Secure Exam Mode settings
5. (Optional) Assign the exam to a course and set a schedule — see
   "Courses and exam assignment" below
6. Publish the exam

## Adding questions in bulk

On the exam edit page, "Add multiple questions" lets you paste several
questions at once instead of adding them one at a time:

1. Paste your questions in the format shown under "Show accepted format"
   (one `QUESTION:` block per question, with `TYPE`, `OPTIONS`/`ANSWER`
   for MCQ, and `POINTS`)
2. Click "Preview" — every question is checked and shown with any
   errors before anything is saved
3. Fix any errors shown, or click "Import" once every question is valid
4. If you have a question bank, you can optionally also save the
   imported questions to it

If any question in the batch has an error, nothing is saved — fix the
errors and try again. See docs/assessment-operations-v1.md for the
full format reference.

## Courses and exam assignment (optional)

If you want an exam visible only to a specific class rather than
everyone in your institution:

1. Go to `/lecturer/courses` and create a course, or open one you
   already teach
2. Enrol students into the course by email
3. On the exam's edit page, under "Course, assignment & schedule",
   select the course
4. Choose **Whole course** (every enrolled student sees it) or
   **Selected students** (pick specific students from that course)
5. Optionally set **Available from** / **Available until** to control
   exactly when the exam opens and closes

If you don't assign a course, the exam remains visible to every student
in your institution — this is the same behaviour SES has always had.
See `docs/course-enrolment-and-exam-assignment.md` for the full
visibility rules, including how this interacts with the access code
below.

## Secure Exam Mode settings explained

- **Enable Secure Exam Mode** — activates integrity controls
- **Block copy/paste** — prevents clipboard use inside the exam
- **Block right-click** — prevents the context menu
- **Block keyboard shortcuts** — best-effort shortcut blocking (cannot
  block every browser- or OS-reserved shortcut)
- **Require fullscreen** — prompts the student to go fullscreen
- **Require camera** — student must grant camera access before starting
- **Camera heartbeat** — monitors camera availability during the exam
- **Require student verification before exam** — student must tick a
  one-time confirmation of their name/ID/email before starting; no
  photo ID scan, no face comparison, no image capture
- **Enable AI-assisted camera integrity checks** — runs local, on-device
  checks for a possible phone, a possible additional person, no visible
  person, or a blocked/dark camera view. This is **not** live
  proctoring — video is never recorded, streamed, or stored, and no one
  watches the student's camera live. See
  docs/on-device-ai-integrity-detection-v1.md for the full design,
  including limitations (false positives, limited field of view) before
  enabling this for a real exam.

These are browser-level friction controls, not an OS-level lockdown — see
docs/known-limitations.md for the full picture of what SES can and
cannot guarantee.

## Setting an exam access code (optional)

An access code adds a second gate in front of starting the exam —
students must enter it before a submission is created. It is a single
shared secret for the exam (not per-student).

1. Open your exam detail page
2. Find the "Exam access code" section
3. Enter a code (4+ characters) and click "Set access code"
4. The status badge changes to "Access code enabled"
5. The code is never shown again after saving — keep it noted securely
6. Share the code verbally with students only at exam start, not before
7. To remove it, click "Clear" — students can then start without a code

If a student enters the wrong code, they see an error and no submission
is created. Students who have already started (existing submission)
are never re-prompted for the code on resuming.

## Sharing the exam with students

- Students log in at https://tether-murex.vercel.app
- They will see published exams under "My Exams"
- Provide students with their account credentials
- Share the [student test instructions](student-test-instructions.md)
  document

## Sharing an exam link

Every exam detail page has a "Share exam link" section with a direct URL
you can send to students (email, LMS announcement, chat) instead of
telling them to find the exam in their dashboard:

1. Open your exam detail page
2. Find the "Share exam link" section
3. Click "Copy link" to copy the URL to your clipboard
4. Send it to your students

Important things to know about this link:

- The exam must be **published** before you can share it — an
  unpublished exam shows a warning instead of the link.
- Students must **log in** to use it. An unauthenticated student who
  opens the link is sent to log in first, then returned straight to the
  exam automatically.
- If the exam requires an **access code**, students still enter it after
  opening the link — the link does not embed or bypass the code.
- If the exam is assigned to a specific course or to selected students,
  the link only works for students who already have that access — it is
  a shortcut to the exam, not a separate grant of access. Sharing it
  with an unauthorized student has no effect; they'll see "You do not
  have access to this exam."

## Monitoring submissions

- Open your exam → Submissions tab
- See all student submissions and status
- Auto-graded: MCQ and short answer questions are scored immediately
- Manual review: essay questions await your input

## Grading essays

1. Click a submission to view the student's answers
2. Enter your score for each essay question
3. Optionally use AI draft marking (if configured)
4. You retain final grading authority
5. Click save/finalise to complete grading

## Reviewing integrity events

- Open your exam → Integrity review tab
- See all integrity events by student
- Review the risk score and risk level
- Click "Review event" to mark it as reviewed
- Add resolution notes where needed
- Download the evidence report for any student of concern

## Understanding risk scores

- **CLEAN** — no integrity events
- **LOW** — minor signals, likely not concerning
- **MEDIUM** — multiple signals, worth reviewing
- **HIGH** — significant signals, review recommended

Risk scores are advisory — you make the final decision. They are signals
for human review, never an automatic misconduct determination.

## Exporting data

- **Analytics page** — score distribution, risk summary, CSV export
- **Integrity review** — CSV export of all events
- **Evidence report** — per-student report, suitable for printing or
  forwarding to an academic integrity panel
- **Exam detail page — "Export results"** — final marks/results for a
  whole exam, in three forms:
  - **Full marks report** (CSV or Excel) — every column, including
    integrity risk and access-code/camera settings, for your own
    records
  - **Canvas/IRM marks upload export** (CSV or Excel) — a minimal,
    marks-only file for uploading to Canvas or an institutional marks
    system; deliberately excludes integrity details and access-code
    data
  - **PDF report** — a human-readable summary with a marks table and
    integrity summary, suitable for printing or filing

  See docs/assessment-operations-v1.md for exactly what each export
  includes and excludes.

## Optional: Canvas integration

See docs/canvas-sandbox-test-guide.md for setting up a Canvas Developer
Key and linking exams to Canvas assignments. Canvas is entirely optional
— the core platform works fully without it.

## Optional: AI assistance

AI features require `ANTHROPIC_API_KEY` to be configured by your SES
operator. If unavailable, these features show a clear "not configured"
message and nothing else in the platform is affected.

- **AI question generation** — generate MCQ/essay questions from source
  material
- **AI essay marking** — draft marks for essay answers

You review and approve all AI suggestions — AI never finalizes a grade.
