/**
 * Controlled AI Brainstorming Assistance — non-blocking request-mode
 * classification (architectural simplification follow-up).
 *
 * Pure, dependency-free, deterministic — mirrors aiAssistanceClassifier.ts's
 * style but serves a completely different purpose: aiAssistanceClassifier.ts
 * BLOCKS a request outright (hard safety boundary); this module NEVER
 * blocks anything. It only picks which short, mode-specific instruction
 * the generator (src/lib/aiAssistanceGenerator.ts) should use for an
 * ALREADY-ALLOWED request, so a concept question gets a concept-teaching
 * instruction, an approach question gets a reasoning-procedure
 * instruction, and so on — instead of one giant instruction trying to
 * cover every shape of legitimate request with accumulating caveats.
 *
 * A request that does not clearly match any specific mode simply gets
 * GENERIC_HELP, which is still a fully safe, useful instruction — this
 * classifier's only job is to pick the MOST HELPFUL applicable framing,
 * never to gate access.
 */

export type BrainstormRequestMode =
  | "CONCEPT_EXPLANATION"
  | "APPROACH_GUIDANCE"
  | "MISCONCEPTION_CHECK"
  | "GUIDING_QUESTION"
  | "ANSWER_CONFIRMATION"
  | "GENERIC_HELP";

// Checked in this order — most distinctive/specific shapes first, so a
// broad pattern later (e.g. CONCEPT_EXPLANATION's "what is X") never
// steals a request that a more specific pattern already claims (e.g.
// APPROACH_GUIDANCE's "help me understand the question").

const GUIDING_QUESTION_PATTERNS = [
  /\bguiding\s+question\b/i,
  /\bask\s+me\s+a\s+question\b/i,
  /\bask\s+me\s+something\b/i,
];

// A student stating their own candidate final answer/option and asking
// for confirmation — distinct from a MISCONCEPTION_CHECK, which checks a
// concept/reasoning step, not a stated final answer. Checked before
// MISCONCEPTION_CHECK so a confirmation-shaped "...right?" is never
// misread as a plain misconception check.
const ANSWER_CONFIRMATION_PATTERNS = [
  /\bis\s+(?:that\s+|this\s+)?the\s+answer\b/i,
  /\bis\s+[a-d]\s+correct\b/i,
  /\bis\s+the\s+correct\s+option\b/i,
  /\bfinal\s+answer\s+is\b/i,
];

const MISCONCEPTION_CHECK_PATTERNS = [
  /\bis\s+(?:a|an)\s+\w+\s+like\s+(?:a|an)?\s*\w+/i,
  /\bam\s+i\s+thinking\s+about\b/i,
  /\bdoes\s+(?:a|an|the)\s+\w+\s+use\b/i,
  // A trailing "..., right?" that wasn't already claimed by
  // ANSWER_CONFIRMATION above is a student checking their own stated
  // understanding of a concept, not their final answer.
  /,?\s*right\?\s*$/i,
];

const APPROACH_GUIDANCE_PATTERNS = [
  /\bhow\s+(?:should|do|can)\s+i\s+approach\b/i,
  /\bwhat\s+should\s+i\s+do\s+first\b/i,
  /\bhelp\s+me\s+understand\b.*\bquestion\b/i,
  /\bwhat\s+is\s+(?:this|the)\s+question\s+(?:asking|testing)\b/i,
];

const CONCEPT_EXPLANATION_PATTERNS = [
  /\bwhat\s+(?:is|are|does|do)\b/i,
  /\bexplain\b/i,
  /\bhow\s+(?:is|are|does|do)\b.*\bdifferent\b/i,
  /\bhelp\s+me\s+understand\s+how\b/i,
  /\bhelp\s+me\s+understand\b/i,
];

/**
 * Picks the generator instruction mode for an ALREADY-ALLOWED student
 * request. Never blocks — a request matching nothing specific gets
 * GENERIC_HELP, which is itself a complete, safe instruction.
 */
export function classifyBrainstormRequestMode(rawPrompt: string): BrainstormRequestMode {
  if (GUIDING_QUESTION_PATTERNS.some((p) => p.test(rawPrompt))) return "GUIDING_QUESTION";
  if (ANSWER_CONFIRMATION_PATTERNS.some((p) => p.test(rawPrompt))) return "ANSWER_CONFIRMATION";
  if (MISCONCEPTION_CHECK_PATTERNS.some((p) => p.test(rawPrompt))) return "MISCONCEPTION_CHECK";
  if (APPROACH_GUIDANCE_PATTERNS.some((p) => p.test(rawPrompt))) return "APPROACH_GUIDANCE";
  if (CONCEPT_EXPLANATION_PATTERNS.some((p) => p.test(rawPrompt))) return "CONCEPT_EXPLANATION";
  return "GENERIC_HELP";
}
