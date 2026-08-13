# Tether Secure Browser v1.7.5 — POLICY_NOT_READY Overlay P0

Physical testing of v1.7.4 against the new production deployment
reproduced the exact class of failure v1.7.4 was meant to fix: the
Windows laptop became unusable and required a restart. The visible
overlay this time said **"Preparing your secure exam session"**, not
"Extended display detected" — a different root cause from the same
symptom family.

## Root cause (confirmed from code)

`src/app/student/exams/[id]/page.tsx` (the exam CONTENT page) had a
mount-time effect, inherited from Corrective pass v1.2.1 ("Task C"),
that unconditionally called:

```js
window.sesLockdown?.setSecureClientEnforcementState?.({ active: true, ready: false, requireSingleDisplay: false });
```

the instant the page mounted — regardless of how it was reached. By the
time v1.7.4 exists, a gated attempt reaches this page **only** via a
successful Phase 2 handoff in `tether-launch/page.tsx`, at which point
native lockdown is already `{active: true, ready: true,
requireSingleDisplay: <policy>}` — confirmed ACTIVE moments earlier by
`activateSecureExamLockdown()`. The content page's own mount effect then
**downgraded** that already-correct state back to `ready: false`.

`resolveReadinessGatedDisplayDecision` (`apps/lockdown/src/
displayEnforcementLogic.ts`) treats `active && !ready` as `BLOCKED`,
reason `POLICY_NOT_READY`. `displayEnforcement.ts`'s `evaluateNow()`
then called `showOverlay("POLICY_NOT_READY")` unconditionally for any
`BLOCKED` decision — constructing the same screen-saver-level
(`alwaysOnTop: "screen-saver"`), `closable: false` `BrowserWindow` used
for genuine misconduct, with no Recheck/Exit affordance of any kind.
That overlay only auto-clears once a *later* evaluation resolves back to
`OK` — normally within one network round trip (the page's own
`/secure-client/status` re-fetch), but any hiccup in that fetch, or the
`.catch` branch's own re-assertion of the identical `{active:true,
ready:false}` covering state, could leave it showing far longer, with no
way for the student to tell it would ever clear.

**Confirmed: this diagnosis is correct.** The physical result was not a
reproduction or a determination of the original one-monitor "extended
display" question — it was blocked by this separate, code-confirmed bug
before a clean read of that condition was ever obtained.

## The fix

Three independent layers, so no single mistake can reintroduce this
failure mode:

1. **The blind mount-time cover is removed entirely.** The content page
   no longer calls `setSecureClientEnforcementState` speculatively on
   mount. The fail-open gap Task C originally existed to close (a second
   display connected during window-creation-to-policy-fetch) no longer
   exists for the Phase 1/Phase 2 architecture — native lockdown is
   established *before* this page is ever navigated to.

2. **`POLICY_NOT_READY` can never construct the native overlay, at the
   overlay-eligibility layer itself** (`isOverlayEligibleBlockingReason`
   in `displayEnforcementLogic.ts`, consumed by
   `displayEnforcement.ts`'s `evaluateNow()`). This is defense in depth:
   even if some future change reopens a readiness-gate transition, that
   transition alone can never produce the unrecoverable overlay again.
   The decision is still recorded as `BLOCKED`/`POLICY_NOT_READY` for
   diagnostics — only the *visible* overlay is suppressed for this one
   reason. Every genuine-evidence reason (`ADDITIONAL_ELECTRON_DISPLAY`,
   `WINDOWS_TOPOLOGY_EXTEND`/`_CLONE`, `MULTIPLE_ACTIVE_TARGETS`) and the
   technical-failure reason (`TOPOLOGY_CHECK_UNAVAILABLE`) are
   unaffected — they still show the overlay exactly as before.

3. **A real secure-reactivation mechanism, not a cover flag.** Removing
   the mount-time cover alone would reopen a genuine security hole: once
   a submission is server-`ACTIVE`, `GET /api/submissions/[id]` returns
   full question content unconditionally — the server cannot know
   whether *this* Electron process ever actually established native
   lockdown (a direct load, a page/renderer reload, or a Tether restart
   could all reach this page with native lockdown never established in
   the current process). A new narrow, read-only IPC method,
   `getSecureClientEnforcementState` (`apps/lockdown/src/main.ts` /
   `preload.ts`), lets the content page query the Electron main
   process's own live `{active, ready, requireSingleDisplay}` state —
   the exact same state `displayEnforcement`'s own overlay decision
   reads, never a second, independently-tracked copy, and never a
   client-held boolean trusted as security evidence. See
   `src/lib/secureExamNativeLockdown.ts` for the pure classification:

   | `gated` | bridge available | native state | → |
   |---|---|---|---|
   | false | — | — | `NOT_APPLICABLE` (render normally) |
   | true | true | `{active:true, ready:true}` | `CONFIRMED` (render normally, state preserved) |
   | true | true | anything else | `REACTIVATION_REQUIRED` (content withheld, redirected to `tether-launch`) |
   | true | false | — | `UNSUPPORTED_BUILD` (content withheld, calm "update required" message, no redirect) |

   `REACTIVATION_REQUIRED` routes back through `tether-launch/page.tsx`'s
   own, already-tested Phase 1/Phase 2 machinery (`POST /start` is
   idempotent — resumes the same `IN_PROGRESS` submission;
   `POST /activate` is idempotent — an already-activated submission
   returns `ok` without moving `activatedAt`) rather than inventing a
   second reactivation flow. `UNSUPPORTED_BUILD` deliberately does **not**
   redirect — a build old enough to lack this v1.7.5 query method would
   fail the same check again on return, looping forever.

   A failed/malformed `/secure-client/status` fetch (the effect's
   `.catch` branch) no longer re-asserts any native cover flag either —
   content is withheld via `STATUS_UNAVAILABLE` (a plain in-page message
   with a "Try again" retry), and native state is left untouched.

## What did NOT change

- Genuine active-exam violations (a real second display, a real
  prohibited application, a remote-session violation) remain fully
  strict — `isOverlayEligibleBlockingReason` and the reactivation gate
  both only ever affect the *readiness* path, never during-exam
  enforcement.
- The pre-exam Phase 1 precheck screen (`LockdownApplicationCheck`,
  Recheck + Return to dashboard) is unchanged.
- `main.ts`'s `before-quit`/`window-closed`/`render-process-gone`
  handlers, which unconditionally call `restoreLockdownControls`, are
  unchanged — closing Tether outright is a fundamentally different,
  unavoidable risk category for any locally-installed lockdown client;
  once the whole Electron process exits there is nothing left running to
  be "left active" either way, and the server-side authoritative gate
  (`isSubmissionContentAccessible`), not the native overlay, is what
  protects exam integrity from that point on.

## Physical root-cause status — the original one-monitor question is still open

This P0 fix does **not** claim the original one-monitor "extended
display" finding is diagnosed or solved. That physical run never
produced a clean determination — it was blocked by `POLICY_NOT_READY`
first. A prior code investigation (see the PR #22 physical-remediation
work) found that `windowsDisplayTopology.ts`'s `QueryDisplayConfig`-based
classifier is a pure function of genuine Windows-reported active-path
counts — TeamViewer's own indirect/virtual display driver technology is
a plausible, real explanation for a one-physical-monitor machine
genuinely reporting a second active display path to Windows, but this
remains **unconfirmed** pending a clean physical retest.

The next physical retest of the one-monitor case must capture, at
minimum (no hardware serials/EDID identifiers):

- `enforcementState.active`
- `enforcementState.ready`
- `enforcementState.requireSingleDisplay`
- `electronDisplayCount`
- `windowsTopologyClassification`
- `activeWindowsTargetCount`
- `blockingReason`
- `decision` (`OK`/`BLOCKED`)
- topology error code, if the query itself failed

All already exposed via the diagnostics panel/log (`apps/lockdown/src/
tetherDiagnosticsSnapshot.ts`) — see `docs/tether-preflight-lifecycle-
v1.7.4.md`'s own Audit 3 for the original field-by-field confirmation.

## Versioning

v1.7.4 is treated as a **failed physical candidate** — its installer and
artifact are not modified or overwritten. This fix is v1.7.5. Not
published or promoted until tests pass and a fresh physical run is
explicitly approved.
