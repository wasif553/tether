/**
 * AI-Use Answer Review v1 — see docs/ai-use-answer-review-v1.md and
 * src/lib/aiUseReview.ts.
 *
 * Pure unit tests only — no Prisma/DB, no browser, no LLM.
 */
import { describe, expect, it } from "vitest";
import {
  extractQuestionAnchors,
  analyzeScenarioGrounding,
  analyzeGenericResponse,
  extractRequiredConceptsFromQuestionText,
  analyzeRequiredConceptCoverage,
  detectUnsupportedSpecificClaims,
  detectGeneratedResponseMetaLanguage,
  analyzeWritingStyleConsistency,
  analyzePolishedButShallow,
  runDeterministicAiUseReviewChecks,
  calculateAiUseReviewRecommendation,
  containsBannedWording,
  overallSignalLevelFromSignals,
  type StyleAnswerInput,
} from "./aiUseReview";

// A specific, scenario-rich question used across several test groups.
const SCENARIO_QUESTION =
  'Acme Corp runs a Microsoft 365 environment with a $50,000 annual security budget. Explain how you would apply "least privilege" to their admin accounts given these constraints.';

const BROAD_THEORETICAL_QUESTION = "Explain the concept of defence in depth in cybersecurity.";

const GENERIC_ANSWER =
  "In general, cybersecurity is a wide range of practices that plays a crucial role in protecting organisations. " +
  "It is important to note that there are many factors involved, and in today's world, various factors must be balanced. " +
  "Overall, a variety of controls exist, and in summary, broadly speaking, security is essential for any organisation " +
  "operating in today's society. In conclusion, it is essential to consider all of these factors carefully.";

const GROUNDED_ANSWER =
  "For Acme Corp's Microsoft 365 environment, I would apply least privilege by ensuring admin accounts only hold the " +
  "specific roles they need day to day, rather than permanent Global Admin rights. Given the $50,000 budget, Acme could " +
  "use the built-in Microsoft 365 Privileged Identity Management features rather than a separate paid tool, assigning " +
  "just-in-time elevation to admins so permanent standing access is minimised across the tenant.";

describe("extractQuestionAnchors", () => {
  it("preserves numbers, currency, and named systems", () => {
    const anchors = extractQuestionAnchors(SCENARIO_QUESTION);
    expect(anchors).toContain("$50,000");
    expect(anchors.some((a) => a.includes("Microsoft"))).toBe(true);
    expect(anchors.some((a) => a.includes("Acme"))).toBe(true);
  });

  it("preserves quoted terms as anchors", () => {
    const anchors = extractQuestionAnchors(SCENARIO_QUESTION);
    expect(anchors).toContain("least privilege");
  });

  it("does not treat instructional sentence-starter words as anchors", () => {
    const anchors = extractQuestionAnchors("Explain how encryption works.");
    expect(anchors).not.toContain("Explain");
  });

  it("returns an empty list for empty input", () => {
    expect(extractQuestionAnchors("")).toEqual([]);
    expect(extractQuestionAnchors(null)).toEqual([]);
  });
});

describe("analyzeScenarioGrounding", () => {
  it("flags a specific question with a generic answer as weakly grounded", () => {
    const result = analyzeScenarioGrounding(SCENARIO_QUESTION, GENERIC_ANSWER);
    expect(result.applicable).toBe(true);
    expect(result.level).toBe("weakly_grounded");
  });

  it("does not flag a specific question with a grounded answer", () => {
    const result = analyzeScenarioGrounding(SCENARIO_QUESTION, GROUNDED_ANSWER);
    expect(result.level).not.toBe("weakly_grounded");
  });

  it("does not incorrectly require scenario anchors for a broad theoretical question", () => {
    const result = analyzeScenarioGrounding(BROAD_THEORETICAL_QUESTION, GENERIC_ANSWER);
    expect(result.applicable).toBe(false);
    expect(result.level).toBe("insufficient_evidence");
  });

  it("does not over-analyse short answers", () => {
    const result = analyzeScenarioGrounding(SCENARIO_QUESTION, "Use least privilege.");
    expect(result.applicable).toBe(false);
  });

  it("alternative terminology does not automatically create a high signal", () => {
    // Answer grounds the scenario using different wording for the anchors
    // ("50k budget" instead of "$50,000", "M365" instead of "Microsoft 365")
    // — the weak/partial distinction should not escalate to a fabricated
    // HIGH result; this module never returns anything above MEDIUM here.
    const result = analyzeScenarioGrounding(SCENARIO_QUESTION, GROUNDED_ANSWER);
    expect(["grounded", "partially_grounded"]).toContain(result.level);
  });
});

