import { describe, it, expect, vi } from "vitest";

// Entirely mocked — no real Prisma client, no disposable database
// required; runs under the ordinary `npm test`. Only the pure functions
// below (evaluateInstitutionEntitlement, canInstitutionDeliverAssessments,
// canInstitutionUseFeature, institutionAccessStatusMessage,
// mapLegacyInstitutionToEntitlementInput, defaultInstitutionEntitlementInput,
// sanitizeInstitutionEntitlementForNonAdmin) are exercised here — the
// DB-touching functions (getInstitutionEntitlement, getInstitutionUsage,
// upsertInstitutionEntitlement, ...) are covered by the DB-backed route
// tests in institutionEntitlement.routes.test.ts instead. Mocking
// "@/lib/prisma" avoids importing the real client at all, so this file
// never hits prisma.ts's DATABASE_URL safety guard (see
// submissionFinalization.unit.test.ts for the same pattern).
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  evaluateInstitutionEntitlement,
  canInstitutionDeliverAssessments,
  canInstitutionUseFeature,
  institutionAccessStatusMessage,
  mapLegacyInstitutionToEntitlementInput,
  defaultInstitutionEntitlementInput,
  sanitizeInstitutionEntitlementForNonAdmin,
  validateEntitlementInput,
  type InstitutionEntitlementRecord,
} from "./institutionEntitlement";
import { isAcademicAttempt, ACADEMIC_ATTEMPT_STATUSES } from "./assessmentLifecycle";

const NOW = new Date("2026-06-15T00:00:00.000Z");

function row(overrides: Partial<InstitutionEntitlementRecord>): InstitutionEntitlementRecord {
  return {
    accessType: "PAID",
    status: "ACTIVE",
    startsAt: null,
    endsAt: null,
    graceEndsAt: null,
    candidateLimit: null,
    attemptLimit: null,
    secureBrowserEnabled: true,
    aiBrainstormingEnabled: true,
    aiMarkingEnabled: true,
    analyticsEnabled: true,
    advancedReportingEnabled: true,
    ...overrides,
  };
}

