# Course, Exam-per-Course v1

Every newly created exam must belong to a course; one course can contain
many exams. Purely an application/API-layer change — the data model
already supported this relationship.

## Data model

No migration. `Course.exams Exam[]` / `Exam.courseId String?` /
`Exam.course Course? @relation(...)` already existed in
`prisma/schema.prisma`, already nullable, already without an `onDelete`
cascade. This feature only tightens what a *new* exam may be created
with — it does not touch the schema or any existing row.

Legacy exams with `courseId = null` remain fully supported at every
layer: they load, are editable/reviewable, keep their submissions/marks/
integrity evidence/archive behaviour, and display "No course assigned"
where a course would otherwise show.

## Creation

`POST /api/exams` (the only exam-creation pathway in the app — confirmed
via `grep -rln "prisma.exam.create" src`) now requires `courseId` in
`createExamSchema` (`src/app/api/exams/route.ts`). Validation errors use
the exact lecturer-facing wording:

- Missing course: "Select a course."
- Missing title: "Enter an exam title."
- Invalid duration: "Enter a valid exam duration."

Authorization reuses the existing `assertCanAssignExamToCourse` check
(`src/lib/courseAssignment.ts`) unchanged. Its `CourseAssignmentError` is
caught at this one call site and rewritten to "You do not have access to
this course." (403) so a lecturer can't discover another
institution/lecturer's course by probing `courseId`, and so a lecturer
can never attach an exam to a course they don't teach. The helper itself
is untouched — `assertStudentsInCourse`'s distinct
"not enrolled" error (for `SELECTED_STUDENTS` assignment) still passes
through unmodified.

## Dashboard UI

`src/app/lecturer/page.tsx`'s create-exam panel adds a Course select
(`GET /api/courses`, already scoped server-side to courses the lecturer
teaches; sorted client-side by code then name). Create is disabled until
a course is chosen. A lecturer with no courses sees "Create a course
first" guidance instead of a form that can only fail.

Arriving from a course page (`/lecturer?courseId=...`) pre-selects and
locks the course field so the lecturer never re-picks a course they're
already inside.

## Course detail page

`src/app/lecturer/courses/[id]/page.tsx`'s existing "Exams in this
course" section already lists every exam for the course (filtered
client-side from the same `GET /api/exams?all=true` the dashboard uses)
— no changes needed to prove one course holds many exams. Its "New exam
→" action now links to `/lecturer?courseId=<id>` instead of the bare
dashboard.

## Exams index

`src/app/lecturer/exams/page.tsx` adds a Course filter (options derived
from the exams already loaded, no extra fetch), alongside the existing
lifecycle-status filter pills. Includes a "No course assigned" option for
legacy exams.

## Existing course/exam display

Dashboard cards, the Needs-your-attention queue, the Exams index,
Submissions, Integrity Signals, and Reports already rendered
`course.code — course.name` as secondary metadata under the exam title
from earlier redesign work — unchanged by this feature.

## Marks export, archive

`src/lib/lecturerMarksExport.ts` already includes `courseCode`/
`courseName` columns, sourced from `exam.course`, and degrades to blank
fields (not an error) for a legacy null-course exam — unchanged.

`PATCH /api/exams/[id]`'s archive/restore only ever sets or clears
`archivedAt`; it never reads or writes `courseId`, so archiving/restoring
an exam can never detach or alter its course association — unchanged.

## Canvas/LTI

Course assignment uses Tether's own `Course` entity exclusively. Canvas/
LTI course mapping (`canvasCourseId` on an `LtiLaunchLink`) is a separate
concept and continues to work unmodified; it is never a dependency for
this feature.

## Course deletion

No `DELETE` handler exists on `/api/courses/[id]` (only `GET`/`PATCH`),
so there is no cascade-safety concern to address for this feature.
