# Answer-Development Provenance v1

## Purpose

An opt-in, default-OFF exam feature that preserves readable checkpoints of
how a student's answer developed over the course of an attempt — meaningful
text arriving, substantial edits, large pastes, and (in DETAILED mode)
optional outline/calculation/code workspaces and source declarations —
for lecturer review.

**This is process evidence, not a misconduct detector.** Every
checkpoint, event, and derived observation is a descriptive fact about
how the response was produced, never a claim about who or what produced
it. Product language throughout this feature (and this document) uses
"answer development", "process evidence", "development checkpoint",
"substantial edit", "paste event", "rewriting pattern", "needs lecturer
review", "possible concern", "human decision", "alternative explanation"
— never "proof of cheating", "detected cheating", "AI-generated answer
confirmed", "automatic misconduct", "keystroke surveillance", or "student
is guilty". Lecturer judgement remains final; **no observation here ever
automatically alters a grade, flags misconduct, requires oral
verification, or changes a submission's status.**

## Threat model

This feature is explicitly NOT:

- A keylogger. Individual key values, scan codes, and typing content
  outside authorised answer/workspace fields are never captured.
- Live proctoring. Nothing here streams, records, or infers video/audio.
- A clipboard monitor. Clipboard contents are never stored separately
  from what the student actually inserted into an authorised field, and
  never captured at all when a paste is blocked.
- An AI detector. No signal here claims a response was AI-generated,
  copied, or otherwise produced by any particular means.

It IS a bounded, server-validated, rate-limited, institution-scoped
capture of the student's own already-authorised answer text at
meaningful checkpoints, plus coarse structured metadata about paste/edit
size and optional self-authored working artifacts.

## What is captured

- Readable answer-version checkpoints (`AnswerDevelopmentVersion`) — the
  literal answer text as it existed at a meaningful moment (first
  meaningful text, a substantial edit, a large paste, navigating away
  with unsaved meaningful changes, an explicit student checkpoint, the
  final submission). Never more than `answerVersionMaximumPerQuestion` per
  question for routine periodic checkpoints (always-preserved types are
  exempt — see "Version-capture rules" below).
- Structured process events (`AnswerDevelopmentEvent`) — paste-blocked
  notices, workspace created/updated markers, code-run requests (never
  actual execution), source-declaration markers. Never itself labelled
  misconduct — `eventLevel` is `INFORMATIONAL`/`CONTEXT`/`REVIEW_CONTEXT`.
- Optional structured working (`AnswerDevelopmentArtifact` +
  `AnswerDevelopmentArtifactVersion`) — outline, calculation working, code
  working, source/AI-use declarations, in DETAILED mode only, per
  lecturer-enabled workspace.
- Code-execution REQUEST metadata only (`CodeExecutionEvent`) — never
  actual execution results (see "Code-run limitation" below).
- Paste metadata: timestamp, inserted character count, resulting answer
  length, whether blocked or inserted, and (derived later, from already-
  stored checkpoint text, never a separate field) whether most of the
  paste was later replaced.
- Deletion/rewrite metadata: characters removed/added, percentage of
  prior text replaced, time between versions.

## What is NOT captured

- Individual keystrokes or key/scan codes.
- Typing content outside an authorised answer or workspace field.
- Clipboard contents when a paste is blocked.
- Text copied from outside the answer editor.
- System-wide activity or mouse-movement streams.
- A separate raw clipboard-text field of any kind — the answer checkpoint
  naturally includes inserted text because it is now part of the
  student's own submitted answer; nothing is captured "on the side."

## No-keystroke-logging guarantee

`src/hooks/useAnswerDevelopmentCapture.ts` never installs a `keydown`/
`keyup`/`keypress` listener anywhere, never reads `document.execCommand`
history, and never uses the Clipboard API. The ONLY signal it derives
client-side is the length delta between successive `onChange` values
already flowing through the page's existing autosave path — a real paste
arrives as one large single-step `onChange` (the whole block appears at
once); ordinary typing arrives as many single-character events. This
distinguishes "paste-like" from "typed" without ever reading clipboard
contents directly.

## Version rules

