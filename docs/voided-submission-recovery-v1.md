# VOIDED-attempt recovery v1

## Problem

A student's exam attempt can be created with a frozen `secureClientPolicySnapshotJson`
that no longer matches the exam's current `deliveryMode`. This happens when
the row was created while Tether secure delivery was unavailable (e.g. the
`TETHER_CLIENT_REQUIRED_DISABLED` kill switch), silently downgrading the
frozen policy to `STANDARD_WEB` even though the exam is (and, at the time,
was meant to be) `TETHER_CLIENT_REQUIRED`. Once availability is restored,
`POST /api/exams/[id]/start`'s resume path correctly tells the student "this
exam requires Tether" (based on the exam's *current* settings), but
`POST /api/submissions/[id]/secure-client/launch` then rejects the manifest
request (`NOT_ENABLED`) because *this attempt's own frozen policy* still says
otherwise — an unrecoverable retry loop with no distinguishable failure
state and no supported repair path.

## Model

`SubmissionStatus` gains a fourth value, `VOIDED`, alongside the existing
`IN_PROGRESS` / `SUBMITTED` / `GRADED`. A VOIDED submission:

- remains permanently stored, with its frozen `secureClientPolicySnapshotJson`,
  answers, integrity events, and network evidence byte-for-byte unchanged
- never resumes, never accepts a submit, never activates, never grades
- never counts toward `Exam.secureSettings.maxAttempts`
- never contributes a score or appears as a genuine SUBMITTED/GRADED outcome
- remains visible to authorized staff (lecturer/platform admin) for audit

`attemptNumber` is never renumbered or reused — see
`src/lib/assessmentLifecycle.ts`'s `nextAttemptNumber` (already
status-agnostic) and `academicAttemptOrdinal` (the student-facing "Attempt X
of Y" ordinal, which counts only non-voided attempts, since the raw
`attemptNumber` can legitimately exceed `maxAttempts` once an earlier attempt
has been voided).

## Detection

`isSecurePolicyMismatchForResume()` (`src/lib/secureClientPolicy.ts`) is the
one shared eligibility check: the exam's current, raw, lecturer-configured
`deliveryMode` is `TETHER_CLIENT_REQUIRED`, but the attempt's own frozen
policy fails `isFrozenPolicyTetherSecure()` — checked against
`deliveryMode`, `requireVerifiedClient`, and `allowedClientTypes` together,
never `requireVerifiedClient` alone.

`POST /api/exams/[id]/start`'s `existingInProgress` branch checks this
*before* computing a Tether-launch redirect, and returns a typed 409
(`SECURE_POLICY_MISMATCH_RESTART_REQUIRED`) instead — read-only, never
mutating the snapshot, never auto-voiding.

## Recovery

`POST /api/lecturer/submissions/[id]/void` ("Void technical attempt and
allow restart") is deliberately narrow: it only accepts a submission that is
currently `IN_PROGRESS` *and* satisfies `isSecurePolicyMismatchForResume()`.
It is not a generic "void any in-progress attempt" capability — that is
explicitly out of scope for this pass.

Requires: lecturer (exam owner) or platform admin, same-institution boundary,
a non-empty `reason`, and explicit `confirm: true` from the caller. Runs
inside one transaction guarded by the same
`pg_advisory_xact_lock(hashtext(submissionId))` key space
`POST /api/submissions/[id]/submit` already uses for this row — the two can
never race into a state where both a void and a submit commit. The
`PlatformAuditLog` write (`action: "SUBMISSION_VOIDED"`) happens on the same
transaction client, so it can never be persisted without the status change,
or vice versa.

## Files

- `prisma/schema.prisma` — `SubmissionStatus.VOIDED` (additive enum value)
- `docs/voided-submission-recovery-v1-migration.sql` — the hand-reviewed,
  idempotent `ALTER TYPE` migration (not yet applied to any environment)
- `src/lib/assessmentLifecycle.ts` — `isActiveSubmission`,
  `isVoidedSubmission`, `isSubmittedSubmission`, `countsTowardAttemptLimit`,
  `isAcademicAttempt`, `isGradableSubmission`, `academicAttemptOrdinal`
- `src/lib/secureClientPolicy.ts` — `isFrozenPolicyTetherSecure`,
  `isSecurePolicyMismatchForResume`
- `src/lib/platformAdmin.ts` — `createPlatformAuditLog` now accepts an
  optional transaction client
- `src/app/api/exams/[id]/start/route.ts` — the mismatch gate, and
  `finalizedAttemptCount` now uses `countsTowardAttemptLimit`
- `src/app/api/exams/available/route.ts` — same attempt-count fix, plus
  `attemptOrdinal` in the response
- `src/app/api/lecturer/submissions/[id]/void/route.ts` — the recovery action
- Grading/analytics/export sweep: `src/app/api/submissions/[id]/grade/route.ts`,
  `src/app/api/lecturer/submissions/[id]/answers/[questionId]/ai-mark/route.ts`,
  `src/app/api/lecturer/submissions/[id]/approve-ai-grade/route.ts`,
  `src/lib/analytics.ts`, `src/lib/assessmentExport.ts`,
  `src/lib/lecturerMarksExport.ts`
- Student-facing state: `src/lib/studentDashboardGrouping.ts`,
  `src/lib/studentSubmissionState.ts`, `src/app/student/page.tsx`,
  `src/app/student/submissions/[id]/page.tsx`
- `src/lib/tetherRecovery.ts` — a voided submission is treated as terminal
  for Tether session recovery purposes

## Deliberately out of scope for this pass

- A generic "void any in-progress attempt" academic/admin capability
- A lecturer-facing UI button wiring the new endpoint into the submission
  detail page (the endpoint exists and is fully tested; no UI trigger was
  added yet)
- A "VOIDED" filter option in the lecturer submissions list dropdown
- Any migration actually being applied to Preview or Production
