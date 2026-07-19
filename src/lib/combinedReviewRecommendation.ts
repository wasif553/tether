/**
 * Exam Session Binding + Time Anomaly Review v1 — combined recommendation
 * logic (Part 12). See docs/exam-session-binding-v1.md and
 * docs/time-anomaly-review-v1.md.
 *
 * Pure, dependency-free: no Prisma, no Next.js. Combines session-binding
 * signals, timing signals, and the RECOMMENDATIONS already produced by
 * the answer-similarity and AI-use-review features (never their raw
 * signals — those stay owned by their own modules) into one explainable,
 * rule-based recommendation. Never a hidden numeric "accusation score",
 * and never AI_USE_CONFIRMED/MISCONDUCT_CONFIRMED/DEVICE_FRAUD_CONFIRMED.
 * This function never creates an OralVerification record itself — that
 * always requires an explicit lecturer action.
 */

export const COMBINED_RECOMMENDATIONS = [
  "NO_IMMEDIATE_ACTION",
  "LECTURER_REVIEW_RECOMMENDED",
  "ORAL_VERIFICATION_RECOMMENDED",
  "ESCALATION_RECOMMENDED",
] as const;
export type CombinedRecommendation = (typeof COMBINED_RECOMMENDATIONS)[number];

export const COMBINED_RECOMMENDATION_LABELS: Record<CombinedRecommendation, string> = {
  NO_IMMEDIATE_ACTION: "No immediate action",
  LECTURER_REVIEW_RECOMMENDED: "Lecturer review recommended",
  ORAL_VERIFICATION_RECOMMENDED: "Oral verification recommended",
  ESCALATION_RECOMMENDED: "Escalated",
};

export type CombinedSignalCategory = "SESSION" | "TIMING" | "EVIDENCE";
export type CombinedSignalLevel = "LOW" | "MEDIUM" | "HIGH";

export type CombinedSignalInput = {
  category: CombinedSignalCategory;
  signalType: string;
  signalLevel: CombinedSignalLevel;
};

/**
 * Signal types that can never, even at MEDIUM/HIGH, justify oral
 * verification purely on their own or in combination only with each
 * other — network/UA/timing-similarity/camera-permission changes are all
 * individually explainable by ordinary legitimate behaviour (Part 12:
 * "one IP-prefix change alone", "one user-agent change alone", "timing
 * similarity alone" never recommend oral verification).
 */
const LIMITED_ALONE_SIGNAL_TYPES = new Set([
  "NETWORK_PREFIX_CHANGED",
  "USER_AGENT_CHANGED",
  "SIMILAR_RESPONSE_TIMING_PATTERN",
  "CAMERA_PERMISSION_CHANGED",
  "SESSION_TOKEN_MISMATCH",
  "SESSION_RESTARTED",
  "INSUFFICIENT_TIMING_DATA",
]);

/**
 * Exam Design Policy v1 (Part 10) — every EVIDENCE-category signal (a
 * policy-interpreted integrity event, from
 * src/lib/examPolicy.ts:integrityEventPolicyToRecommendationSignal) is
 * ALWAYS treated as "limited alone", regardless of its specific type:
 * "one policy inconsistency should normally recommend lecturer review at
 * most". Permitted activity never reaches this function at all — see
 * integrityEventPolicyToRecommendationSignal, which returns null for
 * PERMITTED/NONE-level interpretations before a signal is ever built.
 */
function isLimitedAloneSignal(signal: CombinedSignalInput): boolean {
  return signal.category === "EVIDENCE" || LIMITED_ALONE_SIGNAL_TYPES.has(signal.signalType);
}

export type ExistingFeatureRecommendations = {
  /** From src/lib/answerSimilarity.ts computeSimilarityRecommendation(). */
  similarityRecommendation?: "NO_IMMEDIATE_ACTION" | "LECTURER_REVIEW_RECOMMENDED" | "ORAL_VERIFICATION_RECOMMENDED" | "ESCALATION_RECOMMENDED";
  /** From src/lib/aiUseReview.ts calculateAiUseReviewRecommendation(). */
  aiUseReviewRecommendation?: "NO_IMMEDIATE_ACTION" | "LECTURER_REVIEW_RECOMMENDED" | "ORAL_VERIFICATION_RECOMMENDED";
  /** Count of existing camera-related integrity events on this submission (phone/second-person) — corroboration only, never a signal on its own here. */
  cameraIntegrityEventCount?: number;
  /** Exam Design Policy v1 — included in reasonCodes for transparency only; never changes the arithmetic above on its own. */
  examMode?: "CLOSED_BOOK" | "OPEN_BOOK" | "CUSTOM";
};