See `src/lib/answerDevelopment.ts` (`decideCheckpoint`) for the full,
tested decision function. A checkpoint is created when at least one of:

1. First meaningful text appears (≥10 non-whitespace characters).
2. The configured interval has elapsed AND the minimum character change
   is reached.
3. A substantial edit occurred (≥120 characters changed, or ≥25% of the
   prior response).
4. A large paste was inserted (≥100 characters).
5. Most recently pasted material was substantially replaced (≥60% of the
   pasted segment no longer present in a later checkpoint) — detected
   from the ALREADY-STORED paste checkpoint's own diff against its prior
   version, never a separate clipboard record.
6. The student navigates away after meaningful changes.
7. The student creates a manual checkpoint.
8. The final answer is submitted — always creates a `FINAL_SUBMISSION`
   checkpoint, even if unchanged since the last one.

Every threshold is centralised and versioned in
`src/lib/answerDevelopmentThresholds.ts`
(`ANSWER_DEVELOPMENT_THRESHOLDS_VERSION`). Diffing
(`src/lib/answerDevelopmentDiff.ts`) runs only at these checkpoint
boundaries — never per keystroke — using a prefix/suffix-trimmed
word-token LCS diff, cheap even for a long answer with one small edit.

## Paste metadata

Recorded per paste-triggering checkpoint: server timestamp, inserted
character count, resulting answer length, and (via the retained
checkpoint text itself) a hash for change detection. Whether a paste was
blocked vs inserted is recorded as a `PASTE_ATTEMPT_BLOCKED` /
`PASTE_INSERTED` event. There is no separate raw clipboard-text field
anywhere in the schema.

## Deletion and rewrite patterns

`classifyChange()` in `src/lib/answerDevelopment.ts` classifies a diff as
a substantial edit, large deletion (≥100 characters or ≥30% removed), or
major rewrite (≥50% of prior text replaced) — descriptive categories
only, never risk scores, never used to imply anything about intent.

## Outline and working areas

Available only in DETAILED mode, only when the specific workspace is
lecturer-enabled (`enableOutlineWorkspace` / `enableCalculationWorkspace`
/ `enableCodeWorkspace`). Plain text/structured text only — no HTML
rendering of student content anywhere. An outline never needs to match
the final answer; these are student-authored assessment artifacts, not a
request for private internal reasoning, and are never treated as hidden
chain-of-thought.

## Source declarations

When `requireAiSourceDeclaration` is enabled, the student is asked:
whether an AI tool was used, the tool/service name, how it was used,
which parts of the response it influenced, what was verified/changed,
and other sources consulted — or simply "No AI tool used." A declaration
is never itself treated as an admission of misconduct. Submission is
blocked (`SOURCE_DECLARATION_REQUIRED`, HTTP 400) only when the immutable
policy snapshot says a declaration is required and none exists yet — see
`isSourceDeclarationSatisfied()` in `src/lib/answerDevelopmentRunner.ts`.

## Controlled AI integration

Controlled Tether AI brainstorming interactions
(`AiAssistanceInteraction`) are an already-authorised, separately-tracked
assistance channel. This feature does not require students to
re-declare interactions Tether itself already recorded — the lecturer
timeline is expected to show both the provenance checkpoints and the
existing AI-assistance record side by side (via the existing
`/lecturer/submissions/[id]/ai-assistance` page), never merged into one
hidden score.

## Code-run limitation

**No secure isolated code runner exists in this repository or
environment.** The code-working editor, its version history
(`AnswerDevelopmentArtifact`/`AnswerDevelopmentArtifactVersion` with
`artifactType: "CODE_WORKING"`), and the execution-event contract
(`CodeExecutionEvent`, `POST /api/submissions/[id]/answer-development/code-run`)
are all implemented — but every "Run code" request in v1 is answered
truthfully as unavailable (`exitStatus: "NOT_CONFIGURED"`), never a
fabricated pass/fail result. No student code is ever executed inside the
Next.js/Vercel application process. A future isolated runner can be wired
into the same contract without a schema change.

## Lecturer timeline

