# SES Lockdown Browser v1

A native lockdown client for Safe Exam System — a detection-and-logging
desktop app built with Electron, separate from the main Next.js web app.

## What this does in v1

- Loads the SES web app (`https://tether-murex.vercel.app` by default,
  override with `SES_BASE_URL`) in a fullscreen window with a custom
  user agent (`SESLockdown/1.0.0`) so the web app can detect it.
- Watches for OS-level integrity signals: window blur/focus, fullscreen
  exit (re-enters fullscreen after a short delay and shows a
  non-blocking warning), window minimize (auto-restores after 2s),
  multiple displays at launch, and external (non-SES) network requests.
- Logs every signal as evidence — locally queued with `electron-store`,
  then uploaded to `/api/submissions/[submissionId]/integrity-events`
  once a submission ID is known and the app is online.
- Attempts `win.setContentProtection(true)` and reports whether it
  succeeded — this is best-effort and platform-dependent; it does not
  guarantee screenshots or screen recordings are blocked.
- Exposes a minimal `window.sesLockdown` bridge (see Part 4 below) so
  the SES web page can detect the lockdown browser and forward exam
  context.
- Shows a small always-visible status bar and brief auto-dismissing
  warning banners — never blocks exam input.

## What this does NOT do in v1

- Does not hard-block anything. No process killing, no OS-level
  Alt+Tab blocking, no trapping the student in the window — closing the
  app is always allowed.
- Does not cancel network requests — external domains are logged, not
  blocked.
- Does not claim to be cheat-proof, guarantee prevention, provide a
  "full OS lockdown," detect cheating, or block all cheating. It
  records soft-enforcement evidence for lecturer review — humans make
  the final integrity call.
- Does not require Electron for all exams — it's an additional, optional
  client; the existing browser-based Secure Exam Mode keeps working on
  its own.
- Does not ship an installer, code signing, or MDM packaging in this
  pass — see `npm start` below for local/dev use only.

See `docs/lockdown-browser-known-limitations.md` in the main repo for
the full limitations list.

## Running locally

```sh
cd apps/lockdown
npm install
npm run typecheck
npm run build
npm start
```

`npm start` compiles TypeScript to `dist/` and launches Electron against
it. Set `SES_BASE_URL` to point at a different deployment (e.g. a local
`next dev` instance) if needed:

```sh
SES_BASE_URL=http://localhost:3001 npm start
```

## Launching with `ses://`

The app registers itself as the default handler for the `ses://`
protocol. `ses://launch?examId=<id>` is supported as a deep link.

**Adaptation note:** the deployed SES web app keys the student exam page
by *submission* ID (`/student/exams/[submissionId]`), not exam ID — a
student starts an exam via `POST /api/exams/[id]/start`, which returns
the submission. There is no `/student/exams/[examId]` route. So in v1,
any `ses://launch?examId=...` deep link lands the student on the
dashboard (`/student`) rather than directly on the exam page; the
student still clicks "Start exam" there themselves. A future version
could resolve `examId` → submission server-side before navigating.

The full deep link is never logged, even on error — only the parsed
`examId` value is used internally.

## Authentication

The lockdown browser does not invent a new login or token flow. The
student logs into the SES web app inside this window exactly as they
would in a normal browser; the BrowserWindow's own session cookies are
what authorize the queued-event upload requests.

## Architecture

- `src/main.ts` — Electron main process: window management, OS/window
  event detection, network-request logging, the local event queue, and
  upload-on-flush logic.
- `src/preload.ts` — contextBridge-based bridge (`window.sesLockdown`)
  plus the injected status bar/warning-banner DOM overlay.
- `src/shared.ts` — constants and types shared between the two
  processes (version string, deep-link protocol name, allowed event
  types).

No separate renderer/React bundle in v1 — the SES web app itself is
loaded directly into the window; the overlay is injected via preload.
