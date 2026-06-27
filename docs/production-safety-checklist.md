# Production Safety Checklist

Run through this before opening a deployment to real students for a graded
exam. Most items can be verified with `scripts/smoke-deployed.mjs` plus a
manual pass through the app; a few require checking your hosting/Supabase
dashboard directly.

## Secrets and source control

- [ ] No secrets committed: `git log --all -- .env .env.local .env.production` and
      `git log --all -- '*.pem' '*.b64'` return nothing. `.gitignore` excludes
      `.env*` (except `.env.example`), `*.pem`, `*.b64`, and `.vercel`.
- [ ] `AUTH_SECRET`, `DATABASE_URL`, `LTI_PRIVATE_KEY_B64`/`LTI_PRIVATE_KEY`,
      and `ANTHROPIC_API_KEY` are set only in Vercel's environment variable
      store (or local `.env`, never committed) — not hardcoded anywhere in
      source.
- [ ] `/api/health` and `/api/readiness` return only booleans/status strings,
      never raw env var values or stack traces (verified by
      `scripts/smoke-deployed.mjs`).

## Network and infrastructure

- [ ] The deployed app is served over HTTPS with a public URL (Vercel does
      this by default for any deployment).
- [ ] `APP_URL` matches the deployed HTTPS domain exactly.
- [ ] Database backups are enabled on the Supabase project (Supabase →
      Project Settings → Database → Backups; daily backups are included on
      paid plans).
- [ ] `AUTH_SECRET` is configured and is a strong random value (not a
      placeholder or example value).

## Environment configuration

- [ ] Required environment variables are present in the deployed
      environment: `DATABASE_URL`, `AUTH_SECRET`, `APP_URL`. Confirm with
      `/api/readiness` showing `databaseConnected`, `authSecretConfigured`,
      and `appUrlConfigured` all `true`.

## Secure exam flow

- [ ] A lecturer account and a student account have been created and used
      to run a full standalone secure exam test (create exam → enable
      Secure Exam Mode → publish → student takes exam through the pre-exam
      checklist → student submits → lecturer grades → lecturer reviews
      integrity events and the evidence report).
- [ ] The privacy notice (`/privacy/student-exam-notice`) is reachable and
      linked from the student exam page.
- [ ] Evidence report access is protected: a student cannot load
      `/lecturer/submissions/[id]/evidence` or its API
      (`/api/lecturer/submissions/[id]/evidence`) — confirmed by this
      project's automated tests
      ([src/lib/secureExam.routes.test.ts](../src/lib/secureExam.routes.test.ts))
      and re-checkable manually by attempting the route as a logged-in
      student.
- [ ] A student cannot see lecturer-only data: AI draft scores/reasoning,
      lecturer resolution notes, and Canvas passback internals are never
      present in a student's own submission response (same test file
      covers this).
- [ ] Integrity/audit events have been reviewed at least once on a real
      exam attempt — open `/lecturer/exams/[id]/integrity` after a student
      session and confirm events appear with sensible severities.

## Optional modules

- [ ] Canvas/LTI is optional: with no `LTI_*` keys configured, the app's
      core exam flow, grading, analytics, and evidence report all still
      work, and the pilot-readiness page shows "Optional Canvas module not
      configured" rather than a failure.
- [ ] AI is optional: with no `ANTHROPIC_API_KEY` configured, AI question
      generation and AI draft marking return a safe "not configured" error
      and nothing else in the app is affected; pilot-readiness shows
      "Optional AI module not configured."

## Known limitations (communicate these to pilot stakeholders)

- Secure Exam Mode v1 is **browser-based**, not an OS-level lockdown. It
  cannot prevent a second device, another person in the room, printed
  material, or OS-level screen capture/remote-access tools. See
  [docs/secure-exam-threat-model.md](secure-exam-threat-model.md) for the
  full threat model and what v1 deliberately does not yet cover (camera/mic
  proctoring, Electron lockdown, certification-grade identity
  verification — all explicitly out of scope for this release).
- `maxAttempts` only supports a value of `1` in this release (data model
  limitation, documented in the threat model).
- Integrity events and risk scores are signals for human review, not
  automatic misconduct determinations — communicate this to lecturers and
  students before a pilot, per the existing evidence report disclaimer.
