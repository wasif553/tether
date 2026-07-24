import { describe, it, expect } from "vitest";
import {
  isMeaningfulText,
  isLargePaste,
  classifyChange,
  isPastedTextSubstantiallyReplaced,
  decideCheckpoint,
  shouldSuppressForCapacity,
  computeProcessObservations,
  toStudentSafeVersionSummary,
  ALWAYS_PRESERVED_CHANGE_TYPES,
  isValidChangeType,
  isValidCheckpointSource,
  isValidDevelopmentEventType,
  isValidArtifactType,
  isValidEventLevel,
} from "./answerDevelopment";
import { buildAnswerProvenancePolicySnapshot } from "./answerProvenancePolicy";

const policy = buildAnswerProvenancePolicySnapshot({
  answerProvenanceMode: "BASIC",
  answerVersionIntervalSeconds: 60,
  answerVersionMinimumCharacterChange: 80,
  answerVersionMaximumPerQuestion: 40,
  capturePasteMetadata: true,
  captureDeletionRewriteMetadata: true,
  enableOutlineWorkspace: false,
  enableCalculationWorkspace: false,
  enableCodeWorkspace: false,
  captureCodeRunHistory: false,
  requireAiSourceDeclaration: false,
  allowStudentDevelopmentReview: true,
});

describe("validated string guards", () => {
  it("accept only known values", () => {
    expect(isValidChangeType("INITIAL_TEXT")).toBe(true);
    expect(isValidChangeType("NOT_A_TYPE")).toBe(false);
    expect(isValidCheckpointSource("AUTOSAVE")).toBe(true);
    expect(isValidCheckpointSource("BOGUS")).toBe(false);
    expect(isValidDevelopmentEventType("PASTE_INSERTED")).toBe(true);
    expect(isValidDevelopmentEventType("KEYSTROKE_LOGGED")).toBe(false);
    expect(isValidArtifactType("OUTLINE")).toBe(true);
    expect(isValidArtifactType("SCREENSHOT")).toBe(false);
    expect(isValidEventLevel("REVIEW_CONTEXT")).toBe(true);
    expect(isValidEventLevel("MISCONDUCT")).toBe(false);
  });
});

describe("isMeaningfulText / isLargePaste", () => {
  it("meaningful text requires >=10 non-whitespace characters", () => {
    expect(isMeaningfulText("short")).toBe(false);
    expect(isMeaningfulText("this is long enough")).toBe(true);
    expect(isMeaningfulText("   \n\t   ")).toBe(false);
  });
  it("large paste requires >=100 inserted characters", () => {
    expect(isLargePaste(99)).toBe(false);
    expect(isLargePaste(100)).toBe(true);
  });
});

describe("classifyChange", () => {
  it("classifies substantial edit / large deletion / major rewrite independently", () => {
    expect(classifyChange({ charactersAdded: 0, charactersRemoved: 0, changeRatio: 0, removedRatio: 0 }).isSubstantialEdit).toBe(false);
    expect(classifyChange({ charactersAdded: 130, charactersRemoved: 0, changeRatio: 0.05, removedRatio: 0 }).isSubstantialEdit).toBe(true);
    expect(classifyChange({ charactersAdded: 0, charactersRemoved: 0, changeRatio: 0.3, removedRatio: 0 }).isSubstantialEdit).toBe(true);
    expect(classifyChange({ charactersAdded: 0, charactersRemoved: 150, changeRatio: 0.5, removedRatio: 0.5 }).isLargeDeletion).toBe(true);
    expect(classifyChange({ charactersAdded: 0, charactersRemoved: 10, changeRatio: 0.1, removedRatio: 0.1 }).isLargeDeletion).toBe(false);
    expect(classifyChange({ charactersAdded: 0, charactersRemoved: 0, changeRatio: 0.6, removedRatio: 0.6 }).isMajorRewrite).toBe(true);
    expect(classifyChange({ charactersAdded: 0, charactersRemoved: 0, changeRatio: 0.4, removedRatio: 0.4 }).isMajorRewrite).toBe(false);
  });
});

describe("isPastedTextSubstantiallyReplaced", () => {
  it("uses the 60% threshold", () => {
    expect(isPastedTextSubstantiallyReplaced(0.59)).toBe(false);
    expect(isPastedTextSubstantiallyReplaced(0.6)).toBe(true);
  });
});