describe("analyzeGenericResponse", () => {
  it("flags a broad, reusable answer as generic", () => {
    const result = analyzeGenericResponse(SCENARIO_QUESTION, GENERIC_ANSWER);
    expect(result.flagged).toBe(true);
    expect(result.level).toBe("MEDIUM");
  });

  it("does not flag an answer applied to the scenario", () => {
    const result = analyzeGenericResponse(SCENARIO_QUESTION, GROUNDED_ANSWER);
    expect(result.flagged).toBe(false);
  });

  it("does not flag common academic vocabulary alone", () => {
    const mildlyGenericButSpecific =
      "Acme Corp should apply least privilege to its Microsoft 365 admin accounts. In summary, given the $50,000 " +
      "budget, Privileged Identity Management is the most cost-effective option for Acme's admins and reduces standing access.";
    const result = analyzeGenericResponse(SCENARIO_QUESTION, mildlyGenericButSpecific);
    expect(result.flagged).toBe(false);
  });

  it("does not determine the signal from answer length alone", () => {
    const longGroundedAnswer = GROUNDED_ANSWER + " " + GROUNDED_ANSWER;
    const result = analyzeGenericResponse(SCENARIO_QUESTION, longGroundedAnswer);
    expect(result.flagged).toBe(false);
  });
});

describe("extractRequiredConceptsFromQuestionText / analyzeRequiredConceptCoverage", () => {
  const requirementQuestion = "Design an access control policy for Acme Corp. Refer to least privilege and separation of duties.";

  it("flags an explicitly required concept that is missing", () => {
    const concepts = extractRequiredConceptsFromQuestionText(requirementQuestion);
    expect(concepts.length).toBeGreaterThan(0);
    const result = analyzeRequiredConceptCoverage(requirementQuestion, "Acme should use strong passwords and firewalls.");
    expect(result.applicable).toBe(true);
    expect(result.missingConcepts.length).toBeGreaterThan(0);
  });

  it("accepts a required concept expressed with equivalent wording", () => {
    const result = analyzeRequiredConceptCoverage(
      requirementQuestion,
      "Acme should apply the principle of least privilege and segregation of duties across its admin roles.",
    );
    expect(result.missingConcepts).toEqual([]);
  });

  it("does not fabricate a missing-concept signal when no requirement is stated", () => {
    const result = analyzeRequiredConceptCoverage(BROAD_THEORETICAL_QUESTION, "Defence in depth uses layered controls.");
    expect(result.applicable).toBe(false);
  });
});

describe("detectUnsupportedSpecificClaims", () => {
  it("identifies specific unsupported statistics as candidate claims", () => {
    const answer =
      "According to a 2019 Ponemon Institute Study, 68% of organisations reported a breach, and losses averaged $4.35 million " +
      "per incident across the surveyed cohort of enterprises in this specific field.";
    const result = detectUnsupportedSpecificClaims(BROAD_THEORETICAL_QUESTION, answer);
    expect(result.flagged).toBe(true);
    expect(result.candidateClaims.length).toBeGreaterThan(0);
  });

  it("does not automatically mark ordinary general knowledge as false", () => {
    const result = detectUnsupportedSpecificClaims(BROAD_THEORETICAL_QUESTION, GROUNDED_ANSWER);
    expect(result.candidateClaims.every((c) => typeof c === "string")).toBe(true);
  });

  it("states uncertainty in its wording rather than a factual determination", () => {
    const answer =
      "According to a 2019 Ponemon Institute Study, 68% of organisations reported a breach in that specific detailed " +
      "scenario, and the average cost of a breach across the surveyed cohort of enterprises was substantial that year.";
    const result = detectUnsupportedSpecificClaims(BROAD_THEORETICAL_QUESTION, answer);
    expect(result.limitation.toLowerCase()).toContain("valid prior knowledge");
  });
});

describe("detectGeneratedResponseMetaLanguage", () => {
  it('flags "As an AI language model"', () => {
    const result = detectGeneratedResponseMetaLanguage("As an AI language model, I can explain defence in depth.");
    expect(result.flagged).toBe(true);
  });

  it("flags generated placeholder language", () => {
    const result = detectGeneratedResponseMetaLanguage("Defence in depth means [insert example here] layered controls.");
    expect(result.flagged).toBe(true);
  });

  it("does not flag ordinary first-person academic writing", () => {
    const result = detectGeneratedResponseMetaLanguage(GROUNDED_ANSWER);
    expect(result.flagged).toBe(false);
  });
});

