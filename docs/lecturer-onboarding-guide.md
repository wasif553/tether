# SES Lecturer Onboarding Guide

A step-by-step guide for a lecturer joining a Safe Exam System pilot.

## Getting started

- Receive your lecturer account credentials from your SES operator
- Log in at https://tether-murex.vercel.app
- You will land on the lecturer dashboard

## Creating your first exam

1. Click "New exam" or "Create exam"
2. Enter the exam title, subject, and duration
3. Add questions (MCQ, short answer, essay)
4. Configure Secure Exam Mode settings
5. Publish the exam

## Secure Exam Mode settings explained

- **Enable Secure Exam Mode** — activates integrity controls
- **Block copy/paste** — prevents clipboard use inside the exam
- **Block right-click** — prevents the context menu
- **Block keyboard shortcuts** — best-effort shortcut blocking (cannot
  block every browser- or OS-reserved shortcut)
- **Require fullscreen** — prompts the student to go fullscreen
- **Require camera** — student must grant camera access before starting
- **Camera heartbeat** — monitors camera availability during the exam

These are browser-level friction controls, not an OS-level lockdown — see
docs/known-limitations.md for the full picture of what SES can and
cannot guarantee.

## Sharing the exam with students

- Students log in at https://tether-murex.vercel.app
- They will see published exams under "My Exams"
- Provide students with their account credentials
- Share the [student test instructions](student-test-instructions.md)
  document

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
