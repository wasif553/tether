# Individual Exam Timing & Accommodations v1

Lets a lecturer edit an exam's standard duration after creation, and grant
an individual student a time accommodation (e.g. an approved Learning
Access Plan) — extra minutes, a percentage extension, or a custom total
duration — without changing the standard exam duration for everyone else.

## Product goals

1. Lecturers can edit the standard exam duration after an exam has been
   created.
2. Lecturers can assign an individual time accommodation to a student,
   including students with an approved Learning Access Plan.
3. An accommodation affects that student's FUTURE attempt duration only.
4. Once an attempt starts, its effective duration is frozen and never
   changes because the lecturer later edits the standard duration, edits
   the accommodation, or removes it.
5. Timing/anomaly review treats the student's accommodated duration as
   legitimate exam time, never as suspicious extra time.
6. No diagnosis, disability details, medical information, or reason for
   the accommodation is ever stored.

## Data model

`ExamTimeAccommodation` (see `prisma/schema.prisma`) — one row per
`(examId, studentId)` pair:

- `adjustmentMode`: `PERCENT_EXTRA | EXTRA_MINUTES | TOTAL_DURATION`
  (validated string, not a Prisma enum — matches this codebase's
  established "validated string for an enum-like column" convention).
- `adjustmentValue`: a positive integer whose meaning depends on the mode.
- `createdById`: the lecturer who created/last edited it (audit only).

Deliberately a standalone model rather than folded into `ExamAssignment`:
`ExamAssignment` is an access-assignment construct with meaning only when
`assignmentMode` is `SELECTED_STUDENTS`, but a time accommodation must
also work for an ordinary course-wide or legacy institution-wide exam.

No diagnosis/disability/medical/plan-document/reason column exists on this
model, and none should ever be added to it.

## Resolution — the single source of truth

`src/lib/examTimeAccommodation.ts` — pure module (no Prisma, no
Next.js), mirroring the convention already established by
`src/lib/examPolicy.ts`.

`resolveEffectiveExamDurationMins({ standardDurationMins, accommodation })`:

- No accommodation → `effective = standard`.
- `PERCENT_EXTRA` → `effective = ceil(standard * (100 + value) / 100)`
  (ceil so an approved accommodation is never shortened by rounding).
- `EXTRA_MINUTES` → `effective = standard + value`.
- `TOTAL_DURATION` → `effective = max(standard, value)`.

### Why `TOTAL_DURATION` uses `max()`

A student's custom total was set to 90 minutes when the standard duration
was 60. The lecturer later increases the standard duration to 100
minutes. The student must not suddenly receive only 90 minutes — the
`max()` rule means their effective duration becomes 100. The stored
accommodation still says "90 minutes total"; only the *effective* time an
accommodation produces can never fall below the current standard
duration.

All values must be positive integers; zero, negative, non-integer,
non-finite, and unknown-mode input is rejected
(`InvalidExamTimeAccommodationError`), never silently clamped or guessed.

## Integration point — attempt start (the ONLY place this is resolved)

`POST /api/exams/[id]/start` resolves the student's accommodation (if
any) **once**, only for a brand-new attempt (the existing
IN_PROGRESS-resume branch returns well before this point and never
re-resolves anything), and folds the effective duration into the
attempt's existing immutable `examPolicySnapshotJson.timingPolicy` build
— exactly the same freeze-at-start mechanism every other timing-critical
setting in this codebase already uses (see
`resolveSubmissionTimingPolicy` in `src/lib/assessmentLifecycle.ts`).
Every deadline/late-submit/auto-submit/device-revocation/recovery
decision point in the codebase already reads exclusively from that one
frozen `timingPolicy.durationMins` value, so folding the accommodation in
at this single point makes the entire rest of the system automatically
correct with zero further changes — there is no second, independent
"accommodation timer."

An optional, additive `timeAccommodation` snapshot field (sibling to
`timingPolicy` inside `examPolicySnapshotJson`) freezes
`{ standardDurationMins, adjustmentMode, adjustmentValue,
effectiveDurationMins }` for audit/explainability — `null` for every
attempt without an accommodation, including every pre-existing snapshot.
Nothing reads this field for enforcement.

If the stored accommodation row is somehow malformed, attempt start falls
back to the standard duration rather than failing the student's exam
start — a data issue must never block a student from starting.

## Management API

Lecturer (owning the exam) only:

- `GET /api/exams/[id]/time-accommodations` — standard duration, existing
  accommodations (with resolved `effectiveDurationMins` and a cheap
  `hasInProgressAttempt` UX flag), and the exam's eligible-student
  population.
- `POST /api/exams/[id]/time-accommodations` — create or update
  (upsert, keyed by `examId_studentId` — editing reuses this same
  endpoint with the same student).
- `DELETE /api/exams/[id]/time-accommodations/[accommodationId]`.

Eligibility mirrors `POST /api/exams/[id]/start`'s own access rule
exactly: COURSE mode requires course enrollment as STUDENT,
SELECTED_STUDENTS mode requires an `ExamAssignment` row, and a legacy
(`courseId: null`) exam requires only same-institution STUDENT role.
Institution and ownership are enforced server-side throughout — a
lecturer can never manage an accommodation for an exam they don't own, or
target a student outside the exam's real access population, regardless
of client-supplied IDs.

## Auditability

`EXAM_TIME_ACCOMMODATION_CREATED` / `_UPDATED` / `_REMOVED` and
`EXAM_STANDARD_DURATION_UPDATED` via the existing `createPlatformAuditLog`
mechanism, metadata limited to administrative facts (`examId`,
`studentId`, `adjustmentMode`, `adjustmentValue`,
`standardDurationMins`, `effectiveDurationMins`) — never diagnosis or
reason.

## Standard duration editor

Reuses the existing `PATCH /api/exams/[id]` endpoint (already accepted
`durationMins`; no new endpoint). No restriction on editing after
publish or after attempts exist — the frozen per-attempt snapshot is what
protects an already-started attempt, exactly as it already does for
every other timing-critical exam setting.

## Rollout

See `docs/exam-time-accommodations-v1-migration.sql` and the entry in
`docs/migration-ledger.md` — one new, currently-unused table
(`ExamTimeAccommodation`); zero columns added to any existing table.
Safe for an expand-first rollout: applying the migration before the
application code deploys causes zero behaviour change (old application
code has no idea the table exists), and the new application code is the
only thing that will ever read or write it.
