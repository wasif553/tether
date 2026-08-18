# Tether Integrity Evidence Timeline v1

A per-submission, lecturer-only chronological reconstruction of one
student's exam attempt from evidence Tether **already** captures. Not
another cheating detector — **Tether does not determine guilt here.**

There is no cheating score, no AI-generated misconduct conclusion, and no
evidence-completeness percentage anywhere in this feature.

## Purpose

The Timeline answers, for one attempt:

- What happened, and when?
- Which question/activity was occurring?
- What supporting evidence exists?
- What secure-environment state changed?
- Has an event already been reviewed by a lecturer?

It is a **read/aggregation/UI** feature only: no new Prisma model, no
migration, no new telemetry, no new screenshots, no new camera capture,
no video/audio capture, and no change to `apps/lockdown`, the secure-
browser protocol, or the integrity-risk algorithm.

## Where it lives

- A compact **"Integrity evidence timeline"** card on the existing
  individual submission review page
  (`src/app/lecturer/exams/[id]/submissions/[submissionId]/page.tsx`),
  fetched as a secondary, non-blocking load (the established pattern
  already used there for the Controlled AI activity summary and the
  AI-use/session-timing review cards) — a failure here never blocks
  grading.
- A dedicated full page at `/lecturer/submissions/[id]/timeline`
  (`src/app/lecturer/submissions/[id]/timeline/page.tsx`) for the full
  chronological reconstruction, matching the same
  compact-card-then-detail-page pattern already used for Controlled AI
  and the evidence report.

Server logic lives in `src/lib/integrityEvidenceTimeline.ts`
(`buildIntegrityEvidenceTimeline(submissionId, session)`), exposed via
`GET /api/lecturer/submissions/[id]/timeline`.

## Sources merged into one stream

| Source | What it contributes | Ordering timestamp |
|---|---|---|
| `Submission` | Attempt started / content unlocked / submitted (lifecycle bookends) | the field itself (`startedAt`/`activatedAt`/`submittedAt`) |
| `IntegrityEvent` | The primary integrity/evidence backbone — window/focus, copy/paste, camera, screen-share lifecycle, lockdown detections, navigation, timer, network | `createdAt` (server-authoritative) |
| `AnswerActivityEvent` | `QUESTION_OPENED`, `ANSWER_SAVED` only | `serverReceivedAt` |
| `SecureClientEvent` | An explicit allowlist of lecturer-useful secure-environment facts (display detection/restoration, session interruption/recovery, technical failure, lecturer override) | `serverReceivedAt` |
| `AiAssistanceInteraction` | The canonical Controlled AI outcome record | `createdAt` |

`SessionIntegritySignal` and `TimingIntegritySignal` are **deliberately
not merged into the chronological stream** — see "Session/timing
signals" below.

## Zero-schema architecture

Every datum shown by the Timeline already existed in the schema before
this feature — **no migration, no new column, no new table.** This is
purely a read-side aggregation over five existing tables plus the
`Submission` model's own lifecycle timestamps.

## Timestamp trust

`IntegrityEvent.occurredAt` is client-suppliable (an optional ISO string
on the generic client-event ingestion route, with no server-side
plausibility check against `createdAt`). **Ordering never uses it.**
Every row's chronological position is driven by its source's
server-authoritative timestamp (`createdAt` for `IntegrityEvent` and
`AiAssistanceInteraction`, `serverReceivedAt` for `AnswerActivityEvent`
and `SecureClientEvent`, the lifecycle field itself for `Submission`
rows). `occurredAt` is shown only under progressive disclosure, labelled
"Device-reported time", and only when it differs from `createdAt` by at
least 5 seconds.

Two rows sharing the exact same timestamp are ordered deterministically
by a fixed source rank
(`SUBMISSION < INTEGRITY_EVENT < SECURE_CLIENT < ANSWER_ACTIVITY < AI_ASSISTANCE`)
and finally by row id — the same build always produces the same order.

## Deduplication

Three confirmed, deterministic (never fuzzy-timestamp) dedup rules:

