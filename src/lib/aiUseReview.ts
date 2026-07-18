/**
 * AI-Use Answer Review v1 — see docs/ai-use-answer-review-v1.md.
 *
 * Pure, dependency-free, deterministic analysis engine: no Prisma, no
 * Next.js, no browser APIs, no LLM client, no network — mirrors the
 * separation used by src/lib/answerSimilarity.ts (pure engine) vs.
 * src/lib/aiUseReviewRunner.ts (server-only DB/AI orchestration).
 *
 * THIS IS NOT AN AI DETECTOR. Every function here produces an
 * explainable REVIEW SIGNAL about an observable characteristic of an
 * answer — never a claim that the answer was written by AI, never an
 * automatic misconduct finding, never a grade input. The lecturer or
 * institution makes the final decision. See the required/banned wording
 * lists below.
 */

import { normalizeAnswerText, tokenizeNormalized } from "@/lib/answerSimilarity";

// ---------------------------------------------------------------------------
// Validated string values (schema stores plain strings — see
// AiUseReviewAnalysis/AiUseReviewSignal in prisma/schema.prisma).
// ---------------------------------------------------------------------------

export const AI_USE_REVIEW_ALGORITHM_VERSION = "v1.0";

export const ANALYSIS_STATUSES = ["PENDING", "PROCESSING", "COMPLETE", "FAILED", "NOT_CONFIGURED"] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

export const SIGNAL_LEVELS = ["NONE", "LOW", "MEDIUM", "HIGH"] as const;
export type SignalLevel = (typeof SIGNAL_LEVELS)[number];

export const SIGNAL_TYPES = [
  "WEAK_SCENARIO_GROUNDING",
  "GENERIC_RESPONSE",
  "STYLE_INCONSISTENCY",
  "UNSUPPORTED_SPECIFIC_CLAIMS",
  "REQUIRED_CONCEPTS_MISSING",
  "POLISHED_BUT_SHALLOW_RESPONSE",
  "GENERATED_RESPONSE_META_LANGUAGE",
] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number];

export function isValidSignalType(value: string): value is SignalType {
  return (SIGNAL_TYPES as readonly string[]).includes(value);
}

export const REVIEW_STATUSES = [
  "NEEDS_REVIEW",
  "REVIEWED_NO_CONCERN",
  "REVIEWED_CONCERN_REMAINS",
  "ESCALATED",
  "RESOLVED",
] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export function isValidReviewStatus(value: string): value is ReviewStatus {
  return (REVIEW_STATUSES as readonly string[]).includes(value);
}

export const RECOMMENDATIONS = [
  "NO_IMMEDIATE_ACTION",
  "LECTURER_REVIEW_RECOMMENDED",
  "ORAL_VERIFICATION_RECOMMENDED",
] as const;
export type AiUseReviewRecommendation = (typeof RECOMMENDATIONS)[number];

/** Required neutral wording — see docs/ai-use-answer-review-v1.md. Never "AI detected" / "cheating detected" / "guilty". */
export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  NEEDS_REVIEW: "Lecturer review recommended",
  REVIEWED_NO_CONCERN: "Reviewed — no concern",
  REVIEWED_CONCERN_REMAINS: "Concern remains",
  ESCALATED: "Escalated",
  RESOLVED: "Resolved",
};

export const RECOMMENDATION_LABELS: Record<AiUseReviewRecommendation, string> = {
  NO_IMMEDIATE_ACTION: "No immediate action",
  LECTURER_REVIEW_RECOMMENDED: "Lecturer review recommended",
  ORAL_VERIFICATION_RECOMMENDED: "Oral verification recommended",
};

/** Per-signal-type headline shown on a signal card. Required wording only. */
export const SIGNAL_TYPE_HEADLINES: Record<SignalType, string> = {
  WEAK_SCENARIO_GROUNDING: "AI-use review signal",
  GENERIC_RESPONSE: "AI-use review signal",
  STYLE_INCONSISTENCY: "Writing consistency concern",
  UNSUPPORTED_SPECIFIC_CLAIMS: "AI-use review signal",
  REQUIRED_CONCEPTS_MISSING: "Response grounding concern",
  POLISHED_BUT_SHALLOW_RESPONSE: "AI-use review signal",
  GENERATED_RESPONSE_META_LANGUAGE: "Generated-response artefact review recommended",
};

export const SIGNAL_TYPE_LABELS: Record<SignalType, string> = {
  WEAK_SCENARIO_GROUNDING: "Weak scenario grounding",
  GENERIC_RESPONSE: "Generic response",
  STYLE_INCONSISTENCY: "Writing style inconsistency",
  UNSUPPORTED_SPECIFIC_CLAIMS: "Unsupported specific claims",
  REQUIRED_CONCEPTS_MISSING: "Required concepts missing",
  POLISHED_BUT_SHALLOW_RESPONSE: "Polished but shallow response",
  GENERATED_RESPONSE_META_LANGUAGE: "Generated-response artefact",
};

// ---------------------------------------------------------------------------
// Banned wording guard — used to sanitise optional AI-assisted output
// before it is ever persisted or shown to a lecturer (Part 7/13).
// ---------------------------------------------------------------------------

const BANNED_WORDING_PATTERNS: RegExp[] = [
  /ai[- ]generated answer/i,
  /ai detected/i,
  /written by chatgpt/i,
  /student used ai/i,
  /cheating detected/i,
  /proof of ai use/i,
  /ai probability/i,
  /\bguilty\b/i,
  /misconduct confirmed/i,
  /\d{1,3}\s?%\s*(chance|probability|likelihood)\s*(of\s*)?(ai|generated)/i,
];

