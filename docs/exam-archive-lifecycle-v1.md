# Exam Archive Lifecycle v1

Lets a lecturer clean up their operational views (dashboard, exam index,
course exam list) without deleting or altering any academic record, plus
a genuinely safe permanent-delete path for unused drafts, and a clean
CSV marks export for the Submissions workspace.

## Data model

One new field: `Exam.archivedAt DateTime?` (see
`docs/exam-archive-lifecycle-v1-migration.sql`). `null` = not archived
(every existing exam). Non-null = archived at that timestamp. No new
table, no new enum, no second lifecycle status system — the existing
`lecturerAvailabilityStatus()`/`lecturerDashboardGroup()` classification
(`src/lib/lecturerDashboardGrouping.ts`) is untouched; archived exams are
simply excluded from the list those functions ever see.

## What archive does

- Toggled via `PATCH /api/exams/[id]` with `{ "archived": true | false }`
  — reuses the existing ownership/institution-scoped update route rather
  than adding a new endpoint.
- `GET /api/exams` excludes `archivedAt IS NOT NULL` exams by default
  (current list, closed-history pages, and the `?all=true` full-history
  fetch). Pass `?archived=true` to fetch ONLY archived exams (used by the
  Exams page's "Archived" filter and Course detail's "View archived"
  toggle) — a completely separate query path, so an archived exam can
  never leak into a default/current response by accident.
- Restoring (`archived: false`) simply clears `archivedAt`. The exam
  reappears in the default `GET /api/exams` response and is classified
  by the SAME existing grouping logic every other exam uses — a restored
  published exam whose window has passed lands in "Closed", a restored
  future-dated one in "Upcoming", a restored unpublished one in "Draft".
  No special-cased "restore target" logic exists anywhere.

## What archive does NOT do

- Does **not** touch `published`, `availableFrom`/`availableUntil`, or
  any other exam field.
- Does **not** affect student-facing behaviour in any way — no
  student-facing route (`GET /api/exams/[id]` student branch, exam
  start, submission routes) reads `archivedAt` at all. A student can
  still access, join, and submit an archived-but-published exam exactly
  as before archiving. Archiving is a lecturer-side organisational flag
  only.
- Does **not** delete or modify any `Submission`, `Answer`,
  `IntegrityEvent`, evidence asset, `SecureClientSession`, or any other
  academic/integrity record.
- Is fully reversible (Restore) and has no eligibility restrictions — any
  owned exam can be archived at any point in its lifecycle.

## Safe permanent delete

`DELETE /api/exams/[id]` existed before this feature but performed an
**unconditional** `prisma.exam.delete()` with zero eligibility checks —
every relation from `Submission`, `IntegrityEvent`, evidence assets,
`SecureClientSession`/`SecureClientEvent`, `LtiLaunch`, and every other
assessment-activity table down to `Exam` is `onDelete: Cascade` in the
schema, so that call would have silently cascaded through every academic
and integrity record tied to the exam. It was never wired into any UI
page and had no test coverage (confirmed empty `src/app/api/exams/`
test directory) — a dormant, dangerous route. This feature hardens it in
place with an authoritative server-side eligibility check performed
BEFORE any delete is attempted:

An exam may be permanently deleted only if **all** of the following are
true:

- `published === false` (must currently be a draft)
- Zero rows across every one of these relations: `Submission`,
  `IntegrityEvent`, `NetworkEvidence`, `IntegrityEvidenceAsset`,
  `SubmissionSimilarityAnalysis`, `AiUseReviewAnalysis`,
  `TimingAnalysis`, `AiAssistanceInteraction`,
  `CohortCollusionAnalysis`, `SecureClientSession`,
  `SecureClientEvent`, `LtiLaunch`.

If any check fails, the route returns `409` with a message that never
exposes internal database errors and always points the lecturer at
Archive instead:
`"This exam cannot be permanently deleted because assessment records exist. Archive it instead."`

Configuration-only relations (`Question`, `QuestionPool`,
`ExamAssignment`, `ExamTimeAccommodation`, `LtiExamLink`,
`SecureClientConfiguration`, `SecureClientLaunchManifest`) are
deliberately NOT part of the eligibility check — they represent the
exam's own never-used setup, not student activity, and are expected to
cascade away with a genuinely unused draft.

The UI never relies on its own judgement of eligibility for anything but
*menu visibility* (a client-side heuristic: `!published && submissions
=== 0`, from data already loaded) — the actual delete button always
calls the server, and the server's check is authoritative regardless of
what the client believed.

## Marks export

`GET /api/lecturer/exams/[examId]/marks-export?detail=true|false` — a
new, deliberately separate CSV export from the existing rich
institutional export system at
`/api/lecturer/exams/[examId]/export/[format]` (marks-csv/xlsx,
upload-csv/xlsx, report-pdf — untouched by this feature). That existing
`marks-csv` format includes `Integrity Risk Level` and `Integrity Event
Count` columns, which is appropriate for its own established audit/
institutional-record purpose but is exactly the kind of raw
integrity-signal exposure this feature's own CSV (surfaced directly on
the Submissions page as "Export marks") must NOT include — see
`docs/*-migration.sql`'s own principle, "integrity signals ≠ misconduct
determination." Rather than risk changing the shape of the existing,
already-tested `MarksReport`/`marksReportToCsv` pipeline that other
formats (xlsx, pdf) also depend on, this feature adds a small, separate,
purpose-built module (`src/lib/lecturerMarksExport.ts`) instead.

Reuses `scorePercentage()` from `src/lib/analytics.ts` (the same
percentage-calculation function analytics/reports use) rather than
re-deriving it — `totalScore`/max-score come straight from the stored
`Submission.totalScore` and the exam's `Question.points` sum, the same
authoritative values shown everywhere else in the lecturer UI.

Columns (summary CSV): Student name, Student ID, Student email, Course
code, Course name, Exam, Submission status, Submitted at, Raw mark,
Maximum mark, Percentage, Grading status, Integrity review status.
"Integrity review status" is derived only from `IntegrityEvent.reviewStatus`
(`Not required` / `Needs review` / `Reviewed`) — never from `severity`
or a raw event count, and never an accusatory label.

Detailed CSV (`?detail=true`) adds one `Q<n>` column per question (in
question order), each cell the per-question `Answer.score` awarded —
omitted from the summary export to keep it usably narrow by default.

Filename: `<course-code>_<exam-title>_marks_<YYYY-MM-DD>.csv` (course
code segment omitted for a legacy institution-wide exam with no course),
sanitized to strip `/ \ :` and other filesystem-illegal characters and
collapse whitespace.

Authorization: identical ownership/institution pattern as the existing
export route (`isPlatformAdmin(session) || exam.createdById ===
session.user.id`, then `assertSameInstitution`) — a lecturer cannot
export another institution's or another lecturer's exam by guessing an
exam ID.
