# Approved Student Exam + Brainstorm Layout v2

Fixes the real live-page defect the prior (v1) pass's static-mockup
verification missed, and brings the workspace fully into the approved
design: exam title restored, timer made prominent with urgency states,
and Tether Brainstorm's colors shifted from neutral gray to the
approved teal/navy direction.

## The real bug (root cause)

The grid wrapper's actual DOM children, in order, were:
1. `<div aria-live="polite" className="sr-only">` — **always present**,
   never conditional.
2. The question navigator (conditional on `showQuestionNavigatorPanel`).
3. The question column.
4. The Brainstorm sidebar (conditional on `showAiSidebar`).

CSS Grid counts a zero-size `sr-only` element as a real grid item just
the same as a visible one. With it occupying the grid's first cell,
every subsequent item shifted over by one column: the navigator landed
in the question's `minmax(560px,1fr)` column, the question card got
squeezed into Brainstorm's 360px column, and Brainstorm itself — with
only 3 explicit columns defined — wrapped to a new implicit row,
landing back in column 1, directly under the navigator. This is exactly
the reported defect ("Tether Brainstorm is appearing underneath/
alongside the left navigator").

The v1 pass's static HTML mockup never caught this because it was
hand-written from the same *CSS values*, not copied from the real JSX
tree — it never reproduced the sr-only div at all. This pass instead
inspected the real component source directly and confirmed the fix
against the actual compiled Tailwind CSS output (`.next/static/chunks/
*.css`), not a hand-built approximation.

**Fix**: moved the `sr-only` announcement div to be a sibling *before*
the grid wrapper, not its first child. The grid's three direct children
are now exactly the required siblings, in order: question navigator |
question workspace | Brainstorm sidebar. A regression test now asserts
this structurally (`page.test.ts`, "grid direct children are exactly
the 3 approved siblings, in order").

## Grid (unchanged math from v1, verified against compiled CSS)

- Outer workspace: `max-w-[min(1500px,calc(100vw-32px))] mx-auto`.
- `>= 1200px`: `min-[1200px]:grid-cols-[220px_minmax(560px,1fr)_360px]`,
  `gap-5` (20px), `items-start`. Verified present in the compiled CSS
  (`@media (min-width:1200px){...grid-template-columns:220px
  minmax(560px,1fr) 360px}`) — not just in source.
- `900–1199px` (medium, widened from the default 1024px `lg:` to match
  the approved spec's own stated range): `min-[900px]:grid-cols-[220px_minmax(560px,1fr)]`
  — a clean 2-column navigator+question grid; Brainstorm spans the full
  row below via `col-span-full` (confirmed, via compiled-CSS byte
  offset, to be overridden by `min-[1200px]:col-auto` at >=1200px — i.e.
  `col-span-full` never actually applies at desktop width).
- `< 900px`: single-column stack; both navigator and Brainstorm collapse
  to their own toggles.

## Exam title — restored

A prior pass removed the exam-title `<h1>` entirely; that was not the
final requirement. Restored as `text-2xl font-bold text-slate-900`
(24px, within the requested 22–26px range), sharing a row with the
timer (`flex items-center justify-between`), above the integrity strip.
Not placed in the navigator, not repeated inside Brainstorm.

## Timer — prominence and urgency states

New pure module `src/lib/examTimerUrgency.ts`:
- `getTimerUrgency(remainingSeconds)` → `"normal" | "warning" | "high" | "critical"`,
  boundaries inclusive at the more-urgent side (exactly 5:00 → warning,
  exactly 2:00 → high, exactly 1:00 → critical) — matches the approved
  spec's threshold table exactly; 15 tests in `examTimerUrgency.test.ts`
  cover every boundary the spec lists.
- `timerUrgencyClasses(urgency)` — normal: neutral gray; warning: pale
  orange; high: richer orange; critical: pale red, bold digits.
- `timerAccessibleLabel(remainingSeconds, urgency)` — exact "N minutes M
  seconds remaining" when normal, rounded "N minute(s) remaining" for
  the three urgent tiers, matching the approved copy. Exposed via
  `aria-label`/`title` (never `aria-live`), so it's read on demand by
  assistive tech and never re-announced every second as the countdown
  ticks.

The timer itself is now `text-xl` (20px), a padded bordered pill with a
🕒 icon, and derives its urgency purely from the existing
`remainingSecs` value the page already computes — no second countdown
mechanism, no change to submission timing, autosubmit, or exam expiry.

## Tether Brainstorm — teal/navy colors

`src/components/AiBrainstormPanel.tsx` recolored from the prior pass's
neutral gray back to the approved direction: white panel, subtle gray
border, `slate-900` headings, `teal-700` secondary text/labels, a pale
`teal-50` box for the "AI brainstorming is allowed" notice and the
empty state, `teal-700` numbers in the prompts-remaining card, and a
`teal-700` Ask button (was `gray-900`). Starter suggestions now lay out
as a 2-column grid where width allows. Question-scoped history loading,
the request-token race guard, and every other piece of prior AI-panel
logic are unchanged.

## Also in this pass

- `Previous`/`Next`: `justify-between` (Previous pinned left, Next
  pinned right, matching the approved layout); Next is now a filled
  `teal-700` button, visually stronger than Previous's plain outline.
- Question navigator's `CURRENT` tile border: `border-black` →
  `border-slate-900` (navy, matching the approved direction).

## Unchanged (confirmed, not touched this pass)

- Watermark (`ExamWatermark.tsx`) — still 0.06 opacity, same pattern,
  same security semantics; untouched by this pass.
- Question-scoped Brainstorm history (`GET .../ai-assistance`, the
  request-token guard) — untouched.
- Camera preview position (in-flow below Brainstorm when the desktop
  sidebar layout is active; unchanged fixed-corner fallback otherwise)
  — untouched.
- Claude guardrails, prompt limits, authorization, evidence semantics,
  autosave, submission, Secure Browser, camera monitoring/integrity
  detection — untouched.

## Verification method

Per this task's explicit instruction, static-mockup verification alone
was treated as insufficient. This pass instead:
1. Read the real component source directly to find the actual DOM
   structure (this is what surfaced the sr-only bug — a static mockup
   built from CSS values alone could never have revealed it).
2. Ran the real production build and inspected the actual compiled
   Tailwind CSS output for the exact selectors/media queries/cascade
   order this pass depends on (`grid-template-columns`, the
   `col-span-full` vs `min-[1200px]:col-auto` override order) —
   confirming the CSS Tailwind actually generates, not just the class
   name strings in source.
3. Added a structural regression test asserting the grid's direct
   children are the 3 required siblings in order, so this exact class
   of bug can't silently reappear.

Manually inspecting the authenticated student exam-taking route itself
against the deployed Preview still requires real student/exam
credentials on the shared Preview/Production database, which are not
available in this session — see the final report for what was and
wasn't verified this way.
