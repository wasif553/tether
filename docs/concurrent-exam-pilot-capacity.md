# Concurrent Secure Exam Capacity

This document covers what was validated for multiple students taking
multiple Secure Exam Mode exams concurrently on the live Vercel + Supabase
deployment, how to re-run that validation, and staged rollout guidance.

This validation is for the **standalone secure exam flow only**. Canvas/LTI
and AI are optional modules and are never exercised by the load test script
— a deployment with neither configured is expected to pass.

## RESOLVED — Supabase pooler mode and connection handling

Earlier rounds of live load testing against the deployed instance found
`submit` requests failing under concurrency with empty-body 500s
(infrastructure-level timeouts). Root cause: `DATABASE_URL` was pointing at
Supabase's session-mode pooler (port `5432`, global ~15-connection cap)
instead of the transaction-mode pooler (port `6543`). This was fixed by
switching the Vercel `DATABASE_URL` environment variable to the
transaction-mode connection string, on top of the app-side hardening
already in place (`DATABASE_POOL_MAX` connection cap in `src/lib/prisma.ts`,
commit `f236a54`; the submit route's batch-transaction rewrite, commits
`492c35c` and `5931e62`). See "Final validated results" below for the
re-run after this fix.

## What was tested

`scripts/load-test-secure-exam.mjs` drives, against a real deployed URL:

1. A `LOADTEST_`-prefixed lecturer account (signup + login).
2. One or more `LOADTEST_`-prefixed exams, each with Secure Exam Mode
   enabled, one MCQ and one short-answer question, published.
3. `LOADTEST_`-prefixed student accounts (signup + login), distributed
   round-robin across the exams.
4. Concurrently, for every student: start the exam, autosave an answer,
   record one integrity event (a simulated right-click attempt), then
   submit.
5. A duplicate-submission check: each student re-issues a "start exam"
   call after submitting; a healthy deployment returns the *same*
   submission id every time (this is what makes starting idempotent).
6. Lecturer-side reads: analytics and integrity events fetched once per
   exam.
7. Cleanup: every exam created by the run is deleted (this cascades to its
   questions/submissions/answers/integrity events via the schema's
   `onDelete: Cascade`). Lecturer/student *accounts* are not deleted —
   there is no delete-user API in this app — but they are harmless
   throwaway accounts and are printed at the end of the run so they can be
   identified for manual cleanup if desired.

Concurrency-sensitive correctness (separate from the load script) is also
covered by automated tests in
[src/lib/concurrency.routes.test.ts](../src/lib/concurrency.routes.test.ts):
two students submitting the same exam independently, two simultaneous
"start exam" calls from the same student never creating two submissions,
integrity-event debounce under rapid repeated events, and analytics
correctness with a mix of in-progress/submitted/graded submissions in the
same exam. See [src/lib/secureExam.routes.test.ts](../src/lib/secureExam.routes.test.ts)
for idempotent double-submit, autosave-blocked-after-submit, late-submit
blocking, and evidence-report access control.

## How to run the load test

```bash
node scripts/load-test-secure-exam.mjs --baseUrl=https://your-domain.com --students=10 --exams=1
node scripts/load-test-secure-exam.mjs --baseUrl=https://your-domain.com --students=25 --exams=2
node scripts/load-test-secure-exam.mjs --baseUrl=https://your-domain.com --students=50 --exams=3
```

The script requires no secrets or `.env` — it only needs the target URL.
It prints a report with per-phase success rates, average/P95 response
time, errors grouped by route and status, and a recommendation (`PASS for
internal pilot`, `PASS for small controlled class`, or `NEEDS
INVESTIGATION`). It warns if `--students` exceeds 50 but does not refuse
to run — treat results above 50 with extra caution, since this script
itself is not validated past that size.

Pass `--cleanup=false` to skip exam deletion (useful if you want to
inspect the created data manually afterward in the lecturer UI).

## Live stage results — earlier (pre-fix) rounds

Run against the previous preview deployment URL, before the Supabase
pooler-mode fix and the submit-route batch-transaction rewrite:

