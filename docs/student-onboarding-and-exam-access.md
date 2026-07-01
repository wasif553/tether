# Student Onboarding and Exam Access v1

Closes a gap in Multi-Tenant Architecture v1 / Platform Admin Onboarding
v2: a platform admin could invite lecturers into an institution, but had
no clean way to invite students, and a lecturer had no way to add any
friction in front of a published exam beyond institution scoping. v1
adds both, kept deliberately simple.

## How a platform admin invites a student

1. Sign in as a `PLATFORM_ADMIN` and go to `/platform/institutions`.
2. Use the "Invite student" form: pick the target institution, enter
   the student's name, email, and a temporary password (minimum 8
   characters).
3. The student is created with role `STUDENT`, stamped with the target
   institution's `institutionId`, and a `student.invite` audit log entry
   is written.
4. **Email sending is not implemented.** Share the temporary password
   with the student securely (a password manager, an encrypted message)
   — never over plain email or chat.
5. The student can sign in immediately at `/login` and will see only
   published exams from their own institution.

Equivalent API: `POST /api/platform/institutions/[id]/invite-student`
```json
{ "name": "Student Name", "email": "student@example.edu", "password": "temporary-password" }
```
Returns only `id, name, email, role, institutionId, createdAt` — never
the password or its hash. Rejects a duplicate email with 409, and an
inactive target institution with 400.

## How a lecturer sets an exam access code

1. Open an exam's detail page (`/lecturer/exams/[id]`) and find the
   "Exam access code" section.
2. Enter a code (4+ characters) and click "Set access code." The status
   badge changes to "Access code enabled."
3. To remove it, click "Clear" — the exam goes back to "No access code"
   and any student can start it without entering anything.
4. **The code is never shown back to the lecturer after saving.** Only
   its bcrypt hash (`Exam.accessCodeHash`) is stored — if a lecturer
   forgets the code, they must set a new one.
5. Only the exam's owning lecturer (in the same institution) can set or
   clear its code; `PLATFORM_ADMIN` follows the same institution-scoping
   rules as everywhere else in the app.

Equivalent API: `PATCH /api/exams/[id]` with `{ "accessCode": "ROOM-204" }`
to set, or `{ "accessCode": null }` to clear. No API response ever
includes `accessCodeHash`.

## How a student starts an access-code exam

1. On `/student`, an exam with a code shows an "Access code required"
   badge and an inline text field next to "Start exam" instead of a
   plain button.
2. The student enters the code and clicks "Start exam." The code is sent
   directly to `POST /api/exams/[id]/start` in the request body — it is
   never stored client-side beyond the input field.
3. A missing or incorrect code returns a 403 with the message *"Valid
   access code required to start this exam."* — no submission is
   created in this case.
4. Once a submission already exists (the student already started),
   resuming via "Continue" never re-prompts for the code — only the
   initial creation of the submission requires it.
5. Exams without a code (the default) start exactly as before — this is
   purely additive.

Institution isolation is unaffected and is checked first: a student in
a different institution cannot see the exam at all (it's filtered out
of `/api/exams/available`), and a direct `POST /api/exams/[id]/start`
against another institution's exam ID still fails before the access
code is even considered — even with the correct code.

## What this is not

- **Not a substitute for enrolment or course management.** An access
  code is a single shared secret per exam, not a per-student
  enrolment record. Any student who passes the visibility/assignment
  checks and has the code can start the exam.
- **Course, Enrolment, Exam Assignment, Scheduling v1** (see
  `docs/course-enrolment-and-exam-assignment.md`) adds an *optional*
  course/class model: a lecturer can assign an exam to a course or to
  selected students. An exam with no course attached (`courseId: null`)
  remains visible to every student in the institution exactly as
  before — this is unchanged default behaviour, not a regression. The
  access code check described in this document still runs after
  course/assignment visibility, in exactly the same order.
- **No bulk CSV import** for inviting many students, or for enrolling
  students into a course — one invite/enrolment per API call in v1.
- **No email sending** — same caveat as lecturer invites: temporary
  passwords and access codes must be shared with students securely,
  outside the app, by the platform admin or lecturer.
