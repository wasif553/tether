# Standalone Exam Link v1

**Feature:** Standalone Exam Link v1
**Status:** Ready for Preview

---

## What this feature adds

Following `docs/self-service-account-onboarding-v1.md`, a self-signed-up
STUDENT has `institutionId: null` — a valid, loginable identity with zero
exam visibility until connected to an exam by some other mechanism. This
feature implements the third of the three connection mechanisms
identified in the prior "Tether Three-Mode Student Access" architecture
inspection: **Standalone Exam Link**. (Canvas/LTI and Tether Course
null-institution claiming are both explicitly out of scope for this
pass.)

A lecturer can generate a secure, single-exam invitation link. A student
— including a null-institution self-signup student — who opens that link
and accepts it gets access to exactly that one exam, without being added
to an institution, enrolled in a course, or exposed to any other exam.

## Data model (minimum additive change)

- `ExamAssignmentMode` gains a third value, `STANDALONE`, alongside the
  existing `COURSE` and `SELECTED_STUDENTS`.
- `Exam` gains two nullable/defaulted columns: `standaloneInviteTokenHash
  String?` and `standaloneInviteEnabled Boolean @default(false)`.

No new entitlement model was added. `ExamAssignment` — the same
`{examId, studentId}` table already used for `SELECTED_STUDENTS` — is
reused as-is for standalone entitlement, via the existing
`@@unique([examId, studentId])` constraint. `User.institutionId` is never
written by any part of this feature.

### STANDALONE semantics vs. the legacy institution-wide exam

A `STANDALONE` exam always has `courseId: null` — but so does a legacy
institution-wide exam (`courseId: null`, `assignmentMode: COURSE`, the
schema default). These two cases must never be conflated:

- `courseId: null` + `assignmentMode: COURSE` → legacy, visible to every
  student in the exam's institution. Unchanged by this feature.
- `courseId: null` + `assignmentMode: STANDALONE` → visible to **no one**
  except students with an explicit `ExamAssignment` row, regardless of
  institution membership.

`src/app/api/exams/available/route.ts`'s `studentVisibilityWhere` used to
have a bug in waiting for this feature: its first `OR` branch matched
`{courseId: null}` with no `assignmentMode` filter, which would have made
every `STANDALONE` exam institution-wide visible too. That branch is now
`{courseId: null, assignmentMode: "COURSE"}` — safe and backward
compatible, since every pre-existing exam already has `assignmentMode:
COURSE` (the default).

## Invitation token

`src/lib/standaloneInvite.ts`:

- `generateStandaloneInviteToken()` — `randomBytes(32)` (256 bits),
  base64url-encoded.
- `hashStandaloneInviteToken(token)` — SHA-256 hex digest. Deliberately
  **not** bcrypt: bcrypt's slow cost factor defends against brute-forcing
  a *low-entropy, human-chosen* secret, and adds nothing for an
  already-unguessable 256-bit server-generated token — while adding
  latency and the 72-byte input-truncation footgun. Only the hash is ever
  stored; the plaintext is never logged or persisted anywhere.
- `verifyStandaloneInviteToken(token, hash)` — recomputes the hash and
  compares via `timingSafeEqual` on equal-length buffers (constant-time;
  a plain `===` on the hex digest would leak timing information).
  Returns `false` — never throws — if the stored hash has an unexpected
  length.
- `buildStandaloneInviteUrl(examId, token)` — builds
  `/student/exams/join/{examId}/invite/{token}`, a dedicated **path**
  shape (not a query string). This was a deliberate choice: extending
  `src/lib/safeCallbackUrl.ts`'s open-redirect allowlist with query-string
  parsing would have been a materially riskier change to a
  security-critical file than adding one more path-based regex
  (`JOIN_WITH_INVITE_PATH_RE` / `isSafeJoinWithInviteCallbackUrl`,
  wired into `isSafeAppCallbackUrl`). The plain `/student/exams/join/
  {examId}` route is completely unaffected and still never carries
  standalone entitlement on its own.

Independent of `accessCode`: the invitation token answers "may this
student acquire entitlement"; `accessCode` (when configured) answers
"does an already-entitled student know the operational code needed to
start now." Both can be configured on the same exam simultaneously.

## Lecturer flow

`POST /api/exams/[id]/standalone-invite` (lecturer, exam owner only) —
generates (or regenerates) the link: atomically sets `assignmentMode:
STANDALONE`, `courseId: null`, a fresh token hash, and
`standaloneInviteEnabled: true`; returns the plaintext `inviteUrl` in
this one response only. Regenerating immediately invalidates the
previous token for **new** entitlement — it never touches any
`ExamAssignment` a student already holds.

`DELETE /api/exams/[id]/standalone-invite` — disables the current token
(no new entitlements can be acquired) without deleting the stored hash
or touching any existing `ExamAssignment`/`Submission`.

The lecturer exam editor (`src/app/lecturer/exams/[id]/page.tsx`) now
presents a 3-way **Audience** selector — Institution-wide (legacy) /
Course / Standalone exam link — in place of the old single Course
dropdown. Selecting "Standalone exam link" only changes which panel is
shown; the server-side mode only actually changes when "Generate link"
(or "Save course & schedule" from the Institution-wide/Course panel) is
clicked. The plaintext link is shown exactly once, right after
Generate/Regenerate; after a reload the UI shows "Invitation link
active" with Regenerate/Disable controls, never a fabricated recovered
link.

