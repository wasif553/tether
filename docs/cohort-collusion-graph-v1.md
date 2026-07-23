# Cohort-Level Collusion Detection and Integrity Graph v1

Status: implemented on `feature/cohort-collusion-graph-v1`, migration
**PENDING — NOT APPLIED** (see `docs/migration-ledger.md`, row 12).

## Purpose

Lecturers today review integrity signals one submission at a time
(answer similarity, timing anomalies, session binding). This feature adds
a **cohort-level** view: it looks for possible relationships *between*
submissions — a "possible coordinated-answer cluster" — by combining
several independent, already-explainable signal families into a
transparent graph.

**This is a review-signal system, never a misconduct-detection system.**
Every output is phrased as something requiring lecturer judgement:
"possible coordinated-answer cluster", "supporting signals", "needs
lecturer review", "possible concern", "human decision", "no concern
identified", "oral verification recommended". Nothing here ever says a
student cheated, that collusion is confirmed, or that anything is
"detected" as misconduct. No grade, submission, or existing integrity
record is ever altered by this feature.

## Threat model

This feature is defending against a specific, narrow risk that the
existing per-submission features do not cover: two or more students
producing correlated evidence (similar wording, matching rare mistakes,
synchronised timing, shared devices/networks, recurrence across exams)
that, taken individually, is each too weak to act on, but which together
may warrant a lecturer's attention. It is explicitly **not** a general
misconduct detector, not a proctoring tool, and not a substitute for
academic-integrity policy or process. Its primary failure mode to guard
against is **false positives from coincidence or legitimate shared
context** (study groups, shared course materials, shared accommodation
networks, common terminology) — the entire design (independent-family
requirement, family score caps, weak-support pruning) exists to reduce
that risk, at the cost of possibly missing some genuine cases (a
deliberate, documented trade-off — see "Known limitations" below).

## Graph model

- **Node**: one submitted/graded exam attempt (`Submission`).
- **Edge** (`CollusionPairEdge`): a possible relationship between two
  submissions of the same exam. An edge may carry signals from multiple
  independent families. Pair ordering is canonical
  (`sourceSubmissionId < comparedSubmissionId`), so A-vs-B and B-vs-A can
  never create duplicate edges (enforced by a unique index on
  `(analysisId, sourceSubmissionId, comparedSubmissionId)`).
- **Signal** (`CollusionSignal`): one explainable detection contributing
  to one edge, tagged with its family and type.
- **Cluster** (`CollusionCluster` + `CollusionClusterMember`): a
  connected component of *eligible* edges that has survived minimum-size,
  family-diversity, and weak-member-pruning checks — see "Cluster rules"
  below.
- **Analysis** (`CohortCollusionAnalysis`): one reusable row per exam,
  summarising the whole run.

See `prisma/schema.prisma` for the full field list of every model — every
field name matches this document and the original feature request
exactly.

## Signal families

Six independent families, each in its own pure module under
`src/lib/cohortCollusion/`:

