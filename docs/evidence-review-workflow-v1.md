# Evidence Review Workflow v1

A proper 5-state review workflow for `IntegrityEvent`/evidence-frame review, replacing the
previous single resolved/unresolved boolean. Reviewer comments, decision dates, immutable status
history, and policy-aware interpretation of each signal. **This is a review and governance
feature — it never determines misconduct, never terminates an attempt, never alters a grade,
never blocks marks release, and never automatically escalates a student or requires oral
verification.**

See also [`docs/exam-design-policy-v1.md`](exam-design-policy-v1.md) for the policy layer this
workflow interprets signals against.

## Statuses

| Status | Label shown to lecturer |
| --- | --- |
| `NEEDS_REVIEW` | Needs review |
| `REVIEWED_NO_CONCERN` | Reviewed — no concern |
| `REVIEWED_CONCERN_REMAINS` | Reviewed — concern remains |
| `ESCALATED` | Escalated |
| `RESOLVED` | Resolved |

Never "Cheating detected" / "Proof of misconduct" / "Guilty" / "AI use confirmed" / "Plagiarism
confirmed" / "Device fraud confirmed" — see `src/lib/integrityReview.ts` for the single source of
truth for these labels.

Every `IntegrityEvent` defaults to `NEEDS_REVIEW`. The pre-existing `resolvedAt`/`resolvedById`/
`resolutionNote` fields (from before this feature) are untouched and still populated by the
legacy resolve route — see "Backward compatibility" below.

## Reviewer comments

`IntegrityReviewComment` — one row per freeform comment, immutable in practice (no edit/delete
route). `commentType` is one of `REVIEWER_COMMENT | LECTURER_COMMENT | MARKER_COMMENT |
DECISION_NOTE`. This repo has no separate marker role or marker-assignment concept (`Role` is
`LECTURER | STUDENT | PLATFORM_ADMIN` only) — so a comment from an actual `LECTURER` becomes
`LECTURER_COMMENT`, and a `PLATFORM_ADMIN` comment becomes the generic `REVIEWER_COMMENT` rather
than inventing a `MARKER` identity. `MARKER_COMMENT` is defined for forward compatibility only
and is never produced by any route today.

## Reviewer identity

`authorId`/`authorRole` (comments) and `reviewedById`/`changedByRole` (decisions/history) are
**always derived server-side** from the authenticated session — never accepted from the request
body. A client attempting to pass `authorRole`/`commentType`/`changedByRole` in the request is
silently ignored; the server-derived value always wins (see
`src/lib/integrityReview.ts:deriveCommentAuthorRoleAndType()`).

## Decision dates

`IntegrityEvent.reviewedAt`/`reviewedById`/`reviewNote` record the most recent decision. Every
transition (including the very first one out of `NEEDS_REVIEW`) also creates an immutable
`IntegrityReviewStatusHistory` row with `fromStatus`/`toStatus`/`changedById`/`changedByRole`/
`reason`/`createdAt` — this is the audit-grade history shown in the lecturer UI, distinct from
`PlatformAuditLog` (the platform-wide operational audit trail).

## Status history

Never updated or deleted — one row is created for every transition, by every write path (the new
PATCH review route, the new bulk-no-concern route, and the legacy resolve route).

## Policy interpretation

Each event's `policyInterpretation` (from `classifyIntegritySignalForPolicy()`) is computed fresh
on every read against the submission's immutable policy snapshot — never stored, never cached,
never allowed to drift from the current snapshot. Full rule table:

| Event category | Policy condition | `policyAlignment` | Wording |
| --- | --- | --- | --- |
| Focus/tab (`FULLSCREEN_EXIT`, `WINDOW_BLUR`, `WINDOW_FOCUS_RETURN`) | `internetAllowed: true` | `PERMITTED` | "Activity was permitted under this exam policy." |
| Focus/tab, single occurrence | `internetAllowed: false` | `NOT_APPLICABLE` | Not treated as a breach on its own. |
| Focus/tab, ≥3 occurrences (`REPEATED_FOCUS_LOSS_THRESHOLD`) | `internetAllowed: false` | `NOT_PERMITTED` | "Activity was inconsistent with this exam policy." |
| Clipboard (`COPY_ATTEMPT`/`PASTE_ATTEMPT`/`RIGHT_CLICK_ATTEMPT`) | any | `NOT_APPLICABLE` | Reviewed the same regardless of policy — clipboard is a secure-control matter, not a permitted-resource matter. |
| `POSSIBLE_PHONE_VISIBLE` | `calculatorAllowed: true` | `UNKNOWN` | "Review recommended. Calculators were allowed, so the object may have been a permitted calculator." |
| `NO_PERSON_VISIBLE`/`CAMERA_VIEW_BLOCKED`/`CAMERA_TOO_DARK` | `notesAllowed: true` | `UNKNOWN` | "The student was permitted to consult notes." |
| Session/device, timing, answer-similarity, AI-use, anything else | any | `NOT_APPLICABLE` | Reviewed independently of the exam policy — these remain relevant under every policy. |
| No policy snapshot (legacy attempt) | — | `UNKNOWN` | Never retrospectively classified as a breach; original severity preserved. |

