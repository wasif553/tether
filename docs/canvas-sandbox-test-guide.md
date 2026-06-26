# Canvas Sandbox Test Guide

This guide walks through registering Safe Exam System (SES) as an LTI 1.3
tool in a Canvas sandbox course and running a full launch → exam → grade
passback cycle. It matches the routes that actually exist in this codebase
today — there is no Moodle/Blackboard support and no deep linking UI yet,
so assignments are linked to exams manually (see step 6).

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

## 5. Get the resource_link_id

The easiest way: do one launch first (open the assignment as the
instructor) and check the SES database — the `LtiLaunch` row created by
that launch has a `resourceLinkId` column with the exact value Canvas
sent. (There's no admin UI to read this directly yet; ask whoever has
database access, or temporarily add a `console.log` in
`src/app/api/lti/launch/route.ts` if you don't have DB access.)

## 6. Link the Canvas assignment to an SES exam

1. Log into SES as the lecturer, create (or pick) an exam, add questions,
   and publish it.
2. Open the exam's detail page → **Canvas / LTI linking** section.
3. Fill in:
   - **Canvas platform**: select from the dropdown (populated from
     `GET /api/lecturer/lti-platforms`)
   - **Canvas resource link ID**: the value from step 5
   - **Canvas course ID** / **Canvas assignment ID**: optional, for your
     own reference
   - **Label**: optional, e.g. "Midterm — Section A"
4. Click **Link Canvas resource**.

Until this step is done, any Canvas launch into this assignment will land
on a friendly "Exam not linked yet" page instead of guessing — SES never
auto-links an unknown launch to a random exam.

## 7. Run a student launch test

1. Use Canvas's "Student View" (or a real test-student enrollment) and
   open the assignment.
2. SES should redirect straight to the linked exam's take-exam page and
   create a `Submission` row tied to that Canvas user automatically.
3. If you instead see "Exam not linked yet", double check step 6 — the
   `resourceLinkId` must match exactly.

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
| Stuck on "Exam not linked yet" | No `LtiExamLink` row matches this platform + `resource_link_id`. Re-check step 6, and that you're linking the *resource link ID*, not the assignment ID. |
| `{"error":"Authentication failed"}` on launch | JWT signature verification failed — usually a JWKS/key mismatch. Confirm `{APP_URL}/api/lti/jwks` is reachable from Canvas and matches `LTI_PUBLIC_KEY`. |
| Missing AGS scope warning on the pilot readiness page | The Developer Key doesn't have the `score` scope enabled, or the course's deployment hasn't re-synced permissions. Re-check step 1's scopes and reinstall in the course. |
| Canvas token request fails (passback `FAILED`, error mentions the token endpoint) | `LTI_TOKEN_ENDPOINT` is wrong for your Canvas instance, or the Developer Key's scopes don't include `score`. |
| Grade passback `FAILED` after a successful token request | The lineitem URL on the launch is stale, or the assignment's points possible changed after the line item was created in Canvas. Re-launch to refresh the AGS endpoint claim. |
