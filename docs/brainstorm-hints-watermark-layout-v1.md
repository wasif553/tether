# Brainstorm Hint Quality + Watermark Layout Refinement

Two independent UX refinements on top of existing features — no exam-
integrity control is weakened by either.

## Part A — Brainstorm hint quality

See docs/controlled-ai-brainstorming-assistance-v1.md for the base
feature (generator/verifier/runner architecture, hint ladder, attempt
accounting) — unchanged here.

**Problem**: a normal (safety-approved) Brainstorm response could still
be a bare Socratic question ("What do you think?") with no actual hint,
wasting one of the student's limited interactions.

**Fix**:
- `src/lib/aiAssistanceGenerator.ts`'s system prompt now explicitly
  requires every normal response to contain BOTH a substantive hint/clue
  AND a focused follow-up question (never just the question), with the
  exact BAD/GOOD examples from the product spec, a 2-5 sentence length
  guideline, and progressive hint-ladder stage descriptions (broad cue →
  focused distinction → procedural hint → missing step) plus an explicit
  "do not repeat essentially the same hint" instruction against the
  question's own prior-approved history.
- A new deterministic guard, `isWeakSocraticOnlyResponse()` in
  `src/lib/aiAssistancePolicy.ts`, catches the unambiguous case
  (a short, bare generic question/imperative, or several strung
  together with nothing else) AFTER a candidate has already passed the
  independent safety verifier — a distinct QUALITY check, separate from
  the verifier's RISK check. Deliberately narrow: a genuine (even if
  terse) single-sentence hint like "Consider what happens to prices when
  money supply grows faster than output." is never flagged.
- `src/lib/aiAssistanceRunner.ts`'s existing single-regeneration-attempt
  mechanism (previously always "be more conservative") now branches:
  a weak rejection asks the model to add substance (temperature raised
  for variety); a safety rejection still asks for more conservatism
  (temperature 0, unchanged). If the regenerated candidate still fails
  either check, the existing deterministic FALLBACK response is shown —
  never a second live regeneration.
- `BrainstormGeneratorInput.stricter: boolean` was replaced with
  `regenerationReason?: "TOO_RISKY" | "TOO_WEAK"` — a clearer, mutually-
  exclusive signal for the two opposite regeneration instructions. No
  other caller/test referenced the old field name (checked before
  renaming).

**Clarification-only attempts (Part 5) — deliberately NOT implemented.**
Investigated: the atomic prompt-slot reservation
(`reserveInteractionSlot` in aiAssistanceRunner.ts) happens BEFORE any
generation, by design, to close a count-check-then-insert race under
concurrent requests. Whether a response ends up "clarification-only"
can only be known AFTER generation completes — by which point the slot
is already reserved and its `promptNumberForQuestion`/
`promptNumberForAttempt` already assigned from a live COUNT query.
Retroactively excluding that row from future counts would make those
stored prompt-number fields non-sequential/non-unique per question,
which the lecturer review UI and history views rely on. This is exactly
the "risky attempt-accounting redesign" the task instructed to stop and
report on rather than force — implementing it safely would need
reworking the reserve-before-generate sequence itself. Every BLOCKED
request already consumes a slot today (declining a direct-answer
request is not free either), so this would also be the first outcome-
dependent exception to that existing, intentional anti-abuse design.

## Part B — Watermark distributed layout

See docs/exam-watermark-v1.md for the base feature (text content,
opacity, deterrent framing) — unchanged here.

**Problem**: `ExamWatermark.tsx` rendered tiles in a plain CSS grid
(`grid-cols-2`/`grid-cols-3`, uniform gap) — every tile centered in a
perfectly aligned cell, which reads as obvious repeating vertical
columns in a screenshot even though each tile's own text was rotated.

**Fix**: `buildWatermarkTilePositions()` (new, pure, in
`src/lib/examWatermark.ts`) computes a staggered ("brick") layout
instead — alternate rows offset by half a column width, -30deg rotation
(within the requested -25 to -35deg range), substantial even spacing.
`ExamWatermark.tsx` renders two independent, responsive tile sets via
Tailwind `sm:` classes (3x6 desktop, 2x4 mobile/tablet — fewer, larger
tiles on a small screen, never the same grid shrunk into noise), each
tile absolutely positioned via `left`/`top` percentages plus
`translate(-50%, -50%) rotate(...)`. Opacity stays 0.10; the overlay
stays `pointer-events: none`, `aria-hidden`, and sized via `inset-0` to
its parent (unchanged — the parent has no fixed height, so it grows to
the full scrollable question content, covering it, not just the
viewport).

## Validation

No schema change. No change to secure-browser/native lockdown behavior,
attempt-accounting rejections, or the independent safety verifier.
