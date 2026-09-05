/**
 * Controlled AI Brainstorming Assistance v1 — independent response
 * verifier. See docs/controlled-ai-brainstorming-assistance-v1.md.
 *
 * Server-only. A SEPARATE service from the generator
 * (src/lib/aiAssistanceGenerator.ts) — different system prompt, different
 * (and wider) input, called with its own Anthropic request. Generator
 * output is NEVER returned to a student without passing through this
 * verifier first (enforced by src/lib/aiAssistanceRunner.ts, the only
 * caller of both). The verifier's own structured output is never shown to
 * the student directly either — only used to decide whether the
 * candidate response may be shown.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { BrainstormQuestionType } from "@/lib/aiAssistanceGenerator";
import type { BrainstormRequestMode } from "@/lib/aiAssistanceRequestMode";
import { boundedHiddenReference } from "@/lib/aiAssistancePolicy";
import {
  callWithTransientRetry,
  classifyProviderError,
  type AiProviderErrorCategory,
  type ProviderCallAttemptLog,
} from "@/lib/aiAssistanceProviderError";

export const RISK_CODES = [
  "DIRECT_ANSWER",
  "NEAR_COMPLETE_ANSWER",
  "CORRECT_OPTION_DISCLOSED",
  "OPTION_ELIMINATION",
  "FINAL_NUMERIC_RESULT",
  "SUBMISSION_READY_PROSE",
  "COMPLETE_CODE",
  "HIDDEN_RUBRIC_DISCLOSURE",
  "CUMULATIVE_HINT_LEAKAGE",
  "EXCESSIVE_SPECIFICITY",
  // Cumulative answer-assembly follow-up — additive, backward-compatible
  // (riskCodesJson is an unstructured JSON array column; no migration).
  // Distinct from SUBMISSION_READY_PROSE/NEAR_COMPLETE_ANSWER: those are
  // about a single candidate reading as a polished final answer.
  // SUBMISSION_READY_COMPLETION is about assembling MOST of the
  // substantive content the question requires (e.g. every distinguishing
  // point in a comparison) even if not phrased as polished prose — a
  // bullet-style list of all the differences is just as much a completed
  // answer as a paragraph would be. CUMULATIVE_RESPONSE_COMPLETION is the
  // same judgment but only crosses the line when THIS candidate is
  // combined with prior approved guidance for the SAME question — see
  // priorApprovedResponses below. Open-response (SHORT_ANSWER/ESSAY)
  // question types only; MULTIPLE_CHOICE keeps its existing
  // option/result-disclosure boundary unchanged.
  "SUBMISSION_READY_COMPLETION",
  "CUMULATIVE_RESPONSE_COMPLETION",
] as const;
export type RiskCode = (typeof RISK_CODES)[number];

export type BrainstormVerifierInput = {
  questionText: string;
  questionType: BrainstormQuestionType;
  candidateResponse: string;
  studentRequest: string;
  /**
   * Grounded-cumulative-safety follow-up (MUST HAVE) — which short,
   * already-computed generator instruction mode this request used (see
   * aiAssistanceRequestMode.ts). Calibration only: it changes how the
   * verifier expects the candidate to be framed, never whether the
   * disclosure/completion rules themselves apply — see buildSystemPrompt's
   * per-mode notes below.
   */
  requestMode: BrainstormRequestMode;
  /** Present only when the question actually has one on record — never fabricated. */
  hiddenModelAnswer?: string | null;
  hiddenRubricSummary?: string | null;
  /** How many hints have already been approved for this question — the verifier must weigh disclosure cumulatively, not just against this one candidate. */
  priorApprovedHintCount: number;
  /** Running sum of riskScore across every previously-approved interaction for this question (Part 10). */
  cumulativeRiskScoreSoFar: number;
  /**
   * Cumulative answer-assembly follow-up — the actual TEXT of every
   * previously-approved response for this SAME question (question-scoped
   * — never another question's history), oldest first. Needed so the
   * verifier can judge whether THIS candidate, combined with what was
   * already approved, now substantially completes the assessed response
   * for an open-response question — a judgment that requires seeing the
   * actual prior content, not just a count/score. Empty for a question's
   * first interaction.
   */
  priorApprovedResponses: string[];
};

export type BrainstormVerifierResult = {
  allowed: boolean;
  riskScore: number;
  riskCodes: RiskCode[];
  reason: string;
};

/** `category` defaults to "UNKNOWN" only for the handful of call sites that construct this error directly in tests — every real throw site below always supplies a real classification. */
export class AiAssistanceVerificationError extends Error {
  readonly category: AiProviderErrorCategory;
  constructor(message: string, category: AiProviderErrorCategory = "UNKNOWN") {
    super(message);
    this.category = category;
  }
}

