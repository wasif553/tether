# Course, Enrolment, Exam Assignment, Scheduling v1

**Feature:** Course, Enrolment, Exam Assignment, Scheduling v1
**Status:** Local only — production DDL required before deploying (see
"Production migration" below)

---

## What this feature adds

Before this feature, every published exam in an institution was visible
to every student in that institution — there was no way to target an
exam at a specific class or a subset of students, and no explicit
scheduled availability window beyond exam duration.

This feature adds:

1. **Course** — an academic grouping inside an Institution (e.g. "CS201
   — Intro to Databases"). A course belongs to exactly one institution.
2. **CourseEnrollment** — a student or lecturer's membership in a
   course, with a role (`STUDENT` or `LECTURER`).
3. **ExamAssignment** — a direct link from an exam to a specific
   student, used when an exam is assigned to selected students rather
   than a whole course.
4. **Exam scheduling** — `availableFrom`/`availableUntil` on `Exam`, an
   explicit availability window independent of `durationMins`.

---

## Institution vs. Course vs. selected-student assignment

| Concept | Scope | Enforced by |
|---|---|---|
| **Institution** | The hard tenancy boundary. Nothing crosses it, ever. | `src/lib/institutionScope.ts` — unchanged by this feature |
| **Course** | Academic grouping *inside* one institution. | `Course.institutionId`, checked before any course-level operation |
| **Selected-student assignment** | A named list of individual students on one exam. | `ExamAssignment`, always additionally scoped by the exam's institution |

A course does not weaken institution isolation — every `Course` row has
exactly one `institutionId`, and every enrolment, assignment, and query
in this feature is nested inside the existing institution check before
any course/enrolment logic runs.

---

## Exam assignment modes

`Exam.assignmentMode` is one of:

- **`COURSE`** (default) — visible to every student enrolled in
  `Exam.courseId` with `CourseEnrollment.role: STUDENT`.
- **`SELECTED_STUDENTS`** — visible only to students with an
  `ExamAssignment` row for that exam. Selected students must already be
  enrolled in the exam's course (enforced at exam create/update time by
  `src/lib/courseAssignment.ts`).

`Exam.courseId` is nullable. `null` means **no course** — see "Legacy
institution-wide exams" below.

---

## Access code is separate from assignment

**Access code is not enrolment.** It is an optional exam-*start*
control, orthogonal to course/assignment visibility:

- Visibility/assignment answers "can this student see and attempt this
  exam at all?"
- Access code (if `accessCodeRequired`) answers "did they type the
  right code right now?"

These are checked in a fixed order in `POST /api/exams/[id]/start`:

1. Authenticated student
2. Same institution
3. Course enrolment or direct `ExamAssignment`
4. Exam published
5. Availability window open
6. Access code (if required)
7. Create/resume submission
8. Capture network evidence (fire-and-forget)

No submission is ever created if any check before step 7 fails. This
order was unchanged by this feature except for inserting step 3 — access
code enforcement (step 6) behaves exactly as it did before Course v1.

---

## Scheduled availability windows

- `availableFrom` / `availableUntil` are the new, explicit scheduling
  fields, checked in both `GET /api/exams/available` (visibility) and
  `POST /api/exams/[id]/start` (start enforcement).
- The pre-existing `startsAt` / `endsAt` fields are still honored as a
  fallback: `opensAt = availableFrom ?? startsAt`, `closesAt =
  availableUntil ?? endsAt`. Setting either new field takes precedence.
- **Both are optional.** An exam with neither field set has no window
  restriction — it is available whenever the visibility/assignment
  rules above are satisfied.
- The student dashboard shows an exam's status as `open`, `upcoming`
  (with "Opens at ...") or `closed`. Lecturers see `Draft` / `Scheduled`
  / `Open` / `Closed` on their exam list.

---

## Legacy institution-wide exams (`courseId: null`)

**This is the most important compatibility guarantee in this feature.**

Every exam that existed before this feature shipped has `courseId:
null`. The intended and implemented behavior:

> Existing published exams with `courseId: null` remain visible
> institution-wide, exactly as before, until a lecturer optionally
> attaches them to a course.

Concretely:

- In `GET /api/exams/available`, the visibility query is an `OR` of
  three independent branches. The first branch, `courseId: null`, has
  **no additional condition** — it does not check enrolment or
  assignment at all. Every student in the exam's institution sees it.
- In `POST /api/exams/[id]/start`, the course/assignment check
  (`if (exam.courseId) { ... }`) is skipped entirely when `courseId` is
  `null` — institution membership (already checked earlier) is
  sufficient, exactly as it was before this feature.
- Cross-institution isolation is unaffected: both branches above are
  nested inside the pre-existing `institutionWhere(session)` /
  `assertSameInstitution()` checks, which run first. A legacy exam in
  institution B is still invisible to a student in institution A.