| Family | Module | What it looks at |
|---|---|---|
| `ANSWER_CONTENT` | `answerContent.ts` | Written-response similarity (reusing `src/lib/answerSimilarity.ts`'s proven cosine/n-gram/phrase math) plus cohort-aware rare-phrase detection (inverse cohort frequency) and a code/calculation-structure heuristic. |
| `RARE_MISTAKE` | `rareMistake.ts` | A single incorrect response two students share, weighted by how rare that specific wrong answer is across the cohort. A mistake most of the cohort made gets almost no weight. |
| `MCQ_PATTERN` | `mcqPattern.ts` | Sequence-level matching across many shared MCQ questions — rarity-weighted, plus synchronised answer-change detection. Distinct from `RARE_MISTAKE`, which looks at one question at a time. |
| `TIMING_SYNCHRONISATION` | `timingSync.ts` | Repeated (never single) synchronised saves, substantial edits, question-progression correlation, and shared activity bursts, using `AnswerActivityEvent` server timestamps only. |
| `SESSION_NETWORK_DEVICE` | `sessionNetworkDevice.ts` | Repeated shared hashed network prefix/device token, overlapping `ExamAttemptSession` windows, matching reconnect patterns. Weakest family by design. |
| `CROSS_EXAM_RECURRENCE` | `crossExamRecurrence.ts` | Whether this exact pair/group has repeatedly shown a relationship across other exams at the same institution. Supporting evidence only. |

Deterministic analysis only. `ANSWER_CONTENT`/`RARE_MISTAKE` never send
whole-cohort answers to an external AI provider — everything is local
string/token math, exactly like the existing `answerSimilarity.ts`.

## Independent-family requirement (the core safety rule)

A **signal family** is a fixed set of six labels
(`SIGNAL_FAMILIES` in `src/lib/cohortCollusionThresholds.ts`). Multiple
signals from the same family never count as more than one family — three
`ANSWER_CONTENT` detections are still one family. Each family's
contribution to an edge's `combinedScore` is capped
(`FAMILY_SCORE_CAPS`), so no single family — however many or however
strong its own signals — can push a pair over the eligibility threshold
alone. `SESSION_NETWORK_DEVICE` and `CROSS_EXAM_RECURRENCE` are both
explicitly weak/supporting-only (`WEAK_SUPPORT_ONLY_FAMILIES`), and a
cluster member can never survive on support from those alone — see
"Cluster rules".

## Pair-edge rules

An edge becomes `eligibleForClustering` only when **both**:

1. it has signals from at least `MIN_INDEPENDENT_FAMILIES_FOR_EDGE` (2)
   independent families, **and**
2. its `combinedScore` (sum of each family's capped contribution) is at
   least `PAIR_ELIGIBILITY_SCORE_THRESHOLD` (0.5).

Because every family cap is below 0.5, no single family can ever satisfy
condition 2 alone even if condition 1 were bypassed — belt and
suspenders. See `src/lib/cohortCollusion/graph.ts:buildPairEdge`.

## Cluster rules

Built by `src/lib/cohortCollusion/graph.ts:buildClusters` as a transparent
connected-component search over eligible edges only (never an opaque
ML model):

1. Take every connected component of eligible edges.
2. Discard any component with fewer than `MIN_CLUSTER_MEMBERS` (3)
   members.
3. **Prune weak/unsupported members**: iteratively remove any member
   whose *entire* support within the remaining cluster comes only from
   `WEAK_SUPPORT_ONLY_FAMILIES` (shared network/device and/or bare
   cross-exam recurrence), or who has fewer than
   `MIN_MEMBER_SUPPORTING_EDGES` edges left. Removing one member can
   make another newly unsupported, so this repeats until stable. This is
   "no isolated member included solely through a weak shared-network
   relationship."
4. Recompute the component after pruning (it may have split); discard if
   it no longer has >= `MIN_CLUSTER_MEMBERS` members or
   >= `MIN_CLUSTER_INDEPENDENT_FAMILIES` (3) families across the whole
   cluster.
5. A student is never given cluster-level status merely for appearing in
   one weak pair — every remaining member's own edges are re-verified.

Only a cluster surviving every step above is ever created or shown.

## Scoring and score caps

Each family's raw signal strength (0-1) is reduced to one capped value
per family (the strongest single signal in that family), then summed:

```
ANSWER_CONTENT            cap 0.40
RARE_MISTAKE               cap 0.40
MCQ_PATTERN                cap 0.35
TIMING_SYNCHRONISATION     cap 0.35
SESSION_NETWORK_DEVICE     cap 0.20
CROSS_EXAM_RECURRENCE      cap 0.30
```

All thresholds, caps, and windows live in one versioned module,
`src/lib/cohortCollusionThresholds.ts` (`COHORT_COLLUSION_ALGORITHM_VERSION`
= `v1.0`) — never scattered across routes or UI.

## Rare-mistake weighting

`rarityWeightForFraction` (in the thresholds module) maps "fraction of
the analysed cohort who gave this exact wrong answer" to a weight:
`<= 10%` → full weight (RARE), `<= 25%` → half weight (UNCOMMON),
otherwise → almost no weight (COMMON, 0.05). A mistake most of the
cohort made is effectively invisible to this feature; a mistake almost
no one else made carries full weight. The same rarity function backs
both `RARE_MISTAKE` and `MCQ_PATTERN`'s wrong-answer weighting.

## Timing synchronisation

Uses `AnswerActivityEvent.serverReceivedAt` exclusively — client-supplied
elapsed time is never an input to any threshold comparison, exactly like
`src/lib/timeAnomalyDetection.ts`. Every timing signal type requires
**repeated** synchronisation (across multiple questions or multiple
events) before firing at all — one synchronised save, one substantial
edit, or one activity burst is never enough (`TIMING_SYNC_MIN_*`
constants in the thresholds module).

## Network/device limitations

Uses only the existing hashed fields — `NetworkEvidence.ipHash` and
`ExamAttemptSession.deviceTokenHash`/`firstSeenAt`/`lastSeenAt`/`status`.
Never a raw IP, raw device token, or raw browser-session token, and none
of those raw values are ever returned by any API route in this feature
(see the explicit "deliberately NOT selected" convention already
established for `session-review`). This whole family is capped lowest
and can never independently make an edge eligible or keep a cluster
member attached — students legitimately share university networks,
accommodation, libraries, workplaces, VPN exits, and family networks.

## Cross-exam recurrence

Institution-scoped: `src/lib/cohortCollusionAnalysisRunner.ts` only ever
looks at prior `CohortCollusionAnalysis`/`CollusionPairEdge` rows whose
exam belongs to the same institution (`exam.institutionId`), and only
`COMPLETE` analyses. Recurrence requires the SAME student pair to have
had an eligible relationship in at least `CROSS_EXAM_MIN_RECURRING_EXAMS`
(2) *different* prior exams — a single prior exam is never enough.
Always supporting evidence only (lowest-but-one cap, and a member of the
`WEAK_SUPPORT_ONLY_FAMILIES` set for cluster-membership purposes).

Whether a prior edge's two students were actually in the *same* prior
cluster (`wasInSameCluster`, used to distinguish `REPEATED_GROUP_RECURRENCE`
from the weaker `REPEATED_PAIR_SIMILARITY`) is determined by directly
checking `CollusionClusterMember` co-membership for that prior analysis,
not merely inferred from edge eligibility — see
`loadPriorCrossExamRecords` in the runner. The lookback itself is capped
(`CROSS_EXAM_LOOKBACK_MAX_ANALYSES` prior edges) as a documented v1
performance bound, not a correctness simplification.

## Review workflow

- `CollusionCluster.reviewStatus`: `NEEDS_REVIEW` (default) →
  `REVIEWED_NO_CONCERN` | `REVIEWED_CONCERN_REMAINS` |
  `ORAL_VERIFICATION_REQUESTED` | `ESCALATED` | `RESOLVED`, set via
  `PATCH /api/lecturer/collusion-clusters/[clusterId]/review`.
- `CollusionCluster.concernLevel`: `NONE` (analysis-level only, no
  cluster exists) | `WATCH` | `NEEDS_REVIEW` | `HIGHER_CONCERN`, computed
  by the engine, never set directly by a lecturer.
- `HIGHER_CONCERN` requires strictly more than the minimum: 4+
  independent families, OR 2+ prior exams with a recurring
  `CROSS_EXAM_RECURRENCE`-tagged edge, OR 2+ edges scoring
  >= `STRONG_EDGE_SCORE_THRESHOLD` (0.75), OR both `RARE_MISTAKE` and
  `TIMING_SYNCHRONISATION` independently reaching >= 80% of their own cap
  on the same edge.
- Re-running the analysis never silently deletes a lecturer's review: a
  cluster whose structural pattern no longer qualifies is only deleted if
  it is still `NEEDS_REVIEW` (i.e. no lecturer has touched it yet);
  otherwise it is left exactly as the lecturer left it.
- A private `reviewNote` (staff-only, never shown to any student route)
  can be set independently of `reviewStatus`.

## Oral-verification integration

This feature does **not** create a new way to request oral verification.
"Request oral verification" in the cluster UI sets the cluster's
`reviewStatus` to `ORAL_VERIFICATION_REQUESTED` for bookkeeping, and the
lecturer separately follows the link to each member's submission page,
which uses the pre-existing
`POST /api/lecturer/submissions/[id]/oral-verification` route (see
`docs/oral-verification-workflow-v1.md`) — the only place an
`OralVerification` row is ever created, exactly as before this feature
existed. The cluster-detail API (`GET
/api/lecturer/collusion-clusters/[clusterId]`) surfaces each member's
existing oral-verification status for visibility, without duplicating
its creation logic.

## Institution isolation

Every route re-uses the existing `src/lib/institutionScope.ts` helpers
(`assertSameInstitution`, `isPlatformAdmin`). A lecturer can only trigger
or view analysis for exams they own within their own institution (or, for
a `PLATFORM_ADMIN`, any institution); cross-institution access returns
404/403 exactly like every other lecturer route in this codebase.
`CROSS_EXAM_RECURRENCE` lookups are similarly scoped to
`exam.institutionId`, never across institutions.

## Privacy controls

- `CollusionSignal.evidenceJson` stores only minimal explainable data
  (counts, rarity bands, short matched-phrase excerpts capped at
  `ANSWER_CONTENT_EXCERPT_MAX_CHARS`) — never a full duplicated student
  answer, never a raw hash, never a raw IP/device identifier.
- The lecturer UI shows anonymised `S1`/`S2`/... labels inside the
  optional graph widget itself, with real student names/emails shown
  alongside in the (already lecturer-authenticated,
  institution-scoped) member table — there is no separate
  "anonymous vs identified" access tier in this codebase (see
  `docs/course-enrolment-and-exam-assignment.md`), so the whole page
  being lecturer-only is the "authorised detail panel."
- Student-facing routes never expose any collusion-graph data — there is
  no student-facing route for this feature at all.

## Known limitations

- **No `CODE`/calculation question type**: this repo's `Question.type`
  enum has no distinct code or calculation type. Code-likeness and
  calculation-likeness are detected heuristically from response text
  (`looksCodeLike`/`looksCalculationLike` in `answerContent.ts`) —
  reasonable but imperfect. No identifier-renaming normalisation is
  attempted for code comparison in v1.
- **No starter-code/template field**: `Question` has no dedicated
  starter-code column, so boilerplate discounting only strips the
  question's own text, not a separately lecturer-authored template.
- **Cohort cap**: `MAX_COLLUSION_ANALYSIS_SUBMISSIONS` = 80 for the v1
  synchronous, lecturer-triggered run (this repo has no
  queue/worker) — an exam with more analysable submissions is refused
  with a clear error (422) rather than left to time out. See "Analysis
  engine" performance notes below.
- **`SYNCHRONISED_MCQ_CHANGES` uses response hashes, not values**:
  `AnswerActivityEvent.responseHash` lets the engine detect *that* an
  MCQ answer changed, but the actual intermediate values are not stored
  — only the final answer is compared for a synchronised-change match.
- **Timing signals from other features are contextual, not scored**:
  existing per-submission `TimingIntegritySignal`/`TimingAnalysis` rows
  are not fed into this feature's own scoring (that would conflate a
  single submission's own anomalous pace with pairwise synchronisation
  evidence, which are different claims) — they remain visible via their
  own existing review pages.
- **Small cohorts**: with fewer than 3 analysable submissions, the
  analysis returns `INSUFFICIENT_DATA` rather than attempting clustering
  — see "Alternative explanations to consider" in the lecturer UI, which
  explicitly lists small cohort size as a reason a pattern may be
  coincidental even when the analysis does run.

## Analysis engine (performance)

`src/lib/cohortCollusionAnalysisRunner.ts` runs synchronously inside the
lecturer-triggered request, exactly like `similarityAnalysisRunner.ts`
and `timingAnalysisRunner.ts`. At the documented cap of 80 submissions,
that is at most 3,160 pairs — each pair's per-family computation is
bounded by the number of shared questions/events, which is itself bounded
by the exam's own question count, so this stays comfortably within a
single request's budget for realistic exam sizes. No additional
candidate-blocking beyond the existing per-exam cohort cap is implemented
in v1 (unlike similarity analysis, this feature does not yet reuse
existing `SubmissionSimilarityMatch` results as a pre-filter) — a future
version could narrow pairwise comparison further using existing
similarity matches, matching rare wrong-answer signatures, or timing
buckets as blocking candidates for larger cohorts.

## Migration procedure

See `docs/migration-ledger.md`, row 12 and its "Deployment procedure —
cohort collusion graph" section, and
`docs/cohort-collusion-graph-v1-migration.sql`. **Not applied to any
environment.** Five new, wholly additive tables; zero columns added to
any existing table.

## Rollback procedure

See `docs/migration-ledger.md`'s "Rollback —
`docs/cohort-collusion-graph-v1-migration.sql`" section: all five tables
can be dropped (child-to-parent order) with no impact on any other
feature, since nothing else has a foreign key into them.

## Manual Preview smoke test

Do **not** run this against Production. Requires the migration to be
applied to a real, reachable Preview database first.

1. Create an exam with a mix of MCQ and written (short-answer/essay)
   questions.
2. Create at least six disposable student accounts.
3. Produce one normal group of independent responses (varied wording,
   varied MCQ mistakes, no timing correlation).
4. Produce one synthetic coordinated pattern involving at least three of
   the students.
5. Within that group, include matching rare wrong MCQ answers (an option
   almost no one else picks).
6. Within that group, include similar unusual written phrases on a
   written question (not just generic shared wording).
7. Within that group, include repeated synchronised answer saves (submit
   answers to several different questions within seconds of each other,
   more than once).
8. Optionally, have two of the group reuse one test device or network as
   additional (weak, supporting-only) evidence.
9. As the lecturer, open **Cohort integrity analysis** for the exam and
   click **Run cohort integrity analysis**.
10. Confirm the synthetic group forms a possible coordinated-answer
    cluster, labelled `NEEDS_REVIEW` or `HIGHER_CONCERN`.
11. Confirm a student pair connected ONLY by a shared IP/network (no
    other evidence) never forms a cluster and never appears in one.
12. Confirm a student pair with only a single high-similarity written
    answer (no second family) never forms a cluster.
13. Open the cluster detail and inspect the signal-family matrix —
    confirm every contributing family is named, not just a count.
14. Click **Mark no concern** on one cluster and confirm its status
    updates and persists after reload.
15. Click **Request oral verification** for one member, then follow
    through to that submission's page and use the existing oral
    verification action there; confirm an `OralVerification` row is
    created only via that existing route.
16. Confirm no grades, submission statuses, or existing integrity events
    changed as a result of running the analysis (spot-check before/after).
17. Log in as one of the involved students and confirm the collusion
    analysis is not visible or reachable from any student-facing route.
18. Re-run the analysis on an older, previously-analysed exam and confirm
    it is unaffected by this feature being new (either produces
    `INSUFFICIENT_DATA` if it predates enough activity data, or a fresh
    analysis — never an error tied to legacy data).