`/lecturer/submissions/[id]/answer-development` (see
`src/app/api/lecturer/submissions/[id]/answer-development/route.ts` for
the backing API) shows, per question, a chronological merge of
checkpoints and events, a version-comparison tool (readable highlighted
diff, characters added/removed, percentage changed), and filters (all /
checkpoints / paste events / substantial edits / working areas / code
activity / source declarations). No raw IP/device values, no "guilty"
colour treatment, no automatic misconduct badge — every status is a calm,
neutral label ("Needs lecturer review", "No immediate action").

## Process observations

`computeProcessObservations()` in `src/lib/answerDevelopment.ts` produces
deterministic, contextual descriptions — `LARGE_PASTE_THEN_REWRITE`,
`LARGE_PASTE_RETAINED`, `MAJOR_LATE_REWRITE`, `MINIMAL_DEVELOPMENT_DATA`,
`GRADUAL_DEVELOPMENT`, `OUTLINE_PRECEDED_FINAL_RESPONSE`,
`WORKING_PRECEDED_FINAL_RESPONSE`, `MULTIPLE_SUBSTANTIAL_REVISIONS`,
`SOURCE_DECLARATION_PRESENT`, `SOURCE_DECLARATION_MISSING`,
`CODE_TEST_ITERATION_PRESENT` — each with a recommendation of
`NO_IMMEDIATE_ACTION`, `LECTURER_REVIEW`, `COMPARE_WITH_SIMILARITY_EVIDENCE`,
or `ORAL_VERIFICATION_MAY_ASSIST`. None of these ever alter a grade, flag
misconduct, require oral verification, or change submission status —
those remain exclusively human decisions.

## Integration with similarity, collusion, timing, and oral verification

- Provenance data is displayed ALONGSIDE existing evidence, never merged
  into a hidden combined score.
- Cohort collusion's `TIMING_SYNCHRONISATION` family MAY use synchronised
  substantial-edit timestamps as one input, but multiple provenance
  events from one question still count as ONE timing-family source (per
  cohort-collusion's independent-family rule), a paste event or a large
  rewrite alone can never create a collusion edge, and shared-edit timing
  requires repetition across multiple questions/events — exactly the same
  safeguards already documented in docs/cohort-collusion-graph-v1.md.
- Oral-verification question generation MAY reference major answer
  changes, outline-to-final differences, or code evolution for the
  SUBMISSION BEING REVIEWED ONLY — never another student's data.
- Controlled AI interactions are always shown as permitted assistance
  when allowed, never as a violation.
- The SAME checkpoint/event is never double-counted as both a timing-
  analysis input and a collusion-analysis input independently — any
  future integration must read from this feature's stored rows once and
  reuse the result, not recompute separately in each analysis.

## Institution isolation

Every student route verifies submission ownership (`studentId` match) and
liveness (`IN_PROGRESS`) before anything else. Every lecturer route
reuses the exact `assertSameInstitution`/`isPlatformAdmin` pattern shared
by every other lecturer route in this repo (exam-owner OR platform admin,
same institution, 404 rather than 403 on a cross-institution probe).

## Storage limits

| Content | Limit |
|---|---|
| Checkpoint response text | 50,000 characters |
| Outline | 20,000 characters |
| Calculation working | 30,000 characters |
| Code working | 100,000 characters |
| Source declaration | 10,000 characters |
| Event metadata | 2,000 characters (truncated defensively, never rejected) |
| Checkpoints per question (routine/periodic) | 5–100 (lecturer-configured), always below the hard ceiling |

No destructive retention deletion is implemented in v1 (per explicit
instruction) — the per-question cap suppresses further ROUTINE periodic
checkpoints once reached, while INITIAL_TEXT, SUBSTANTIAL_EDIT,
POST_PASTE_CHECKPOINT, PRE_SUBMISSION_CHECKPOINT, FINAL_SUBMISSION, and
MANUAL_STUDENT_CHECKPOINT are always preserved regardless of the cap (see
`shouldSuppressForCapacity()`).

## Privacy

Student-authored working content is private assessment data. Students can
read only their own current attempt's checkpoints/events/artifacts (and
only when `allowStudentDevelopmentReview` is enabled); lecturers can read
only submissions they own (or platform-admin) within their own
institution. No raw IP/device values ever appear in this feature's output
(it captures none). No hidden chain-of-thought labelling of outline/
working content.