export type CombinedRecommendationResult = {
  recommendation: CombinedRecommendation;
  reasonCodes: string[];
  summary: string;
};

/**
 * Explainable, rule-based combination — see docs for the full rule
 * table. `signals` should contain only already-flagged (non-NONE-level)
 * session/timing signal records; this function never re-derives a
 * signal's level, only combines what's already been computed.
 */
export function calculateCombinedReviewRecommendation(
  signals: CombinedSignalInput[],
  existing: ExistingFeatureRecommendations = {},
): CombinedRecommendationResult {
  const reasonCodes: string[] = signals.map((s) => `${s.category}:${s.signalType}:${s.signalLevel}`);
  if (existing.similarityRecommendation) reasonCodes.push(`EXISTING_SIMILARITY:${existing.similarityRecommendation}`);
  if (existing.aiUseReviewRecommendation) reasonCodes.push(`EXISTING_AI_USE_REVIEW:${existing.aiUseReviewRecommendation}`);
  if (existing.cameraIntegrityEventCount) reasonCodes.push(`CAMERA_INTEGRITY_EVENTS:${existing.cameraIntegrityEventCount}`);
  if (existing.examMode) reasonCodes.push(`POLICY_CONTEXT:${existing.examMode}`);

  const mediumOrAbove = signals.filter((s) => s.signalLevel === "MEDIUM" || s.signalLevel === "HIGH");
  const nonLimitedMediumOrAbove = mediumOrAbove.filter((s) => !isLimitedAloneSignal(s));
  const distinctNonLimitedTypes = new Set(nonLimitedMediumOrAbove.map((s) => s.signalType));
  const distinctNonLimitedHighTypes = new Set(nonLimitedMediumOrAbove.filter((s) => s.signalLevel === "HIGH").map((s) => s.signalType));

  const existingHigh =
    existing.similarityRecommendation === "ORAL_VERIFICATION_RECOMMENDED" ||
    existing.similarityRecommendation === "ESCALATION_RECOMMENDED" ||
    existing.aiUseReviewRecommendation === "ORAL_VERIFICATION_RECOMMENDED";
  const existingMedium =
    existing.similarityRecommendation === "LECTURER_REVIEW_RECOMMENDED" || existing.aiUseReviewRecommendation === "LECTURER_REVIEW_RECOMMENDED";

  let recommendation: CombinedRecommendation;
  let summary: string;

  if (distinctNonLimitedTypes.size >= 3 && distinctNonLimitedHighTypes.size >= 2 && existingHigh) {
    recommendation = "ESCALATION_RECOMMENDED";
    summary = "Multiple strong, independent session/timing signals plus existing high-risk review signals. This is a review recommendation only.";
  } else if (distinctNonLimitedTypes.size >= 3 || (distinctNonLimitedTypes.size >= 2 && existingHigh)) {
    recommendation = "ORAL_VERIFICATION_RECOMMENDED";
    summary = "Multiple independent session/timing signals. Oral verification recommended. This is a review recommendation only.";
  } else if (distinctNonLimitedTypes.size >= 2) {
    recommendation = "LECTURER_REVIEW_RECOMMENDED";
    summary = "Independent session-binding signals were found together. Lecturer review recommended. This is a review recommendation only.";
  } else if (mediumOrAbove.length >= 1 || existingMedium) {
    recommendation = "LECTURER_REVIEW_RECOMMENDED";
    summary = "A session or timing review signal was found. Lecturer review recommended. This is a review recommendation only.";
  } else {
    recommendation = "NO_IMMEDIATE_ACTION";
    summary = "No session or timing signals above review thresholds.";
  }

  return { recommendation, reasonCodes, summary };
}
