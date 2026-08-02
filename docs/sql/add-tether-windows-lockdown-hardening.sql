-- Tether Windows Lockdown Hardening v1 — see
-- docs/tether-windows-lockdown-hardening-v1.md.
--
-- Additive enum update ONLY — no new table, no new column, no dropped/
-- renamed/retyped value. Adds five new IntegrityEventType values so
-- prohibited-application detections during an active exam can be
-- recorded as genuine integrity signals — see Part 11's classification
-- rules in the doc above. Every other lockdown fact (preflight blocked,
-- process inspection unavailable, restoration lifecycle, navigation/
-- download denials, remote-session check failures) is PlatformAuditLog
-- only, whose `action` column is a plain string — no schema change is
-- needed for any of those.
--
-- NOT applied by the assistant that generated it. Preview and Production
-- share ONE Supabase database (see docs/migration-ledger.md) — apply
-- this file ONCE, manually, through the Supabase SQL Editor, after
-- review. Do not run `prisma db push`, `prisma migrate dev`, `prisma
-- migrate deploy`, or `prisma migrate resolve` against the shared
-- database. Every statement below is idempotent (`ADD VALUE IF NOT
-- EXISTS`), so this file is safe to re-run if an earlier attempt was
-- interrupted — but do not deliberately re-apply it after a confirmed
-- success (see "Post-application verification" below and the ledger
-- entry this file should get once applied).

-- ---------------------------------------------------------------------------
-- Pre-application verification — run first. Expect ZERO rows.
-- ---------------------------------------------------------------------------
-- SELECT enumlabel FROM pg_enum
-- WHERE enumtypid = 'IntegrityEventType'::regtype
--   AND enumlabel IN (
--     'REMOTE_CONTROL_SOFTWARE_DETECTED',
--     'SCREEN_CAPTURE_SOFTWARE_DETECTED',
--     'DEBUGGING_TOOL_DETECTED',
--     'PROHIBITED_APPLICATION_DETECTED',
--     'PROHIBITED_APPLICATION_CLOSED'
--   );

ALTER TYPE public."IntegrityEventType" ADD VALUE IF NOT EXISTS 'REMOTE_CONTROL_SOFTWARE_DETECTED';
ALTER TYPE public."IntegrityEventType" ADD VALUE IF NOT EXISTS 'SCREEN_CAPTURE_SOFTWARE_DETECTED';
ALTER TYPE public."IntegrityEventType" ADD VALUE IF NOT EXISTS 'DEBUGGING_TOOL_DETECTED';
ALTER TYPE public."IntegrityEventType" ADD VALUE IF NOT EXISTS 'PROHIBITED_APPLICATION_DETECTED';
ALTER TYPE public."IntegrityEventType" ADD VALUE IF NOT EXISTS 'PROHIBITED_APPLICATION_CLOSED';

-- ---------------------------------------------------------------------------
-- Post-application verification.
-- ---------------------------------------------------------------------------
-- SELECT enumlabel FROM pg_enum
-- WHERE enumtypid = 'IntegrityEventType'::regtype
--   AND enumlabel IN (
--     'REMOTE_CONTROL_SOFTWARE_DETECTED',
--     'SCREEN_CAPTURE_SOFTWARE_DETECTED',
--     'DEBUGGING_TOOL_DETECTED',
--     'PROHIBITED_APPLICATION_DETECTED',
--     'PROHIBITED_APPLICATION_CLOSED'
--   )
-- ORDER BY enumlabel;
-- (Expected: five rows)
--
-- No existing IntegrityEvent row is affected by an enum value addition —
-- nothing writes one of these five new values until a real detection
-- occurs, and no existing row's eventType changes:
-- SELECT count(*) FROM "public"."IntegrityEvent"
-- WHERE "eventType" IN (
--   'REMOTE_CONTROL_SOFTWARE_DETECTED', 'SCREEN_CAPTURE_SOFTWARE_DETECTED',
--   'DEBUGGING_TOOL_DETECTED', 'PROHIBITED_APPLICATION_DETECTED',
--   'PROHIBITED_APPLICATION_CLOSED'
-- );
-- (Expected: 0 immediately after applying)

-- ---------------------------------------------------------------------------
-- Rollback.
-- ---------------------------------------------------------------------------
-- Postgres cannot remove an enum value once added, even if unused —
-- leaving the five unused values in place is safe (application code
-- simply never writes them if this feature's code is reverted) and is
-- the recommended forward-fix over attempting an enum rebuild. The
-- practical rollback for almost any issue is simply not shipping the
-- application code that writes these values, rather than reverting the
-- schema.