/** True if the text contains any banned accusatory/confirmatory wording. */
export function containsBannedWording(text: string): boolean {
  return BANNED_WORDING_PATTERNS.some((p) => p.test(text));
}

// ---------------------------------------------------------------------------
// Shared word lists
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(
  (
    "the a an and or but if then else of to in on at for with from by as is are was were be been being " +
    "this that these those it its they them their there here we you i he she his her not no yes do does " +
    "did done can could should would will shall may might must have has had having about into over under " +
    "between because so such which what when where who whom whose how why more most some any all each very " +
    "also just only than too own same other another my our your us"
  ).split(" "),
);

/** Common sentence-starter / instructional words — never treated as scenario anchors on their own. */
const SENTENCE_STARTER_WORDS = new Set(
  (
    "the a an this that these those explain describe discuss given consider using what how why which who " +
    "when where identify outline summarise summarize analyse analyze evaluate compare calculate state list " +
    "provide apply define justify critically briefly refer answer complete"
  ).split(" "),
);

const MIN_ANCHOR_LENGTH = 2;

// ---------------------------------------------------------------------------
// 4.1 Extract question-specific anchors
// ---------------------------------------------------------------------------

/**
 * Extracts meaningful, question-specific anchors from question text:
 * numbers/currency/percentages, quoted terms, capitalised phrases
 * (organisation/system/person names), and technical tokens (acronyms,
 * hyphenated terms, alphanumeric identifiers). Never includes a hidden
 * correct answer — this only looks at the question text itself, which is
 * already student-visible.
 */
