# Pilot Operator Checklist

Use this checklist to run a controlled pilot of Safe Exam System (SES)
with one real Canvas course, one lecturer, and a small group of students.
It assumes the Canvas-side setup in `canvas-sandbox-test-guide.md` is
already done, or is being done alongside this checklist.

## Pre-pilot setup

- [ ] SES is deployed and reachable at a stable `APP_URL`
- [ ] `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build` all pass
- [ ] `GET /api/health` returns `status: "ok"` and `database: "ok"`
- [ ] `GET /api/readiness` shows the expected booleans (database connected,
      auth secret configured, app URL configured)
- [ ] `/lecturer/pilot-readiness` (once a lecturer account exists) shows no
      unexpected "Not configured" items in section E (Deployment readiness)

## Canvas setup

- [ ] Developer Key registered (see Canvas sandbox test guide, step 1)
- [ ] Required AGS scopes enabled on the Developer Key
- [ ] Tool installed in the pilot course
- [ ] One assignment created using SES as the external tool
- [ ] `resource_link_id` captured and ready to link

## Lecturer setup

- [ ] Lecturer account exists (standalone signup or via first LTI launch)
- [ ] Lecturer creates the pilot exam
- [ ] Lecturer adds a representative mix of MCQ, short-answer, and essay
      questions (manually and/or via AI generation/question bank import)
- [ ] Lecturer publishes the exam
- [ ] Lecturer links the Canvas assignment's resource link to this exam
      (exam detail page → Canvas / LTI linking)
- [ ] `/lecturer/pilot-readiness` section A (core exam flow) shows "Ready"
      for exam creation, questions, and published

## Student test launch

- [ ] One test student (or Canvas "Student View") launches the assignment
- [ ] SES routes directly to the linked exam, not a generic dashboard
- [ ] A `Submission` row exists for that student (visible on the
      submissions list)
- [ ] Re-launching the same assignment resumes the same submission rather
      than creating a duplicate

## Exam test

- [ ] Student can answer all question types and autosave works
      (refresh mid-exam, confirm answers persisted)
- [ ] Student submits before the timer expires
- [ ] Student sees a calm "submitted" state, not a generic error

## Integrity event test

- [ ] Student switches away from the exam tab/window at least once
- [ ] Lecturer's integrity review page for that exam shows the event with
      a calm, non-accusatory label ("review recommended", not "cheating
      detected")
- [ ] Lecturer marks the event reviewed and the status updates

## AI question generation test

- [ ] With `ANTHROPIC_API_KEY` unset, the "Generate questions with AI"
      action fails safely (clear error, no crash, no exposed key)
- [ ] With a valid key, generation returns a reviewable draft list
- [ ] Lecturer selects a subset and "Add selected to exam" succeeds
- [ ] Bulk import from a question bank still works independently of AI
      generation

## AI essay marking test

- [ ] With `ANTHROPIC_API_KEY` unset or invalid, "Mark essays with AI"
      fails safely (clear error, no crash)
- [ ] With a valid key, AI drafts appear on the grading page labeled
      clearly as a draft, with a confidence indicator
- [ ] Lecturer can accept the AI draft score into the manual score field
      and still has to click Save/Finalize — the AI never finalizes a
      grade on its own
- [ ] Lecturer can override the AI draft entirely

## Analytics export test

- [ ] Lecturer opens the exam's analytics page and sees summary stats,
      score distribution, and per-question breakdown
- [ ] CSV export downloads and contains student results and question
      analytics sections

## Canvas grade passback test

- [ ] After the lecturer finalizes the student's grade, passback status
      moves from `PENDING`/`NOT_READY` to `SENT` (check the grading
      page's Canvas passback panel)
- [ ] The score appears in Canvas's Gradebook for that assignment
- [ ] If passback fails, the SES grade is still saved (never rolled back)
      and the lecturer can retry from the same panel
- [ ] A non-LTI (standalone) submission's passback status is `SKIPPED`,
      never an error

## Evidence to collect

For each section above, capture:

- A screenshot of the relevant SES page in its final state
- A screenshot of the corresponding Canvas page where applicable
  (Gradebook entry, assignment submission, Developer Key scopes)
- The `/lecturer/pilot-readiness` page screenshot at the end of the run
- Any error messages encountered, verbatim

## Go / no-go decision checklist

Pilot is **go** only if all of the following are true:

- [ ] Core exam flow (create → publish → take → submit → grade) works
      with zero unhandled errors
- [ ] At least one full Canvas launch → exam → grade passback to `SENT`
      cycle completed successfully
- [ ] Integrity events are visible and reviewable by the lecturer
- [ ] No UI text claims SES is "cheat-proof" or that AI makes final
      grading decisions
- [ ] AI features fail safely when unconfigured (no crash, no leaked key)
- [ ] `/api/health` and `/api/readiness` are reachable and accurate
- [ ] The student privacy notice page is linked from the exam-taking page
      and accurately describes what is recorded

If any of these fail, treat the pilot as **no-go** until resolved — do
not proceed with real student data until the core flow and Canvas
passback have been verified end-to-end at least once.
