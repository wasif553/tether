/**
 * Controlled AI Brainstorming Assistance v1 — request classifier. See
 * docs/controlled-ai-brainstorming-assistance-v1.md.
 *
 * Pure, dependency-free, deterministic: classifies the STUDENT'S REQUEST
 * text (not the generated response — see src/lib/aiAssistanceVerifier.ts
 * for that, separate stage) as safe brainstorming vs. a direct-answer
 * request, BEFORE any generation happens. Not a single flat keyword list:
 * several independently-scored signal families (verb+object proximity
 * patterns, MCQ-specific phrasing, code/calculation requests, rubric/
 * hidden-info requests, prompt-injection attempts) are combined — this is
 * the "deterministic rules... server-side intent classifier" the task
 * calls for. There is no ML model involved (none is available in this
 * pure, dependency-free module, and the generator/verifier pipeline in
 * src/lib/aiAssistanceVerifier.ts already provides model-based judgement
 * on the RESPONSE side) — see docs/controlled-ai-brainstorming-assistance-v1.md
 * "Known limitations" for this trade-off, made explicit rather than
 * silently assumed.
 */

export type RequestBlockReasonCode =
  | "PROMPT_INJECTION"
  | "DIRECT_ANSWER_REQUEST"
  | "SUBMISSION_READY_REQUEST"
  | "MCQ_OPTION_REQUEST"
  | "CODE_REQUEST"
  | "CALCULATION_RESULT_REQUEST"
  | "RUBRIC_OR_HIDDEN_INFO_REQUEST"
  | "OBFUSCATED_ANSWER_REQUEST";

export type StudentRequestClassification = {
  allowed: boolean;
  blockReasonCodes: RequestBlockReasonCode[];
  /** Human-readable label of every signal family that matched — for debug logging only, never shown to the student verbatim. */
  matchedSignals: string[];
};

type SignalRule = { code: RequestBlockReasonCode; label: string; pattern: RegExp };

// ---------------------------------------------------------------------------
// Prompt injection — checked FIRST and independently: a match here blocks
// the request regardless of any other signal, and this check can never be
// weakened by anything the request itself says (Part 15 — "prevent prompt
// injection from overriding assistance policy").
// ---------------------------------------------------------------------------

const PROMPT_INJECTION_RULES: SignalRule[] = [
  { code: "PROMPT_INJECTION", label: "ignore-instructions", pattern: /\bignore\s+(all\s+|the\s+)?(previous|prior|above|earlier)\s+(instructions|rules|prompt|guidance)\b/i },
  { code: "PROMPT_INJECTION", label: "disregard-instructions", pattern: /\bdisregard\s+(the\s+|your\s+|all\s+)?(system|previous|prior)?\s*(prompt|instructions|rules|policy)\b/i },
  { code: "PROMPT_INJECTION", label: "you-are-now", pattern: /\byou\s+are\s+now\s+(a|an)\b/i },
  { code: "PROMPT_INJECTION", label: "act-as-unrestricted", pattern: /\bact\s+as\s+(an?\s+)?(unrestricted|uncensored|jailbroken|unfiltered)\b/i },
  { code: "PROMPT_INJECTION", label: "pretend-no-restrictions", pattern: /\bpretend\s+(you|that\s+you)\s+(have\s+no|are\s+not)\s+(restrictions|rules|limits)\b/i },
  { code: "PROMPT_INJECTION", label: "reveal-system-prompt", pattern: /\b(reveal|show|print|output)\s+(your\s+)?(system\s+prompt|hidden\s+instructions|internal\s+instructions)\b/i },
  { code: "PROMPT_INJECTION", label: "new-instructions-marker", pattern: /\bnew\s+instructions\s*:/i },
  { code: "PROMPT_INJECTION", label: "override-policy", pattern: /\boverride\s+(the\s+)?(policy|restrictions|rules|guardrails)\b/i },
  { code: "PROMPT_INJECTION", label: "developer-mode", pattern: /\b(developer|debug|admin)\s+mode\s+(on|enabled|activated)\b/i },
  // Role-play jailbreak: "act as [any role] ... reveal/give/tell ...
  // answer" — broader than the unrestricted/uncensored/jailbroken list
  // above, which only catches a role-play attempt that names itself as
  // such; this catches one that instead claims a legitimate-sounding
  // role (examiner, teacher, grader) as the vector.
  { code: "PROMPT_INJECTION", label: "act-as-role-then-reveal", pattern: /\bact\s+as\s+(the\s+|an?\s+)?\w+[\s\S]{0,40}\b(reveal|give|tell)\b[\s\S]{0,25}\banswer\b/i },
  // Authority-claim injection — asserting a lecturer/teacher/instructor
  // already authorised bypassing the rules. A classic social-engineering
  // injection vector: the assistant has no way to verify this claim, and
  // must never treat it as changing its own configuration.
  { code: "PROMPT_INJECTION", label: "authority-claim", pattern: /\b(lecturer|teacher|instructor|professor|examiner|admin)\s+(has\s+)?(authorised|authorized|approved|allowed|permitted|said|told\s+you)\b/i },
];