describe("evaluateInstitutionEntitlement — status/date derivation (section 3/22)", () => {
  it("1. ACTIVE TRIAL before expiry -> ACTIVE (allowed)", () => {
    const evaluated = evaluateInstitutionEntitlement(row({ accessType: "TRIAL", status: "ACTIVE", endsAt: new Date("2026-11-30") }), NOW);
    expect(evaluated.effectiveStatus).toBe("ACTIVE");
    expect(canInstitutionDeliverAssessments(evaluated)).toEqual({ allowed: true });
  });

  it("2. ACTIVE TRIAL after endsAt -> EXPIRED (denied), even though stored status still says ACTIVE", () => {
    const evaluated = evaluateInstitutionEntitlement(row({ accessType: "TRIAL", status: "ACTIVE", endsAt: new Date("2026-01-01") }), NOW);
    expect(evaluated.effectiveStatus).toBe("EXPIRED");
    expect(canInstitutionDeliverAssessments(evaluated)).toEqual({ allowed: false, reason: "ENTITLEMENT_EXPIRED" });
  });

  it("3. indefinite TRIAL (endsAt: null) -> ACTIVE (allowed)", () => {
    const evaluated = evaluateInstitutionEntitlement(row({ accessType: "TRIAL", status: "ACTIVE", endsAt: null }), NOW);
    expect(evaluated.effectiveStatus).toBe("ACTIVE");
  });

  it("4. ACTIVE FREE with no expiry -> ACTIVE (allowed)", () => {
    const evaluated = evaluateInstitutionEntitlement(row({ accessType: "FREE", status: "ACTIVE", endsAt: null }), NOW);
    expect(evaluated.effectiveStatus).toBe("ACTIVE");
    expect(canInstitutionDeliverAssessments(evaluated).allowed).toBe(true);
  });

  it("5. time-limited FREE before expiry -> ACTIVE (allowed)", () => {
    const evaluated = evaluateInstitutionEntitlement(row({ accessType: "FREE", status: "ACTIVE", endsAt: new Date("2026-12-31") }), NOW);
    expect(evaluated.effectiveStatus).toBe("ACTIVE");
  });

  it("6. time-limited FREE after expiry -> EXPIRED (denied) — FREE never silently converts to PAID/TRIAL", () => {
    const evaluated = evaluateInstitutionEntitlement(row({ accessType: "FREE", status: "ACTIVE", endsAt: new Date("2026-01-01") }), NOW);
    expect(evaluated.effectiveStatus).toBe("EXPIRED");
    expect(evaluated.entitlement?.accessType).toBe("FREE");
  });

  it("7. ACTIVE PAID -> allowed", () => {
    const evaluated = evaluateInstitutionEntitlement(row({ accessType: "PAID", status: "ACTIVE" }), NOW);
    expect(canInstitutionDeliverAssessments(evaluated)).toEqual({ allowed: true });
  });

  it("8. SUSPENDED PAID -> denied, even with a future endsAt and no startsAt restriction (explicit admin action always wins)", () => {
    const evaluated = evaluateInstitutionEntitlement(row({ accessType: "PAID", status: "SUSPENDED", endsAt: new Date("2027-01-01") }), NOW);
    expect(evaluated.effectiveStatus).toBe("SUSPENDED");
    expect(canInstitutionDeliverAssessments(evaluated)).toEqual({ allowed: false, reason: "ENTITLEMENT_SUSPENDED" });
  });

  it("9. GRACE -> no new attempt (denied), distinct reason from SUSPENDED/EXPIRED", () => {
    const evaluated = evaluateInstitutionEntitlement(row({ accessType: "PAID", status: "GRACE", graceEndsAt: new Date("2027-01-14") }), NOW);
    expect(evaluated.effectiveStatus).toBe("GRACE");
    expect(canInstitutionDeliverAssessments(evaluated)).toEqual({ allowed: false, reason: "ENTITLEMENT_GRACE_PERIOD" });
  });

  it("GRACE whose graceEndsAt has passed -> EXPIRED (grace is not indefinite)", () => {
    const evaluated = evaluateInstitutionEntitlement(row({ status: "GRACE", graceEndsAt: new Date("2026-01-01") }), NOW);
    expect(evaluated.effectiveStatus).toBe("EXPIRED");
  });

  it("10. INTERNAL active -> allowed", () => {
    const evaluated = evaluateInstitutionEntitlement(row({ accessType: "INTERNAL", status: "ACTIVE" }), NOW);
    expect(canInstitutionDeliverAssessments(evaluated)).toEqual({ allowed: true });
  });

  it("11. future startsAt -> NOT_STARTED (denied), regardless of endsAt", () => {
    const evaluated = evaluateInstitutionEntitlement(row({ status: "ACTIVE", startsAt: new Date("2027-01-01") }), NOW);
    expect(evaluated.effectiveStatus).toBe("NOT_STARTED");
    expect(canInstitutionDeliverAssessments(evaluated)).toEqual({ allowed: false, reason: "ENTITLEMENT_NOT_STARTED" });
  });

  it("PAID + SUSPENDED = no new delivery access, even though PAID alone would otherwise be fine (section 2 worked example)", () => {
    const evaluated = evaluateInstitutionEntitlement(row({ accessType: "PAID", status: "SUSPENDED" }), NOW);
    expect(canInstitutionDeliverAssessments(evaluated).allowed).toBe(false);
  });

  it("stored status EXPIRED with endsAt still in the future -> still EXPIRED (an admin can mark this directly)", () => {
    const evaluated = evaluateInstitutionEntitlement(row({ status: "EXPIRED", endsAt: new Date("2027-01-01") }), NOW);
    expect(evaluated.effectiveStatus).toBe("EXPIRED");
  });

  it("no entitlement row at all -> ACTIVE (migration-safety fallback, documented in the file's own doc comment)", () => {
    const evaluated = evaluateInstitutionEntitlement(null, NOW);
    expect(evaluated.effectiveStatus).toBe("ACTIVE");
    expect(canInstitutionDeliverAssessments(evaluated)).toEqual({ allowed: true });
  });
});

describe("canInstitutionUseFeature — independent of general status (section 5/7)", () => {
  it("18. feature enabled -> allowed", () => {
    expect(canInstitutionUseFeature(row({ aiMarkingEnabled: true }), "AI_MARKING")).toEqual({ allowed: true });
  });

  it("19. feature disabled -> denied with FEATURE_NOT_ENTITLED", () => {
    expect(canInstitutionUseFeature(row({ aiMarkingEnabled: false }), "AI_MARKING")).toEqual({ allowed: false, reason: "FEATURE_NOT_ENTITLED" });
  });

  it("a SUSPENDED institution's feature flags are still consulted independently — feature check alone never denies for status reasons", () => {
    // canInstitutionUseFeature only ever reads the flag itself; a caller
    // that also cares about general status calls
    // requireInstitutionEntitlement separately (see the route-level
    // tests) — this function must never fold status into its answer.
    expect(canInstitutionUseFeature(row({ status: "SUSPENDED", analyticsEnabled: true }), "ANALYTICS")).toEqual({ allowed: true });
  });

  it("no entitlement row -> every feature defaults to enabled (migration-safety fallback)", () => {
    expect(canInstitutionUseFeature(null, "ADVANCED_REPORTING")).toEqual({ allowed: true });
  });
});

