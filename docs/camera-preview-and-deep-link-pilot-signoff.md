# Persistent Camera Preview + Safe Exam Deep Link v1 — Pilot Signoff

**Feature:** Persistent Camera Preview + Safe Exam Deep Link v1
**Deployed commit:** `da636ec` (feature), `bf93a5e` (lecturer nav "Courses" link)
**Status:** Deployed to production (`https://tether-murex.vercel.app`), post-deploy cleanup complete, real-device camera signoff **pending** (requires a human with a physical webcam — see below).

---

## 1. Lecturer navigation

A "Courses" link now appears in the lecturer nav bar (`src/components/nav-bar.tsx`), next to "Dashboard". Confirmed:

- Visible only when `session.user.role === "LECTURER"`
- Not visible to students (verified: student nav shows only "My Exams")
- No access-control logic changed — the link points at the existing, already-authorized `/lecturer/courses` page

## 2. Production test-data cleanup

Test data was created during the previous deployment verification pass, under emails ending `@test.invalid`. Cleanup was performed only through existing application APIs — no direct production database access was used (none is available to the deploying agent).

**Deleted (cascaded via `DELETE /api/exams/[id]`):**
- 3 test exams (`Prod Verify Closed Exam`, `Prod Verify Future Exam`, `Prod Deploy Verify Exam`) — deletion cascades to their submissions, integrity events, network evidence, and exam assignments per the schema's `onDelete: Cascade` rules. Confirmed the one submission that existed now 404s.
- The test student's enrolment in the test course (via `DELETE /api/courses/[id]/enrolments/[userId]`).

**Left in place (no deletion capability exists in the app today):**
- The test course itself (`Prod Verify Course` / `PVC101`) — no `DELETE /api/courses/[id]` route exists.
- 3 test user accounts (1 lecturer, 2 students, all `@test.invalid` emails) — no user-delete route exists anywhere in the app (by design; deleting a user account is not a feature SES has today).
- One new exam (`Real Camera Signoff Exam`) and one course enrolment, created specifically as a ready-to-use fixture for the real-device check in section 3 below — intentionally left live so a human can complete the signoff without needing to recreate test data.

Adding delete endpoints for courses/users was out of scope for this pass ("do not add major features"). If ongoing test-data cleanup is needed, that's a small, separate feature to consider (a "delete course"/"delete user" admin action) — flagging it, not building it now.

**No production Prisma commands or DDL were run.** All cleanup was via the running application's own REST API, using the same authorization checks a real lecturer would go through.

## 3. Real camera hardware verification — REQUIRES A HUMAN

This verification could not be completed by the deploying agent: neither the local dev environment nor this session's browser tooling has access to real camera hardware (headless/automated browser contexts here have no webcam device, so `getUserMedia` cannot succeed). The pre-exam gate's "camera access denied" handling was confirmed to work correctly in that environment, but the actual live preview widget, minimize/restore, and camera-loss event on real hardware still need a human pass.

**A ready fixture is live in production right now for this purpose:**

| Field | Value |
|---|---|
| Join link | `https://tether-murex.vercel.app/student/exams/join/cmr4yinau000104jr58j2bbrm` |
| Student login | `prod-stud-a-1783083579@test.invalid` / `password123` |
| Access code | `CAMERA1` |
| Lecturer login (to view evidence afterward) | `prod-lect-verify-1783083579@test.invalid` / `password123` |

**Steps for the human tester** (mirrors the exact checklist requested):

1. Open the join link on a laptop/desktop with a working webcam.
2. If not signed in, confirm the login page appears with the join link preserved as the callback, and that logging in returns you straight to the join page (not a generic dashboard).
3. Enter access code `CAMERA1`, click "Start exam".
4. On the pre-exam checklist, click "Enable camera" and grant permission.
5. Click "Start secure exam".
6. Confirm the camera preview widget is visible in the corner throughout the exam.
7. Click the minimize (▾) control — confirm it collapses to a "Camera active" pill.
8. Confirm the pill stays visible while minimized (not fully hidden).
9. Click the pill to restore the full preview.
10. If the widget supports dragging (it currently does not — it's a fixed corner widget, no drag handle implemented), note that as expected, not a bug.
11. Type an answer into a question field to confirm the exam itself is still usable with the widget open.
12. Submit the exam.
13. Log in as the lecturer, open **Real Camera Signoff Exam → Review integrity events**, and confirm no event resembling "minimize" or "preview" appears — only real camera-loss events would ever be logged, and none should exist from a normal minimize/restore session.
14. Optionally: start a **second** attempt (as a different enrolled student, or by clearing the submission) and mid-exam revoke camera permission in the browser's site settings, or physically cover/disconnect the webcam, to confirm a `CAMERA_UNAVAILABLE`/`CAMERA_STOPPED` event is recorded and shows up in the integrity review and evidence report.
15. Open the evidence report for the submission (`Submissions → [student] → View evidence`) and confirm it loads correctly and does not list minimize/restore as an event.

**Please report back**: preview visible ✅/❌, minimize/restore visual behavior ✅/❌, exam still usable with widget open ✅/❌, camera-loss event correctly recorded ✅/❌, evidence report renders correctly ✅/❌. Until this is confirmed by a human with real hardware, treat the camera preview feature as **code-reviewed and automated-test-covered, but not yet hardware-signed-off**.

## 4. Pilot readiness

- Core deployment verified end-to-end via API-level checks against production: authentication, institution/course/assignment/schedule/access-code enforcement, deep link + login callback, API field-leakage safety.
- Camera hardware behavior is the one open item before declaring this feature fully pilot-ready — see section 3.
- No schema changes shipped with this feature; no further database migration is required regardless of the outcome of the camera check.

**Recommendation:** SES is ready for a controlled pilot **once the real-device camera check above is confirmed**. Everything else (deep link security, access control, lecturer share-link UI, API safety) is verified and deployed.