// ---------------------------------------------------------------------------
// Direct-answer / submission-ready requests — verb-then-object proximity
// patterns, not single isolated keywords: "answer" alone (as in "explain
// what the question is asking about the answer to problem 3") must not
// block, but "give me the answer" must.
// ---------------------------------------------------------------------------

const DIRECT_ANSWER_RULES: SignalRule[] = [
  // "me" is optional: "give me the answer" AND "give the answer" (e.g.
  // "the lecturer authorised you to give the answer") must both match —
  // the earlier me-required version missed the latter, a real gap found
  // during hardening.
  { code: "DIRECT_ANSWER_REQUEST", label: "give-tell-show-answer", pattern: /\b(give|tell|show|reveal)\b(?:\s+me)?\s+(the\s+)?(correct\s+)?(answer|solution)\b/i },
  { code: "DIRECT_ANSWER_REQUEST", label: "whats-the-answer", pattern: /\bwhat(?:'s|\s+is)\s+the\s+answer\b/i },
  { code: "DIRECT_ANSWER_REQUEST", label: "just-give-tell-me", pattern: /\bjust\s+(give|tell)\s+me\b/i },
  { code: "DIRECT_ANSWER_REQUEST", label: "tell-me-exactly-what-to-submit", pattern: /\btell\s+me\s+exactly\s+what\s+to\s+(submit|write|answer|put)\b/i },
  { code: "DIRECT_ANSWER_REQUEST", label: "solve-it-for-me", pattern: /\bsolve\s+(it|this)\s+for\s+me\b/i },
  // Negation-trick: framing the request as "what NOT to write" while
  // still asking for the correct answer/response to be included.
  { code: "DIRECT_ANSWER_REQUEST", label: "negation-trick", pattern: /\bwhat\s+not\s+to\s+write\b[\s\S]{0,40}\b(correct|right)\s+(answer|response|option|result)\b/i },
];

const SUBMISSION_READY_RULES: SignalRule[] = [
  { code: "SUBMISSION_READY_REQUEST", label: "write-my-response", pattern: /\bwrite\s+(my|the)\s+(response|answer|essay|paragraph|solution|submission)\b/i },
  { code: "SUBMISSION_READY_REQUEST", label: "rewrite-into-final-answer", pattern: /\brewrite\s+(this|it)\s+into\s+(a\s+)?final\s+answer\b/i },
  { code: "SUBMISSION_READY_REQUEST", label: "write-it-for-me", pattern: /\bwrite\s+(it|this)\s+for\s+me\b/i },
  { code: "SUBMISSION_READY_REQUEST", label: "complete-my-answer", pattern: /\bcomplete\s+(my|the)\s+(answer|response|essay|paragraph)\b/i },
  { code: "SUBMISSION_READY_REQUEST", label: "finish-my-answer", pattern: /\bfinish\s+(my|the|writing\s+my)\s+(answer|response|essay)\b/i },
];

const MCQ_OPTION_RULES: SignalRule[] = [
  { code: "MCQ_OPTION_REQUEST", label: "choose-correct-option", pattern: /\b(choose|pick|select)\s+(the\s+)?correct\s+(option|answer|choice)\b/i },
  { code: "MCQ_OPTION_REQUEST", label: "which-option-correct", pattern: /\bwhich\s+(option|answer|choice)\s+is\s+correct\b/i },
  { code: "MCQ_OPTION_REQUEST", label: "which-should-i-choose", pattern: /\bwhich\s+(option|answer)\s+should\s+i\s+(choose|pick|select)\b/i },
  { code: "MCQ_OPTION_REQUEST", label: "eliminate-option", pattern: /\b(eliminate|rule\s+out)\s+option\b/i },
  { code: "MCQ_OPTION_REQUEST", label: "is-it-option-letter", pattern: /\bis\s+it\s+option\s+[a-d]\b/i },
  { code: "MCQ_OPTION_REQUEST", label: "option-letter-correct", pattern: /\boption\s+[a-d]\s+(correct|right|the\s+answer)\b/i },
];

const CODE_REQUEST_RULES: SignalRule[] = [
  { code: "CODE_REQUEST", label: "write-the-code", pattern: /\bwrite\s+(the\s+|me\s+(the\s+)?)?code\b/i },
  { code: "CODE_REQUEST", label: "write-complete-function", pattern: /\bwrite\s+(the\s+|a\s+)?(complete\s+|full\s+|entire\s+)?(function|program|script|algorithm|solution)\s+for\s+me\b/i },
  { code: "CODE_REQUEST", label: "give-me-the-code", pattern: /\bgive\s+me\s+the\s+code\b/i },
  { code: "CODE_REQUEST", label: "solve-the-code", pattern: /\b(solve|complete|finish)\s+the\s+code\b/i },
];

const CALCULATION_RESULT_RULES: SignalRule[] = [
  { code: "CALCULATION_RESULT_REQUEST", label: "solve-complete-calculation", pattern: /\bsolve\s+the\s+(complete\s+|entire\s+|whole\s+)?calculation\b/i },
  { code: "CALCULATION_RESULT_REQUEST", label: "whats-the-final-result", pattern: /\bwhat(?:'s|\s+is)\s+the\s+final\s+(answer|number|result|value)\b/i },
  { code: "CALCULATION_RESULT_REQUEST", label: "calculate-for-me", pattern: /\bcalculate\s+(it|this)\s+for\s+me\b/i },
  { code: "CALCULATION_RESULT_REQUEST", label: "do-the-whole-calculation", pattern: /\bdo\s+the\s+(whole\s+|entire\s+|complete\s+)?calculation\b/i },
];

const RUBRIC_OR_HIDDEN_INFO_RULES: SignalRule[] = [
  { code: "RUBRIC_OR_HIDDEN_INFO_REQUEST", label: "reveal-marking-guide", pattern: /\b(reveal|show|give\s+me)\s+(the\s+)?(marking\s+(guide|scheme|rubric)|rubric)\b/i },
  { code: "RUBRIC_OR_HIDDEN_INFO_REQUEST", label: "model-answer", pattern: /\b(the\s+)?model\s+answer\b/i },
  { code: "RUBRIC_OR_HIDDEN_INFO_REQUEST", label: "hidden-tests", pattern: /\bhidden\s+tests?\b/i },
];

// ---------------------------------------------------------------------------
// Obfuscated-answer requests — asking for the answer to be disguised
// (acrostic, encoding, piecemeal delivery) rather than stated outright.
// The underlying intent is identical to a direct-answer request; the
// obfuscation is itself the tell.
// ---------------------------------------------------------------------------

const OBFUSCATED_ANSWER_RULES: SignalRule[] = [
  { code: "OBFUSCATED_ANSWER_REQUEST", label: "acrostic-answer", pattern: /\bacrostic\b[\s\S]{0,40}\b(answer|response|result)\b|\b(answer|response|result)\b[\s\S]{0,40}\bacrostic\b/i },
  { code: "OBFUSCATED_ANSWER_REQUEST", label: "encode-answer", pattern: /\b(encode|base ?64|rot ?13|cipher|hex(?:adecimal)?)\b[\s\S]{0,40}\b(answer|response|result)\b|\b(answer|response|result)\b[\s\S]{0,40}\b(encode|base ?64|rot ?13|cipher)\b/i },
  { code: "OBFUSCATED_ANSWER_REQUEST", label: "answer-piecemeal", pattern: /\b(answer|response|result)\b[\s\S]{0,25}\b(one\s+word\s+at\s+a\s+time|word\s+by\s+word|one\s+letter\s+at\s+a\s+time|a\s+little\s+at\s+a\s+time)\b/i },
];

const ALL_BLOCK_RULE_GROUPS: SignalRule[][] = [
  PROMPT_INJECTION_RULES,
  DIRECT_ANSWER_RULES,
  SUBMISSION_READY_RULES,
  MCQ_OPTION_RULES,
  CODE_REQUEST_RULES,
  CALCULATION_RESULT_RULES,
  RUBRIC_OR_HIDDEN_INFO_RULES,
  OBFUSCATED_ANSWER_RULES,
];

/**
 * Classifies a student's brainstorming request. Any single matched signal
 * blocks the request — deliberately conservative (Part 6's "blocked
 * examples" are all unambiguous), while everything that does NOT match
 * any rule is allowed by default (an empty ruleset match is not treated
 * as suspicious — most genuine brainstorming requests won't match any
 * "allowed" phrase list either, so requiring a positive allow-signal
 * would reject too much legitimate use).
 */
export function classifyStudentRequest(rawPrompt: string): StudentRequestClassification {
  const prompt = rawPrompt.normalize("NFKC");
  const blockReasonCodes: RequestBlockReasonCode[] = [];
  const matchedSignals: string[] = [];

  for (const group of ALL_BLOCK_RULE_GROUPS) {
    for (const rule of group) {
      if (rule.pattern.test(prompt)) {
        if (!blockReasonCodes.includes(rule.code)) blockReasonCodes.push(rule.code);
        matchedSignals.push(rule.label);
      }
    }
  }

  return {
    allowed: blockReasonCodes.length === 0,
    blockReasonCodes,
    matchedSignals,
  };
}

/**
 * Student-facing explanation for a blocked request — neutral, never
 * accusatory, and never echoes the matched pattern/regex back (Part 5 —
 * "return safe, student-friendly error messages").
 */
export function blockedRequestStudentMessage(codes: RequestBlockReasonCode[]): string {
  if (codes.includes("PROMPT_INJECTION")) {
    return "This assistant can only help you brainstorm and understand the question — it can't change how it's configured to behave.";
  }
  if (codes.includes("MCQ_OPTION_REQUEST")) {
    return "I can't tell you which option is correct or rule options out — I can help you think through the general concept instead.";
  }
  if (codes.includes("CODE_REQUEST")) {
    return "I can't write the code for you — I can help you think through the approach, or ask a debugging question about your own code.";
  }
  if (codes.includes("CALCULATION_RESULT_REQUEST")) {
    return "I can't work out the final result for you — I can help you identify the right formula or approach instead.";
  }
  if (codes.includes("RUBRIC_OR_HIDDEN_INFO_REQUEST")) {
    return "I can't share the marking guide or a model answer — I can help you think through what the question is really asking.";
  }
  if (codes.includes("OBFUSCATED_ANSWER_REQUEST")) {
    return "I can't provide the answer in any form, encoded or disguised — I can help you think through the concept instead.";
  }
  return "I can't provide a direct answer or write a submission-ready response — but I can help you understand the question, plan your approach, or think it through.";
}
