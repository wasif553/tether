# Assessment Operations v1

**Feature:** Assessment Operations v1
**Status:** Shipped locally (see local commit); no schema/DDL changes required beyond one additive nullable column.

This document covers three additions that make running and closing out an exam faster for a lecturer: student identity fields, bulk question entry, and final marks/results exports.

---

## 1. Student profile: full name and optional institutional student ID

Student identity in SES is:

- **Full name** — `User.name`, unchanged, already required.
- **Email** — `User.email`, unchanged, already required and unique.
- **Institutional student ID** — `User.institutionStudentId` (new, optional).

`institutionStudentId` is:

- **Optional.** Most flows work identically with or without it.
- **Not the database user id** (`User.id`) and **not a login credential** — it exists purely for identification on exports, rosters, and reports (a roll number, SIS ID, or similar).
- **Not treated as secret.** It appears in lecturer exports and course rosters — do not use it as, or in place of, a password or access code.
- **Not unique-constrained at the database level in v1.** Uniqueness is deferred rather than enforced with a DB constraint, because a hard `@@unique` on an optional field is awkward in Postgres (multiple `NULL`s are allowed under a unique index, but two lecturers entering the same non-null ID by mistake would otherwise hard-fail an unrelated invite). If duplicate-ID detection becomes a real operational need, add application-level validation (or a partial unique index) in a future release rather than retrofitting it now.

**Where it's set:** only via the platform-admin "Invite student" flow (`POST /api/platform/institutions/[id]/invite-student`) — self-signup does not collect it, since self-signup is unverified and the ID is meant to reflect an institution's own records.

**Where it's shown:**
- The platform-admin invite-student form has an optional "Institutional student ID" field.
- A lecturer's course enrolment list (`/lecturer/courses/[id]`) shows it next to each enrolled student, when set.
- Every marks/results export (see below) includes it as its own column.

---

## 2. Bulk question entry

The lecturer exam edit page has an "Add multiple questions" section, separate from the existing single "Add question" form and the existing "Generate questions with AI" section.

**Accepted format** (shown in the UI itself, under "Show accepted format"):

```
QUESTION:
What is 2 + 2?
TYPE: MCQ
OPTIONS:
A. 3
B. 4
C. 5
D. 6
ANSWER: B
POINTS: 1

QUESTION:
Explain the difference between authentication and authorization.
TYPE: SHORT_ANSWER
POINTS: 5

QUESTION:
Discuss academic integrity risks in online exams.
TYPE: ESSAY
POINTS: 10
```

- `TYPE` accepts `MCQ` (alias for `MULTIPLE_CHOICE`), `SHORT_ANSWER`, or `ESSAY`.
- `OPTIONS`/`ANSWER` are required for MCQ only — short-answer and essay questions never require options.
- `ANSWER` may be a letter (matched against the listed options) or the literal option text.
- `POINTS` defaults to `1` if omitted; must be a positive whole number.

**Validation and preview:** clicking "Preview" parses the pasted text entirely in the browser (`src/lib/bulkQuestionParser.ts`) and shows a row-by-row breakdown with inline errors. Nothing is saved at this point. The "Import" button is only enabled once every row is valid.

**All-or-nothing import:** the server (`POST /api/lecturer/exams/[examId]/bulk-questions`) re-parses and re-validates the same raw text independently — it never trusts the client's preview. If any question in the batch is invalid, the entire batch is rejected and nothing is saved; there is no partial-import mode in v1.

**Published exams:** importing questions into a published exam is allowed (matching the existing single-question-add behavior, which was never blocked on published status either), but the UI shows a clear warning before import, and the API response includes a warning noting that the imported questions are now visible to students.

**Question bank integration:** if the lecturer has at least one existing question bank, an optional "Also save to question bank" dropdown appears during preview. Selecting a bank saves an independent copy of each imported question into that bank (same ownership check as the existing question-bank import feature) — the bank question carries the exam's course code as its `topic`, when the exam is course-linked, so future course-scoped browsing of a bank has a hook to filter on. If the lecturer has no banks yet, this option is simply hidden — bulk import does not require or auto-create a question bank.

---

## 3. Final marks/results exports

Every exam detail page has an "Export results" section with five export links, all served by a single route: `GET /api/lecturer/exams/[examId]/export/[format]`, where `format` is one of `marks-csv`, `marks-xlsx`, `upload-csv`, `upload-xlsx`, `report-pdf`.

### A. Full marks report (CSV/Excel)

Every column requested: institution name, course code/name, exam title/ID, student full name, institutional student ID, student email, submission ID, status, started/submitted/graded timestamps, total score, max score, percentage, integrity risk level, integrity event count, whether an access code was required, whether camera was required, and a short feedback-notes summary.

Intended for the lecturer/institution's own records — this file **does** include integrity and access-control metadata, because it's meant for internal use, not for uploading anywhere.

### B. Canvas/IRM marks upload export (CSV/Excel)

A deliberately minimal file: student ID, student name, student email, exam/assignment name, mark, mark out of, percentage, submitted at, status. Nothing else.

**Explicitly excluded from this file:** integrity risk level, integrity event count, access-code-required flag, camera-required flag, notes/feedback, and (as with every export in this feature) `passwordHash`, `accessCodeHash`, and correct answers. This is a structural guarantee — `toUploadReadyRows()` in `src/lib/assessmentExport.ts` only ever selects the fields listed above; it does not filter a larger object down at output time. Provided as both CSV and Excel since some downstream systems (Canvas among them) expect CSV specifically.

### C. PDF report

A human-readable one-page-per-page-as-needed report: institution, course, exam title, schedule, lecturer, export timestamp, summary (students assigned/enrolled, submissions received, pending submissions, average score), an integrity summary (clean / needing review / high-risk counts), a marks table (student name, student ID, email, score, percentage, status, submitted date), and the same disclaimer used on the existing evidence report: *"Integrity signals are indicators for review. The lecturer or institution makes the final academic decision."*

Never included: password hashes, access-code hashes, correct answers, raw network evidence, or camera/video footage — none of these are ever read by the export code path in the first place.

### Access control

All five export formats share one route and one access-control check, copied exactly from the existing analytics/evidence export pattern: the caller must be a `LECTURER` (checked first, so students are rejected before any exam lookup happens), then either the exam's owner (`exam.createdById === session.user.id`) or a `PLATFORM_ADMIN`, then `assertSameInstitution` against the exam's institution. Cross-institution access and student access are both rejected the same way every other lecturer-only export in SES already is.

---

## What's excluded from every export, and why

- **`passwordHash`, `accessCodeHash`** — never selected by the underlying Prisma query in `src/lib/assessmentExport.ts`; there's no field to accidentally leak.
- **Correct answers** — exports report scores and percentages, never the answer key or a student's actual response text.
- **Raw network evidence** — out of scope for this feature; the existing evidence report (`src/lib/evidenceReport.ts`) remains the only place that surfaces network evidence, and only to the exam owner.
- **Camera/video footage** — SES has never recorded or stored camera footage (see docs/known-limitations.md); there is nothing to export.
- **Integrity detail in the upload-ready file** — by design, so a marks-upload file can be handed to a registrar or uploaded to Canvas without incidentally disclosing academic-integrity review data.