export function extractQuestionAnchors(questionText: string | null | undefined): string[] {
  if (!questionText) return [];
  const anchors = new Set<string>();

  // Numbers, currency, percentages, years — supplied scenario "variables".
  const numberMatches = questionText.match(/\$\d[\d,]*(\.\d+)?|\b\d[\d,]*(\.\d+)?%|\b(19|20)\d{2}\b|\b\d{2,}\b/g) ?? [];
  numberMatches.forEach((m) => anchors.add(m));

  // Quoted terms — explicit required concepts/labels the question calls out.
  const quoted = questionText.match(/["“]([^"”]{2,60})["”]/g) ?? [];
  quoted.forEach((q) => anchors.add(q.replace(/["“”]/g, "").trim()));

  // Capitalised phrases: organisation/person/system names, locations.
  // A lone capitalised word that is also a common sentence-starter/
  // instructional word is excluded (e.g. "Explain", "Given").
  const capPhraseRegex = /\b([A-Z][a-zA-Z0-9&.'-]*(?:\s+[A-Z][a-zA-Z0-9&.'-]*)*)\b/g;
  let match: RegExpExecArray | null;
  while ((match = capPhraseRegex.exec(questionText))) {
    const phrase = match[1].trim();
    const words = phrase.split(/\s+/);
    if (words.length === 1 && SENTENCE_STARTER_WORDS.has(words[0].toLowerCase())) continue;
    if (phrase.length < 3) continue;
    anchors.add(phrase);
  }

  // Technical tokens: acronyms, hyphenated compounds, alphanumeric identifiers.
  const techRegex = /\b([A-Za-z]+-[A-Za-z0-9]+|[A-Z]{2,}\d*|[A-Za-z]+\d+)\b/g;
  while ((match = techRegex.exec(questionText))) {
    anchors.add(match[1]);
  }

  return [...anchors].filter((a) => a.trim().length >= MIN_ANCHOR_LENGTH);
}

// ---------------------------------------------------------------------------
// 4.2 Scenario-grounding score
// ---------------------------------------------------------------------------

export const MIN_QUESTION_ANCHORS_FOR_GROUNDING_CHECK = 2;
export const MIN_ANSWER_WORDS_FOR_GROUNDING_CHECK = 40;
export const WEAK_GROUNDING_MAX_ANCHOR_HIT_RATIO = 0.15;
export const PARTIAL_GROUNDING_MAX_ANCHOR_HIT_RATIO = 0.4;

export type ScenarioGroundingLevel = "grounded" | "partially_grounded" | "weakly_grounded" | "insufficient_evidence";

export type ScenarioGroundingResult = {
  /** False when the question is too broad/short-answer to require scenario grounding — never flag in that case. */
  applicable: boolean;
  level: ScenarioGroundingLevel;
  anchors: string[];
  matchedAnchors: string[];
  anchorHitRatio: number;
  reasonCode: "INSUFFICIENT_EVIDENCE" | "WEAKLY_GROUNDED" | "PARTIALLY_GROUNDED" | "GROUNDED";
  explanation: string;
  evidence: string[];
  limitation: string;
};

/**
 * Compares an answer against the question's own anchors. A weak-grounding
 * result requires a sufficiently specific question (enough anchors), a
 * meaningful-length answer, AND low reference to the supplied anchors —
 * broad theoretical questions with few anchors are never flagged.
 */
export function analyzeScenarioGrounding(
  questionText: string | null | undefined,
  answerText: string | null | undefined,
): ScenarioGroundingResult {
  const anchors = extractQuestionAnchors(questionText);
  const answerWordCount = tokenizeNormalized(normalizeAnswerText(answerText)).length;

  if (anchors.length < MIN_QUESTION_ANCHORS_FOR_GROUNDING_CHECK || answerWordCount < MIN_ANSWER_WORDS_FOR_GROUNDING_CHECK) {
    return {
      applicable: false,
      level: "insufficient_evidence",
      anchors,
      matchedAnchors: [],
      anchorHitRatio: 0,
      reasonCode: "INSUFFICIENT_EVIDENCE",
      explanation:
        "This question does not have enough distinctive scenario details (or the response is too short) for a grounding comparison.",
      evidence: [],
      limitation: "Broad theoretical questions legitimately allow generic answers and are not analysed for grounding.",
    };
  }

  const normalizedAnswer = normalizeAnswerText(answerText);
  const matchedAnchors = anchors.filter((a) => normalizedAnswer.includes(normalizeAnswerText(a)));
  const anchorHitRatio = matchedAnchors.length / anchors.length;

  let level: ScenarioGroundingLevel;
  let reasonCode: ScenarioGroundingResult["reasonCode"];
  if (anchorHitRatio <= WEAK_GROUNDING_MAX_ANCHOR_HIT_RATIO) {
    level = "weakly_grounded";
    reasonCode = "WEAKLY_GROUNDED";
  } else if (anchorHitRatio <= PARTIAL_GROUNDING_MAX_ANCHOR_HIT_RATIO) {
    level = "partially_grounded";
    reasonCode = "PARTIALLY_GROUNDED";
  } else {
    level = "grounded";
    reasonCode = "GROUNDED";
  }

  const missingAnchors = anchors.filter((a) => !matchedAnchors.includes(a)).slice(0, 5);
  return {
    applicable: true,
    level,
    anchors,
    matchedAnchors,
    anchorHitRatio,
    reasonCode,
    explanation:
      level === "grounded"
        ? "The response references most of the specific details supplied in the question."
        : "The response provides discussion but does not reference several of the specific details supplied in the question.",
    evidence: missingAnchors.map((a) => `No reference to "${a}"`),
    limitation:
      "A valid answer may use different terminology to refer to the same scenario detail. Lecturer review is required.",
  };
}

// ---------------------------------------------------------------------------
// 4.3 Generic-response analysis
// ---------------------------------------------------------------------------

export const MIN_ANSWER_WORDS_FOR_GENERIC_CHECK = 40;
export const LOW_QA_OVERLAP_RATIO = 0.12;
export const MIN_GENERIC_PHRASE_COUNT = 2;

const GENERIC_PHRASES = [
  "in general",
  "overall",
  "in conclusion",
  "it is important to note",
  "in today's world",
  "in today's society",
  "there are many factors",
  "a wide range of",
  "various factors",
  "in summary",
  "broadly speaking",
  "in many cases",
  "a variety of",
  "plays a crucial role",
  "plays a vital role",
  "it is essential to",
  "in order to fully understand",
];

export type GenericResponseResult = {
  applicable: boolean;
  flagged: boolean;
  level: SignalLevel;
  genericPhrases: string[];
  questionAnswerOverlapRatio: number;
  reasonCode: "TOO_SHORT" | "NOT_GENERIC" | "GENERIC_RESPONSE";
  explanation: string;
  evidence: string[];
  limitation: string;
};

/**
 * Flags answers that read as broad/reusable rather than applied to the
 * specific question: low term overlap with the question's own distinctive
 * vocabulary AND multiple generic filler phrases. Neither signal alone is
 * sufficient — a vocabulary list alone never declares AI use, and answer
 * length alone never determines the signal.
 */
export function analyzeGenericResponse(
  questionText: string | null | undefined,
  answerText: string | null | undefined,
): GenericResponseResult {
  const answerWords = tokenizeNormalized(normalizeAnswerText(answerText));
  if (answerWords.length < MIN_ANSWER_WORDS_FOR_GENERIC_CHECK) {
    return {
      applicable: false,
      flagged: false,
      level: "NONE",
      genericPhrases: [],
      questionAnswerOverlapRatio: 0,
      reasonCode: "TOO_SHORT",
      explanation: "Response is too short for generic-response analysis.",
      evidence: [],
      limitation: "Short answers are not analysed for this signal.",
    };
  }

  const questionTokens = new Set(
    tokenizeNormalized(normalizeAnswerText(questionText)).filter((t) => t.length >= 4 && !STOPWORDS.has(t)),
  );
  const answerTokenSet = new Set(answerWords);
  const overlapCount = [...questionTokens].filter((t) => answerTokenSet.has(t)).length;
  const questionAnswerOverlapRatio = questionTokens.size === 0 ? 1 : overlapCount / questionTokens.size;

  const normalizedAnswer = normalizeAnswerText(answerText);
  const genericPhrases = GENERIC_PHRASES.filter((p) => normalizedAnswer.includes(p));

  const flagged = questionAnswerOverlapRatio <= LOW_QA_OVERLAP_RATIO && genericPhrases.length >= MIN_GENERIC_PHRASE_COUNT;

  if (!flagged) {
    return {
      applicable: true,
      flagged: false,
      level: "NONE",
      genericPhrases,
      questionAnswerOverlapRatio,
      reasonCode: "NOT_GENERIC",
      explanation: "Response engages with terms specific to the question.",
      evidence: [],
      limitation: "Generic academic vocabulary alone is never sufficient to flag a response.",
    };
  }

  return {
    applicable: true,
    flagged: true,
    level: "MEDIUM",
    genericPhrases,
    questionAnswerOverlapRatio,
    reasonCode: "GENERIC_RESPONSE",
    explanation:
      "The response uses broad, reusable phrasing and has low overlap with terms specific to this question — it reads as though it could plausibly answer many unrelated questions.",
    evidence: [
      `Question-specific term overlap: ${(questionAnswerOverlapRatio * 100).toFixed(0)}%`,
      ...genericPhrases.slice(0, 3).map((p) => `Generic phrase used: "${p}"`),
    ],
    limitation: "A concise, well-focused answer may legitimately use some general phrasing. Lecturer review is required.",
  };
}

// ---------------------------------------------------------------------------
// 4.4 Required-concept coverage
// ---------------------------------------------------------------------------

/** Curated equivalent phrasings for a small set of common course-concept anchors — "where feasible" only. */
const CONCEPT_SYNONYMS: Record<string, string[]> = {
  "least privilege": ["least privilege", "principle of least privilege", "minimal access", "minimum necessary access"],
  "separation of duties": ["separation of duties", "segregation of duties", "split of responsibilities"],
  "defence in depth": ["defence in depth", "defense in depth", "layered security", "layered defence"],
};

const REQUIRED_CONCEPT_PATTERNS = [
  /\bmust\s+(?:address|include|discuss|cover|apply|reference|mention)\s+([^.]+)/i,
  /\bshould\s+(?:address|include|discuss|cover|apply|reference|mention)\s+([^.]+)/i,
  /\brefer\s+to\s+([^.]+)/i,
];

/**
 * Extracts explicitly required concepts from the question's own visible
 * text (e.g. "Refer to least privilege and separation of duties."). Never
 * infers hidden marking criteria that are not present in the question.
 */
export function extractRequiredConceptsFromQuestionText(questionText: string | null | undefined): string[] {
  if (!questionText) return [];
  for (const pattern of REQUIRED_CONCEPT_PATTERNS) {
    const match = questionText.match(pattern);
    if (!match) continue;
    const captured = match[1];
    return captured
      .split(/,|\band\b|\bas well as\b/i)
      .map((c) => c.trim().replace(/^"+|"+$/g, "").replace(/["“”]/g, ""))
      .filter((c) => c.length >= 3);
  }
  return [];
}

export type RequiredConceptCoverageResult = {
  applicable: boolean;
  requiredConcepts: string[];
  missingConcepts: string[];
  reasonCode: "NO_REQUIREMENT_STATED" | "ALL_CONCEPTS_PRESENT" | "CONCEPTS_MISSING";
  explanation: string;
  evidence: string[];
  limitation: string;
};

/** Only runs when the question text itself explicitly names required concepts — never a fabricated rubric. */
export function analyzeRequiredConceptCoverage(
  questionText: string | null | undefined,
  answerText: string | null | undefined,
): RequiredConceptCoverageResult {
  const requiredConcepts = extractRequiredConceptsFromQuestionText(questionText);
  if (requiredConcepts.length === 0) {
    return {
      applicable: false,
      requiredConcepts: [],
      missingConcepts: [],
      reasonCode: "NO_REQUIREMENT_STATED",
      explanation: "The question does not explicitly require specific concepts.",
      evidence: [],
      limitation: "This signal only runs when the question text itself names required concepts.",
    };
  }

  const normalizedAnswer = normalizeAnswerText(answerText);
  const missingConcepts = requiredConcepts.filter((concept) => {
    const candidates = CONCEPT_SYNONYMS[concept.toLowerCase()] ?? [concept];
    return !candidates.some((c) => normalizedAnswer.includes(normalizeAnswerText(c)));
  });

  if (missingConcepts.length === 0) {
    return {
      applicable: true,
      requiredConcepts,
      missingConcepts: [],
      reasonCode: "ALL_CONCEPTS_PRESENT",
      explanation: "The response addresses the concepts explicitly required by the question.",
      evidence: [],
      limitation: "This is an academic-answer quality signal, not proof of AI use.",
    };
  }

  return {
    applicable: true,
    requiredConcepts,
    missingConcepts,
    reasonCode: "CONCEPTS_MISSING",
    explanation: `The question explicitly requires application of ${missingConcepts.map((c) => `"${c}"`).join(", ")}, but the response does not address ${missingConcepts.length === 1 ? "that concept" : "those concepts"}.`,
    evidence: missingConcepts.map((c) => `Required concept not addressed: "${c}"`),
    limitation: "This is an academic-answer quality signal, not proof of AI use. Alternative wording may exist.",
  };
}

// ---------------------------------------------------------------------------
// 4.5 Unsupported specific claims
// ---------------------------------------------------------------------------

export const MIN_ANSWER_WORDS_FOR_CLAIMS_CHECK = 30;
export const MEDIUM_CLAIM_COUNT = 2;
export const HIGH_CLAIM_COUNT = 4;

const NUMERIC_CLAIM_REGEX = /\b\d{1,3}(?:\.\d+)?\s?%|\$\d[\d,]*(?:\.\d+)?|\b(19|20)\d{2}\b/g;
const NAMED_SOURCE_REGEX = /\b([A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*)*\s+(?:Act|Regulation|Study|Report|Survey|Journal|Framework))\b/g;

export type UnsupportedClaimsResult = {
  applicable: boolean;
  flagged: boolean;
  level: SignalLevel;
  candidateClaims: string[];
  reasonCode: "TOO_SHORT" | "NO_CANDIDATE_CLAIMS" | "CANDIDATE_CLAIMS_FOUND";
  explanation: string;
  evidence: string[];
  limitation: string;
};

/**
 * Identifies CANDIDATE unsupported claims (numbers, dates, named sources)
 * present in the answer but not in the question. This never states that a
 * fact is false — only that it is not grounded in the supplied material.
 */
export function detectUnsupportedSpecificClaims(
  questionText: string | null | undefined,
  answerText: string | null | undefined,
): UnsupportedClaimsResult {
  const answerWords = tokenizeNormalized(normalizeAnswerText(answerText));
  if (answerWords.length < MIN_ANSWER_WORDS_FOR_CLAIMS_CHECK) {
    return {
      applicable: false,
      flagged: false,
      level: "NONE",
      candidateClaims: [],
      reasonCode: "TOO_SHORT",
      explanation: "Response is too short for unsupported-claims analysis.",
      evidence: [],
      limitation: "Short answers are not analysed for this signal.",
    };
  }

  const questionText_ = questionText ?? "";
  const answerText_ = answerText ?? "";
  const questionNumbers = new Set(questionText_.match(NUMERIC_CLAIM_REGEX) ?? []);
  const answerNumbers = (answerText_.match(NUMERIC_CLAIM_REGEX) ?? []).filter((n) => !questionNumbers.has(n));
  const namedSources = [...answerText_.matchAll(NAMED_SOURCE_REGEX)].map((m) => m[1]);

  const candidateClaims = [...new Set([...answerNumbers, ...namedSources])];

  if (candidateClaims.length === 0) {
    return {
      applicable: true,
      flagged: false,
      level: "NONE",
      candidateClaims: [],
      reasonCode: "NO_CANDIDATE_CLAIMS",
      explanation: "No specific claims outside the supplied question material were identified.",
      evidence: [],
      limitation: "This check only looks for candidate claims — it never confirms a fact is false.",
    };
  }

  const level: SignalLevel = candidateClaims.length >= HIGH_CLAIM_COUNT ? "HIGH" : candidateClaims.length >= MEDIUM_CLAIM_COUNT ? "MEDIUM" : "LOW";
  return {
    applicable: true,
    flagged: level !== "LOW",
    level,
    candidateClaims,
    reasonCode: "CANDIDATE_CLAIMS_FOUND",
    explanation: "The response introduces several specific claims that are not supported by the supplied question material.",
    evidence: candidateClaims.slice(0, 5).map((c) => `Unsupported candidate claim: "${c}"`),
    limitation: "The claims may come from valid prior knowledge and require lecturer review — this is not a factual determination.",
  };
}

// ---------------------------------------------------------------------------
// 4.6 Generated-response meta-language
// ---------------------------------------------------------------------------

const META_LANGUAGE_PATTERNS: RegExp[] = [
  /as an ai language model/i,
  /as an ai(?:,| )/i,
  /i cannot provide assistance with an active exam/i,
  /here is a comprehensive (response|answer)/i,
  /based on the prompt provided/i,
  /\[insert[^\]]*\]/i,
  /i'?m an ai/i,
  /i am an ai/i,
  /as a language model/i,
  /i hope this (response|answer) helps/i,
  /let me know if you (would like|need) (any )?further/i,
  /i don'?t have (access to|the ability to)/i,
];

export type MetaLanguageResult = {
  flagged: boolean;
  level: SignalLevel;
  matchedPhrases: string[];
  reasonCode: "NO_ARTEFACTS_FOUND" | "ARTEFACTS_FOUND";
  explanation: string;
  evidence: string[];
  limitation: string;
};

/**
 * Detects directly observable response artefacts (e.g. "As an AI language
 * model", "[insert example here]") — a stronger signal because it is
 * observable text, not an inference. Still framed as a review
 * recommendation, never "AI use confirmed".
 */
export function detectGeneratedResponseMetaLanguage(answerText: string | null | undefined): MetaLanguageResult {
  const text = answerText ?? "";
  const matchedPhrases: string[] = [];
  for (const pattern of META_LANGUAGE_PATTERNS) {
    const match = text.match(pattern);
    if (match) matchedPhrases.push(match[0]);
  }

  if (matchedPhrases.length === 0) {
    return {
      flagged: false,
      level: "NONE",
      matchedPhrases: [],
      reasonCode: "NO_ARTEFACTS_FOUND",
      explanation: "No generated-response artefacts were found.",
      evidence: [],
      limitation: "Absence of these artefacts does not indicate anything either way.",
    };
  }

  return {
    flagged: true,
    level: matchedPhrases.length >= 2 ? "HIGH" : "MEDIUM",
    matchedPhrases,
    reasonCode: "ARTEFACTS_FOUND",
    explanation: "The response contains wording commonly associated with generated-text artefacts (e.g. a direct address to a user, or placeholder text).",
    evidence: matchedPhrases.map((p) => `Observed phrase: "${p}"`),
    limitation: "This is an observable text artefact, not confirmation of how the response was produced. Lecturer review is recommended.",
  };
}

// ---------------------------------------------------------------------------
// Part 5 — Internal writing-style consistency
// ---------------------------------------------------------------------------

export const MIN_MEANINGFUL_ANSWERS_FOR_STYLE = 3;
export const MIN_ANSWER_WORDS_FOR_STYLE = 20;
/** An answer must deviate by at least this many standard deviations on >=2 features to be an outlier. */
export const STYLE_OUTLIER_Z_SCORE = 1.5;

export type StyleAnswerInput = {
  questionId: string;
  type: "SHORT_ANSWER" | "ESSAY";
  text: string;
};

type StyleFeatures = {
  avgSentenceLength: number;
  vocabDiversity: number;
  punctuationFrequency: number;
  firstPersonRatio: number;
  contractionRatio: number;
};

function computeStyleFeatures(text: string): StyleFeatures {
  const sentences = text.split(/[.!?]+/).map((s) => s.trim()).filter((s) => s.length > 0);
  const tokens = tokenizeNormalized(normalizeAnswerText(text));
  const wordCount = tokens.length || 1;
  const avgSentenceLength = sentences.length > 0 ? wordCount / sentences.length : wordCount;
  const vocabDiversity = new Set(tokens).size / wordCount;
  const punctuationMatches = text.match(/[,;:—-]/g) ?? [];
  const punctuationFrequency = punctuationMatches.length / wordCount;
  const firstPersonMatches = text.match(/\b(i|my|me|we|our)\b/gi) ?? [];
  const firstPersonRatio = firstPersonMatches.length / wordCount;
  const contractionMatches = text.match(/\b\w+'\w+\b/g) ?? [];
  const contractionRatio = contractionMatches.length / wordCount;
  return { avgSentenceLength, vocabDiversity, punctuationFrequency, firstPersonRatio, contractionRatio };
}

function mean(values: number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}
function stddev(values: number[], m: number): number {
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}

export type StyleConsistencyResult = {
  applicable: boolean;
  outlierQuestionIds: string[];
  reasonCode: "NOT_ENOUGH_MEANINGFUL_ANSWERS" | "CONSISTENT" | "OUTLIER_FOUND";
  explanation: string;
  evidence: string[];
  limitation: string;
};

/**
 * Compares a student's own written answers within one attempt only —
 * never against demographic/cohort norms, never against other students,
 * never against historical work. Requires >=3 meaningful written answers.
 * Style mismatch alone can only ever reach MEDIUM (enforced by the
 * caller mapping this result to a signal level).
 */
export function analyzeWritingStyleConsistency(answers: StyleAnswerInput[]): StyleConsistencyResult {
  const meaningful = answers.filter((a) => tokenizeNormalized(normalizeAnswerText(a.text)).length >= MIN_ANSWER_WORDS_FOR_STYLE);
  if (meaningful.length < MIN_MEANINGFUL_ANSWERS_FOR_STYLE) {
    return {
      applicable: false,
      outlierQuestionIds: [],
      reasonCode: "NOT_ENOUGH_MEANINGFUL_ANSWERS",
      explanation: "Fewer than three meaningful written responses are available for style comparison.",
      evidence: [],
      limitation: "Style analysis requires at least three sufficiently long written answers in the same attempt.",
    };
  }

  // Compare like-for-like question types where a type has enough
  // meaningful answers of its own; otherwise compare across all
  // meaningful answers together.
  const byType = new Map<string, StyleAnswerInput[]>();
  for (const a of meaningful) {
    const bucket = byType.get(a.type) ?? [];
    bucket.push(a);
    byType.set(a.type, bucket);
  }
  const groups: StyleAnswerInput[][] = [];
  for (const [, bucket] of byType) {
    if (bucket.length >= MIN_MEANINGFUL_ANSWERS_FOR_STYLE) groups.push(bucket);
  }
  if (groups.length === 0) groups.push(meaningful);

  const outlierQuestionIds: string[] = [];
  const evidence: string[] = [];

  for (const group of groups) {
    const featureList = group.map((a) => ({ questionId: a.questionId, features: computeStyleFeatures(a.text) }));
    const dims: (keyof StyleFeatures)[] = ["avgSentenceLength", "vocabDiversity", "punctuationFrequency", "firstPersonRatio", "contractionRatio"];
    const stats = new Map(
      dims.map((dim) => {
        const values = featureList.map((f) => f.features[dim]);
        const m = mean(values);
        return [dim, { mean: m, sd: stddev(values, m) }];
      }),
    );

    for (const f of featureList) {
      let deviatingDims = 0;
      for (const dim of dims) {
        const { mean: m, sd } = stats.get(dim)!;
        if (sd === 0) continue;
        const z = Math.abs((f.features[dim] - m) / sd);
        if (z >= STYLE_OUTLIER_Z_SCORE) deviatingDims++;
      }
      if (deviatingDims >= 2 && !outlierQuestionIds.includes(f.questionId)) {
        outlierQuestionIds.push(f.questionId);
        evidence.push(`Response to this question deviates from the student's other responses on ${deviatingDims} writing-style measures.`);
      }
    }
  }

  if (outlierQuestionIds.length === 0) {
    return {
      applicable: true,
      outlierQuestionIds: [],
      reasonCode: "CONSISTENT",
      explanation: "The student's written responses in this attempt show broadly consistent writing style.",
      evidence: [],
      limitation: "Different questions may naturally produce different writing styles.",
    };
  }

  return {
    applicable: true,
    outlierQuestionIds,
    reasonCode: "OUTLIER_FOUND",
    explanation:
      "One or more responses use substantially different sentence structure, vocabulary, and formatting from the student's other responses in this attempt.",
    evidence,
    limitation: "Different questions may naturally produce different writing styles. Style mismatch alone is not evidence of AI use.",
  };
}

// ---------------------------------------------------------------------------
// Part 6 — Polished-but-shallow signal
// ---------------------------------------------------------------------------

export const POLISHED_MIN_WORD_COUNT = 150;
export const POLISHED_MIN_HEADING_COUNT = 2;

type StructuralPolishFeatures = {
  wordCount: number;
  headingCount: number;
  hasConclusionPhrase: boolean;
};

function detectStructuralPolishFeatures(answerText: string): StructuralPolishFeatures {
  const wordCount = tokenizeNormalized(normalizeAnswerText(answerText)).length;
  const headingLines = answerText.split(/\n/).filter((line) => /^\s*(#{1,3}\s|\d+\.\s|[A-Z][a-zA-Z ]{2,40}:\s*$)/.test(line));
  const hasConclusionPhrase = /\b(in conclusion|to conclude|in summary)\b/i.test(answerText);
  return { wordCount, headingCount: headingLines.length, hasConclusionPhrase };
}

export type PolishedButShallowResult = {
  applicable: boolean;
  flagged: boolean;
  level: SignalLevel;
  explanation: string;
  evidence: string[];
  limitation: string;
};

/**
 * Requires MULTIPLE features together (structural polish AND low
 * grounding/generic phrasing) — never flags a response merely for being
 * well written.
 */
export function analyzePolishedButShallow(
  answerText: string | null | undefined,
  grounding: ScenarioGroundingResult,
  generic: GenericResponseResult,
): PolishedButShallowResult {
  const text = answerText ?? "";
  const structure = detectStructuralPolishFeatures(text);
  const polishIndicatorCount =
    (structure.headingCount >= POLISHED_MIN_HEADING_COUNT ? 1 : 0) +
    (structure.wordCount >= POLISHED_MIN_WORD_COUNT ? 1 : 0) +
    (structure.hasConclusionPhrase ? 1 : 0);
  const shallowIndicatorCount =
    (grounding.applicable && (grounding.level === "weakly_grounded" || grounding.level === "partially_grounded") ? 1 : 0) +
    (generic.flagged ? 1 : 0);

  const flagged = polishIndicatorCount >= 2 && shallowIndicatorCount >= 1;

  if (!flagged) {
    return {
      applicable: true,
      flagged: false,
      level: "NONE",
      explanation: "No combination of strong structural polish with low scenario application was found.",
      evidence: [],
      limitation: "A well-written response is never flagged on its own.",
    };
  }

  return {
    applicable: true,
    flagged: true,
    level: "LOW",
    explanation: "The response is highly structured but provides limited application to the specific scenario.",
    evidence: [
      structure.headingCount >= POLISHED_MIN_HEADING_COUNT ? `${structure.headingCount} headings/list items` : undefined,
      structure.wordCount >= POLISHED_MIN_WORD_COUNT ? `${structure.wordCount} words` : undefined,
      structure.hasConclusionPhrase ? "Polished concluding statement" : undefined,
    ].filter((e): e is string => Boolean(e)),
    limitation: "This is not evidence that AI was used — some students write in a highly structured style naturally.",
  };
}

// ---------------------------------------------------------------------------
// Signal record shape + deterministic-check orchestration
// ---------------------------------------------------------------------------

export type AiUseReviewSignalRecord = {
  questionId: string;
  answerId: string | null;
  signalType: SignalType;
  signalLevel: SignalLevel;
  explanation: string;
  evidence: string[];
  limitation: string;
  reasonCode: string;
};

export type QuestionForAnalysis = {
  id: string;
  type: "MULTIPLE_CHOICE" | "SHORT_ANSWER" | "ESSAY";
  text: string;
};

export type AnswerForAnalysis = {
  id: string;
  questionId: string;
  response: string | null;
};

/** Answers below this length are excluded from every deterministic check ("short answers are not over-analysed"). */
export const MIN_ANSWER_WORDS_FOR_ANY_CHECK = 15;

/**
 * Runs every Layer-A (deterministic, no AI provider) check across a
 * submission's written answers and returns explainable signal records.
 * Never touches Prisma — the caller (aiUseReviewRunner.ts) maps DB rows
 * into the plain types above and persists the result.
 */
export function runDeterministicAiUseReviewChecks(
  questions: QuestionForAnalysis[],
  answers: AnswerForAnalysis[],
): AiUseReviewSignalRecord[] {
  const signals: AiUseReviewSignalRecord[] = [];
  const answerByQuestion = new Map(answers.map((a) => [a.questionId, a]));
  const writtenQuestions = questions.filter((q) => q.type !== "MULTIPLE_CHOICE");

  for (const q of writtenQuestions) {
    const answer = answerByQuestion.get(q.id);
    const text = answer?.response ?? "";
    if (tokenizeNormalized(normalizeAnswerText(text)).length < MIN_ANSWER_WORDS_FOR_ANY_CHECK) continue;

    const grounding = analyzeScenarioGrounding(q.text, text);
    if (grounding.applicable && grounding.level === "weakly_grounded") {
      signals.push({
        questionId: q.id,
        answerId: answer?.id ?? null,
        signalType: "WEAK_SCENARIO_GROUNDING",
        signalLevel: "MEDIUM",
        explanation: grounding.explanation,
        evidence: grounding.evidence,
        limitation: grounding.limitation,
        reasonCode: grounding.reasonCode,
      });
    }

    const generic = analyzeGenericResponse(q.text, text);
    if (generic.flagged) {
      signals.push({
        questionId: q.id,
        answerId: answer?.id ?? null,
        signalType: "GENERIC_RESPONSE",
        signalLevel: generic.level,
        explanation: generic.explanation,
        evidence: generic.evidence,
        limitation: generic.limitation,
        reasonCode: generic.reasonCode,
      });
    }

    const concepts = analyzeRequiredConceptCoverage(q.text, text);
    if (concepts.applicable && concepts.missingConcepts.length > 0) {
      signals.push({
        questionId: q.id,
        answerId: answer?.id ?? null,
        signalType: "REQUIRED_CONCEPTS_MISSING",
        signalLevel: concepts.missingConcepts.length >= 2 ? "MEDIUM" : "LOW",
        explanation: concepts.explanation,
        evidence: concepts.evidence,
        limitation: concepts.limitation,
        reasonCode: concepts.reasonCode,
      });
    }

    const claims = detectUnsupportedSpecificClaims(q.text, text);
    if (claims.flagged) {
      signals.push({
        questionId: q.id,
        answerId: answer?.id ?? null,
        signalType: "UNSUPPORTED_SPECIFIC_CLAIMS",
        signalLevel: claims.level,
        explanation: claims.explanation,
        evidence: claims.evidence,
        limitation: claims.limitation,
        reasonCode: claims.reasonCode,
      });
    }

    const meta = detectGeneratedResponseMetaLanguage(text);
    if (meta.flagged) {
      signals.push({
        questionId: q.id,
        answerId: answer?.id ?? null,
        signalType: "GENERATED_RESPONSE_META_LANGUAGE",
        signalLevel: meta.level,
        explanation: meta.explanation,
        evidence: meta.evidence,
        limitation: meta.limitation,
        reasonCode: meta.reasonCode,
      });
    }

    const polished = analyzePolishedButShallow(text, grounding, generic);
    if (polished.flagged) {
      signals.push({
        questionId: q.id,
        answerId: answer?.id ?? null,
        signalType: "POLISHED_BUT_SHALLOW_RESPONSE",
        signalLevel: polished.level,
        explanation: polished.explanation,
        evidence: polished.evidence,
        limitation: polished.limitation,
        reasonCode: "POLISHED_BUT_SHALLOW",
      });
    }
  }

  const styleInput: StyleAnswerInput[] = writtenQuestions
    .map((q) => ({ questionId: q.id, type: q.type as "SHORT_ANSWER" | "ESSAY", text: answerByQuestion.get(q.id)?.response ?? "" }))
    .filter((a) => tokenizeNormalized(normalizeAnswerText(a.text)).length >= MIN_ANSWER_WORDS_FOR_ANY_CHECK);
  const style = analyzeWritingStyleConsistency(styleInput);
  if (style.applicable && style.outlierQuestionIds.length > 0) {
    for (const questionId of style.outlierQuestionIds) {
      signals.push({
        questionId,
        answerId: answerByQuestion.get(questionId)?.id ?? null,
        signalType: "STYLE_INCONSISTENCY",
        signalLevel: "MEDIUM",
        explanation: style.explanation,
        evidence: style.evidence,
        limitation: style.limitation,
        reasonCode: style.reasonCode,
      });
    }
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Part 8 — Overall recommendation logic
// ---------------------------------------------------------------------------

/** Signal types that, even at MEDIUM, can never by themselves justify oral verification. */
const ORAL_VERIFICATION_LIMITED_TYPES = new Set<SignalType>(["STYLE_INCONSISTENCY", "GENERIC_RESPONSE", "POLISHED_BUT_SHALLOW_RESPONSE"]);

export type RecommendationSignalInput = { signalType: SignalType; signalLevel: SignalLevel };

export type RecommendationCorroboration = {
  /** True if this submission already has an existing HIGH similarity or oral-verification-recommended signal elsewhere in the app. */
  existingHighSimilarityOrIntegritySignal?: boolean;
};

export type AiUseReviewRecommendationResult = {
  recommendation: AiUseReviewRecommendation;
  reasonCodes: string[];
  summary: string;
};

/**
 * Explainable, rule-based recommendation — deliberately NOT a hidden
 * numeric score, and never AI_USE_CONFIRMED/MISCONDUCT_CONFIRMED. Never
 * creates an OralVerification record itself — that always requires an
 * explicit lecturer action (see the "Require oral verification" button).
 */
export function calculateAiUseReviewRecommendation(
  signals: RecommendationSignalInput[],
  corroboration: RecommendationCorroboration = {},
): AiUseReviewRecommendationResult {
  const meaningful = signals.filter((s) => s.signalLevel !== "NONE");
  const reasonCodes = meaningful.map((s) => `${s.signalType}:${s.signalLevel}`);
  if (corroboration.existingHighSimilarityOrIntegritySignal) reasonCodes.push("EXISTING_SIMILARITY_OR_INTEGRITY_SIGNAL");

  if (meaningful.length === 0) {
    return {
      recommendation: "NO_IMMEDIATE_ACTION",
      reasonCodes,
      summary: "No AI-use review signals above review thresholds.",
    };
  }

  const mediumOrAbove = meaningful.filter((s) => s.signalLevel === "MEDIUM" || s.signalLevel === "HIGH");
  const mediumOrAboveTypes = new Set(mediumOrAbove.map((s) => s.signalType));
  const hasNonLimitedMediumSignal = mediumOrAbove.some((s) => !ORAL_VERIFICATION_LIMITED_TYPES.has(s.signalType));

  const oralVerificationEligible =
    (mediumOrAboveTypes.size >= 2 && hasNonLimitedMediumSignal) ||
    (Boolean(corroboration.existingHighSimilarityOrIntegritySignal) && mediumOrAbove.length >= 1);

  if (oralVerificationEligible) {
    return {
      recommendation: "ORAL_VERIFICATION_RECOMMENDED",
      reasonCodes,
      summary: "Multiple independent AI-use review signals. Oral verification recommended. This is a review recommendation only.",
    };
  }

  if (mediumOrAbove.length >= 1) {
    return {
      recommendation: "LECTURER_REVIEW_RECOMMENDED",
      reasonCodes,
      summary: "An AI-use review signal was found. Lecturer review recommended. This is a review recommendation only.",
    };
  }

  return {
    recommendation: "NO_IMMEDIATE_ACTION",
    reasonCodes,
    summary: "Only low-level AI-use review signals were found. No immediate action recommended.",
  };
}

/** Overall level shown on the analysis summary = highest level of any signal found. */
export function overallSignalLevelFromSignals(signals: Array<{ signalLevel: SignalLevel }>): SignalLevel {
  if (signals.some((s) => s.signalLevel === "HIGH")) return "HIGH";
  if (signals.some((s) => s.signalLevel === "MEDIUM")) return "MEDIUM";
  if (signals.some((s) => s.signalLevel === "LOW")) return "LOW";
  return "NONE";
}