## Accessibility

Assistive-technology users may produce different editing patterns
(bulk dictation inserts, screen-reader-driven bulk edits, switch-access
batched input) that can resemble a large paste or a substantial edit.
This is explicitly called out as an alternative explanation everywhere a
lecturer sees a paste/rewrite signal — never treated as inherently
suspicious.

## Known limitations

- This repo's `Question` model has no distinct "CODE" question type or
  starter-code field — code-likeness for the ANSWER_CONTENT-adjacent
  heuristics elsewhere in this codebase, and this feature's own code
  workspace, are opt-in per exam via `enableCodeWorkspace`, independent of
  question type.
- `AnswerDevelopmentArtifact`'s uniqueness constraint
  (`submissionId, questionId, artifactType`) is fully enforced at the
  database level only for the non-null-`questionId` case; attempt-level
  source declarations (`questionId` null) are de-duplicated at the
  application layer (find-then-update inside a transaction), since
  Postgres treats each NULL as distinct in a unique index.
- No secure isolated code runner exists — see "Code-run limitation" above.
- Paste-retention detection uses a token-level LCS/multiset-overlap
  heuristic, not exact substring tracking — a reasonable, bounded
  approximation, not a perfect one.
- No lecturer-facing "mark reviewed" workflow is added for individual
  observations in v1 (unlike cohort-collusion's cluster review states) —
  observations are read-only context alongside the existing evidence/
  ai-assistance review pages, which already carry the reviewable-decision
  workflow for this submission.

## Migration procedure

See `docs/answer-development-provenance-v1-migration.sql` and the
"Deployment procedure — answer-development provenance" section of
`docs/migration-ledger.md`. **Not applied to any environment.**

## Rollback procedure

See the "Rollback — `docs/answer-development-provenance-v1-migration.sql`"
section of `docs/migration-ledger.md`.

## Preview smoke test

Because Preview and Production currently share ONE database, do not run
this checklist until the migration has been applied to a disposable
Preview/test database, separately reviewed and approved.

1. Create a disposable exam with provenance OFF. Confirm legacy behaviour
   is unchanged (autosave, submission, grading all work exactly as before).
2. Create an exam with BASIC provenance enabled.
3. Type an answer gradually; confirm first meaningful text is recorded
   (`INITIAL_TEXT`).
4. Wait for a periodic checkpoint (per the configured interval).
5. Make a substantial edit; confirm a `SUBSTANTIAL_EDIT` checkpoint.
6. Paste a large block where paste is permitted; confirm a
   `POST_PASTE_CHECKPOINT`.
7. Replace most of the pasted block; confirm a
   `PASTED_TEXT_SUBSTANTIALLY_REPLACED` event appears later.
8. Submit; confirm a `FINAL_SUBMISSION` checkpoint exists for every
   answered question.
9. Review the lecturer timeline at
   `/lecturer/submissions/[id]/answer-development`.
10. Compare two versions; confirm a readable highlighted diff.
11. Create a DETAILED exam with outline and calculation-working enabled.
12. Create an outline before finishing the final answer; add calculation
    working; confirm both appear in the timeline
    (`OUTLINE_PRECEDED_FINAL_RESPONSE` / `WORKING_PRECEDED_FINAL_RESPONSE`
    observations, if applicable).
13. Enable a required AI/source declaration; confirm submission is
    blocked (`SOURCE_DECLARATION_REQUIRED`) until the declaration is
    completed; confirm "No AI tool used" is accepted.
14. Confirm controlled Tether AI interactions still appear (on the
    existing AI-assistance page) as authorised assistance.
15. Confirm the student cannot view lecturer-only observations (the
    student GET route never returns them).
16. Confirm grades and submission status are unchanged by any of the above.
17. Confirm one-question-at-a-time mode still works with provenance
    enabled.
18. Confirm screen sharing and camera monitoring still work unaffected.