1. **Controlled AI.** `aiAssistanceRunner.ts` always creates one of
   `AI_ASSISTANCE_USED` / `AI_ASSISTANCE_REQUEST_BLOCKED` /
   `AI_ASSISTANCE_RESPONSE_REGENERATED` / `AI_ASSISTANCE_REQUEST_FAILED`
   as an `IntegrityEvent` immediately after finalizing the same
   `AiAssistanceInteraction` row. The Timeline suppresses those four
   `IntegrityEvent` types and uses `AiAssistanceInteraction` as the
   canonical row instead. `AI_ASSISTANCE_LIMIT_REACHED` is **not**
   suppressed — it fires only when a prompt is rejected at the
   reservation stage, before any `AiAssistanceInteraction` row is ever
   created (confirmed by reading `recordLimitReached`'s call site), so
   there is nothing to prefer instead.
2. **Native/secure-client incidents.** `SecureClientEvent`'s
   `REMOTE_SESSION_SIGNAL` / `VIRTUAL_MACHINE_SIGNAL` /
   `PROHIBITED_PROCESS_SIGNAL` are excluded from the Timeline's
   secure-client allowlist entirely: when one of these native signals is
   actually observed during an active exam it is promoted to the
   corresponding `IntegrityEvent`
   (`REMOTE_CONTROL_SOFTWARE_DETECTED` / `SCREEN_CAPTURE_SOFTWARE_DETECTED`
   / `DEBUGGING_TOOL_DETECTED` / `PROHIBITED_APPLICATION_DETECTED`),
   which carries a lecturer review state and a safe message — that is
   the canonical row. The allowlist otherwise only includes display and
   session-lifecycle facts that have **no** `IntegrityEvent` equivalent
   at all (`ADDITIONAL_DISPLAY_PRESENT`, `DISPLAY_CONFIGURATION_CHANGED`,
   `DISPLAY_POLICY_RESTORED`, `SECURE_CLIENT_INTERRUPTED`,
   `SECURE_CLIENT_RECOVERED`, `CLIENT_TECHNICAL_FAILURE`,
   `LECTURER_OVERRIDE_GRANTED`).
3. **Question navigation.** A finding made while building this feature:
   both `save-and-navigate/route.ts` and `question-progress/route.ts`
   create an `AnswerActivityEvent(eventType: "QUESTION_NAVIGATED")`
   **only** inside the same `if (eventType)` branch that also creates
   the richer `QUESTION_NAVIGATED_NEXT` / `_PREVIOUS` /
   `QUESTION_BACK_NAVIGATION_BLOCKED` `IntegrityEvent` for the identical
   navigation action — confirmed by reading both call sites, not
   inferred from timestamps. `AnswerActivityEvent`'s `QUESTION_NAVIGATED`
   is therefore excluded from the Timeline's `AnswerActivityEvent`
   allowlist; `IntegrityEvent` is the sole navigation source (this also
   covers the Question Navigator's `QUESTION_NAVIGATED_DIRECT` /
   `QUESTION_DIRECT_NAVIGATION_BLOCKED`, which has no
   `AnswerActivityEvent` counterpart at all).

Evidence assets are never a separate chronological source: an
`IntegrityEvidenceAsset` is attached to its single parent `IntegrityEvent`
row (the two are always 1:1) — never queried independently.

## Controlled AI semantics

Reuses `parseAiAssistancePolicy()`/`isAiAssistanceEnabled()` wherever
Controlled AI's enabled state matters (never `snapshot != null`, and
never the exam's *current* settings — always the frozen per-attempt
snapshot). A `RESERVED` interaction is either genuinely mid-flight
(excluded — not yet a completed fact) or stale, normalized to `FAILED`
using the exact same `isStaleReservation()` rule
`aiAssistanceReview.ts` uses, so the compact Controlled AI summary and
the Timeline never disagree about the same interaction. Every
Controlled-AI-sourced row carries `category: "ALLOWED_RESOURCE"` and
`severity: "INFO"` unconditionally — permitted use, a declined request,
and a failed request are all routine, expected outcomes of an allowed
resource, never a security signal.

## Session/timing review signals

`SessionIntegritySignal.createdAt` and `TimingIntegritySignal.createdAt`
are when the analysis *row* was written — often after, or via a
lecturer-triggered re-run long after, the underlying behaviour actually
occurred — not a validated occurrence time. They are **never** merged
into the chronological stream; the Timeline instead shows an aggregate
"Related review signals" summary (count still `NEEDS_REVIEW`, reusing
the existing review-status field directly).

## Review-state reuse

Read-only. Reuses the existing 5-state vocabulary exactly
(`NEEDS_REVIEW | REVIEWED_NO_CONCERN | REVIEWED_CONCERN_REMAINS |
ESCALATED | RESOLVED`, from `src/lib/integrityReview.ts`) wherever an
`IntegrityEvent` carries one. No new comments/status workflow — reviewing
an event still happens on the existing Integrity Review page.

## Privacy and safe disclosure

- No new capture of any kind — only re-presentation of already-collected
  evidence.
- `technicalDetails` is built from an explicit allowlist of primitive,
  already-safe fields (event code, confidence band, display count,
  response length, AI prompt/policy numbers) — **never raw
  `metadataJson`**, never `storageKey`, never `responseHash`, never the
  Controlled AI student prompt or approved response text, never
  `riskScore`/`cumulativeRiskScore`.
- Evidence is referenced, not duplicated: a Timeline row exposes only
  `{ id, kind, capturedAt }` for its evidence asset; the actual image is
  resolved only when a lecturer clicks through to the existing
  authenticated `GET /api/integrity-evidence/[id]` route — never eagerly
  loaded.
- Camera evidence is always a single low-resolution still frame, never
  video — the Timeline never uses the words "recording" or "video".

## Known v1 limitations

- `QUESTION_OPENED` is defined in the `AnswerActivityEvent` type union
  but no current code path in this repo actually emits it — the Timeline
  includes it structurally for forward compatibility, but it may never
  appear for any real attempt today.
- Session/timing review signals appear only as an aggregate count, not
  as individual chronological rows (see above) — a lecturer who needs
  the individual signal detail still uses the existing session/timing
  review card on the submission page.
- No pagination: v1 loads the entire bounded event set for one
  submission in one response. `IntegrityEvent` volume is naturally
  bounded by 5–60 second per-type debounce windows (realistically tens,
  rarely more than ~100–150 rows per attempt); high-volume raw telemetry
  (25-second heartbeats, page visibility) is excluded by construction,
  not filtered client-side.