export type FastVerifierDecision =
  | { kind: "REJECT"; result: BrainstormVerifierResult }
  | { kind: "DEFER" };

const DIRECT_ANSWER_PATTERNS = [
  // Concept-explanation quality follow-up — the optional "to this/the
  // question" clause was added after finding "The answer to this
  // question is @decorator." slipped past this pattern (it required
  // "answer" to be immediately followed by "is", with nothing in
  // between) — a real gap in the direct-answer fast-check, not a
  // weakening: still requires the same qualifier+answer+is structure.
  // Architectural simplification follow-up — also allow an optional
  // "full/complete/whole" between the qualifier and "answer", found
  // missing "Yes, your full answer is correct." (a confirmation of a
  // stated final answer).
  /\b(?:the|your|correct|final)\s+(?:full\s+|complete\s+|whole\s+)?answer(?:\s+to\s+(?:this|the)\s+question)?\s+(?:is|would be|should be)\b/i,
  /\b(?:therefore|thus|hence)\s+(?:the\s+)?(?:answer|result)\s+(?:is|=)\b/i,
  /\b(?:the\s+)?correct\s+(?:option|choice)\s+(?:is|would be)\b/i,
  /\byou\s+should\s+(?:choose|select|answer)\b/i,
  // Architectural simplification follow-up — "The output is [1, 2, 3,
  // 4]." names a computed VALUE, not a general concept, so it's a
  // direct-answer disclosure like the others above. Deliberately narrow:
  // only fires when "output/result is" is immediately followed by
  // something that reads as a literal value (bracket/brace/quote/digit/
  // minus sign) — "the output is a tuple" (explaining a TYPE, not a
  // value) must still defer to the semantic verifier, not be
  // deterministically rejected here.
  /\bthe\s+(?:output|result)\s+is\s*[[{('"-]|\bthe\s+(?:output|result)\s+is\s+\d/i,
];

const OPTION_DISCLOSURE_PATTERNS = [
  /\b(?:option|choice)\s*[A-Z0-9]\s+(?:is|looks|seems|would be)\s+(?:correct|right|best)\b/i,
  /\b(?:eliminate|rule out)\s+(?:option|choice)\s*[A-Z0-9]\b/i,
  // Architectural simplification follow-up — "Yes, B is correct." names
  // the option letter directly without the word "option"/"choice",
  // which the two patterns above require. MCQ-only (see
  // fastVerifyBrainstormResponse's questionType guard), and requires an
  // uppercase single letter (conventional MCQ option style) to avoid
  // matching ordinary lowercase words.
  /\b[A-D]\s+is\s+correct\b/,
];

const CODE_DISCLOSURE_PATTERNS = [
  /```[\s\S]*```/,
  /(?:^|\n)\s*(?:def|function|class)\s+\w+/i,
  /(?:^|\n)\s*(?:return|console\.log|print)\s*\(/i,
];


function normaliseForComparison(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.+-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function leaksHiddenReference(candidate: string, hiddenReference?: string | null): boolean {
  if (!hiddenReference) return false;

  const candidateNormalised = normaliseForComparison(candidate);
  const hiddenNormalised = normaliseForComparison(hiddenReference);

  if (hiddenNormalised.length >= 4 && candidateNormalised.includes(hiddenNormalised)) {
    return true;
  }

  const hiddenNumbers = hiddenNormalised.match(/[-+]?\d+(?:\.\d+)?/g) ?? [];
  return (
    hiddenNumbers.length > 0 &&
    /\b(?:answer|result|equals?|gives?|therefore|thus|hence)\b/i.test(candidate) &&
    hiddenNumbers.some((value) => candidateNormalised.includes(value))
  );
}

/**
 * Fast deterministic first stage for the independent verifier.
 *
 * It is deliberately asymmetric:
 * - obvious leakage is rejected immediately;
 * - only a narrow class of short, question-led Socratic hints is approved locally;
 * - everything else defers to the existing independent Anthropic verifier.
 *
 * This removes the second remote model call from clearly-safe first/second hints
 * without making uncertain semantic cases fail open.
 */
export function fastVerifyBrainstormResponse(input: BrainstormVerifierInput): FastVerifierDecision {
  const candidate = input.candidateResponse.trim();

  if (
    DIRECT_ANSWER_PATTERNS.some((pattern) => pattern.test(candidate)) ||
    leaksHiddenReference(candidate, input.hiddenModelAnswer)
  ) {
    return {
      kind: "REJECT",
      result: {
        allowed: false,
        riskScore: 0.95,
        riskCodes: ["DIRECT_ANSWER"],
        reason: "Deterministic guard detected direct-answer or hidden-answer disclosure.",
      },
    };
  }

  if (
    input.questionType === "MULTIPLE_CHOICE" &&
    OPTION_DISCLOSURE_PATTERNS.some((pattern) => pattern.test(candidate))
  ) {
    return {
      kind: "REJECT",
      result: {
        allowed: false,
        riskScore: 0.95,
        riskCodes: ["CORRECT_OPTION_DISCLOSED"],
        reason: "Deterministic guard detected option-specific guidance.",
      },
    };
  }

  if (CODE_DISCLOSURE_PATTERNS.some((pattern) => pattern.test(candidate))) {
    return {
      kind: "REJECT",
      result: {
        allowed: false,
        riskScore: 0.9,
        riskCodes: ["COMPLETE_CODE"],
        reason: "Deterministic guard detected code-like answer content.",
      },
    };
  }

  // Deterministic checks are fail-closed only: they may reject obvious
  // leakage immediately, but they NEVER approve a response for display.
  // Every candidate that is not rejected here still goes through the
  // independent semantic verifier below.
  return { kind: "DEFER" };
}

/**
 * Architectural simplification follow-up — `reason` deliberately has NO
 * upper bound in the model-facing schema. It is an internal audit note
 * (never shown to the student), and a long-but-valid safety
 * justification must never itself invalidate an otherwise-correct
 * verdict — a prior version capped this at 400 chars, which meant a
 * verbose (but entirely valid) `reason` string failed schema validation
 * and the WHOLE interaction fell to the deterministic fallback, even
 * when the model's `allowed` judgment was itself correct. Length is
 * enforced separately, AFTER parsing succeeds — see
 * MAX_VERIFIER_REASON_CHARACTERS below and its use in
 * verifyBrainstormResponse.
 */
const verifierResultSchema = z.object({
  allowed: z.boolean(),
  riskScore: z.number().min(0).max(1),
  riskCodes: z.array(z.enum(RISK_CODES)),
  reason: z.string().min(1),
});

/** Applied only AFTER a verdict has already parsed and validated successfully — never part of the parse/validate step itself (see verifierResultSchema's own doc comment). */
export const MAX_VERIFIER_REASON_CHARACTERS = 400;

/**
 * Architectural simplification follow-up — replaces the prior broad,
 * accumulated "too specific / excessive detail / relevance" style
 * judgment with a single narrow question. Four successive rounds of
 * patches each added another carve-out to that broader framing, and
 * repeated live Preview testing kept finding new false-positive
 * rejections of genuinely safe teaching content — evidence that the
 * broader framing itself, not any one missing carve-out, was the
 * problem. This prompt asks ONLY whether the candidate discloses,
 * confirms, or completes the graded final answer; teaching content is
 * categorically safe regardless of how detailed or how relevant to the
 * active question it is.
 *
 * Grounded-cumulative-safety follow-up — a live false positive (focused
 * "what is a tuple" / "what is a list" / "what is the difference"
 * teaching wrongly suppressed) exposed that Check 2 (the cumulative
 * question below) needs a real answer to "what does the active question
 * require" — and that answer must come from the actual assessment
 * context (the question's own wording, or lecturer-authored/-approved
 * hidden reference material), never from the model's own general
 * subject-matter knowledge invented as an unstated rubric. See the
 * "WHAT THE ACTIVE QUESTION ACTUALLY REQUIRES" section below — this is
 * the grounding hierarchy the whole exercise converged on. Check 1 does
 * not need this grounding: it judges the candidate purely against the
 * literal question text, which is always available.
 */
function buildSystemPrompt(): string {
  return [
    "You are a strict, independent safety verifier for an exam brainstorming assistant — a restricted tutor. You do not generate help yourself — you only judge whether a CANDIDATE RESPONSE, already drafted by another system, is safe to show a student during a live exam.",
    "",
    "Ask exactly ONE question: does this candidate response STATE, CONFIRM, TRIVIALLY IMPLY, or PROVIDE A SUBMISSION-READY VERSION of the graded final answer for the ACTIVE question? That is the only thing that makes a response unsafe. Call this \"Check 1\".",
    "",
    "A response is UNSAFE (allowed=false) only if it does ANY of the following:",
    // MCQ semantic-verifier calibration follow-up — "gets the student all
    // the way there" was ambiguous between "the candidate itself reaches
    // the graded result" (correct reading) and "the candidate gives the
    // student enough that THEY could now reach it" (an over-broad
    // reading that a semantic model can plausibly apply to good
    // teaching). Live Preview testing found substantive, general concept
    // teaching for an MCQ rejected as DIRECT_ANSWER — this bullet is the
    // most direct textual source of that ambiguity. Narrowed to name
    // what actually makes it unsafe (the CANDIDATE doing the reasoning/
    // computation, not the student), and to say explicitly that teaching
    // a general rule/method the student must still apply is not this,
    // even when it gives the student everything they need.
    "- states or clearly implies the correct final answer, or does the reasoning/computation FOR the student such that the graded result is reached without the student applying anything themselves (DIRECT_ANSWER / NEAR_COMPLETE_ANSWER) — teaching the general rule, method, or mechanism the student must still apply is NOT this, even when it gives the student everything they need to work out the result on their own",
    "- states, confirms, ranks, or eliminates the correct multiple-choice option (CORRECT_OPTION_DISCLOSED / OPTION_ELIMINATION)",
    "- gives the final numeric result, or performs the last substitution/computation step for the student (FINAL_NUMERIC_RESULT)",
    "- is a complete, submission-ready essay/prose response the student could paste directly as their final answer (SUBMISSION_READY_PROSE)",
    "- is complete, working code that directly answers the assessed question (COMPLETE_CODE)",
    "- discloses or paraphrases the rubric/marking scheme/model answer text you were given as hidden reference material (HIDDEN_RUBRIC_DISCLOSURE)",
    "",
    "Check 1 is a HOLISTIC judgment on the candidate's CONTENT AS WRITTEN: if this exact text, with only trivial editing or reformatting, were submitted as the student's answer, would it already substantially satisfy the active question? Judge this purely on substance. It does NOT matter whether the facts in it are newly stated here or were already taught earlier in this conversation, whether it uses comparative words like \"while\"/\"whereas\", how many bullets or sentences it has, or whether it repeats terminology from the question — a candidate that packages enough assessed content to be substantially submission-ready is unsafe even if every individual fact in it was separately safe on its own, and even if none of the wording is new.",
    "",
    "TEACHING CONTENT IS SAFE, EVEN WHEN HIGHLY RELEVANT TO THE ACTIVE QUESTION. Relevance to the question is NEVER by itself a reason to reject. All of the following are SAFE, including when the active question is directly about them:",
    '- "*args collects extra positional arguments into a tuple, while **kwargs collects extra keyword arguments into a dictionary."',
    '- "x is a list because square brackets create a list."',
    '- "append() mutates an existing list in place."',
    '- "A list is mutable while a tuple is immutable."',
    '- "A decorator is a callable that wraps another function to modify or extend its behaviour."',
    '- "Classification predicts categories, while regression predicts numeric values."',
    "Contrast with what actually IS unsafe — resolving the active question itself, not merely teaching its subject matter:",
    '- "The correct option is B."',
    "- \"The output is (1, 2, (3, 4), {'x': 10}).\"",
    '- "The answer is def."',
    '- "Yes, B is correct." / "Yes, your final answer is correct."',
    '- "Lists are mutable. They use square brackets. They are useful for changing collections. Tuples are immutable. They use parentheses. They are useful for fixed collections." — even though every individual fact here is separately safe, THIS single candidate packages essentially the whole comparison at once, so it is unsafe (SUBMISSION_READY_COMPLETION) regardless of whether any of it was said before.',
    "",
    "For an open-response question (essay/short-answer), teaching and substantial explanation are SAFE — reject only when the candidate becomes a complete, submission-ready version of the student's final assessed response, never merely because it is thorough or detailed.",
    "",
    // MCQ semantic-verifier calibration follow-up — Check 1's holistic
    // "would this substantially satisfy the active question" framing was
    // written for open-response questions, where "satisfying the
    // question" and "assembling the required content" are the same
    // thing. For MULTIPLE_CHOICE there is no partial "submission" other
    // than the option itself, so applying that SAME holistic test lets
    // a semantic model collapse "does this candidate substantially help
    // the student solve it" into "does this candidate disclose the
    // answer" — exactly the false positive found in Preview testing
    // (a general *args/**kwargs explanation rejected as DIRECT_ANSWER).
    // This makes Check 1's MCQ meaning explicit and DIFFERENT from its
    // open-response meaning, rather than one wording doing both jobs.
    "=== MULTIPLE_CHOICE — CHECK 1 IS NARROWER THAN FOR OPEN-RESPONSE QUESTIONS ===",
    "For a MULTIPLE_CHOICE question, Check 1 is NOT 'would this content substantially help or explain enough that a competent student could work out the option' — that is exactly what Brainstorm is FOR, and is never itself unsafe. Check 1 for MULTIPLE_CHOICE asks a narrower, different question: does this candidate STATE, CONFIRM, or MAKE TRIVIAL the correct option or the exact graded result FOR THIS ASSESSED INSTANCE?",
    "The governing distinction: Tether may TEACH THE RULE — terminology, syntax, language semantics, relevant concepts, intermediate mechanics, misconception correction, analogous examples, how to reason through the options, what a construct means, how a general rule or algorithm works — even when that teaching is highly relevant and gives the student everything they need to work out the option themselves. Tether may NOT APPLY THE RULE ALL THE WAY TO THE GRADED RESULT for the specific assessed instance — perform the actual substitution/binding/computation for this exact question, state the correct option or exact final result/output that trivially identifies it, or confirm a student's proposed option/result.",
    "MCQ OPTION-TRIVIALIZATION: a candidate does not need to name an option letter to be unsafe. If it states the one decisive fact that, given the ACTUAL options shown for this question, leaves only one of them possible, that is CORRECT_OPTION_DISCLOSED even without naming the option — judge this against the real options for this question, not against the concept in the abstract.",
    "MCQ worked examples:",
    '- SAFE (general rule): "*args collects extra positional arguments into a tuple, and **kwargs collects extra keyword arguments into a dictionary." Safe even when the active question asks to trace a specific function call, because it teaches the mechanism, not this call\'s actual values.',
    '- SAFE (describes the reasoning to do, not its result): "The question is asking you to trace how each argument is assigned to the function parameters and then reason about the structure that gets returned."',
    '- UNSAFE (applies the rule to this instance): "`a` is 1, `b` is 2, `args` is (3, 4), and `kwargs` is {\'x\': 10}." — this performs the actual binding for the SPECIFIC assessed call, which trivially yields the printed result; unsafe even though it never uses the word "answer".',
    '- UNSAFE: "The output is (1, 2, (3, 4), {\'x\': 10})."',
    '- SAFE (general rule): "Merge sort repeatedly divides the collection in half and merges the sorted halves back together." — for "Which sorting algorithm has O(n log n) average complexity?"; teaches how merge sort works without presenting it as the answer to pick.',
    '- UNSAFE: "The correct option is merge sort."',
    '- SAFE for "Which collection is immutable?" (options: list, set, tuple, dictionary): "Immutable means an object cannot be changed after creation." / "Think about which collection types permit item replacement or append-like mutation." Both teach the concept without resolving which option it applies to.',
    '- UNSAFE for that same question: "A tuple is immutable; lists, sets, and dictionaries are mutable." — this names the deciding property for EVERY option shown, not just what "immutable" means, so it is option-trivialization (CORRECT_OPTION_DISCLOSED) even though no option letter is stated.',
    '- Context-dependent: "HTTPS is the encrypted form of HTTP and normally uses TLS." is a SAFE general fact on its own, but for "Which protocol uses port 443?" judge it against the actual options shown — if HTTPS is one of the displayed options and stating this fact leaves no other option plausible, it is option-trivialization exactly like the immutability case above.',
    "",
    "=== WHAT THE ACTIVE QUESTION ACTUALLY REQUIRES ===",
    "Both Check 1 above and Check 2 below ultimately depend on knowing what would 'substantially satisfy' or 'substantially complete' the active question. Ground that judgment using this strict priority order. Tether must never invent an unstated marking rubric from its own general subject knowledge:",
    "LEVEL 1 (highest confidence): explicit requirements literally stated in the question's own text — for example the question names specific dimensions, parts, or an exact number of points to cover. Reason directly against these.",
    "LEVEL 2: a hidden model answer / marking guidance, when it is supplied to you below as hidden reference material. This is lecturer-authored or lecturer-approved, so it may ground what the answer needs to cover — but treat it as strong guidance, not necessarily an exhaustive list of every valid point, and never require the candidate to match its exact wording, only its substance. Never quote or closely paraphrase it in your reason field.",
    "LEVEL 3: if the question names no explicit requirements AND no hidden model answer/guidance is supplied below, there is NO grounded rubric available. Do not silently decide the topic has some fixed number of 'canonical' comparison dimensions or required parts from your own subject knowledge — that is exactly the invented-rubric failure this policy exists to prevent. Instead, judge only whether the accumulated approved guidance, read as a whole in ordinary terms, ALREADY AND CLEARLY reads as a substantially complete answer to the LITERAL question text — not whether it happens to cover topics you personally know are commonly discussed for this subject. If it is genuinely unclear whether the literal question has been substantially answered, do not reject at Level 3 merely because a fuller answer is imaginable.",
    "Level 1 (the question's own literal wording) always outranks Level 2 if the two ever seem to disagree.",
    "",
    // Cumulative answer-assembly follow-up — a SECOND, narrower safety
    // question for SHORT_ANSWER/ESSAY only. Deliberately NOT a return to
    // the removed "is this too specific/detailed" framing — that broad
    // question caused useful single-concept teaching to be rejected and
    // must never come back. This one only asks whether the substantive
    // CONTENT the question requires — grounded per the hierarchy above —
    // has now been assembled, whether in one message or spread across
    // several approved ones. Never applies to MULTIPLE_CHOICE, whose own
    // disclosure/option boundary above is unchanged and is never
    // replaced or weakened by this second check.
    "For SHORT_ANSWER and ESSAY questions specifically (never for MULTIPLE_CHOICE — that keeps only the disclosure/confirmation boundary above, unchanged and never replaced by what follows), ask a SECOND question (\"Check 2\"): considering this candidate TOGETHER WITH the prior approved guidance already given for this SAME question (listed below, if any), has the assistant now cumulatively supplied enough GROUNDED assessed content — judged using the LEVEL 1/2/3 priority above — that the student effectively has a substantially complete answer, needing only trivial editing to submit? If yes, this is unsafe: SUBMISSION_READY_COMPLETION if this candidate alone does it, CUMULATIVE_RESPONSE_COMPLETION if it only crosses that line combined with the prior approved guidance.",
    "This is NOT the same as 'too detailed' or 'too specific' — teach or address ONE concept, ONE definition, ONE misconception, or ONE reasoning direction at a time, as thoroughly as is useful; that is SAFE even on a question's very first interaction, and learning multiple individual concepts separately across turns is not itself prohibited. It becomes unsafe only when the accumulated content — this response plus every prior approved one for this same question — substantially assembles what the question is GROUNDED to require (Level 1/2), or, at Level 3, clearly and substantially answers the literal question as a whole — never merely because several individually-safe facts happen to relate to the same topic, and never merely because you can imagine a canonical set of topics a typical answer 'should' cover.",
    "For SHORT_ANSWER questions the grounded expected answer is often very small (sometimes just 1-3 points), so when Level 1 or Level 2 grounding is available, treat completion conservatively — two or three combined grounded points may already be most of the expected answer. When there is no Level 1/2 grounding for a SHORT_ANSWER question, still apply the cautious Level 3 test above rather than inventing a checklist; a focused definition remains teachable. For ESSAY questions, explaining any SINGLE required point in depth remains safe — one concept, one argument, one counterargument, or an explanation of one term is fine — but the accumulated guidance must never include a complete thesis, a complete structure, AND fully-worked arguments for more than one required point in submission-ready form; do not assume grounded marking guidance excludes every legitimate alternative argument unless the question or guidance itself says so. This applies equally to code (do not let the accumulated guidance progressively assemble into the complete solution) and mathematical derivations (do not let it carry the calculation all the way to the final result).",
    "",
    "=== WORKED EXAMPLES (question: \"Explain the difference between a list and a tuple in Python\", unless noted otherwise) ===",
    'A. Bare concept teaching, no comparison yet. Prior: "A tuple is an ordered collection." Candidate: "A list is an ordered collection." → ALLOW. Neither fact, alone or together, answers what makes them DIFFERENT.',
    'B. One established difference, broad open question, no grounding (no explicit dimensions named, no hidden model answer supplied). Prior: "A tuple is immutable." Candidate: "A list is mutable." → ALLOW. These two facts together establish one real distinction, but for a broad, ungrounded "explain the difference" question, one distinction is not yet clearly a complete answer — do not reject merely because mutability is a commonly-cited comparison point for this topic.',
    'C. Same facts, narrow grounded question: "State ONE difference between a list and a tuple." Same prior/candidate as B. → Check 2 MAY REJECT (CUMULATIVE_RESPONSE_COMPLETION): the question\'s own literal wording (Level 1 — it explicitly asks for exactly one difference) means this one established distinction now substantially supplies the entire requested answer.',
    'D. Explicit grounded requirements (Level 1): "Compare lists and tuples in terms of mutability, syntax and typical use cases." History already supplies mutability + syntax. Candidate supplies the final use-case distinction. → REJECT (CUMULATIVE_RESPONSE_COMPLETION) — grounded directly in the question\'s own literal wording, not inferred from subject knowledge.',
    "E. Same facts, ungrounded open question (Level 3): \"Explain the difference between a list and a tuple.\" No hidden model answer. Same history/candidate as D (mutability + syntax already established, candidate adds use-case). → Do NOT reject merely because mutability/syntax/use-case are common comparison dimensions you happen to know for this topic — that would be inventing a rubric. Only reject if the accumulated transcript, read as a whole, already and clearly reads as a substantially complete treatment of the literal question — more of these established facts accumulating makes that more likely to be true, but it is a matter of degree, not a fixed count of dimensions.",
    'F. Reassembly without new facts. Candidate: "Lists are mutable and use square brackets. Tuples are immutable and use parentheses." If this candidate ALONE already substantially answers the assessed question → REJECT under CHECK 1 (SUBMISSION_READY_COMPLETION), regardless of whether every individual fact in it was already approved earlier — Check 1 never requires novelty.',
    'G. Safe redirect. "Use the facts you\'ve already established and compare one feature at a time in your own response." → ALLOW. This asks the student to do the synthesis themselves; it does not itself supply or assemble the comparison.',
    "",
    "A candidate that corrects a student's mistaken claim (for example \"Not quite — a tuple is not a row\") or acknowledges the student is looking in the right area, WITHOUT stating the actual final answer/option/result, is SAFE. A candidate that answers \"yes\"/\"correct\"/\"that's right\" (or equivalent agreement) to a student's own fully-stated final answer, option, or result IS unsafe, even when phrased as agreement rather than a fresh statement.",
    "",
    "Judge ONLY the candidate response text — never the student's own request wording. A student's request may legitimately contain words like \"answer\", \"solve\", \"result\", or \"help\" while asking for guidance or method, not disclosure.",
    "If it is genuinely unclear whether the candidate DISCLOSES or CONFIRMS the final answer (Check 1), prefer allowed=true with a moderately higher riskScore over an outright rejection. This preference does NOT extend to Level 3 cumulative-completion uncertainty under Check 2 — there, being unsure what an unstated rubric might contain is not evidence that the answer has been completed, so the default in that specific situation is to ALLOW (see Level 3 above), never to reject out of caution about an invented structure.",
    "",
    "The student's current request has a MODE (given below) that calibrates how the candidate is likely framed — it never changes whether the disclosure/completion rules above apply:",
    "- CONCEPT_EXPLANATION: a focused explanation of the requested concept is presumptively legitimate; reject only if it actually crosses the completion/disclosure boundaries above.",
    "- MISCONCEPTION_CHECK: a focused correction of a misconception is expected and safe; it should not expand into a full answer.",
    "- GUIDING_QUESTION: normally safe unless the guiding question itself effectively reveals the answer.",
    "- APPROACH_GUIDANCE: one reasoning direction is expected; assembled required content is not.",
    "- ANSWER_CONFIRMATION: keep the strict confirmation protection above — do not confirm or deny a stated final answer.",
    "- GENERIC_HELP: useful direction is expected; answer assembly is not.",
    "",
    "You ARE given the hidden model answer and/or rubric summary (when available) purely so you can judge disclosure and grounded completion accurately — never quote them back in your reason field. Merely sharing WORDS or CONCEPTS with the hidden model answer is not itself disclosure — e.g. if the hidden answer contains a tuple or a dictionary, explaining that '*args produces a tuple' or '**kwargs produces a dictionary' is teaching a prerequisite concept, not disclosing the answer. Only flag HIDDEN_RUBRIC_DISCLOSURE when the candidate states the actual answer/result itself or a meaningfully equivalent restatement of it — not when it merely uses a term or concept that also happens to appear within it.",
    "",
    "Respond with ONLY a JSON object — no markdown, no preamble:",
    '{ "allowed": boolean, "riskScore": number (0-1), "riskCodes": string[], "reason": string }',
    "riskCodes must only use these exact values: " + RISK_CODES.join(", "),
    "riskScore reflects how close the response comes to violating the rule even when allowed=true (0 = completely safe, 1 = essentially the answer).",
    "reason is a short internal note for audit logs — never quote the hidden model answer/rubric in it, and never write anything intended to be shown to the student.",
  ].join("\n");
}

function buildUserPrompt(input: BrainstormVerifierInput): string {
  const lines = [
    `Question type: ${input.questionType}`,
    `Question: ${input.questionText}`,
    `Request mode (calibration only — see system prompt; never a safety bypass): ${input.requestMode}`,
    `Student's request: ${input.studentRequest}`,
    `Candidate response to judge: ${input.candidateResponse}`,
    `Hints already approved for this question: ${input.priorApprovedHintCount}`,
    `Cumulative risk score already accumulated for this question: ${input.cumulativeRiskScoreSoFar.toFixed(2)}`,
  ];
  // Cumulative answer-assembly follow-up — the ACTUAL prior approved
  // response text for this same question (question-scoped — never
  // another question's), so the verifier can judge whether this
  // candidate, combined with what was already approved, now assembles
  // the substantive content the question requires. Only meaningful for
  // SHORT_ANSWER/ESSAY (see buildSystemPrompt), but included whenever
  // present — the verifier is instructed to ignore it for MULTIPLE_CHOICE.
  if (input.priorApprovedResponses.length > 0) {
    lines.push("", "Prior approved responses for this SAME question, oldest first (for judging cumulative completion only):");
    input.priorApprovedResponses.forEach((response, index) => {
      lines.push(`${index + 1}. ${response}`);
    });
  }
  // Bounded even though the runner already bounds these before calling
  // in (Part 9) — defense in depth against a future call site that
  // forgets to.
  const hiddenModelAnswer = boundedHiddenReference(input.hiddenModelAnswer);
  const hiddenRubricSummary = boundedHiddenReference(input.hiddenRubricSummary);
  if (hiddenModelAnswer) {
    lines.push(`Hidden model answer (reference only — never disclose): ${hiddenModelAnswer}`);
  }
  if (hiddenRubricSummary) {
    lines.push(`Hidden rubric summary (reference only — never disclose): ${hiddenRubricSummary}`);
  }
  return lines.join("\n");
}

function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

let cachedClient: Anthropic | undefined;

/** Bounded request timeout and retry count (Part 10 hardening) — see the matching constants in aiAssistanceGenerator.ts. */
export const ANTHROPIC_TIMEOUT_MS = 20_000;
/** Intermittent-failure follow-up — see the identical note on aiAssistanceGenerator.ts's own ANTHROPIC_MAX_RETRIES. */
export const ANTHROPIC_MAX_RETRIES = 0;
/** Intermittent-failure follow-up — see the identical note on aiAssistanceGenerator.ts's own AI_ASSISTANCE_GENERATOR_MAX_ATTEMPTS. */
export const AI_ASSISTANCE_VERIFIER_MAX_ATTEMPTS = 3;

/**
 * Independent verifier model. The generator can use Sonnet while the
 * safety-screening call uses the lower-latency Haiku model.
 */
export const ANTHROPIC_BRAINSTORM_VERIFIER_MODEL_DEFAULT = "claude-haiku-4-5-20251001";

export function getAnthropicBrainstormVerifierModel(): string {
  return (
    process.env.ANTHROPIC_BRAINSTORM_VERIFIER_MODEL?.trim() ||
    ANTHROPIC_BRAINSTORM_VERIFIER_MODEL_DEFAULT
  );
}

function getClient(): Anthropic {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new AiAssistanceVerificationError("Missing required environment variable: ANTHROPIC_API_KEY", "CONFIG_MISSING");
  }
  cachedClient = new Anthropic({ apiKey, timeout: ANTHROPIC_TIMEOUT_MS, maxRetries: ANTHROPIC_MAX_RETRIES });
  return cachedClient;
}

/**
 * Optional diagnostics hook (intermittent-failure follow-up) — see the
 * identical GenerateBrainstormDiagnostics in aiAssistanceGenerator.ts.
 */
export type VerifyBrainstormDiagnostics = { onAttempt?: (log: ProviderCallAttemptLog) => void };

export async function verifyBrainstormResponse(
  input: BrainstormVerifierInput,
  diagnostics?: VerifyBrainstormDiagnostics,
): Promise<BrainstormVerifierResult> {
  const fastDecision = fastVerifyBrainstormResponse(input);
  if (fastDecision.kind === "REJECT") {
    return fastDecision.result;
  }

  const client = getClient();

  let response;
  try {
    response = await callWithTransientRetry(
      () =>
        client.messages.create({
          model: getAnthropicBrainstormVerifierModel(),
          max_tokens: 220,
          temperature: 0,
          system: buildSystemPrompt(),
          messages: [{ role: "user", content: buildUserPrompt(input) }],
        }),
      { maxAttempts: AI_ASSISTANCE_VERIFIER_MAX_ATTEMPTS, onAttempt: diagnostics?.onAttempt },
    );
  } catch (err) {
    // Never include the caught error's own message — see the identical
    // note in aiAssistanceGenerator.ts. A verifier failure is at least
    // as sensitive to sanitise as a generator one, since the SDK error
    // could in principle echo back request content — the classification
    // category alone (never the message) is safe to log/persist.
    throw new AiAssistanceVerificationError("Anthropic API request failed", classifyProviderError(err));
  }

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new AiAssistanceVerificationError("Anthropic response did not contain a text block", "PARSE_ERROR");
  }

  const cleaned = stripMarkdownFences(textBlock.text);

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(cleaned);
  } catch {
    // Do not include the raw model text or the parser's own message —
    // both could contain a snippet of the (potentially unsafe) candidate
    // content the verifier was judging.
    throw new AiAssistanceVerificationError("Failed to parse verifier output as JSON", "PARSE_ERROR");
  }

  // Also structurally rejects an unknown/invented risk code (Part 1 —
  // "the verifier returns an unknown risk code") via the z.enum(RISK_CODES)
  // array element schema: any code outside the fixed RISK_CODES list
  // fails validation here exactly like any other malformed payload, so
  // it hits the same fail-closed path rather than being silently
  // accepted or crashing later.
  const validated = verifierResultSchema.safeParse(parsedJson);
  if (!validated.success) {
    throw new AiAssistanceVerificationError("Verifier output did not match the expected schema", "SCHEMA_ERROR");
  }

  // Truncate ONLY here, after a successful parse+validate — never as
  // part of the schema itself (see verifierResultSchema's doc comment).
  // A long-but-valid `reason` must never invalidate the verdict it
  // belongs to; this only bounds what gets persisted/logged afterward.
  return {
    ...validated.data,
    reason:
      validated.data.reason.length > MAX_VERIFIER_REASON_CHARACTERS
        ? validated.data.reason.slice(0, MAX_VERIFIER_REASON_CHARACTERS)
        : validated.data.reason,
  };
}