## Evidence signals are not proof

Every card, list item, and summary in the lecturer UI carries an explicit `limitation` string
alongside its `explanation` — e.g. "This may result from browser recovery, delayed autosave...",
"A permitted calculator may appear visually similar to another handheld device...". No screen
ever displays a "cheating probability" or a hidden numeric score.

## Lecturer/institution final decision

The recommendation function (`calculateCombinedReviewRecommendation()` in
`src/lib/combinedReviewRecommendation.ts`, extended for this feature with an `"EVIDENCE"` signal
category) only ever outputs `NO_IMMEDIATE_ACTION | LECTURER_REVIEW_RECOMMENDED |
ORAL_VERIFICATION_RECOMMENDED | ESCALATION_RECOMMENDED` — never an automatic misconduct
determination, and every `EVIDENCE`-category signal is always treated as "limited alone" (Part
10: "one policy inconsistency should normally recommend lecturer review at most"), regardless of
its specific type.

## Student visibility restrictions

Students receive 401 on every route in this workflow — `GET .../integrity-review`, `PATCH
.../review`, `POST .../comments`, `POST .../bulk-no-concern`. No response from any of these
routes exposes evidence storage keys, raw Supabase URLs, correct answers, raw IP addresses,
device/session hashes, or reviewer comments through a student-facing path (there is none).

## Oral-verification integration

"Require oral verification" always links to the existing, unmodified
`POST /api/lecturer/submissions/[id]/oral-verification` workflow
([`docs/oral-verification-workflow-v1.md`](oral-verification-workflow-v1.md)) — this feature never
creates an `OralVerification` record itself.

## Audit history

Every write in this workflow creates a `PlatformAuditLog` entry: `EVIDENCE_REVIEW_STATUS_CHANGED`
/ `INTEGRITY_EVENT_ESCALATED` / `INTEGRITY_EVENT_RESOLVED` (PATCH review), `EVIDENCE_REVIEW_COMMENT_ADDED`
(POST comments), `EVIDENCE_REVIEW_BULK_NO_CONCERN` (bulk route, one entry per event), plus
`EXAM_POLICY_ACKNOWLEDGED` / `EXAM_POLICY_SNAPSHOT_CREATED` (attempt start). Never stores full
answer text, camera image contents, raw IP, session/device hashes, secrets, or external-provider
credentials — only actor, actor role, institution, exam, submission, event, old/new status, and
timestamp.

## Legacy evidence handling

- Existing `IntegrityEvent` rows: `reviewStatus` defaults to `NEEDS_REVIEW` for every row,
  **including** rows that already have `resolvedAt` set from the old resolve route — this
  migration performs no backfill and never fabricates a reviewer decision that was never actually
  made under the new 5-state model.
- The legacy `POST /api/lecturer/integrity-events/[eventId]/resolve` route is preserved exactly
  (same request/response shape, same authorization check) and now additionally sets
  `reviewStatus: "RESOLVED"` plus a status-history row, so new resolutions made through the legacy
  route participate consistently in the new workflow. Historical `resolvedAt`/`resolvedById`/
  `resolutionNote` values are never altered or removed.
- Reviewer identity, comments, and decision dates are never fabricated for legacy events — a
  legacy event with no comments simply shows an empty comment list, not a synthesized one.

## Bulk review

Only one bulk action exists: **"Mark selected as Reviewed — no concern"**
(`POST /api/lecturer/submissions/[id]/integrity-review/bulk-no-concern`). Requires explicit
client-side selection and a confirmation dialog; creates one `IntegrityReviewStatusHistory` row
and one audit-log entry per event. Bulk escalation, concern-remains, resolution-with-concern,
oral verification, and any misconduct referral are all deliberately unsupported — those always
require a per-event decision through `PATCH .../review`.