describe("decideCheckpoint", () => {
  const base = { policy, nowMs: 1_000_000, lastCheckpointAtMs: null as number | null };

  it("never creates a version when the normalised response is unchanged", () => {
    const decision = decideCheckpoint({
      ...base,
      priorText: "hello world",
      currentText: "hello   world",
      requestedSource: "AUTOSAVE",
    });
    expect(decision.shouldCreate).toBe(false);
    expect(decision.reasonCode).toBe("UNCHANGED");
  });

  it("creates INITIAL_TEXT for the first meaningful answer", () => {
    const decision = decideCheckpoint({
      ...base,
      priorText: null,
      currentText: "this is a meaningful first answer",
      requestedSource: "AUTOSAVE",
    });
    expect(decision.shouldCreate).toBe(true);
    expect(decision.changeType).toBe("INITIAL_TEXT");
  });

  it("does not create a checkpoint for text below the meaningful threshold", () => {
    const decision = decideCheckpoint({ ...base, priorText: null, currentText: "hi", requestedSource: "AUTOSAVE" });
    expect(decision.shouldCreate).toBe(false);
    expect(decision.reasonCode).toBe("NOT_YET_MEANINGFUL");
  });

  it("creates POST_PASTE_CHECKPOINT for a large paste regardless of interval", () => {
    const decision = decideCheckpoint({
      ...base,
      priorText: "an existing meaningful answer that already has content",
      currentText: "an existing meaningful answer that already has content" + "x".repeat(150),
      requestedSource: "PASTE",
      pasteInsertedChars: 150,
    });
    expect(decision.shouldCreate).toBe(true);
    expect(decision.changeType).toBe("POST_PASTE_CHECKPOINT");
  });

  it("creates SUBSTANTIAL_EDIT when the change ratio/size crosses the threshold", () => {
    const prior = "word ".repeat(40).trim();
    const decision = decideCheckpoint({
      ...base,
      priorText: prior,
      currentText: prior + " " + "extra ".repeat(30).trim(),
      requestedSource: "AUTOSAVE",
    });
    expect(decision.shouldCreate).toBe(true);
    expect(decision.changeType).toBe("SUBSTANTIAL_EDIT");
  });

  it("TIMER/AUTOSAVE source only checkpoints once interval elapsed AND minimum change reached", () => {
    // Long prior text so an ~90-character addition stays well below the
    // SUBSTANTIAL_EDIT ratio threshold (0.25) while still exceeding the
    // policy's minimumCharacterChange (80) — isolates the PERIODIC path
    // from the SUBSTANTIAL_EDIT path, which is checked first.
    const prior = "word ".repeat(100).trim();
    const smallChange = prior + " a bit"; // small, below minimumCharacterChange
    const notElapsed = decideCheckpoint({
      ...base,
      priorText: prior,
      currentText: smallChange,
      requestedSource: "TIMER",
      lastCheckpointAtMs: base.nowMs - 1000, // interval not elapsed
    });
    expect(notElapsed.shouldCreate).toBe(false);

    const elapsedButTooSmall = decideCheckpoint({
      ...base,
      priorText: prior,
      currentText: smallChange,
      requestedSource: "TIMER",
      lastCheckpointAtMs: base.nowMs - 61_000,
    });
    expect(elapsedButTooSmall.shouldCreate).toBe(false);
    expect(elapsedButTooSmall.reasonCode).toBe("NOT_ENOUGH_CHANGE_YET");

    const bigEnoughChange = prior + " " + "y".repeat(90);
    const elapsedAndBigEnough = decideCheckpoint({
      ...base,
      priorText: prior,
      currentText: bigEnoughChange,
      requestedSource: "TIMER",
      lastCheckpointAtMs: base.nowMs - 61_000,
    });
    expect(elapsedAndBigEnough.shouldCreate).toBe(true);
    expect(elapsedAndBigEnough.changeType).toBe("PERIODIC_CHECKPOINT");
  });

  it("FINAL_SUBMISSION is always created, even if unchanged since the last checkpoint", () => {
    const decision = decideCheckpoint({
      ...base,
      priorText: "same text",
      currentText: "same text",
      requestedSource: "SUBMISSION",
      isFinalSubmission: true,
    });
    expect(decision.shouldCreate).toBe(true);
    expect(decision.changeType).toBe("FINAL_SUBMISSION");
  });

  it("manual checkpoints are honoured when something actually changed", () => {
    const decision = decideCheckpoint({
      ...base,
      priorText: "an existing meaningful answer",
      currentText: "an existing meaningful answer with a small addition",
      requestedSource: "STUDENT_ACTION",
      isManualCheckpoint: true,
    });
    expect(decision.shouldCreate).toBe(true);
    expect(decision.changeType).toBe("MANUAL_STUDENT_CHECKPOINT");
  });
});

