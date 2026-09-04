# Exam Watermark — Distributed Layout

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

## History

This was originally shipped alongside a Brainstorm hint-quality change
in commit `73c9521` ("Improve Brainstorm hints and watermark layout").
Manual Preview testing found the Brainstorm change regressed live
behavior (responses became repetitive/generic across different student
questions) and it was reverted in a follow-up commit on this same
branch — see that commit's own message and
docs/controlled-ai-brainstorming-assistance-v1.md for the restored
Brainstorm behavior. This watermark layout change was kept; nothing
here was affected by that revert.

## Validation

No schema change. No change to secure-browser/native lockdown behavior.