- Access-code behavior for legacy exams is completely unchanged —
  the access-code check happens after visibility/assignment resolution
  in both cases, and legacy exams don't add or remove anything from
  that check.
- Availability windows on legacy exams work the same as on
  course-assigned exams: only enforced if `availableFrom`/
  `availableUntil` (or the older `startsAt`/`endsAt`) are actually set.
- **No migration backfills `courseId` onto existing exams.** Nothing
  currently published becomes invisible the moment this feature ships.

Tests in `src/lib/courseEnrolmentExamAssignment.test.ts` explicitly
cover: a legacy exam remains visible to same-institution students, is
invisible cross-institution, still requires its access code, and starts
successfully with no schedule restriction.

---

## Canvas/LTI mapping (v1 foundation only)

This pass adds a **foundation**, not a rebuild of Canvas integration:

- `Course.canvasCourseId` / `Course.ltiPlatformId` — new, optional
  fields for mapping an SES course to a Canvas course on a given LTI
  platform. **Not yet read or written by any LTI code path** — they
  exist so a future pass can wire Canvas course → SES course mapping
  without another schema migration.
- Exam-level Canvas mapping **already existed** before this feature via
  `LtiExamLink` (`examId`, `platformId`, `resourceLinkId`,
  `canvasCourseId`, `canvasAssignmentId`) — this feature does not
  duplicate it with new `Exam`-level fields, to avoid two sources of
  truth for the same mapping.
- **Not implemented in v1:** Canvas launch does not yet auto-enrol a
  student into the matching SES course, and Canvas course IDs are not
  yet cross-referenced against `Course.canvasCourseId`. This is
  intentionally deferred — see "Future work" below.
- No existing LTI route (`/api/lti/launch`, `/api/lti/login`, etc.) was
  modified by this feature. All existing LTI/Canvas tests pass
  unchanged.

---

## Enrolment listing shows institutional student ID

`GET /api/courses/[id]` returns each enrolled student's
`institutionStudentId` (Assessment Operations v1 — see
docs/assessment-operations-v1.md) alongside name/email, and the
lecturer course detail page displays it when set. This is display-only
here — enrolment itself is still keyed by email/user id, not by
student ID.

## What this is not

- **Not a full SIS integration.** There is no automated roster sync,
  term/semester modeling, or grade-passback-per-course. A course here
  is a simple grouping mechanism for exam visibility.
- **Not bulk enrolment.** Students are enrolled one at a time via
  `POST /api/courses/[id]/enrolments` (by email or user id). CSV/bulk
  import is future work — see below.
- **Not a replacement for institution isolation.** Institution remains
  the only hard tenancy boundary; course/enrolment/assignment operate
  entirely within it.

## Future work

- Bulk/CSV student enrolment into a course
- Canvas course ↔ SES course auto-mapping on LTI launch
- Per-course analytics/reporting
- Course archival/term rollover workflow

---

## API summary

| Route | Method | Purpose |
|---|---|---|
| `/api/courses` | GET | List courses (platform admin: all in scope; lecturer: courses they teach) |
| `/api/courses` | POST | Create a course (platform admin: any institution; lecturer: own institution, auto-enrolled as LECTURER) |
| `/api/courses/[id]` | GET | Course detail + enrolment list |
| `/api/courses/[id]` | PATCH | Update course name/code/description/active |
| `/api/courses/[id]/enrolments` | POST | Enrol a user (by `userId` or `email`) with a role |
| `/api/courses/[id]/enrolments/[userId]` | DELETE | Remove an enrolment |
| `/api/exams` | POST | Create exam — accepts `courseId`, `assignmentMode`, `selectedStudentIds`, `availableFrom`, `availableUntil` |
| `/api/exams/[id]` | PATCH | Update exam — same course/assignment/schedule fields; `courseId: null` reverts to legacy |
| `/api/exams/available` | GET | Student-facing list — course/legacy/assignment visibility + availability status |
| `/api/exams/[id]/start` | POST | Enforces the 8-step order above |

All course-management routes reject `STUDENT` role callers, enforce
institution isolation via `assertSameInstitution`, and never expose
`accessCodeHash`, `passwordHash`, `correctAnswer`, or network evidence.

---

## Production migration required

This feature adds three new tables (`Course`, `CourseEnrollment`,
`ExamAssignment`) and four new nullable/defaulted columns on `Exam`
(`courseId`, `assignmentMode`, `availableFrom`, `availableUntil`). Like
prior schema additions in this project, apply the DDL via the Supabase
SQL Editor — do **not** run `prisma db push` against production. See
`docs/production-safety-checklist.md` for the general procedure.