describe("institutionAccessStatusMessage — neutral institution-user-facing text (section 16)", () => {
  it("unrestricted ACTIVE PAID -> no banner needed (null)", () => {
    expect(institutionAccessStatusMessage(evaluateInstitutionEntitlement(row({ accessType: "PAID" }), NOW))).toBeNull();
  });

  it("ACTIVE TRIAL with an end date -> names the date, never mentions payment/contract status", () => {
    const msg = institutionAccessStatusMessage(evaluateInstitutionEntitlement(row({ accessType: "TRIAL", endsAt: new Date("2026-11-30") }), NOW));
    expect(msg).toContain("Trial access");
    expect(msg).not.toMatch(/paid|payment|invoice|contract|suspend/i);
  });

  it("SUSPENDED -> neutral inactive message, no payment/contract wording", () => {
    const msg = institutionAccessStatusMessage(evaluateInstitutionEntitlement(row({ status: "SUSPENDED" }), NOW));
    expect(msg).toMatch(/currently inactive/i);
    expect(msg).not.toMatch(/paid|payment|invoice|hasn't paid|suspended/i);
  });
});

describe("mapLegacyInstitutionToEntitlementInput — migration/backfill safety (section 4/22.27)", () => {
  it("plan='pilot', active=true -> TRIAL/ACTIVE, unlimited, no expiry, every feature on (never locks out an existing pilot institution)", () => {
    const mapped = mapLegacyInstitutionToEntitlementInput({ plan: "pilot", active: true });
    expect(mapped.accessType).toBe("TRIAL");
    expect(mapped.status).toBe("ACTIVE");
    expect(mapped.endsAt).toBeNull();
    expect(mapped.candidateLimit).toBeNull();
    expect(mapped.attemptLimit).toBeNull();
    expect(mapped.secureBrowserEnabled).toBe(true);
    expect(mapped.aiBrainstormingEnabled).toBe(true);
    expect(mapped.aiMarkingEnabled).toBe(true);
    expect(mapped.analyticsEnabled).toBe(true);
    expect(mapped.advancedReportingEnabled).toBe(true);

    const evaluated = evaluateInstitutionEntitlement(mapped, NOW);
    expect(evaluated.effectiveStatus).toBe("ACTIVE");
    expect(canInstitutionDeliverAssessments(evaluated).allowed).toBe(true);
  });

  it("plan='pilot', active=false -> SUSPENDED, preserving the legacy deactivation exactly", () => {
    const mapped = mapLegacyInstitutionToEntitlementInput({ plan: "pilot", active: false });
    expect(mapped.status).toBe("SUSPENDED");
    const evaluated = evaluateInstitutionEntitlement(mapped, NOW);
    expect(evaluated.effectiveStatus).toBe("SUSPENDED");
  });

  it("a non-pilot plan maps to PAID, still unlimited/no-expiry/all-features (never invents a restriction the legacy row never had)", () => {
    const mapped = mapLegacyInstitutionToEntitlementInput({ plan: "standard", active: true });
    expect(mapped.accessType).toBe("PAID");
    expect(mapped.endsAt).toBeNull();
    expect(mapped.candidateLimit).toBeNull();
  });
});

describe("defaultInstitutionEntitlementInput — new-institution default (section 20)", () => {
  it("TRIAL/ACTIVE, no invented expiry, unlimited, every feature on", () => {
    const def = defaultInstitutionEntitlementInput();
    expect(def.accessType).toBe("TRIAL");
    expect(def.status).toBe("ACTIVE");
    expect(def.endsAt).toBeNull();
    expect(def.startsAt).toBeNull();
    expect(def.candidateLimit).toBeNull();
    expect(def.attemptLimit).toBeNull();
    expect(def.secureBrowserEnabled).toBe(true);
    expect(def.aiBrainstormingEnabled).toBe(true);
    expect(def.aiMarkingEnabled).toBe(true);
    expect(def.analyticsEnabled).toBe(true);
    expect(def.advancedReportingEnabled).toBe(true);
  });
});

describe("sanitizeInstitutionEntitlementForNonAdmin — internalNotes never leaks (section 6/11/16/22.26)", () => {
  it("strips internalNotes while preserving every other field", () => {
    const full = { ...row({}), id: "e1", internalNotes: "Signed a 3-year contract at a discount — do not mention to the lecturer." };
    const sanitized = sanitizeInstitutionEntitlementForNonAdmin(full);
    expect(sanitized).not.toHaveProperty("internalNotes");
    expect(JSON.stringify(sanitized)).not.toMatch(/discount|contract/i);
    expect(sanitized.accessType).toBe(full.accessType);
    expect(sanitized.id).toBe("e1");
  });
});

describe("ACADEMIC_ATTEMPT_STATUSES stays in sync with isAcademicAttempt (regression guard for the commercial attempt-limit counting query)", () => {
  it("every SubmissionStatus value agrees between the literal array and the predicate", () => {
    const allStatuses = ["IN_PROGRESS", "SUBMITTED", "GRADED", "VOIDED"] as const;
    for (const status of allStatuses) {
      expect((ACADEMIC_ATTEMPT_STATUSES as readonly string[]).includes(status)).toBe(isAcademicAttempt(status));
    }
  });
});

describe("validateEntitlementInput — server-side logical validation (hardening pass, section 9/14)", () => {
  function validInput(overrides: Partial<ReturnType<typeof defaultInstitutionEntitlementInput>> = {}) {
    return { ...defaultInstitutionEntitlementInput(), ...overrides };
  }

  it("a fully valid input produces no errors", () => {
    expect(validateEntitlementInput(validInput())).toEqual([]);
  });

  it("endsAt earlier than startsAt is rejected", () => {
    const errors = validateEntitlementInput(validInput({ startsAt: new Date("2026-06-01"), endsAt: new Date("2026-05-01") }));
    expect(errors.some((e) => e.field === "endsAt")).toBe(true);
  });

  it("endsAt equal to or after startsAt is accepted", () => {
    expect(validateEntitlementInput(validInput({ startsAt: new Date("2026-06-01"), endsAt: new Date("2026-06-01") }))).toEqual([]);
    expect(validateEntitlementInput(validInput({ startsAt: new Date("2026-06-01"), endsAt: new Date("2026-07-01") }))).toEqual([]);
  });

  it("GRACE status with no graceEndsAt is rejected — grace is never indefinite", () => {
    const errors = validateEntitlementInput(validInput({ status: "GRACE", graceEndsAt: null }));
    expect(errors.some((e) => e.field === "graceEndsAt")).toBe(true);
  });

  it("GRACE status WITH a graceEndsAt is accepted", () => {
    expect(validateEntitlementInput(validInput({ status: "GRACE", graceEndsAt: new Date("2027-01-14") }))).toEqual([]);
  });

  it("non-GRACE status never requires graceEndsAt", () => {
    expect(validateEntitlementInput(validInput({ status: "ACTIVE", graceEndsAt: null }))).toEqual([]);
  });

  it("graceEndsAt earlier than endsAt is rejected", () => {
    const errors = validateEntitlementInput(
      validInput({ status: "GRACE", endsAt: new Date("2027-01-01"), graceEndsAt: new Date("2026-12-01") }),
    );
    expect(errors.some((e) => e.field === "graceEndsAt")).toBe(true);
  });

  it("graceEndsAt at or after endsAt is accepted", () => {
    expect(
      validateEntitlementInput(validInput({ status: "GRACE", endsAt: new Date("2027-01-01"), graceEndsAt: new Date("2027-01-14") })),
    ).toEqual([]);
  });

  it("negative or zero candidateLimit is rejected", () => {
    expect(validateEntitlementInput(validInput({ candidateLimit: -1 })).some((e) => e.field === "candidateLimit")).toBe(true);
    expect(validateEntitlementInput(validInput({ candidateLimit: 0 })).some((e) => e.field === "candidateLimit")).toBe(true);
  });

  it("negative or zero attemptLimit is rejected", () => {
    expect(validateEntitlementInput(validInput({ attemptLimit: -1 })).some((e) => e.field === "attemptLimit")).toBe(true);
    expect(validateEntitlementInput(validInput({ attemptLimit: 0 })).some((e) => e.field === "attemptLimit")).toBe(true);
  });

  it("a positive candidateLimit/attemptLimit is accepted", () => {
    expect(validateEntitlementInput(validInput({ candidateLimit: 50, attemptLimit: 200 }))).toEqual([]);
  });

  it("null candidateLimit/attemptLimit (unlimited) is always accepted", () => {
    expect(validateEntitlementInput(validInput({ candidateLimit: null, attemptLimit: null }))).toEqual([]);
  });

  it("returns every violation found, not just the first", () => {
    const errors = validateEntitlementInput(
      validInput({ startsAt: new Date("2026-06-01"), endsAt: new Date("2026-05-01"), candidateLimit: -5, attemptLimit: -5 }),
    );
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});
