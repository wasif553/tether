# Deploying SES Standalone on Vercel + Supabase

Safe Exam System (SES) is a standalone secure exam platform. Canvas/LTI and
AI question generation/marking are **optional convenience modules** — you
can deploy and run a full secure exam pilot with neither configured. This
guide covers a standalone deployment first, with Canvas and AI as clearly
separated, later, optional steps.

## Environment variables

### Required for core SES

| Variable | Used for | Notes |
|---|---|---|
| `DATABASE_URL` | Prisma connection string | Use the Supabase **Connection pooling** string (port `6543`) for Vercel — see [Supabase connection strings](#supabase-connection-strings) below |
| `AUTH_SECRET` | NextAuth (v5) session signing | This app reads `AUTH_SECRET`, **not** `NEXTAUTH_SECRET`. Generate with `openssl rand -base64 32` |
| `APP_URL` | Builds the Canvas OIDC `redirect_uri`/`target_link_uri` in `/api/lti/login` and `/api/lti/config` — the one app-URL variable actually read by the codebase. Deliberately **not** used for the post-launch redirect in `/api/lti/launch`, which derives its (same-app) destination from the incoming request's own origin instead, so it can never point at a stale deployment URL. | Set to your deployed HTTPS domain, e.g. `https://ses.example.com` — this must match what's registered as the tool's redirect URI in Canvas's Developer Key, so keep it in sync if you change domains |

`AUTH_URL` / `NEXTAUTH_URL` and `NEXT_PUBLIC_APP_URL` are **not currently
read by any code path** in this app — NextAuth v5 auto-trusts the request
host on Vercel (it detects the `VERCEL` env var Vercel sets automatically),
so no separate auth URL variable is required. `APP_URL` is the single
source of truth for the app's own public URL. `NEXT_PUBLIC_APP_URL` is
listed in `.env.example` for forward-compatibility only; setting it has no
effect today.

### Local development only

| Variable | Used for |
|---|---|
| `SHADOW_DATABASE_URL` | Only consulted by `prisma migrate dev` (not used by `prisma db push`, which is what this project's scripts and CI use) |
| `LTI_PRIVATE_KEY_PATH` / `LTI_PUBLIC_KEY_PATH` | Point at local `.pem` files on disk — never set these on Vercel |

### Optional — Canvas/LTI module

| Variable | Required for |
|---|---|
| `LTI_CLIENT_ID`, `LTI_DEPLOYMENT_ID` | Canvas Developer Key identifiers |
| `LTI_PLATFORM_ISSUER`, `LTI_PLATFORM_OIDC_AUTH`, `LTI_PLATFORM_JWKS`, `LTI_TOKEN_ENDPOINT` | Canvas platform endpoints |
| `LTI_PRIVATE_KEY_B64`, `LTI_PUBLIC_KEY_B64` | Base64-encoded RSA keypair — **preferred for Vercel** (see [LTI key setup](#lti-key-setup-optional) below) |
| `LTI_PRIVATE_KEY` / `LTI_PUBLIC_KEY` | Raw multiline PEM fallback (legacy/local only — base64 is preferred for deployment) |
| `LTI_TOOL_NAME`, `LTI_TOOL_DESCRIPTION` | Optional branding shown in `/api/lti/config`; defaults are used if unset |

If none of these are set, the app runs fine. `/api/lti/config` and
`/api/lti/jwks` return a safe 500 error (no stack trace, no key material),
and the pilot-readiness page reports "Optional Canvas module not
configured" rather than failing core readiness.

### Optional — AI module

| Variable | Required for |
|---|---|
| `ANTHROPIC_API_KEY` | AI question generation and AI draft essay marking |

Without it, those two features return a safe "not configured" error.
Nothing else in the app is affected.

## Supabase connection strings

Supabase exposes two Postgres connection strings for the same database:

- **Direct connection** (port `5432`) — a normal Postgres connection. Use
  this for one-off commands you run from your own machine: `prisma db
  push`, `npm run seed`.
- **Connection pooling / Transaction pooler** (port `6543`, via PgBouncer)
  — designed for many short-lived connections, which is exactly what
  Vercel serverless functions create on every invocation. **Use this one
  for the `DATABASE_URL` you set in Vercel.**

To get both: open your Supabase project → **Project Settings → Database →
Connection string**, and copy the "URI" value under each tab.

### Does the Prisma client need a code change for this?

No. This project already uses Prisma 7's driver-adapter mode
(`@prisma/adapter-pg`, see [src/lib/prisma.ts](../src/lib/prisma.ts)) rather
than Prisma's built-in connection engine, and the `pg` driver does not use
named/cached prepared statements across requests, so it's compatible with
Supabase's PgBouncer transaction-mode pooler without any adapter
configuration changes. The smallest correct "fix" here is operational, not
code: **point `DATABASE_URL` at the pooled connection string in
production, and use the direct connection string only for local dev and
one-off schema/seed commands.** Local development continues to use the
local Prisma dev Postgres server (`npx prisma dev`) exactly as before —
nothing in `src/lib/prisma.ts` or `prisma.config.ts` changed for this.

### Schema push and seed commands

```bash
# One-off, from your own machine, using the Supabase DIRECT connection string:
DATABASE_URL="<supabase-direct-connection-string>" npx prisma db push
DATABASE_URL="<supabase-direct-connection-string>" npm run seed   # optional — only if you want the Canvas sandbox seed platform
```

Do **not** run `prisma db push` against production without real Supabase
credentials in hand, and double-check you're pointed at the intended
project before running it — `db push` can alter the live schema.

## A. Standalone pilot deployment (no Canvas, no AI)

1. **Create a Supabase project.** supabase.com → New project. Note the
   database password you set — you'll need it in the connection string.
2. **Copy the database connection string.** Project Settings → Database →
   copy both the direct and pooled URIs (see above).
3. **Create a Vercel project** from this repository (Vercel dashboard →
   Add New → Project → import the repo).
4. **Configure Vercel environment variables** (Project → Settings →
   Environment Variables): at minimum `DATABASE_URL` (pooled string),
   `AUTH_SECRET`, `APP_URL` (your Vercel domain, e.g.
   `https://ses.vercel.app`).
5. **Deploy.** Vercel builds and deploys automatically on push, or trigger
   a manual deploy from the dashboard.
6. **Push the Prisma schema** to the Supabase database (run locally, using
   the Supabase **direct** connection string — see command above).
7. **Seed if needed.** Only required if you intend to test the optional
   Canvas module locally against the seeded sandbox platform; skip for a
   pure standalone pilot.
8. **Run the smoke script** against your deployed URL:
   ```bash
   node scripts/smoke-deployed.mjs https://your-ses-domain.com
   ```
9. **Create a lecturer account and a student account** via `/signup`.
10. **Run a standalone secure exam test**: as the lecturer, create an exam,
    add questions, enable Secure Exam Mode, publish it. As the student,
    take the exam through the secure exam gate, submit, and confirm the
    lecturer can grade it and view the integrity/evidence report.

## B. Optional Canvas setup (after standalone deployment is working)

1. **Configure LTI keys** — generate a keypair and set
   `LTI_PRIVATE_KEY_B64` / `LTI_PUBLIC_KEY_B64` in Vercel (see
   [LTI key setup](#lti-key-setup-optional) below).
2. **Register a Canvas Developer Key** in your Canvas instance using the
   tool config below.
3. **Use `/api/lti/config`** — point Canvas at
   `https://your-domain.com/api/lti/config` (or paste its JSON output
   manually) when creating the Developer Key.
4. **Run the first launch** from a Canvas course assignment using this
   tool.
5. **Link the unmatched launch** — the first launch from a course Canvas
   hasn't seen before lands in `/lecturer/lti/unmatched-launches`; link it
   to the corresponding SES exam.
6. **Relaunch** from Canvas — it should now route directly to the linked
   exam.
7. **Test passback to SENT** — have a student submit and get graded (or
   use "Push to Canvas" on the submission's grading page), then confirm
   the grade reaches Canvas and the passback status reaches `SENT`.

## C. Optional AI setup (after standalone deployment is working)

1. **Add `ANTHROPIC_API_KEY`** in Vercel environment variables.
2. **Redeploy** — Vercel environment variable changes require a new
   deployment to take effect (see [Troubleshooting](#troubleshooting)).
3. **Test AI question generation** from an exam's edit page.
4. **Test AI draft marking** by marking essays with AI on a submitted
   exam.
5. **Confirm lecturers remain final decision-makers** — AI essay scores
   are always shown as drafts; a lecturer must explicitly accept/save a
   grade. AI never finalizes a grade on its own.

## LTI key setup (optional)

Generate an RSA keypair and base64-encode it for deployment. Base64 is
preferred over pasting raw multiline PEM into a dashboard env var field,
which is prone to newline-stripping bugs.

**macOS/Linux:**

```bash
openssl genrsa -out lti_private.pem 2048
openssl rsa -in lti_private.pem -pubout -out lti_public.pem
base64 -w 0 lti_private.pem > lti_private.b64
base64 -w 0 lti_public.pem > lti_public.b64
```

**PowerShell:**

```powershell
openssl genrsa -out lti_private.pem 2048
openssl rsa -in lti_private.pem -pubout -out lti_public.pem
[Convert]::ToBase64String([IO.File]::ReadAllBytes("lti_private.pem")) | Set-Content lti_private.b64
[Convert]::ToBase64String([IO.File]::ReadAllBytes("lti_public.pem")) | Set-Content lti_public.b64
```

Then paste the contents of `lti_private.b64` into `LTI_PRIVATE_KEY_B64` and
`lti_public.b64` into `LTI_PUBLIC_KEY_B64` in Vercel's environment
variables. **Never commit `*.pem` or `*.b64` files** — `.gitignore` already
excludes both patterns.

## Troubleshooting

- **Database connection fails** — confirm you're using the Supabase
  **pooled** (port `6543`) string for `DATABASE_URL` on Vercel, not the
  direct string. Confirm the password in the connection string matches
  the one set when the Supabase project was created (it's not
  retrievable later — reset it in Supabase if lost).
- **Auth redirect mismatch / login loops** — confirm `APP_URL` exactly
  matches your deployed domain, including `https://` and no trailing
  slash.
- **Missing app URL** — `/api/lti/config` and `/api/lti/login` return a
  clear 500 error naming `APP_URL` if it's unset (both build a Canvas-facing
  URL that must match Canvas's registered value, so they can't safely fall
  back to the request's own origin). `/api/lti/launch`'s internal
  post-launch redirect does not depend on `APP_URL` at all — it always
  redirects within whichever origin actually received the launch request,
  so it can never end up pointing at a stale/previous deployment URL.
  None of this affects the core (non-Canvas) app.
- **LTI JWKS unavailable** (`/api/lti/jwks` returns 500) — expected and
  safe if the Canvas module isn't configured. If you intended to enable
  Canvas, confirm `LTI_PRIVATE_KEY_B64`/`LTI_PUBLIC_KEY_B64` (or the
  `_PATH`/raw fallbacks) are set and base64-encode/decode cleanly.
- **Canvas launch not linked** — first launches from a new Canvas course
  land in `/lecturer/lti/unmatched-launches` for a lecturer to link
  manually; this is expected, not a bug.
- **Passback failed** — check the submission's grading page for the
  Canvas passback status and error message. A `FAILED` or `SKIPPED`
  passback never blocks or alters the SES-side grade.
- **AI key missing** — AI question generation and AI draft marking return
  a safe "not configured" error; everything else in the app is
  unaffected.
- **Vercel environment variables not applied until redeploy** — Vercel
  bakes environment variables into a deployment at build time. After
  adding or changing an env var, trigger a new deployment (push a commit,
  or use "Redeploy" in the dashboard) — it will not take effect on the
  currently-running deployment.
