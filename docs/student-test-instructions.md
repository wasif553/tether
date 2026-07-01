# SES Student Test Instructions

Simple instructions for taking an exam in Safe Exam System.

## Before your exam

- You will receive login credentials from your lecturer or institution
- Log in at https://tether-murex.vercel.app
- Use a modern browser: Chrome, Firefox, or Edge (latest version)
- Use a laptop or desktop — not a mobile phone
- Ensure you have a stable internet connection
- If camera monitoring is required, make sure your webcam works

## Starting your exam

1. Log in with your student account
2. Click "My Exams" to see your available exams
3. If the exam shows an "Access code required" badge, wait for your
   lecturer to share the access code before proceeding
4. Click the exam you have been assigned
5. Read the pre-exam checklist carefully
6. If camera access is required, click "Enable camera" and allow access
   when your browser asks
7. Enter the access code when prompted and click "Start exam"
8. Your timer starts immediately

If you see an "SES Lockdown Browser Active" badge, it means your
institution's SES Secure Exam Browser (the Electron lockdown client) is
running and OS-level integrity signals are being recorded in addition
to browser signals. If your institution requires this app, they will
provide the installer directly — see `apps/lockdown/PILOT-INSTALL.md`
for installation steps, including the SmartScreen/Gatekeeper warning
you should expect on first install (this is normal for a pilot build).

## During the exam

- Stay in the exam window
- Do not switch to other browser tabs
- Do not copy or paste content
- Do not use keyboard shortcuts to open other tools
- If you exit fullscreen, you will be asked to return
- Your answers are saved automatically as you type
- If you lose internet briefly, your answers are preserved and saved
  once your connection returns

## What is recorded

SES records integrity signals during your exam, including:

- Tab or window switching
- Copy/paste attempts
- Fullscreen exits
- Camera availability (if required)
- Network disconnections

These signals are reviewed by your lecturer. SES does not automatically
accuse you of misconduct. Your lecturer makes all final academic
integrity decisions.

Read the full privacy notice at `/privacy/student-exam-notice`.

## Submitting your exam

- Answer all questions
- Click "Submit exam" when finished
- You will see a confirmation message
- You cannot change your answers after submission

## Viewing your result

Results appear after your lecturer has graded your exam. Log in and open
the exam to see your score.

## If something goes wrong

- **Lost internet** — wait for your connection to return; your answers
  are auto-saved
- **Camera stopped** — follow the on-screen instructions to restore
  camera access
- **Browser closed accidentally** — log back in and reopen the exam;
  your progress is saved; you will not need to re-enter the access code
- **Access code rejected** — confirm you are entering the exact code
  your lecturer shared; check for extra spaces and correct capitalisation
- **Exam not visible** — confirm you are signed in with the correct
  account; contact your exam coordinator if the exam does not appear
- **Any other issue** — contact your lecturer or exam coordinator
