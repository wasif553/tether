# SES Pilot Proposal Template

A template for an institution or lecturer to complete when agreeing to a
controlled pilot of Safe Exam System.

## Pilot objective

[What the institution wants to achieve with this pilot]

## Pilot scope

- Institution/department: [name]
- Number of lecturers: [1-3 recommended]
- Number of exams: [1-3 recommended]
- Students per exam: [20-40 recommended]
- Pilot duration: [2-4 weeks recommended]

## Technical requirements

- Modern browser (Chrome, Firefox, Edge — latest version)
- Webcam (if camera monitoring enabled)
- Stable internet connection
- No software installation required for browser mode

## Roles and responsibilities

- SES operator: platform setup, account creation, monitoring
- Lecturer: exam creation, grading, integrity review
- Students: take exam using provided credentials
- Institution: final academic integrity decisions

## What SES records during an exam

- Exam answers and timing
- Autosave events
- Tab/window switching attempts
- Copy/paste attempts
- Right-click attempts
- Keyboard shortcut attempts
- Fullscreen exit and return
- Camera availability (if enabled)
- Network disconnections
- Timer events

## What SES does not record in v1

- Video recordings
- Audio recordings
- Screenshots of student screen
- Identity verification
- Face recognition
- Keystroke content

## Data and privacy

- Exam data stored on Supabase (PostgreSQL)
- Hosted on Vercel (serverless)
- No video or images stored in v1
- Integrity events reviewed by authorised teaching staff only
- Students notified via privacy notice before exam starts
- Institution responsible for compliance with local privacy laws

## Success criteria

- [ ] Lecturer can create and publish a secure exam
- [ ] Students can complete the exam with secure mode active
- [ ] Integrity events are recorded and reviewable
- [ ] Evidence reports are usable for lecturer review
- [ ] Analytics export works for institutional reporting
- [ ] Grading workflow is complete end-to-end

## Go/no-go criteria

**Go:**
- All success criteria met
- No critical data loss incidents
- Lecturers comfortable with the workflow

**No-go:**
- Submission failures > 5% under real conditions
- Data loss or privacy incident
- Lecturer workflow unacceptably complex

## Pricing placeholder

[To be discussed — contact pilot@yourdomain.com]

## Next steps

- [ ] Confirm pilot scope and dates
- [ ] SES operator creates lecturer accounts
- [ ] Lecturers complete onboarding guide
- [ ] Test exam run with pilot students
- [ ] Pilot begins
- [ ] Post-pilot review and feedback
