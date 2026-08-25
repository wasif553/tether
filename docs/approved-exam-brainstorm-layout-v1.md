# Approved Student Exam + Brainstorm Layout v1

Implements the approved, final desktop workspace design for the student
exam page — one-question-at-a-time delivery only, where a single
"current question" exists for a right sidebar to be about. Layout/
presentation only; no change to Claude guardrails, prompt limits,
authorization, evidence semantics, autosave, submission, timing, Secure
Browser, camera monitoring, or watermark security behaviour.

## Grid

Outer workspace (`src/app/student/exams/[id]/page.tsx`'s live-workspace
wrapper): `max-w-[min(1500px,calc(100vw-32px))] mx-auto` — replaces the
previous `max-w-2xl` (672px), which was already too narrow for the
2-column navigator+question grid, let alone a 3rd column.

Three responsive tiers, via `oneQuestionGridColsClass`/
`oneQuestionGridWrapperClass`/`aiSidebarCellSpanClass`:

- **< 1024px (small)**: single column stack. Navigator collapses to its
  own toggle; Brainstorm collapses to its own toggle (`AiBrainstormPanel`'s
  `sidebar` prop, `expanded` state) — an expandable drawer below the
  question, per spec.
- **1024–1199px (medium)**: `lg:grid-cols-[220px_minmax(560px,1fr)]` —
  a clean 2-column navigator+question grid, never a 3-column squeeze.
  When AI is also enabled, the Brainstorm cell spans the full row below
  via `col-span-full` (only when a navigator is present — the AI-only,
  no-navigator case is already an uncrowded 2-column grid at this same
  tier and doesn't need it) rather than being crushed into the 220px
  navigator column.
- **>= 1200px (large, "approved" desktop)**: `min-[1200px]:grid-cols-[220px_minmax(560px,1fr)_360px]`,
  `min-[1200px]:col-auto` on the Brainstorm cell — the full 3-column
  structure (question navigator | question | Tether Brainstorm). Gap:
  `gap-5` (20px). This is a `min-[1200px]:` arbitrary Tailwind variant,
  not the default 1024px `lg:` breakpoint, since 220+360+gaps leaves too
  little room for the question column below ~1200px.

`AiBrainstormPanel`'s own `sidebar`-prop treatment (sticky, always
expanded, no mobile toggle) mirrors the same `min-[1200px]:` threshold,
so it only becomes "a dedicated right-side assistant panel" exactly
when the grid actually gives it a real column.

## Central exam-title heading removed

The large `<h1>{data.exam.title}</h1>` above the live assessment
workspace is gone — the exam's identity is already established by the
surrounding page/nav context. The timer (previously a sibling `<span>`
in the same `flex justify-between` row) is unaffected: the row is now
`flex justify-end` so the timer alone still sits at the workspace's
upper-right. Unrelated: the exam-title headings on the separate
post-submission and pre-exam-gate screens (different early-return
branches, different narrower wrappers) are untouched.

## Watermark

`src/components/ExamWatermark.tsx` — opacity lightened from `0.1` to
`0.06` (within the requested 0.05–0.08 range, toward its lighter end).
Purely a CSS visual property; nothing in the codebase reads this value
as a signal or condition (see the component's own doc comment). Text
content, the repeated-tile pattern, positioning (`absolute inset-0`
inside the same `position: relative` wrapper), `pointer-events: none`,
and `aria-hidden="true"` are all unchanged.

## Camera preview

Previously always a `position: fixed` bottom-right corner overlay,
regardless of delivery mode or AI settings. Now: exactly one render
location per state (never two — see below), computed once as
`cameraPreviewInner`:

- **`showDesktopAiSidebarLayout` true** (one-question-at-a-time AND AI
  enabled): renders in-flow inside the right sidebar cell, below
  `<AiBrainstormPanel>` — at every viewport width for that state,
  including narrow ones (the sidebar cell itself is already in the DOM
  whenever AI is enabled; only its CSS presentation collapses at
  narrower widths). This structurally guarantees it can never overlap
  Brainstorm content, unlike a floating corner bubble.
- **Every other case** (AI disabled, or full-paper mode): unchanged
  `fixed bottom-4 right-4 z-50` corner overlay, exactly as before.

Both locations share the same `<video ref={examVideoRef}>` JSX
(`cameraPreviewInner`), never rendered twice simultaneously — a React
ref can only ever point at the most recently mounted element, so
rendering it in two places at once would mean only one ever actually
receives the live stream. Camera monitoring, integrity checking,
evidence capture, and "Your camera — only you can see this" are all
unchanged; only its on-screen position moved.

## Left navigator

Already matched the approved design (compact numbered tile grid,
current/answered/flagged/not-visited/locked legend, sticky at `lg:`).
Added only the small "QUESTIONS" eyebrow label above the existing
"Question N of M" line — everything else in `QuestionNavigatorPanel`
is unchanged.

## Centre question card

Already matched closely (`Question N of M · N pt(s)` header with
`Flag for review` opposite, question text, answer input, Previous/Next
below, Submit exam separate). Changes: explicit `bg-white` (clean white
card, was previously bare/transparent over the page background), `pts`
wording (was `pt(s)`), and `← Previous` / `Next →` arrow glyphs.

## Tether Brainstorm sidebar

`src/components/AiBrainstormPanel.tsx` — recolored from an indigo-heavy
palette to neutral white surfaces and gray borders/text throughout (a
single dark `bg-gray-900` button remains the one prominent action, the
Ask button), per "avoid excessive purple/blue decoration." Copy changes:
the AI notice is now two lines ("AI brainstorming is allowed" /
"Guidance only · Interactions are recorded"), the empty state gained a
second line ("Try one of the suggestions below or ask your own."), and
"About AI assistance" is now styled as an underlined link-like
`<summary>` rather than plain text. Question-scoped history loading
(GET on mount/question-change, request-token race guard), the
"This question X / Y" / "This exam X / Y" counters, guardrail responses
shown as "Guidance only" rather than error styling, and every other
piece of prior work in this area are unchanged.

## Verification method

This repo has no component-render test tooling (no
`@testing-library/react`, no jsdom/happy-dom Vitest environment) and no
available student/exam login credentials for the live, authenticated
exam-taking page against the shared Preview/Production database. Visual
verification was done with a static HTML mockup reproducing the exact
same CSS values written into `page.tsx`/`AiBrainstormPanel.tsx` (grid
template columns, breakpoints, gap, max-width, colors, copy) — served
as a plain static file under `public/` (removed after verification) via
the local dev server, so no database or authenticated route was
touched. Screenshotted at 1920×1080, 1536×864, 1366×768 (the 3 required
viewports), plus 1100×800 (medium tier) and 375×812 (mobile), confirming
the grid proportions, column spanning, and absence of overlap this doc
describes above. This confirms the CSS is correct; it does not exercise
the real page's live data, watermark rendering, or camera stream —
those still warrant a manual pass against the actual deployed Preview
with real credentials.
