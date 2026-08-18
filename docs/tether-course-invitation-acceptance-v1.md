# Tether Course Invitation + Acceptance v1

**Feature:** Tether Course Invitation + Acceptance v1
**Status:** Ready for Preview

---

## What this feature adds

Following `docs/self-service-account-onboarding-v1.md` and
`docs/standalone-exam-link-v1.md`, this is the third and final connection
mechanism from the "Tether Three-Mode Student Access" architecture
inspection: **Tether Course** — safely connecting a self-service STUDENT
(`institutionId: null`) to a lecturer's institution/course, without a
lecturer ever silently claiming that student merely by knowing their
email.

## The core rule

`User.institutionId` transitions from `null` to `course.institutionId`
**only** after the exact student named in the invitation explicitly
accepts it, authenticated as themselves. Nothing else in this feature
ever writes `User.institutionId`. It is also never overwritten from one
non-null institution to another — a student already linked elsewhere is
always rejected, never moved.

This is single-institution-per-user v1: no `StudentInstitutionMembership`
table, no multi-institution support. A student who already belongs to
institution A can never additionally join institution B's course through
this mechanism.

## Data model

`CourseEnrollmentInvitation` (additive, new table):
`{id, courseId, studentId, invitedById, tokenHash, expiresAt, acceptedAt,
revokedAt, createdAt, updatedAt}`, unique on `(courseId, studentId)` — one
logical invitation per course/student pair; regenerating updates the same
row rather than creating duplicates. Bound to an exact existing
`User.id`, never an email string — an invitation can never be created for
an email with no matching account, and a forwarded link can never be
accepted by a different account (see "Acceptance" below).

`CourseEnrollment` is unchanged — acceptance ends by upserting the
existing model exactly as direct same-institution enrolment already did.

## Token

`src/lib/courseInvitationToken.ts` — deliberately a **separate** module
from `src/lib/standaloneInvite.ts` (Standalone Exam Link v1 is DONE/
FROZEN and was not modified). Same cryptographic shape as that module
(256-bit `randomBytes`, base64url, SHA-256 hash, `timingSafeEqual`
verification) for the same reasoning: this is simply the correct shape
for a server-generated, unguessable, single-purpose secret, not a
code-sharing relationship between the two features. Fixed 7-day expiry
(`COURSE_INVITATION_EXPIRY_MS`).

The invitation URL is a dedicated path,
`/student/course-invitations/{invitationId}/{token}` — not a query
string, for the same open-redirect-allowlist reasoning as the Standalone
invite URL. `isSafeCourseInvitationCallbackUrl` in `safeCallbackUrl.ts`
guards the post-login callback for this path without touching any
existing regex.

## Existing enrolment endpoint — five cases

`POST /api/courses/[id]/enrolments` (STUDENT target) now returns one of
five distinct outcomes instead of a single collapsed "does not belong to
this institution" error:

- **A — no account at all:** `404 {code: "STUDENT_NOT_FOUND"}`. Never
  creates an account, never creates an invitation for a non-existent
  email.
- **B — target isn't a STUDENT:** `400 {code: "NOT_A_STUDENT"}`.
- **C — same institution:** unchanged — immediate `CourseEnrollment`
  upsert, `201`.
- **D — `institutionId: null`:** `200 {code: "INVITATION_REQUIRED",
  student}`. Never touches the `User` row.
- **E — a different, non-null institution:** `409
  {code: "DIFFERENT_INSTITUTION"}`, without naming that institution.

(Adding a co-**LECTURER** to a course's teaching team through the same
endpoint is unchanged legacy behavior, out of scope for this feature —
lecturer accounts are always institution-bound at creation.)

## Invitation lifecycle API

`POST /api/courses/[id]/invitations` — create or regenerate, identified
by email server-side (never a client-supplied `studentId`/
`institutionId`). Fails closed (`409`) if the target became affiliated
with any institution — same or different — concurrently, and if the
target already accepted a prior invitation for this exact course
(`ALREADY_ACCEPTED`, never silently resets acceptance state). Returns the
plaintext `invitationUrl` **once**.

`DELETE /api/courses/[id]/invitations/[invitationId]` — revoke. Never
alters `User.institutionId`, never alters any existing
`CourseEnrollment`, never affects exams/submissions. Never deletes the
row (audit/lifecycle evidence).

