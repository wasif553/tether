# Canvas Sandbox Test Guide

This guide walks through registering Safe Exam System (SES) as an LTI 1.3
tool in a Canvas sandbox course and running a full launch → exam → grade
passback cycle. It matches the routes that actually exist in this codebase
today — there is no Moodle/Blackboard support and no deep linking UI yet,
so assignments are linked to exams manually via the **Unmatched Canvas
Launches** inbox (see steps 5–6).

**What counts as successful pilot proof**: a second launch routes
directly to the correct exam (no "not linked yet"), and after grading,
the submission's Canvas passback status reaches **SENT** — visible both
on the grading page's Canvas passback panel and as a real score in
Canvas's Gradebook. A `FAILED` or `SKIPPED` status, or one that never
moves past `NOT_READY`/`PENDING`, means the Canvas validation isn't
complete yet, even if everything else in SES works.

Throughout this guide, `{APP_URL}` means the value of the `APP_URL`
environment variable the app is deployed with (e.g. `https://ses.example.com`,
or `http://localhost:3001` for local dev against a Canvas sandbox that can
reach your machine, e.g. via a tunnel).

## 1. Register SES as a Canvas Developer Key

In your Canvas account (Admin → Developer Keys → `+ Developer Key` →
`+ LTI Key`):

1. Set **Method** to "Manual Entry" or "Paste JSON" if available.
2. **Target Link URI**: `{APP_URL}/api/lti/launch`
3. **OpenID Connect Initiation URL**: `{APP_URL}/api/lti/login`
4. **JWK Method**: "Public JWK URL"
5. **Public JWK URL**: `{APP_URL}/api/lti/jwks`
6. If Canvas offers "Paste JSON" instead of manual fields, fetch
   `{APP_URL}/api/lti/config` and paste the returned JSON directly — it
   already contains the title, description, initiation/target URLs,
   scopes, and public JWK in the shape Canvas expects.

### Required scopes

Make sure these are enabled on the Developer Key:

- `https://purl.imsglobal.org/spec/lti-ags/scope/lineitem`
- `https://purl.imsglobal.org/spec/lti-ags/scope/result.readonly`
- `https://purl.imsglobal.org/spec/lti-ags/scope/score`
- `https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly`

Only `score` is actually used by SES today (for grade passback), but the
others are requested so they're available if needed later.

7. Save the key, then **turn it on** (the key list shows a state toggle —
   it must be "ON" to be installable in a course).
8. Note the **Client ID** shown in the key list — you'll need it.

## 2. Configure SES with this Developer Key

In SES's environment (`.env` or your deployment's secret store), set:

```
LTI_CLIENT_ID=<the Client ID from step 1.8>
LTI_DEPLOYMENT_ID=<filled in after step 4, see below>
LTI_PLATFORM_ISSUER=https://canvas.instructure.com
LTI_PLATFORM_OIDC_AUTH=https://sso.canvaslms.com/api/lti/authorize_redirect
LTI_PLATFORM_JWKS=https://sso.canvaslms.com/api/lti/security/jwks
LTI_TOKEN_ENDPOINT=<your Canvas instance's OAuth2 token endpoint>
LTI_PRIVATE_KEY=<RSA private key PEM, \n-escaped>
LTI_PUBLIC_KEY=<matching RSA public key PEM, \n-escaped>
```

If you're on a self-hosted/Open edX-style Canvas instance, substitute its
actual issuer/OIDC/JWKS/token URLs instead of the canvaslms.com defaults.

Then seed the platform row (creates one `LtiPlatform` record if none
exists yet):

```
npm run seed
```

## 3. Install the tool in a Canvas course

1. Go to the course → Settings → Apps → `+ App`.
2. Configuration Type: "By Client ID".
3. Paste the Client ID from step 1.8, click Submit, then Install.

## 4. Create a Canvas assignment using SES

1. In the course, create a new Assignment.
2. Submission Type: "External Tool".
3. Find/select the SES tool you just installed.
4. Save the assignment.

After saving, Canvas assigns this assignment/placement a
**deployment_id** — you can usually find it by checking the assignment's
External Tool URL parameters, or via Canvas's API
(`GET /api/v1/courses/:course_id/external_tools`). Set `LTI_DEPLOYMENT_ID`
in SES's environment to this value once you have it (it's only used
informationally today — launches aren't rejected based on it — but the
seeded `LtiPlatform.deploymentId` field should still reflect the real
deployment for future use).

## 5. First launch — expect "not linked yet"

