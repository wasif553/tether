import { describe, it, expect } from "vitest";
import {
  ASSESSMENT_TYPES,
  ASSESSMENT_TYPE_LABELS,
  isValidAssessmentType,
  assessmentTypeRequiresMandatoryTetherPolicy,
  applyMandatoryFinalExaminationPolicy,
  isFinalExaminationPolicyEstablished,
  MANDATORY_FINAL_EXAMINATION_POLICY,
} from "./assessmentType";

describe("ASSESSMENT_TYPES / labels", () => {
  it("has exactly the four required categories", () => {
    expect([...ASSESSMENT_TYPES].sort()).toEqual(
      ["PRACTICE_OR_FORMATIVE", "QUIZ_OR_TEST", "MID_SEMESTER_EXAMINATION", "FINAL_EXAMINATION"].sort(),
    );
  });

  it("every type has a lecturer-facing label", () => {
    for (const type of ASSESSMENT_TYPES) {
      expect(ASSESSMENT_TYPE_LABELS[type]).toBeTruthy();
    }
    expect(ASSESSMENT_TYPE_LABELS.FINAL_EXAMINATION).toBe("Final examination");
  });

  it("isValidAssessmentType rejects unknown strings", () => {
    expect(isValidAssessmentType("FINAL_EXAMINATION")).toBe(true);
    expect(isValidAssessmentType("SOMETHING_ELSE")).toBe(false);
  });
});

describe("assessmentTypeRequiresMandatoryTetherPolicy", () => {
  it("is true only for FINAL_EXAMINATION", () => {
    expect(assessmentTypeRequiresMandatoryTetherPolicy("FINAL_EXAMINATION")).toBe(true);
    expect(assessmentTypeRequiresMandatoryTetherPolicy("PRACTICE_OR_FORMATIVE")).toBe(false);
    expect(assessmentTypeRequiresMandatoryTetherPolicy("QUIZ_OR_TEST")).toBe(false);
    expect(assessmentTypeRequiresMandatoryTetherPolicy("MID_SEMESTER_EXAMINATION")).toBe(false);
  });
});

const nonMandatoryDraft = {
  deliveryMode: "STANDARD_WEB" as const,
  displayPolicy: "UNRESTRICTED" as const,
  requireDisplayCheck: false,
  secureClientMaximumDisplays: 3,
};

describe("applyMandatoryFinalExaminationPolicy", () => {
  it("1. FINAL_EXAMINATION forces exactly the mandatory policy from a Standard Web draft", () => {
    const result = applyMandatoryFinalExaminationPolicy("FINAL_EXAMINATION", nonMandatoryDraft);
    expect(result.deliveryMode).toBe("TETHER_CLIENT_REQUIRED");
    expect(result.displayPolicy).toBe("SINGLE_DISPLAY_REQUIRED");
    expect(result.requireDisplayCheck).toBe(true);
    expect(result.secureClientMaximumDisplays).toBe(1);
  });

  it("2. FINAL_EXAMINATION forces the mandatory policy even from an explicit SEB_REQUIRED draft — a lecturer cannot pick a different secure client for a final exam", () => {
    const result = applyMandatoryFinalExaminationPolicy("FINAL_EXAMINATION", {
      deliveryMode: "SEB_REQUIRED" as const,
      displayPolicy: "SINGLE_DISPLAY_REQUIRED" as const,
      requireDisplayCheck: true,
      secureClientMaximumDisplays: 1,
    });
    expect(result.deliveryMode).toBe("TETHER_CLIENT_REQUIRED");
  });

  it("4. every non-final assessment type is a complete no-op, preserving whatever delivery/display settings were already there", () => {
    for (const type of ["PRACTICE_OR_FORMATIVE", "QUIZ_OR_TEST", "MID_SEMESTER_EXAMINATION"] as const) {
      const result = applyMandatoryFinalExaminationPolicy(type, nonMandatoryDraft);
      expect(result).toEqual(nonMandatoryDraft);
    }
  });

  it("preserves every OTHER field on the settings object untouched (camera/microphone/fullscreen/integrity/autosave are out of scope for this function)", () => {
    const draft = { ...nonMandatoryDraft, requireCamera: true, requireFullscreen: false, autoSubmitOnTimerEnd: true, maxAttempts: 2 };
    const result = applyMandatoryFinalExaminationPolicy("FINAL_EXAMINATION", draft);
    expect(result.requireCamera).toBe(true);
    expect(result.requireFullscreen).toBe(false);
    expect(result.autoSubmitOnTimerEnd).toBe(true);
    expect(result.maxAttempts).toBe(2);
  });

  it("MANDATORY_FINAL_EXAMINATION_POLICY matches the exact product-rule values", () => {
    expect(MANDATORY_FINAL_EXAMINATION_POLICY).toEqual({
      deliveryMode: "TETHER_CLIENT_REQUIRED",
      displayPolicy: "SINGLE_DISPLAY_REQUIRED",
      requireDisplayCheck: true,
      secureClientMaximumDisplays: 1,
    });
  });
});

describe("isFinalExaminationPolicyEstablished", () => {
  it("3/11. a final examination whose EFFECTIVE delivery mode is TETHER_CLIENT_REQUIRED has the invariant established", () => {
    expect(isFinalExaminationPolicyEstablished("FINAL_EXAMINATION", "TETHER_CLIENT_REQUIRED")).toBe(true);
  });

  it("3/11. a final examination whose effective delivery mode was downgraded away from Tether (e.g. the kill switch) does NOT have the invariant established", () => {
    expect(isFinalExaminationPolicyEstablished("FINAL_EXAMINATION", "STANDARD_WEB")).toBe(false);
    expect(isFinalExaminationPolicyEstablished("FINAL_EXAMINATION", "SEB_REQUIRED")).toBe(false);
    expect(isFinalExaminationPolicyEstablished("FINAL_EXAMINATION", "TETHER_CLIENT_OPTIONAL")).toBe(false);
  });

  it("4. non-final assessment types are always considered established, regardless of delivery mode — the invariant simply does not apply to them", () => {
    for (const type of ["PRACTICE_OR_FORMATIVE", "QUIZ_OR_TEST", "MID_SEMESTER_EXAMINATION"] as const) {
      expect(isFinalExaminationPolicyEstablished(type, "STANDARD_WEB")).toBe(true);
      expect(isFinalExaminationPolicyEstablished(type, "SEB_OPTIONAL")).toBe(true);
    }
  });
});