describe("shouldSuppressForCapacity (Part 11 retention rule)", () => {
  it("suppresses only PERIODIC_CHECKPOINT once the max is reached", () => {
    expect(shouldSuppressForCapacity("PERIODIC_CHECKPOINT", 40, policy)).toBe(true);
    expect(shouldSuppressForCapacity("PERIODIC_CHECKPOINT", 39, policy)).toBe(false);
  });
  it("never suppresses always-preserved change types, regardless of count", () => {
    for (const changeType of ALWAYS_PRESERVED_CHANGE_TYPES) {
      expect(shouldSuppressForCapacity(changeType, 1000, policy)).toBe(false);
    }
  });
});

describe("computeProcessObservations", () => {
  it("flags minimal development data for very few checkpoints", () => {
    const obs = computeProcessObservations({
      versionCount: 1,
      substantialEditCount: 0,
      pasteEvents: [],
      outlinePrecededFinalResponse: false,
      workingPrecededFinalResponse: false,
      majorLateRewriteRatio: null,
      requireAiSourceDeclaration: false,
      hasSourceDeclaration: false,
      hasCodeTestIteration: false,
    });
    expect(obs.some((o) => o.code === "MINIMAL_DEVELOPMENT_DATA")).toBe(true);
    expect(obs.every((o) => o.recommendation === "NO_IMMEDIATE_ACTION")).toBe(true);
  });

  it("never uses violation language — every observation is one of the four defined recommendations", () => {
    const obs = computeProcessObservations({
      versionCount: 10,
      substantialEditCount: 4,
      pasteEvents: [{ insertedChars: 500, replacedRatio: 0.1 }],
      outlinePrecededFinalResponse: true,
      workingPrecededFinalResponse: true,
      majorLateRewriteRatio: 0.9,
      requireAiSourceDeclaration: false,
      hasSourceDeclaration: true,
      hasCodeTestIteration: true,
    });
    const allowed = new Set(["NO_IMMEDIATE_ACTION", "LECTURER_REVIEW", "COMPARE_WITH_SIMILARITY_EVIDENCE", "ORAL_VERIFICATION_MAY_ASSIST"]);
    for (const o of obs) {
      expect(allowed.has(o.recommendation)).toBe(true);
      expect(o.explanation.toLowerCase()).not.toMatch(/cheat|guilty|confirmed cheating|proof of misconduct|ai.generated|copied answer/);
    }
    expect(obs.some((o) => o.code === "LARGE_PASTE_RETAINED")).toBe(true);
    expect(obs.some((o) => o.code === "MAJOR_LATE_REWRITE")).toBe(true);
  });

  it("a retained large paste alone recommends comparison, never a misconduct label", () => {
    const obs = computeProcessObservations({
      versionCount: 5,
      substantialEditCount: 0,
      pasteEvents: [{ insertedChars: 300, replacedRatio: 0.05 }],
      outlinePrecededFinalResponse: false,
      workingPrecededFinalResponse: false,
      majorLateRewriteRatio: null,
      requireAiSourceDeclaration: false,
      hasSourceDeclaration: false,
      hasCodeTestIteration: false,
    });
    const pasteObs = obs.find((o) => o.code === "LARGE_PASTE_RETAINED");
    expect(pasteObs?.recommendation).toBe("COMPARE_WITH_SIMILARITY_EVIDENCE");
  });
});

describe("toStudentSafeVersionSummary", () => {
  it("never leaks a hash or any lecturer-only field", () => {
    const summary = toStudentSafeVersionSummary({
      id: "v1",
      versionNumber: 1,
      responseLength: 10,
      changeType: "INITIAL_TEXT",
      source: "AUTOSAVE",
      serverReceivedAt: new Date(),
    });
    expect(summary).not.toHaveProperty("responseHash");
    expect(summary).not.toHaveProperty("observations");
  });
});