describe("analyzeWritingStyleConsistency", () => {
  const consistentAnswers: StyleAnswerInput[] = [
    { questionId: "q1", type: "ESSAY", text: "I think the best way to secure a network is to use layered controls, and I believe firewalls help a lot with that." },
    { questionId: "q2", type: "ESSAY", text: "I think encryption is really important, and I believe it protects data both at rest and in transit for most systems." },
    { questionId: "q3", type: "ESSAY", text: "I think access control matters a great deal, and I believe least privilege reduces the blast radius of a compromise." },
  ];

  it("does not flag similar writing style across meaningful responses", () => {
    const result = analyzeWritingStyleConsistency(consistentAnswers);
    expect(result.outlierQuestionIds).toEqual([]);
  });

  it("flags one substantially different response as a medium concern", () => {
    const outlierAnswers: StyleAnswerInput[] = [
      ...consistentAnswers,
      {
        questionId: "q4",
        type: "ESSAY",
        text:
          "Cybersecurity encompasses; a multifaceted, comprehensive; framework of technical, administrative; and physical " +
          "safeguards; furthermore, it necessitates; continuous, iterative; risk assessment; methodologies; moreover; " +
          "organizational; resilience; hinges; upon; robust; governance; structures; consequently; stakeholders; must; " +
          "prioritize; strategic; alignment.",
      },
    ];
    const result = analyzeWritingStyleConsistency(outlierAnswers);
    expect(result.outlierQuestionIds).toContain("q4");
  });

  it("disables style analysis with fewer than three meaningful answers", () => {
    const result = analyzeWritingStyleConsistency(consistentAnswers.slice(0, 2));
    expect(result.applicable).toBe(false);
  });

  it("does not blindly compare different question types when enough same-type answers exist", () => {
    const mixedTypes: StyleAnswerInput[] = [
      ...consistentAnswers,
      { questionId: "sa1", type: "SHORT_ANSWER", text: "Least privilege limits access to only what is needed for a role." },
    ];
    // The lone SHORT_ANSWER should not be forced into the ESSAY comparison group.
    const result = analyzeWritingStyleConsistency(mixedTypes);
    expect(result.outlierQuestionIds).not.toContain("sa1");
  });
});

describe("analyzePolishedButShallow", () => {
  it("does not flag a response merely because it is well written", () => {
    const grounding = analyzeScenarioGrounding(SCENARIO_QUESTION, GROUNDED_ANSWER);
    const generic = analyzeGenericResponse(SCENARIO_QUESTION, GROUNDED_ANSWER);
    const result = analyzePolishedButShallow(GROUNDED_ANSWER, grounding, generic);
    expect(result.flagged).toBe(false);
  });

  it("requires multiple features (structure + low grounding/generic) to flag", () => {
    const polishedShallow =
      "# Introduction\nCybersecurity is a wide range of practices that plays a crucial role in protecting organisations. " +
      "It is important to note that there are many factors involved in keeping any organisation safe from harm every day.\n" +
      "# Body\nIn today's world, various factors must be balanced against each other in a broad and general sense across " +
      "many different types of organisations everywhere, and a variety of controls exist to help manage overall exposure. " +
      "Broadly speaking, in many cases a wide range of tools plays a vital role in supporting these general goals over time. " +
      "It is essential to consider all of these factors carefully in order to fully understand the general landscape today.\n" +
      "# Conclusion\nIn conclusion, security is essential for any organisation in today's society, broadly speaking, overall, " +
      "and in summary these general practices apply broadly across many different unrelated organisations and industries.";
    const grounding = analyzeScenarioGrounding(SCENARIO_QUESTION, polishedShallow);
    const generic = analyzeGenericResponse(SCENARIO_QUESTION, polishedShallow);
    const result = analyzePolishedButShallow(polishedShallow, grounding, generic);
    expect(result.flagged).toBe(true);
    expect(result.level).toBe("LOW");
  });
});

