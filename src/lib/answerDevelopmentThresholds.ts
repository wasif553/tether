/**
 * Answer-Development Provenance v1 — versioned threshold configuration.
 * See docs/answer-development-provenance-v1.md.
 *
 * Every number that decides whether a checkpoint is captured, how a
 * change is classified (substantial edit, large deletion, major
 * rewrite, ...), a policy's hard bounds, or a storage/retention limit
 * lives here — never scattered across routes or UI components. This is
 * PROCESS EVIDENCE, not a misconduct detector — nothing here computes or
 * contributes to a risk/misconduct score.
 *
 * Pure, dependency-free: no Prisma, no Next.js.
 */

export const ANSWER_DEVELOPMENT_THRESHOLDS_VERSION = "v1.0";

// ---------------------------------------------------------------------------
// Policy hard bounds (Part 1) — the single source of truth other than the
// matching min/max on the zod schema in secureExam.ts. Any client- or
// lecturer-supplied value outside these is clamped, never trusted verbatim.
// ---------------------------------------------------------------------------

export const DEFAULT_ANSWER_VERSION_INTERVAL_SECONDS = 60;
export const MIN_ANSWER_VERSION_INTERVAL_SECONDS = 30;
export const MAX_ANSWER_VERSION_INTERVAL_SECONDS = 300;

export const DEFAULT_ANSWER_VERSION_MINIMUM_CHARACTER_CHANGE = 80;
export const MIN_ANSWER_VERSION_MINIMUM_CHARACTER_CHANGE = 20;
export const MAX_ANSWER_VERSION_MINIMUM_CHARACTER_CHANGE = 1000;

export const DEFAULT_ANSWER_VERSION_MAXIMUM_PER_QUESTION = 40;
export const MIN_ANSWER_VERSION_MAXIMUM_PER_QUESTION = 5;
export const MAX_ANSWER_VERSION_MAXIMUM_PER_QUESTION = 100;

// ---------------------------------------------------------------------------
// Version-capture rules (Part 4) — descriptive process categories, never
// risk scores. All are counts/ratios over normalised text; see
// src/lib/answerDevelopmentDiff.ts for the diff that produces them.
// ---------------------------------------------------------------------------

/** At least this many non-whitespace characters before an answer counts as "meaningful" (FIRST_MEANINGFUL_TEXT). */
export const MEANINGFUL_TEXT_MIN_NON_WHITESPACE_CHARS = 10;

/** A paste inserting at least this many characters counts as "large" (POST_PASTE_CHECKPOINT / PASTE_INSERTED). */
export const LARGE_PASTE_MIN_INSERTED_CHARS = 100;

/** Substantial edit: at least this many characters changed... */
export const SUBSTANTIAL_EDIT_MIN_CHARS_CHANGED = 120;
/** ...OR at least this fraction of the prior response changed. */
export const SUBSTANTIAL_EDIT_MIN_RATIO = 0.25;

/** Large deletion: at least this many characters removed... */
export const LARGE_DELETION_MIN_CHARS_REMOVED = 100;
/** ...OR at least this fraction of prior text removed. */
export const LARGE_DELETION_MIN_RATIO = 0.3;

/** Major rewrite: at least this fraction of prior text replaced. */
export const MAJOR_REWRITE_MIN_RATIO = 0.5;

/** Pasted text counts as "substantially replaced" once at least this fraction of the pasted segment no longer appears in a later checkpoint. */
export const PASTED_TEXT_SUBSTANTIALLY_REPLACED_MIN_RATIO = 0.6;

// ---------------------------------------------------------------------------
// Rate limiting (Part 6) — same minimal, DB-timestamp-driven sliding-
// window pattern as src/lib/aiAssistancePolicy.ts / screenSharePolicy.ts
// (no shared rate-limiting utility exists elsewhere in this repo).
// ---------------------------------------------------------------------------

export const CHECKPOINT_RATE_LIMIT_MAX_REQUESTS = 6;
export const CHECKPOINT_RATE_LIMIT_WINDOW_MS = 20_000;

export const DEVELOPMENT_EVENT_RATE_LIMIT_MAX_REQUESTS = 10;
export const DEVELOPMENT_EVENT_RATE_LIMIT_WINDOW_MS = 20_000;

// ---------------------------------------------------------------------------
// Storage / retention limits (Part 11) — avoid uncontrolled database
// growth. Applied server-side regardless of what a client sends.
// ---------------------------------------------------------------------------

/**
 * Checkpoint response text ceiling. The Answer.response column itself has
 * no explicit length limit anywhere else in this repo — this is the
 * first one introduced, chosen generously so no realistic exam answer is
 * ever truncated, while still bounding a single checkpoint row's size.
 */
export const CHECKPOINT_RESPONSE_TEXT_MAX_CHARS = 50_000;

export const ARTIFACT_MAX_CHARACTERS: Record<string, number> = {
  OUTLINE: 20_000,
  CALCULATION_WORKING: 30_000,
  CODE_WORKING: 100_000,
  AI_SOURCE_DECLARATION: 10_000,
  GENERAL_SOURCE_DECLARATION: 10_000,
};

/** Tightly-bounded event metadata — never arbitrary/unlimited JSON (Part 11). Measured as JSON.stringify(...).length. */
export const EVENT_METADATA_MAX_CHARS = 2_000;

/** Bounded, structured code-execution output summary — never raw/unrestricted terminal output (Part 2). */
export const CODE_EXECUTION_OUTPUT_SUMMARY_MAX_CHARS = 2_000;

/** Hard ceiling on a single code-working artifact's codeHash input length used for change detection — mirrors ARTIFACT_MAX_CHARACTERS.CODE_WORKING. */
export const CODE_WORKING_MAX_CHARACTERS = ARTIFACT_MAX_CHARACTERS.CODE_WORKING;