`GET /api/courses/[id]/invitations` — lists this course's invitations for
the lecturer's "Pending invitations" UI, with a computed
`PENDING | ACCEPTED | REVOKED | EXPIRED` status. Never includes
`tokenHash`.

## Student acceptance — the critical transaction

`GET /api/course-invitations/[invitationId]/[token]` — read-only preview.
Never mutates. Authenticated STUDENT only; a different logged-in
student's account gets a distinct `wrong_account` denial (deliberately
more specific than Standalone Exam Link v1's blanket denial, since this
invitation is bound to an account rather than merely to an exam).

`POST /api/course-invitations/[invitationId]/[token]/accept` — the ONLY
route that ever writes `User.institutionId` from this feature, and the
only one that creates the resulting `CourseEnrollment`. `studentId` is
always `session.user.id`, never request-body-supplied. Everything happens
inside **one** `prisma.$transaction`:

1. Re-load the invitation; verify `studentId === session.user.id`.
2. If already accepted by this same student: idempotent success,
   short-circuit (no re-verification of the now-cleared token).
3. Reject if revoked / expired / token mismatch.
4. **Atomically claim** the row via an `updateMany` whose `WHERE` clause
   re-checks `acceptedAt: null, revokedAt: null, tokenHash: <the exact
   hash just read>` at write time — this is what closes every race
   window (see below), relying on Postgres row-level locking rather than
   any manual locking.
5. Re-read the student's **current** `institutionId` inside the same
   transaction. If it's a *different* non-null institution, throw —
   rolling back the entire transaction, including the claim in step 4, so
   the invitation is left exactly as it was (still pending).
6. If `null`, set it to the course's institution. If already exactly that
   institution, no-op (idempotent continuation).
7. Upsert `CourseEnrollment{courseId, studentId, role: STUDENT}`.
8. Write the `course.invitation_accepted` audit entry, inside the same
   transaction.
9. Clear `tokenHash`, set `acceptedAt`.

### Race safety

- **Two concurrent accepts:** the loser's `updateMany` matches zero rows
  (the winner already committed `acceptedAt`), it re-reads and returns
  the same idempotent success — never a duplicate `CourseEnrollment`.
- **Regenerate vs. accept:** if the lecturer regenerates between the
  student's page load and their click, the row's `tokenHash` has changed;
  the claim's `WHERE tokenHash: <stale hash>` matches nothing, and the
  stale token is correctly rejected.
- **Revoke vs. accept:** same mechanism — `WHERE revokedAt: null` stops
  matching once revoked.
- **Institution race:** handled by the transaction rollback in step 5
  above — never a partial "accepted but not actually affiliated" state.

## Post-acceptance

Course exams (assignment mode `COURSE`) become visible under the exact
same existing rules `GET /api/exams/available` already applies via
`CourseEnrollment` — no second entitlement system was introduced.
`SELECTED_STUDENTS` and Standalone Exam Link `ExamAssignment` rows are
completely untouched by this feature; a student who previously accepted
a Standalone exam keeps that entitlement regardless of later joining an
institution via this mechanism.

Removing a `CourseEnrollment` (existing `DELETE
/api/courses/[id]/enrolments/[userId]`, unchanged) does **not** clear
`User.institutionId` — institution affiliation is broader than any one
course enrolment once a student has accepted it. "Leave institution" is
not implemented in this pass.

## Explicitly out of scope for this pass

- `StudentInstitutionMembership` / multi-institution-per-user.
- Canvas/LTI (including the previously-identified duplicate-account bug).
- Standalone Exam Link v1's own semantics — untouched.
- Email sending — the lecturer receives a copyable link and shares it out
  of band, exactly like Standalone Exam Link v1.
- Automatic student account creation from an invitation — the student
  must already have a Tether STUDENT account.

## Tests

`src/lib/courseInvitationAcceptance.routes.test.ts` — DB-backed route
tests covering the existing-enrolment five-case split, invitation
creation/regeneration/revocation (including entropy, expiry, and
hash-never-exposed checks), acceptance (including idempotency and every
identified race), cross-institution rollback (including that the other
institution's identity is never leaked), post-acceptance exam visibility
and enrolment-removal semantics, Platform Admin invite-student
regression, and the audit trail.