## Student flow

`/student/exams/join/[examId]/invite/[token]` — the invitation-landing
page. Shows no exam metadata before acceptance beyond "You have been
invited to this exam." Clicking "Accept invitation" is the one
deliberate, `POST`-only action
(`POST /api/exams/[id]/standalone-invite/accept`) that creates the
`ExamAssignment` — nothing here mutates on page load. An invalid,
expired, disabled, or wrong token produces the same generic denial: "This
exam invitation is not valid or is no longer available." On success, the
page hands off to the ordinary `/student/exams/join/[examId]` flow — from
this point on, a standalone student goes through the exact same
access-check → policy acknowledgement → start pipeline every other
student uses, with no further dependency on the token.

Route protection: `/student/*` requires an authenticated STUDENT session
via `src/proxy.ts` before this page ever renders. An unauthenticated
visitor is redirected to
`/login?callbackUrl=/student/exams/join/[examId]/invite/[token]` and
returned here after login — `isSafeJoinWithInviteCallbackUrl` guards that
callback value against open-redirect the same way the plain join link
already does.

`POST /api/exams/[id]/standalone-invite/accept` — authenticated STUDENT
only. Verifies the exam exists, is published, has `assignmentMode:
STANDALONE`, `standaloneInviteEnabled: true`, and the supplied token
against the stored hash; then `upsert`s `ExamAssignment{examId,
studentId: session.user.id}` (never a client-supplied `studentId`) —
idempotent via the existing unique constraint. Never sets
`User.institutionId`, never creates a `CourseEnrollment`, never exposes
any other exam.

## Authorization wiring (access-check / start / available)

Both `GET /api/exams/[id]/access-check` and `POST /api/exams/[id]/start`
now branch on `assignmentMode === "STANDALONE"` **before** the ordinary
`assertSameInstitution` call: for STANDALONE, entitlement is exactly "an
`ExamAssignment` row exists for this student," independent of
institution membership (including `institutionId: null`).
`assertSameInstitution` is skipped entirely for this branch — it would
otherwise incorrectly throw for a null-institution student, who is
exactly who this feature exists to serve. COURSE/SELECTED_STUDENTS/
legacy exams are completely unaffected — they still go through
`assertSameInstitution` and the existing course/assignment checks exactly
as before.

`GET /api/exams/available`'s null-institution short-circuit (previously
an unconditional `[]`) now returns exactly the published `STANDALONE`
exams this student holds an `ExamAssignment` for — nothing else. An
institution-linked student's visibility is unaffected other than the
`studentVisibilityWhere` branch-1 fix described above; their existing
third `OR` branch (`assignments: {some: {studentId}}}`) already covered
STANDALONE exams with no change needed.

### Bug fixed as part of this feature: `/start`'s post-submission institutionId crash

While wiring STANDALONE into `/start`, a pre-existing bug was found:
after `prisma.submission.create(...)` succeeded, the route called
`requireInstitutionId(session)` unconditionally to feed the
best-effort audit-log/network-evidence calls. For any session with
`institutionId: null` — which STANDALONE mode makes a normal, supported
case — this threw `MissingInstitutionError`, uncaught by the route's
try/catch (which only special-cases the Prisma `P2002` unique-constraint
race), producing an unhandled 500 **after** the submission had already
been durably created.

Fixed by reading `exam.institutionId` instead (the exam's own tenancy
owner — always populated for a real published exam, and the semantically
correct value regardless of the requesting student's own institution
membership), with a null-guard around the one call
(`captureNetworkEvidence`) whose `institutionId` parameter is typed as a
required, non-nullable `string`.

## Submission continuity

Disabling or regenerating an invite never touches an existing
`ExamAssignment` or any `Submission`/answers/evidence/timeline/marking
history. If `/start` rediscovers an existing `IN_PROGRESS` submission,
that resume always succeeds regardless of the invite's current enabled
state — invite revocation only blocks acquiring **new** entitlement, it
never deletes or blocks resuming an active attempt. Direct student
submission routes remain ownership-based, unchanged.

## Institution admin surfaces

`src/app/api/exams/[id]/time-accommodations/route.ts`'s
`isStudentEligibleForExam`/`listEligibleStudents` both gained an explicit
`assignmentMode === "STANDALONE"` branch, checked **before** the existing
`!exam.courseId` legacy branch (a STANDALONE exam also has `courseId:
null`, so without this explicit ordering it would fall into legacy
institution-wide eligibility logic and either wrongly reject a
null-institution student or wrongly list every institution student as
eligible).

## Explicitly out of scope for this pass

- Canvas/LTI is not redesigned.
- Tether Course null-institution claiming is not implemented — a
  lecturer cannot claim/change a null-institution student's
  `institutionId` merely by knowing their email.
- No new entitlement model, no `StudentInstitutionMembership` table.
- No change to `User.institutionId` anywhere in this feature.

## Tests

`src/lib/standaloneExamLink.routes.test.ts` — DB-backed route tests
covering schema/mode, token generation/hashing/verification, lecturer
invite generation/regeneration/disable, student acceptance (including
idempotency and never setting `institutionId`), dashboard visibility for
both null-institution and institution-linked students, access-check/start
authorization (including the institutionId crash fix), submission
continuity across invite state changes, and regression coverage for
COURSE/SELECTED_STUDENTS/legacy exams and cross-tenant isolation.
