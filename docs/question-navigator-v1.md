# Question Navigator v1

An accessible question navigator grid, visited/answered/flagged state tracking, and a
review-before-submit workflow, layered on top of the existing one-question-at-a-time delivery.
**The navigator never weakens server-side question delivery** — every navigation request is
authorised server-side, exactly like the existing back-navigation enforcement.

## Student question-grid behaviour

Enabled per-exam via `showQuestionNavigator` (default `false` — every existing exam's interface
is unchanged). When enabled, a progress panel appears above the current question showing:

- Answered / unanswered / flagged counts
- A numbered tile grid, one tile per question in this submission's persisted question order
- A legend

## Visual states

| State | Meaning | Style |
| --- | --- | --- |
| `CURRENT` | The question being shown right now | Strong border, ◆ icon, `aria-current="step"` |
| `ANSWERED` | Has a meaningful (non-whitespace-only) saved response | Green, ✓ icon |
| `SKIPPED` | Visited but no meaningful response yet | Amber, … icon |
| `NOT_VISITED` | Never opened | Neutral, no icon |
| Locked (overlay) | Navigation not currently authorised (independent of the four states above) | Muted, 🔒 icon, `disabled` |
| Flagged (overlay) | `flaggedForReview: true` — can coexist with any of the above | 🚩 icon |

Every tile carries an `aria-label` describing its full state in words (never colour alone) — e.g.
"Question 4, visited but unanswered, flagged for review".

## Navigation settings

- `showQuestionNavigator` (default `false`): shows the grid/progress/states.
- `allowQuestionJumping` (default `false`): whether a **grid tile** may be selected directly.
  **Distinct from the existing Next/Previous buttons**, which are entirely unaffected by this
  setting and keep working exactly as before any exam already has them configured — see
  `canNavigateSequential()` vs `canNavigateToQuestion()` in `src/lib/questionNavigator.ts`. A
  direct (grid) request to ANY non-current question — even one position away — requires this to
  be `true`.
- `allowFlagForReview` (default `true`): whether the flag control appears and can be toggled.

## Interaction with back-navigation

A direct (grid) request to an earlier index additionally requires `allowBackNavigation: true`,
exactly the same rule the existing sequential Previous button already follows. A disabled-back-
navigation exam shows earlier tiles as locked (🔒), and a manipulated direct request to an earlier
index is rejected server-side with `403 Back navigation is not allowed for this exam` — the
existing `QUESTION_BACK_NAVIGATION_BLOCKED` sequential-path enforcement is completely unchanged.

## Interaction with one-question delivery

The navigator only ever exposes **numbered metadata** — `questionId, index, number, state,
flaggedForReview, locked, canNavigate` — never question text, options, or correct answers. The
full question content continues to come exclusively from `GET/POST /api/submissions/[id]/question
(-progress)`, unchanged. Selecting a grid tile posts `{ action: "GOTO", targetIndex }` to the
existing `question-progress` route, which re-uses the exact same
`buildOneQuestionPayload()`/`markQuestionVisited()` path as Next/Previous.

When `oneQuestionAtATime` is off, or `showQuestionNavigator` is off, the interface is completely
unchanged from before this feature.

## Question-pool and random-order handling

The navigator's question list is built exclusively from `resolveEffectiveQuestionIds()` — the
same persisted, per-submission selected/ordered question set every other one-question-delivery
route already uses. Unselected pool questions, other pool contents, and the randomisation "seed"
are never touched by this feature — there is no seed to expose (see
`docs/one-question-delivery-v1.md`). Tile numbering follows this submission's stable persisted
order; a refresh never renumbers.

## Flag-for-review behaviour

A student workflow action, not an integrity signal — flagging/unflagging is never logged as an
`IntegrityEvent` and never affects marks. Persisted in `SubmissionQuestionState.flaggedForReview`,
survives refresh and session resume. `PATCH /api/submissions/[id]/question-state/[questionId]`
validates the question belongs to this submission's selected set before accepting any mutation.

## Review-before-submit workflow

Clicking "Submit exam" opens a "Review your exam" panel (only when the navigator is active for
this exam) showing answered/unanswered/flagged counts, with:

- **Return to unanswered questions** — jumps to the first unanswered question the server actually
  authorises right now; if navigation policy prevents reopening any unanswered question, a clear
  message explains why instead of bypassing the policy.
- **Review flagged questions** — same, for flagged questions.
- **Submit exam** — calls the existing, unmodified submit route.
- **Cancel**.

Unanswered questions never block submission (unless a future lecturer setting explicitly requires
it — not implemented in v1); the warning uses neutral wording: "You may submit now, but
unanswered questions may receive no marks."

## Grid layout

The tile group is a **compact, left-aligned wrapping flex layout** (`flex flex-wrap gap-2`), not a
fixed-column grid (`grid-cols-N`). A fixed-column grid stretches tiles into equal-width columns
across the panel's full width regardless of how many questions actually exist — with only 3
questions this produced three widely-spaced, stretched tiles rather than a compact group. Each
tile is a fixed 40×40px (`h-10 w-10 shrink-0`) with an 8px gap (`gap-2`), so tile count never
changes tile size or spacing, and the group never grows wider than its content — e.g. `[1] [2]
[3]` stays compact regardless of the panel's width. Vertical spacing between the heading, counts,
grid, and legend is intentionally tight (`mt-1.5`/`mt-2`) while keeping the legend readable.

## Accessibility

- Every grid tile is a real `<button>` — full keyboard operability, visible focus ring
  (`focus-visible:outline`).
- `aria-current="step"` on the current tile; `aria-label` on every tile describing its full state.
- Locked tiles are `disabled` (announced by screen readers) with a title/label explaining why.
- State is always communicated by icon + text, never colour alone.
- An `aria-live="polite"` region announces successful navigation and flag/unflag actions.

## Privacy/security boundaries

The navigator API (`GET /api/submissions/[id]/question-navigator`) never returns question text,
options, correct answers, answer response text, unselected pool questions, question-pool rules, a
randomisation seed, hidden marking information, or another student's state — see
`src/lib/questionNavigatorRunner.ts` for the exact DTO shape. Every navigation request
(`POST .../question-progress` with `action: "GOTO"`) and every flag mutation
(`PATCH .../question-state/[questionId]`) is authorised server-side against the submission's
actual owner and its persisted selected question set — a client-supplied `questionId` or index is
never trusted directly.

## Legacy-submission behaviour

Existing submissions have zero `SubmissionQuestionState` rows — this is a normal, expected state
(see `docs/question-navigator-migration.sql`), not a data-integrity problem. Answered state is
still derived correctly from `Answer.response`; a legacy submission with saved answers but no
visit rows shows those questions as `ANSWERED`, never `SKIPPED`/`NOT_VISITED`, the first time the
navigator is opened for it. Existing exams default `showQuestionNavigator`/`allowQuestionJumping`
to `false`, so their interface and navigation behaviour are completely unchanged.

## Scope notes (v1)

- The desktop layout is a compact panel above the question (not a fixed/sticky side rail) —
  functionally equivalent progress+grid+legend, simplified for this v1 given the size of the
  existing exam page component.
- Full-paper (non-one-question) mode does not receive a navigator in v1: since every selected
  question is already loaded and rendered at once in that mode, there is no server-authorised
  "current question" concept to navigate — a future iteration could add a scroll-to-question
  affordance without any new authorisation surface.