| Stage | Result |
|---|---|
| 10 students, 1 exam (before fix) | NEEDS INVESTIGATION — start/autosave/integrity-event 100%, submit 10% (1/10), integrity-events fetch failed |
| Connection-pool fix deployed (commit `f236a54`) | App-side pool capped at `DATABASE_POOL_MAX=3`; deployed and confirmed live via `scripts/smoke-deployed.mjs` |
| 10 students, 1 exam (after fix) | Still NEEDS INVESTIGATION — start/autosave/integrity-event 100%, submit 30% (3/10). Root cause narrowed to the **Supabase session-mode pooler's global ~15-connection cap** rather than this app's own pool sizing |
| 25 students, 2 exams | Not run — stage 1 had not passed cleanly yet |
| 50 students, 3 exams | Not run — same reason |

## Final validated results

Production URL: `https://tether-murex.vercel.app`
Validated: June 2025

After switching `DATABASE_URL` to Supabase's transaction-mode pooler (port
`6543`) and deploying the submit-route batch-transaction rewrite, all three
load test stages were re-run and passed:

| Stage | Students / Exams | Result |
|---|---|---|
| Stage 1 | 10 students, 1 exam | 100% all phases — **PASS** |
| Stage 2 | 25 students, 2 exams | 100% all phases — **PASS** |
| Stage 3 | 50 students, 3 exams | 96% autosave, 94% submit — **ACCEPTABLE FOR PILOT** |

P95 latency at 50 students: ~4 seconds.

**Recommended pilot capacity:** up to 30–40 students per exam on the
current Vercel + Supabase free tier. For 50+ students, upgrade to Vercel
Pro + Supabase Pro first and re-validate.

**Known limitation:** the load test script fires all submits
simultaneously (a worst-case burst), whereas real exams have natural
staggering as students finish at different times — actual production
performance is expected to be better than these load test results
suggest.

## Recommended rollout stages

| Stage | Students | Notes |
|---|---|---|
| Internal users | 5–10 | Team/staff dry run before any real student touches it |
| Controlled class | 20–30 | First real class pilot, ideally with a TA monitoring live |
| Larger pilot | 50–75 | Only after at least one clean controlled-class run with no `NEEDS INVESTIGATION` results |
| 100+ | — | Only after further load validation beyond what this script covers — re-run at higher counts and review Vercel/Supabase plan limits first |

Each stage should be a genuine increase in confidence, not just a bigger
number — re-run the load test at each new student count before trusting
it with real students, and check the monitoring signals below during a
real class session, not just during the synthetic load test.

## What to monitor during a real pilot

- **Vercel function errors** — Vercel dashboard → your project →
  Observability/Logs. Watch for 5xx spikes during the exam window.
- **Supabase connection errors** — Supabase dashboard → Database →
  connection pool usage. If you're on the free/small tier, watch for
  "too many connections" errors when concurrency rises.
- **Autosave failures** — students see "A save attempt failed and was
  retried" banners if `AUTOSAVE_FAILED` integrity events are recorded;
  check the integrity review page during/after a real exam.
- **Submit failures** — a student stuck on "Submitting..." or seeing an
  error is the most disruptive failure mode; check Vercel function logs
  for the `/api/submissions/[id]/submit` route.
- **Integrity event failures** — these are designed to fail silently from
  the student's perspective (never interrupt the exam), so they won't
  surface as visible errors; check event counts in the integrity review
  page against expected behavior.
- **P95 latency** — the load test script reports this; if it climbs
  noticeably between stages, investigate before scaling further.
- **Auth/session failures** — students unable to log in or getting logged
  out mid-exam; check `AUTH_SECRET`/`APP_URL` configuration and Vercel
  deployment consistency (a redeploy mid-exam window would be disruptive —
  avoid deploying during a live exam).

## Current known limitations

- Secure Exam Mode v1 is **browser-based only** — no OS-level lockdown.
- No camera/microphone proctoring.
- No certification-grade identity verification.
- Canvas/LTI is optional and was not exercised by this validation; AI is
  optional and was not exercised either — both can be added later without
  affecting the core secure exam flow's behavior under load.
- Actual capacity depends on your specific Vercel plan (concurrent
  function execution limits) and Supabase plan (connection pool size) —
  this document gives staged *recommendations*, not a guaranteed ceiling.
  Re-validate after any plan change.