Before any exam is linked, **this is expected, not a bug**: launch the
assignment once, as the lecturer/instructor (Canvas's "Student View" also
works, but a real instructor launch is easiest the first time).

You should land on SES's "Exam not linked yet" page. If you're logged in
as a lecturer, that page itself links to **Unmatched Canvas Launches** —
follow it to step 6. This first launch is what actually creates the
`LtiLaunch` row containing the real `resource_link_id`, so you don't need
database access or to read Canvas's UI/API to find it.

## 6. Link the Canvas assignment to an SES exam

1. Log into SES as the lecturer, create (or pick) an exam, add questions,
   and publish it (if you haven't already).
2. Go to **Canvas/LTI → Unmatched Canvas Launches** (or follow the link
   from the not-linked page in step 5).
3. Find the launch from step 5 in the list — it shows the launch time,
   platform, resource link ID, deployment ID, Canvas course/assignment
   ID (if Canvas sent them), and the launching user's role.
4. Pick your exam from the dropdown next to that launch and click
   **Link to exam**.

This creates an `LtiExamLink` for that platform + `resource_link_id`, and
immediately backfills any other unmatched launches that share the same
resource link. SES never auto-links an unknown launch to a random exam —
linking is always an explicit lecturer action.

(You can also create a link directly from the exam detail page's
**Canvas / LTI linking** section if you already know the
`resource_link_id` — the Unmatched Launches inbox is just the easier path
when you don't.)

## 7. Relaunch and confirm routing

1. Launch the same Canvas assignment again (lecturer or student).
2. This second launch should route straight to the linked exam — the
   lecturer lands on the exam detail page; a student lands directly on
   their exam submission, with a `Submission` row created automatically.
3. If you still see "Exam not linked yet", the `resource_link_id` Canvas
   sent on this launch doesn't match what you linked in step 6 — check
   Unmatched Canvas Launches again; a second unmatched entry would
   indicate a mismatch (e.g. a different assignment, or Canvas issuing a
   new resource link after an edit).

## 8. Submit and grade

1. As the test student, answer the questions and submit.
2. MCQ/short-answer auto-grade immediately. Essay questions hold the
   submission as `SUBMITTED` until a lecturer (or the AI draft-marking
   assistant) grades them.
3. As the lecturer, open the exam's submissions list, grade any
   remaining essay answers, and finalize the grade.

## 9. Verify Canvas passback reaches SENT

1. On the submission's grading page, a **Canvas passback** panel shows
   the current status. After finalizing the grade, SES automatically
   attempts a passback in the background.
2. Refresh the page — status should move from `PENDING` to `SENT` (or
   `FAILED` if something's misconfigured — see below).
3. In Canvas's Gradebook for that assignment, the score should appear.
4. If it's stuck at `FAILED`, use the **Retry Canvas passback** button
   after fixing the underlying issue.

## Common failure cases

| Symptom | Likely cause |
|---|---|
| `{"error":"Unknown platform"}` on login | The `iss` Canvas sent doesn't match any seeded `LtiPlatform.issuer`. Re-check `LTI_PLATFORM_ISSUER` and re-run `npm run seed`. |
| `{"error":"Invalid session"}` on launch | The `state` is missing, expired (60s window), or already used. Usually means too much time passed between login and launch, or the launch was retried/refreshed. |
| Stuck on "Exam not linked yet" after linking | The launch that's failing has a *different* `resource_link_id` than the one you linked — check Unmatched Canvas Launches for a second, still-unmatched entry, and link that one too. |
| Nothing shows up in Unmatched Canvas Launches | The launch never reached `/api/lti/launch` at all (check for an earlier `Authentication failed`/`Invalid session` error), or it had no `resource_link_id` in its claims (a non-assignment launch). |
| `{"error":"Authentication failed"}` on launch | JWT signature verification failed — usually a JWKS/key mismatch. Confirm `{APP_URL}/api/lti/jwks` is reachable from Canvas and matches `LTI_PUBLIC_KEY`. |
| Missing AGS scope warning on the pilot readiness page | The Developer Key doesn't have the `score` scope enabled, or the course's deployment hasn't re-synced permissions. Re-check step 1's scopes and reinstall in the course. |
| Canvas token request fails (passback `FAILED`, error mentions the token endpoint) | `LTI_TOKEN_ENDPOINT` is wrong for your Canvas instance, or the Developer Key's scopes don't include `score`. |
| Grade passback `FAILED` after a successful token request | The lineitem URL on the launch is stale, or the assignment's points possible changed after the line item was created in Canvas. Re-launch to refresh the AGS endpoint claim. |
