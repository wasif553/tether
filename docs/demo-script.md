# SES Demo Script (15 minutes)

A structured demo flow for showing Safe Exam System to a prospective
university contact. Language throughout follows the project's wording
rules — see docs/secure-exam-threat-model.md. Never claim SES is
"cheat-proof" or that it "detects cheating"; always frame integrity
events as signals for human review.

## Setup before demo

- Have a lecturer account ready
- Have a student account ready (use an incognito window)
- Have a secure exam pre-created with one MCQ and one essay question
- Have Secure Exam Mode enabled with camera monitoring and browser
  friction settings on
- Know the pilot readiness URL: `/lecturer/pilot-readiness`

## Demo flow (15 minutes)

### 1. Homepage and platform overview (1 min)

- Open https://tether-murex.vercel.app
- Show the login page
- Explain: standalone platform, no Canvas required to start

### 2. Lecturer creates secure exam (3 min)

- Log in as lecturer
- Show exam creation
- Enable Secure Exam Mode
- Show browser friction settings
- Show camera monitoring settings
- Add an MCQ question and an essay question
- Publish the exam

### 3. Student experience (4 min)

- Open an incognito window
- Log in as student
- Open the published exam
- Show the pre-exam secure checklist
- Show the camera permission step (if enabled)
- Show the "Secure Exam Mode active" status panel
- Demonstrate copy/paste blocked
- Demonstrate right-click blocked
- Answer the questions and submit

### 4. Integrity review (4 min)

- Switch back to the lecturer view
- Show the integrity events recorded
- Show the risk score and risk level badge
- Open the evidence report
- Explain: "These are signals for human review — the lecturer makes the
  final decision"
- Show the CSV export

### 5. Analytics (2 min)

- Show the analytics page
- Show the score distribution
- Show the integrity risk summary
- Export the analytics CSV

### 6. Optional modules (1 min)

- Mention Canvas/LTI integration (show the `/api/lti/config` URL)
- Mention AI question generation and essay marking
- Explain that both are optional add-ons — the core platform works fully
  without either

## What to say / what NOT to say

### Say

- "SES records integrity signals for your lecturers to review"
- "Browser-level friction makes casual attempts harder"
- "Camera monitoring checks availability during the exam"
- "Lecturers retain full decision-making authority"
- "This is evidence for human review, not automated accusation"

### Do NOT say

- "This is cheat-proof"
- "We detect cheating"
- "AI decides if a student cheated"
- "We can close other browser tabs"
- "This replaces human judgment"