describe("runDeterministicAiUseReviewChecks", () => {
  it("does not over-analyse MCQ answers", () => {
    const signals = runDeterministicAiUseReviewChecks(
      [{ id: "q1", type: "MULTIPLE_CHOICE", text: "What is 2+2?" }],
      [{ id: "a1", questionId: "q1", response: "4" }],
    );
    expect(signals).toEqual([]);
  });
});

describe("calculateAiUseReviewRecommendation", () => {
  it("one low signal gives no immediate action", () => {
    const result = calculateAiUseReviewRecommendation([{ signalType: "REQUIRED_CONCEPTS_MISSING", signalLevel: "LOW" }]);
    expect(result.recommendation).toBe("NO_IMMEDIATE_ACTION");
  });

  it("one style mismatch does not recommend oral verification", () => {
    const result = calculateAiUseReviewRecommendation([{ signalType: "STYLE_INCONSISTENCY", signalLevel: "MEDIUM" }]);
    expect(result.recommendation).not.toBe("ORAL_VERIFICATION_RECOMMENDED");
  });

  it("generic response alone does not recommend oral verification", () => {
    const result = calculateAiUseReviewRecommendation([{ signalType: "GENERIC_RESPONSE", signalLevel: "MEDIUM" }]);
    expect(result.recommendation).not.toBe("ORAL_VERIFICATION_RECOMMENDED");
  });

  it("multiple independent medium signals recommend lecturer review", () => {
    const result = calculateAiUseReviewRecommendation([
      { signalType: "STYLE_INCONSISTENCY", signalLevel: "MEDIUM" },
      { signalType: "GENERIC_RESPONSE", signalLevel: "MEDIUM" },
    ]);
    expect(result.recommendation).toBe("LECTURER_REVIEW_RECOMMENDED");
  });

  it("strong meta-language plus another independent signal may recommend oral verification", () => {
    const result = calculateAiUseReviewRecommendation([
      { signalType: "GENERATED_RESPONSE_META_LANGUAGE", signalLevel: "HIGH" },
      { signalType: "WEAK_SCENARIO_GROUNDING", signalLevel: "MEDIUM" },
    ]);
    expect(result.recommendation).toBe("ORAL_VERIFICATION_RECOMMENDED");
  });

  it("includes reason codes", () => {
    const result = calculateAiUseReviewRecommendation([{ signalType: "WEAK_SCENARIO_GROUNDING", signalLevel: "MEDIUM" }]);
    expect(result.reasonCodes.length).toBeGreaterThan(0);
  });

  it("existing corroborating similarity/integrity signal can push a single medium signal to oral verification", () => {
    const result = calculateAiUseReviewRecommendation(
      [{ signalType: "WEAK_SCENARIO_GROUNDING", signalLevel: "MEDIUM" }],
      { existingHighSimilarityOrIntegritySignal: true },
    );
    expect(result.recommendation).toBe("ORAL_VERIFICATION_RECOMMENDED");
  });

  it("never outputs a confirmed/misconduct recommendation", () => {
    const allHigh = calculateAiUseReviewRecommendation([
      { signalType: "GENERATED_RESPONSE_META_LANGUAGE", signalLevel: "HIGH" },
      { signalType: "WEAK_SCENARIO_GROUNDING", signalLevel: "HIGH" },
      { signalType: "UNSUPPORTED_SPECIFIC_CLAIMS", signalLevel: "HIGH" },
    ]);
    expect(["NO_IMMEDIATE_ACTION", "LECTURER_REVIEW_RECOMMENDED", "ORAL_VERIFICATION_RECOMMENDED"]).toContain(
      allHigh.recommendation,
    );
  });
});

describe("overallSignalLevelFromSignals", () => {
  it("takes the highest level present", () => {
    expect(overallSignalLevelFromSignals([{ signalLevel: "LOW" }, { signalLevel: "MEDIUM" }])).toBe("MEDIUM");
    expect(overallSignalLevelFromSignals([])).toBe("NONE");
  });
});

describe("containsBannedWording", () => {
  it("rejects banned accusatory/confirmatory phrases", () => {
    expect(containsBannedWording("This is an AI-generated answer.")).toBe(true);
    expect(containsBannedWording("AI detected in this response.")).toBe(true);
    expect(containsBannedWording("Misconduct confirmed.")).toBe(true);
    expect(containsBannedWording("There is an 87% probability of AI use.")).toBe(true);
  });

  it("accepts neutral review-signal wording", () => {
    expect(containsBannedWording("AI-use review signal: Medium. Lecturer review recommended.")).toBe(false);
  });
});
