# Platform Admin Onboarding v2

How a `PLATFORM_ADMIN` operates this multi-tenant deployment day-to-day,
without writing SQL. Builds on Multi-Tenant Architecture v1 — see
docs/multi-tenant-migration.md for the schema and institution-scoping
helpers this relies on.

## Becoming a platform admin

There is no self-service way to become a `PLATFORM_ADMIN`, and there is
no fallback or default password — platform admin credentials must be
created explicitly, by one of these two paths:

1. **Seed script with explicit env vars.** Set both `PLATFORM_ADMIN_EMAIL`
   and `PLATFORM_ADMIN_PASSWORD` before running `prisma/seed.ts`. If
   both are present, the seed creates (or updates) a `PLATFORM_ADMIN`
   user with that email/password, hashed the same way as every other
   account (bcrypt, cost 12) — never logged or printed. If either var is
   missing, the seed skips platform admin creation entirely and logs a
   safe message; it does not fail the rest of the seed.
2. **Promote a trusted existing user.** An operator with direct database
   access can update an existing user's `role` to `PLATFORM_ADMIN` (e.g.
   via a one-off SQL statement or Prisma Studio) rather than creating a
   new account.

Log in with that account, then use `/platform/institutions`.

## Creating an institution

1. Sign in as a `PLATFORM_ADMIN` and go to `/platform/institutions`.
2. Fill in the "Create institution" form: name, slug, optional domain,
   plan (defaults to `"pilot"`).
3. Slugs are sanitized automatically — lowercased, non-alphanumeric
   characters collapsed to single hyphens — but must be unique. A
   duplicate slug returns a 409.
4. The new institution starts `active: true` with zero users and exams.

Equivalent API: `POST /api/platform/institutions`
```json
{ "name": "Example University", "slug": "example-university", "domain": "example.edu", "plan": "pilot" }
```

## Inviting a lecturer

1. On `/platform/institutions`, use the "Invite lecturer" form: pick the
   target institution, enter the lecturer's name, email, and a temporary
   password (minimum 8 characters).
2. The lecturer is created with role `LECTURER` and stamped with the
   target institution's `institutionId` immediately — no separate
   acceptance step.
3. **Email sending is not implemented yet.** The temporary password is
   never emailed automatically — share it with the lecturer securely
   (e.g. a password manager, an encrypted message), not over plain
   email or chat.
4. The lecturer can sign in immediately with that email/password at
   `/login` and will see only their own institution's data.

Equivalent API: `POST /api/platform/institutions/[id]/invite-lecturer`
```json
{ "name": "Lecturer Name", "email": "lecturer@example.edu", "password": "temporary-password" }
```

If the target institution is inactive, this returns a 400 — reactivate
it first.

## Activating / deactivating an institution

Use the "Activate"/"Deactivate" button next to an institution on
`/platform/institutions`, or `PATCH /api/platform/institutions/[id]`
with `{ "active": false }`. Deactivating an institution does **not**
delete it, its users, or its data — it only blocks new lecturer invites
into it (see above). There is no institution-deletion feature in v2.

`name`, `domain`, and `plan` can also be updated via the same `PATCH`
endpoint. **The `slug` cannot be changed in v2** — it isn't yet tested
and other systems may reference it.

## Audit log

Every institution create/update and lecturer invite writes a
`PlatformAuditLog` row (actor, action, target, institution, timestamp,
and a small metadata blob — never passwords or password hashes). View
recent entries at the bottom of `/platform/institutions`, or via
`GET /api/platform/audit-logs?limit=50&institutionId=...&action=...`.

This is a minimal v2 log for operational visibility, not a compliance or
security audit trail — it has no tamper-evidence, retention policy, or
export tooling.

## What's still not implemented

- **Billing** — no plans, payments, or usage limits beyond the `plan`
  string field, which is currently just a label.
- **Enterprise SSO** — institutions authenticate via the same
  email/password flow as everyone else; no SAML/OIDC.
- **Student bulk import** — students still self-signup or arrive via
  Canvas LTI launch; there is no platform-admin bulk-create flow for
  students.
- **Institution deletion** — only activate/deactivate.
- **Email sending** — see "Inviting a lecturer" above.
