/**
 * Institution Entitlement & Access Control v1 — see
 * docs/institution-entitlement-v1.md.
 *
 * The ONE place that decides whether an institution may deliver new
 * assessment activity or use a licensed capability. Every server route
 * that needs an entitlement decision goes through
 * requireInstitutionEntitlement()/requireInstitutionFeature() below —
 * never re-derive status/date/limit logic at a call site (mirrors the
 * "one choke point" pattern institutionScope.ts already establishes for
 * multi-tenant scoping).
 *
 * This is NOT payment integration. InstitutionEntitlement records the
 * RESULT of a commercial decision Platform Admin already made (manually,
 * today) — it never talks to a payment provider, stores a payment
 * method, or computes billing. The architecture is meant to let a future
 * billing system write rows here without any exam-access logic changing:
 *
 *   invoice / Stripe / manual contract
 *                ↓
 *        Tether entitlement (this file + InstitutionEntitlement)
 *                ↓
 *        institution access
 *
 * CRITICAL COMMERCIAL PRINCIPLE: downloading Tether Secure Browser must
 * never grant paid-product access — entitlement belongs to the
 * institution, not the browser installer. Nothing here gates the
 * installer download; see docs/institution-entitlement-v1.md, "Secure
 * Browser download".
 *
 * MIGRATION SAFETY: an institution with NO InstitutionEntitlement row —
 * true for every institution created before this feature, until the
 * backfill in prisma/seed.ts runs against it — is treated as fully
 * ACTIVE/unlimited/all-features-enabled (see evaluateInstitutionEntitlement's
 * `entitlement === null` branch). This is a deliberate, documented
 * fail-open default so this feature can never retroactively lock out an
 * existing customer that hasn't been migrated yet — the alternative
 * (fail-closed) would turn a missing row into an outage. Once the
 * backfill has run, every real institution has an explicit row and this
 * fallback is dead code for them; it remains reachable in tests that
 * create an institution without an explicit entitlement (see
 * getOrCreateTestInstitution's own doc comment on why most tests instead
 * get an explicit row).
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { Prisma, InstitutionAccessType, InstitutionEntitlementStatus } from "@/generated/prisma/client";

export type { InstitutionAccessType, InstitutionEntitlementStatus };

/** Plain data shape — what evaluateInstitutionEntitlement actually reads. Accepts either a real Prisma row or a hand-built test fixture. */
export type InstitutionEntitlementRecord = {
  accessType: InstitutionAccessType;
  status: InstitutionEntitlementStatus;
  startsAt: Date | null;
  endsAt: Date | null;
  graceEndsAt: Date | null;
  candidateLimit: number | null;
  attemptLimit: number | null;
  secureBrowserEnabled: boolean;
  aiBrainstormingEnabled: boolean;
  aiMarkingEnabled: boolean;
  analyticsEnabled: boolean;
  advancedReportingEnabled: boolean;
};

/** The status this file/UI actually reasons about — one more state (NOT_STARTED) than the stored enum, since "startsAt in the future" is derived, never stored. */
export type EffectiveEntitlementStatus = "ACTIVE" | "SUSPENDED" | "EXPIRED" | "GRACE" | "NOT_STARTED";

export type EvaluatedEntitlement = {
  effectiveStatus: EffectiveEntitlementStatus;
  /** null only when there is genuinely no InstitutionEntitlement row (pre-migration fallback). */
  entitlement: InstitutionEntitlementRecord | null;
};

/**
 * Pure function — the ONE place effective status is derived from the
 * stored row + current time. No cron job this correctness depends on:
 * call it fresh on every request.
 *
 * Rules (see docs/institution-entitlement-v1.md for the worked examples
 * this implements):
 *  - No row at all → ACTIVE (migration-safety fallback, see file doc comment).
 *  - status === SUSPENDED → SUSPENDED, unconditionally (an explicit
 *    admin action always wins over dates).
 *  - startsAt in the future → NOT_STARTED, unconditionally.
 *  - status === GRACE → GRACE, unless graceEndsAt has passed (then EXPIRED).
 *  - endsAt has passed → EXPIRED, even if the stored status still says ACTIVE.
 *  - stored status === EXPIRED → EXPIRED (an admin can mark this directly,
 *    independent of endsAt).
 *  - otherwise → ACTIVE.
 */
export function evaluateInstitutionEntitlement(
  entitlement: InstitutionEntitlementRecord | null,
  now: Date = new Date(),
): EvaluatedEntitlement {
  if (!entitlement) {
    return { effectiveStatus: "ACTIVE", entitlement: null };
  }
  if (entitlement.status === "SUSPENDED") {
    return { effectiveStatus: "SUSPENDED", entitlement };
  }
  if (entitlement.startsAt && now < entitlement.startsAt) {
    return { effectiveStatus: "NOT_STARTED", entitlement };
  }
  if (entitlement.status === "GRACE") {
    if (entitlement.graceEndsAt && now > entitlement.graceEndsAt) {
      return { effectiveStatus: "EXPIRED", entitlement };
    }
    return { effectiveStatus: "GRACE", entitlement };
  }
  if (entitlement.endsAt && now > entitlement.endsAt) {
    return { effectiveStatus: "EXPIRED", entitlement };
  }
  if (entitlement.status === "EXPIRED") {
    return { effectiveStatus: "EXPIRED", entitlement };
  }
  return { effectiveStatus: "ACTIVE", entitlement };
}

/** Fetches the raw InstitutionEntitlement row, or null if none exists yet. Never throws for a missing row — that's the normal pre-migration/pre-onboarding state. */
export async function getInstitutionEntitlement(institutionId: string): Promise<InstitutionEntitlementRecord | null> {
  return prisma.institutionEntitlement.findUnique({ where: { institutionId } });
}

/**
 * Candidate usage V1 definition (hardening pass, section 6) — distinct
 * STUDENT users who either:
 *   (a) formally belong to the institution (User.institutionId match), OR
 *   (b) hold at least one ExamAssignment against one of the
 *       institution's exams, even with no institutionId at all — this is
 *       the standalone-exam-invite path (see
 *       src/app/api/exams/[id]/standalone-invite/accept/route.ts's own
 *       doc comment: "Never sets User.institutionId"). Without (b), a
 *       student could take a real, institution-owned exam via a
 *       standalone invite link and never once count against
 *       candidateLimit — exactly the bypass this hardening pass closes.
 * A student matching both (a) and (b) is counted once (UNION, not UNION
 * ALL, de-duplicates by construction). Never counts LECTURER/PLATFORM_ADMIN.
 * Selected-student assignment also uses ExamAssignment, so it's covered
 * by (b) too, though in practice those students are always already
 * course-enrolled institution members (assertStudentsInCourse requires
 * it) and so are already counted by (a) — (b) costs nothing extra there,
 * it just closes the standalone gap. See
 * docs/institution-entitlement-v1.md, "Candidate limit definition".
 */
export async function getInstitutionCandidateUsage(institutionId: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(DISTINCT id)::bigint AS count FROM (
      SELECT u."id" FROM "User" u
      WHERE u."institutionId" = ${institutionId} AND u."role" = 'STUDENT'
      UNION
      SELECT ea."studentId" AS id FROM "ExamAssignment" ea
      JOIN "Exam" e ON e."id" = ea."examId"
      JOIN "User" u2 ON u2."id" = ea."studentId"
      WHERE e."institutionId" = ${institutionId} AND u2."role" = 'STUDENT'
    ) AS combined_candidates
  `;
  return Number(rows[0]?.count ?? 0);
}

/**
 * True if this student already counts as a candidate for this
 * institution by getInstitutionCandidateUsage's own definition — i.e.
 * adding one more ExamAssignment/institution link for them would NOT
 * increase candidate usage. Used to decide whether a specific new
 * assignment (e.g. a standalone-invite acceptance) needs a fresh
 * candidateLimit check at all, versus a returning candidate taking a
 * second exam at the same institution.
 */
export async function isExistingCandidateForInstitution(studentId: string, institutionId: string): Promise<boolean> {
  const [member, assigned] = await Promise.all([
    prisma.user.findFirst({ where: { id: studentId, institutionId, role: "STUDENT" }, select: { id: true } }),
    prisma.examAssignment.findFirst({ where: { studentId, exam: { institutionId } }, select: { id: true } }),
  ]);
  return member != null || assigned != null;
}

/**
 * Attempt usage V1 definition (hardening pass, section 7) — every
 * non-VOIDED Submission (IN_PROGRESS, SUBMITTED, or GRADED) across every
 * exam belonging to this institution. Deliberately counts IN_PROGRESS
 * now (not just SUBMITTED/GRADED, the original v1 definition) so many
 * simultaneous active attempts reserve allowance the moment they're
 * created rather than only once they finish — otherwise an institution
 * could run unboundedly many concurrent IN_PROGRESS attempts under a
 * low attemptLimit and only discover the oversubscription retroactively.
 * A VOIDED attempt — by definition invalidated for a platform/technical
 * reason outside the student's control — never consumes commercial
 * allowance, exactly like it never consumes the per-student academic
 * limit (isAcademicAttempt/countsTowardAttemptLimit; kept as a distinct
 * definition from ACADEMIC_ATTEMPT_STATUSES on purpose — see that
 * constant's own doc comment: "is this a real result to grade/analyse"
 * (SUBMITTED/GRADED only) is a different question from "is this
 * currently consuming institution-wide commercial allowance"
 * (IN_PROGRESS too)). A resumed attempt never double-counts: /start's
 * existing-IN_PROGRESS branch returns before ever creating a second
 * Submission row, so there is only ever one row per real attempt to
 * begin with.
 */
export async function getInstitutionAttemptUsage(institutionId: string): Promise<number> {
  return prisma.submission.count({
    where: { exam: { institutionId }, status: { not: "VOIDED" } },
  });
}

export type InstitutionUsage = {
  candidateUsage: number;
  candidateLimit: number | null;
  attemptUsage: number;
  attemptLimit: number | null;
};

/** Combined usage-vs-limit snapshot for the Platform Admin institution summary (section 21). Limits of `null` mean unlimited — never rendered as a number. */
export async function getInstitutionUsage(institutionId: string): Promise<InstitutionUsage> {
  const [entitlement, candidateUsage, attemptUsage] = await Promise.all([
    getInstitutionEntitlement(institutionId),
    getInstitutionCandidateUsage(institutionId),
    getInstitutionAttemptUsage(institutionId),
  ]);
  return {
    candidateUsage,
    candidateLimit: entitlement?.candidateLimit ?? null,
    attemptUsage,
    attemptLimit: entitlement?.attemptLimit ?? null,
  };
}

// ---------------------------------------------------------------------
// Action/feature gating
// ---------------------------------------------------------------------

/**
 * Server-boundary actions that require a live entitlement check before
 * proceeding. Deliberately NOT one action per route — see
 * docs/institution-entitlement-v1.md, "Where access is enforced", for
 * the full audit of routes considered and why each was or wasn't gated.
 *
 *  - CREATE_EXAM: POST /api/exams (a lecturer creating new content).
 *  - PUBLISH_EXAM: PATCH /api/exams/[id], only on the draft→published
 *    transition (an already-published exam being edited is not new
 *    commercial activity and is never re-gated here).
 *  - START_ATTEMPT: POST /api/exams/[id]/start, only for a genuinely NEW
 *    attempt — the existing-IN_PROGRESS resume branch never reaches this
 *    check (see section 8/"in-progress exams" in the design doc).
 *  - ADD_CANDIDATE: POST /api/platform/institutions/[id]/invite-student
 *    (creating a new STUDENT user — the only point a candidate is
 *    actually "added" against the candidate limit).
 *  - INVITE_LECTURER: POST /api/platform/institutions/[id]/invite-lecturer.
 *    General gate only — lecturers are never counted against
 *    candidateLimit (candidates are students only).
 */
export type InstitutionEntitlementAction = "CREATE_EXAM" | "PUBLISH_EXAM" | "START_ATTEMPT" | "ADD_CANDIDATE" | "INVITE_LECTURER";

export type InstitutionFeature = "SECURE_BROWSER" | "AI_BRAINSTORMING" | "AI_MARKING" | "ANALYTICS" | "ADVANCED_REPORTING";

const FEATURE_FLAG_KEY: Record<InstitutionFeature, keyof InstitutionEntitlementRecord> = {
  SECURE_BROWSER: "secureBrowserEnabled",
  AI_BRAINSTORMING: "aiBrainstormingEnabled",
  AI_MARKING: "aiMarkingEnabled",
  ANALYTICS: "analyticsEnabled",
  ADVANCED_REPORTING: "advancedReportingEnabled",
};

export type InstitutionEntitlementDenialReason =
  | "ENTITLEMENT_SUSPENDED"
  | "ENTITLEMENT_EXPIRED"
  | "ENTITLEMENT_NOT_STARTED"
  | "ENTITLEMENT_GRACE_PERIOD"
  | "CANDIDATE_LIMIT_REACHED"
  | "ATTEMPT_LIMIT_REACHED"
  | "FEATURE_NOT_ENTITLED";

export type InstitutionEntitlementDecision = { allowed: true } | { allowed: false; reason: InstitutionEntitlementDenialReason };

/**
 * The general (status/date-only) gate — no limit checks. Actions that
 * only need "is this institution currently allowed to do new commercial
 * activity at all" (before any limit-specific check) go through this.
 * A GRACE institution is deliberately blocked here too: section 3/14 —
 * "by default NO new assessment attempts" during grace, though
 * historical access remains available (this function is never consulted
 * for historical/read access routes at all — see the file's routing
 * audit in the design doc).
 */
export function canInstitutionDeliverAssessments(evaluated: EvaluatedEntitlement): InstitutionEntitlementDecision {
  switch (evaluated.effectiveStatus) {
    case "ACTIVE":
      return { allowed: true };
    case "SUSPENDED":
      return { allowed: false, reason: "ENTITLEMENT_SUSPENDED" };
    case "EXPIRED":
      return { allowed: false, reason: "ENTITLEMENT_EXPIRED" };
    case "NOT_STARTED":
      return { allowed: false, reason: "ENTITLEMENT_NOT_STARTED" };
    case "GRACE":
      return { allowed: false, reason: "ENTITLEMENT_GRACE_PERIOD" };
  }
}

/**
 * Feature checks are a SEPARATE axis from status/date (section 2: "Access
 * type must NOT itself determine access"; section 5: the entitlement
 * layer only answers whether a licensed capability is authorised). A
 * SUSPENDED/EXPIRED institution's feature flags are intentionally not
 * consulted here — general status is checked independently by
 * requireInstitutionEntitlement at the actual new-activity boundary,
 * while marking/analytics/reporting on EXISTING records stay reachable
 * (section 7: "PRESERVE where safe... marking/history... reports/results
 * required for records"). No row at all → every feature defaults to
 * enabled (same migration-safety fallback as the status evaluator).
 */
export function canInstitutionUseFeature(entitlement: InstitutionEntitlementRecord | null, feature: InstitutionFeature): InstitutionEntitlementDecision {
  if (!entitlement) return { allowed: true };
  const enabled = entitlement[FEATURE_FLAG_KEY[feature]] as boolean;
  return enabled ? { allowed: true } : { allowed: false, reason: "FEATURE_NOT_ENTITLED" };
}

/** The full decision for a gated action: general status/date gate, then (only for the two actions that have one) the relevant usage limit. */
export async function evaluateInstitutionEntitlementForAction(params: {
  institutionId: string;
  action: InstitutionEntitlementAction;
}): Promise<InstitutionEntitlementDecision> {
  const entitlement = await getInstitutionEntitlement(params.institutionId);
  const evaluated = evaluateInstitutionEntitlement(entitlement, new Date());
  const base = canInstitutionDeliverAssessments(evaluated);
  if (!base.allowed) return base;

  if (params.action === "ADD_CANDIDATE" && entitlement?.candidateLimit != null) {
    const usage = await getInstitutionCandidateUsage(params.institutionId);
    if (usage >= entitlement.candidateLimit) {
      return { allowed: false, reason: "CANDIDATE_LIMIT_REACHED" };
    }
  }
  if (params.action === "START_ATTEMPT" && entitlement?.attemptLimit != null) {
    const usage = await getInstitutionAttemptUsage(params.institutionId);
    if (usage >= entitlement.attemptLimit) {
      return { allowed: false, reason: "ATTEMPT_LIMIT_REACHED" };
    }
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------
// Route-boundary helpers — never expose internalNotes; STUDENT audience
// gets deliberately neutral wording (section 17 — never reveal
// contract/payment status to a student).
// ---------------------------------------------------------------------

const STAFF_DENIAL_MESSAGE: Record<InstitutionEntitlementDenialReason, string> = {
  ENTITLEMENT_SUSPENDED: "Your institution's Tether access is currently suspended. Contact Tether support.",
  ENTITLEMENT_EXPIRED: "Your institution's Tether access has expired. Contact Tether support to renew.",
  ENTITLEMENT_NOT_STARTED: "Your institution's Tether access has not started yet.",
  ENTITLEMENT_GRACE_PERIOD: "Your institution's Tether access is in a grace period. New assessment delivery is paused; existing records remain available. Contact Tether support.",
  CANDIDATE_LIMIT_REACHED: "Your institution has reached its candidate limit for Tether. Contact Tether support to increase it.",
  ATTEMPT_LIMIT_REACHED: "Your institution has reached its assessment-attempt limit for Tether. Contact Tether support to increase it.",
  FEATURE_NOT_ENTITLED: "This feature is not enabled for your institution. Contact Tether support.",
};

const STUDENT_DENIAL_MESSAGE = "This assessment cannot be started at this time. Please contact your institution.";

const DENIAL_STATUS: Record<InstitutionEntitlementDenialReason, number> = {
  ENTITLEMENT_SUSPENDED: 403,
  ENTITLEMENT_EXPIRED: 403,
  ENTITLEMENT_NOT_STARTED: 403,
  ENTITLEMENT_GRACE_PERIOD: 403,
  // Capacity/business-rule conflicts, not authorization failures — 409
  // matches the existing convention elsewhere in this route family (e.g.
  // "No attempts remaining for this exam." in /start).
  CANDIDATE_LIMIT_REACHED: 409,
  ATTEMPT_LIMIT_REACHED: 409,
  FEATURE_NOT_ENTITLED: 403,
};

function denialResponse(reason: InstitutionEntitlementDenialReason, audience: "STUDENT" | "STAFF"): NextResponse {
  const message = audience === "STUDENT" ? STUDENT_DENIAL_MESSAGE : STAFF_DENIAL_MESSAGE[reason];
  return NextResponse.json({ error: message, code: reason }, { status: DENIAL_STATUS[reason] });
}

/**
 * Use at the top of any route that gates a genuinely NEW piece of
 * commercial activity: `const denied = await requireInstitutionEntitlement({...}); if (denied) return denied;`
 *
 * `audience: "STUDENT"` (default "STAFF") selects the neutral,
 * contract-status-free wording section 17 requires for student-facing
 * denials — never say "Your university hasn't paid" or reveal
 * suspended/expired/grace specifically to a student.
 */
export async function requireInstitutionEntitlement(params: {
  institutionId: string;
  action: InstitutionEntitlementAction;
  audience?: "STUDENT" | "STAFF";
}): Promise<NextResponse | null> {
  const decision = await evaluateInstitutionEntitlementForAction(params);
  if (decision.allowed) return null;
  return denialResponse(decision.reason, params.audience ?? "STAFF");
}

/**
 * Use at the top of any route that performs a specific licensed
 * capability ON EXISTING/HISTORICAL data (marking already-submitted
 * work, viewing an already-computed report, ...). Independent of
 * general entitlement status — see canInstitutionUseFeature's own doc
 * comment. For a route that GENERATES new licensed activity, use
 * requireInstitutionEntitlementAndFeature below instead (hardening
 * pass, section 3) — a plain feature check alone is no longer correct
 * for a NEW-activity boundary, since SUSPENDED/EXPIRED/GRACE must still
 * block new activity even when the feature flag itself is on.
 */
export async function requireInstitutionFeature(params: {
  institutionId: string;
  feature: InstitutionFeature;
  audience?: "STUDENT" | "STAFF";
}): Promise<NextResponse | null> {
  const entitlement = await getInstitutionEntitlement(params.institutionId);
  const decision = canInstitutionUseFeature(entitlement, params.feature);
  if (decision.allowed) return null;
  return denialResponse(decision.reason, params.audience ?? "STAFF");
}

/**
 * Hardening pass, section 3 — "NEW cost-bearing/licensed actions must
 * require BOTH: A. effective institution entitlement is ACTIVE, B. the
 * corresponding feature flag is enabled." A plain requireInstitutionFeature
 * check alone was insufficient here: it never looked at status at all,
 * so a SUSPENDED/EXPIRED/GRACE institution with the feature flag still
 * on (the normal case — flags don't auto-flip when status changes)
 * could keep generating NEW AI marking runs, analytics, or advanced
 * reports indefinitely. This checks status FIRST (denying with the
 * ordinary ENTITLEMENT_* reason if it fails — a GRACE/SUSPENDED
 * institution never even learns whether the feature itself was
 * licensed), then the feature flag. Fetches the entitlement row once
 * for both checks. Use ONLY for a route that generates/computes NEW
 * output — never for viewing something already generated (section 3:
 * "Do not block: previously generated AI marking results... existing
 * reports... ordinary permitted historical viewing" — those stay on
 * requireInstitutionFeature, or ungated entirely).
 */
export async function requireInstitutionEntitlementAndFeature(params: {
  institutionId: string;
  feature: InstitutionFeature;
  audience?: "STUDENT" | "STAFF";
}): Promise<NextResponse | null> {
  const entitlement = await getInstitutionEntitlement(params.institutionId);
  const evaluated = evaluateInstitutionEntitlement(entitlement, new Date());
  const statusDecision = canInstitutionDeliverAssessments(evaluated);
  if (!statusDecision.allowed) return denialResponse(statusDecision.reason, params.audience ?? "STAFF");
  const featureDecision = canInstitutionUseFeature(entitlement, params.feature);
  if (!featureDecision.allowed) return denialResponse(featureDecision.reason, params.audience ?? "STAFF");
  return null;
}

// ---------------------------------------------------------------------
// Institution-user-facing status text (section 16) — deliberately
// minimal, never exposes internalNotes/payment/contract details.
// ---------------------------------------------------------------------

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * A single neutral sentence describing current access, safe to show a
 * lecturer/institution administrator (never a student mid-exam — see
 * section 17, which uses its own, separate, even-more-neutral wording).
 * Returns null for an unrestricted ACTIVE institution (no banner
 * needed).
 */
export function institutionAccessStatusMessage(evaluated: EvaluatedEntitlement): string | null {
  const { effectiveStatus, entitlement } = evaluated;
  if (effectiveStatus === "ACTIVE") {
    if (!entitlement) return null;
    if (entitlement.accessType === "TRIAL") {
      return entitlement.endsAt ? `Trial access. Access active until ${formatDate(entitlement.endsAt)}.` : "Trial access. No end date set.";
    }
    if (entitlement.accessType === "FREE" && entitlement.endsAt) {
      return `Free access. Access active until ${formatDate(entitlement.endsAt)}.`;
    }
    return null;
  }
  return "Institution access is currently inactive. Contact your institution administrator or Tether support.";
}

// ---------------------------------------------------------------------
// Platform Admin write path — see src/app/api/platform/institutions/[id]/entitlement/route.ts.
// ---------------------------------------------------------------------

export type UpsertInstitutionEntitlementInput = {
  accessType: InstitutionAccessType;
  status: InstitutionEntitlementStatus;
  startsAt: Date | null;
  endsAt: Date | null;
  graceEndsAt: Date | null;
  candidateLimit: number | null;
  attemptLimit: number | null;
  secureBrowserEnabled: boolean;
  aiBrainstormingEnabled: boolean;
  aiMarkingEnabled: boolean;
  analyticsEnabled: boolean;
  advancedReportingEnabled: boolean;
  internalNotes: string | null;
};

/** Default entitlement for a brand-new institution (section 20): TRIAL/ACTIVE, no expiry (Platform Admin sets one explicitly), unlimited limits, every feature enabled (preserves current pilot behaviour). */
export function defaultInstitutionEntitlementInput(): UpsertInstitutionEntitlementInput {
  return {
    accessType: "TRIAL",
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
    internalNotes: null,
  };
}

/** Creates or replaces the institution's entitlement row (Platform Admin only — callers must have already checked requirePlatformAdmin). Returns the full row (internalNotes included) — callers responsible for a student/lecturer-facing response must strip it themselves; see sanitizeInstitutionEntitlementForNonAdmin. */
export async function upsertInstitutionEntitlement(
  institutionId: string,
  input: UpsertInstitutionEntitlementInput,
  client: Prisma.TransactionClient | typeof prisma = prisma,
) {
  return client.institutionEntitlement.upsert({
    where: { institutionId },
    create: { institutionId, ...input },
    update: { ...input },
  });
}

/**
 * Migration/backfill mapping (section 4) — conservative by design: NEVER
 * invents an expiry, NEVER imposes a limit, and ONLY changes `status`
 * (derived from the legacy `active` boolean). The single goal is "do not
 * break existing institutions after migration": a pre-existing
 * plan="pilot" institution keeps working exactly as before (TRIAL,
 * unlimited, no expiry, every feature on); a deactivated institution
 * stays blocked (SUSPENDED) exactly as `active: false` already blocked
 * it for the two routes that checked it. `plan` is free-text (not an
 * enum) in the legacy schema — anything other than the "pilot" default
 * is treated as PAID rather than guessed at more specifically, since
 * that's the least likely mapping to under-grant access.
 */
export function mapLegacyInstitutionToEntitlementInput(legacy: { plan: string; active: boolean }): UpsertInstitutionEntitlementInput {
  const accessType: InstitutionAccessType = legacy.plan.trim().toLowerCase() === "pilot" ? "TRIAL" : "PAID";
  return {
    accessType,
    status: legacy.active ? "ACTIVE" : "SUSPENDED",
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
    internalNotes: `Migrated from legacy plan="${legacy.plan}", active=${legacy.active} by the Institution Entitlement & Access Control v1 backfill.`,
  };
}

export class InstitutionAttemptLimitReachedError extends Error {
  constructor() {
    super("Institution attempt limit reached");
  }
}

/**
 * Hardening pass, section 7 — call INSIDE a prisma.$transaction,
 * immediately before creating the new Submission row, ONLY when the
 * institution has attemptLimit set (callers skip this entirely when
 * null — unlimited, no locking overhead for the overwhelming majority
 * of institutions). Takes a Postgres advisory transaction lock keyed on
 * the institution id first, so concurrent new-attempt-creation requests
 * for the SAME institution serialize around the count-then-create
 * sequence instead of racing past each other and collectively
 * oversubscribing the limit — mirrors finalizeSubmission's own
 * `pg_advisory_xact_lock(hashtext(id))` pattern in
 * submissionFinalization.ts for a single submission's finalization. The
 * lock is transaction-scoped — released automatically on commit or
 * rollback, never needs an explicit unlock. Throws
 * InstitutionAttemptLimitReachedError if usage has already reached the
 * limit; callers catch this INSIDE their existing try/catch, before any
 * Prisma-specific error handling (e.g. the P2002 double-submit race
 * recovery already in POST /api/exams/[id]/start).
 */
export async function reserveInstitutionAttemptAllowance(tx: Prisma.TransactionClient, institutionId: string, attemptLimit: number): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${institutionId}))`;
  const usage = await tx.submission.count({ where: { exam: { institutionId }, status: { not: "VOIDED" } } });
  if (usage >= attemptLimit) {
    throw new InstitutionAttemptLimitReachedError();
  }
}

export type EntitlementValidationError = { field: string; message: string };

/**
 * Server-side logical validation beyond basic type/shape checks
 * (hardening pass, section 9) — the Platform Admin form's own HTML
 * validation is never trusted as the only gate. Returns every violation
 * found (not just the first), so the UI can surface them together.
 * Pure and independently unit-testable from the zod schema in the
 * entitlement route, which only validates types/shape, not these
 * cross-field logical rules.
 */
export function validateEntitlementInput(input: UpsertInstitutionEntitlementInput): EntitlementValidationError[] {
  const errors: EntitlementValidationError[] = [];
  if (input.startsAt && input.endsAt && input.endsAt < input.startsAt) {
    errors.push({ field: "endsAt", message: "End date must not be before start date." });
  }
  if (input.status === "GRACE" && !input.graceEndsAt) {
    errors.push({ field: "graceEndsAt", message: "A grace period requires a grace end date — grace is a temporary state, never indefinite." });
  }
  if (input.graceEndsAt && input.endsAt && input.graceEndsAt < input.endsAt) {
    errors.push({ field: "graceEndsAt", message: "Grace end date must not be before the access end date." });
  }
  if (input.candidateLimit != null && input.candidateLimit <= 0) {
    errors.push({ field: "candidateLimit", message: "Candidate limit must be a positive number, or left empty for unlimited." });
  }
  if (input.attemptLimit != null && input.attemptLimit <= 0) {
    errors.push({ field: "attemptLimit", message: "Attempt limit must be a positive number, or left empty for unlimited." });
  }
  return errors;
}

/** Strips internalNotes — the one field that must never reach a lecturer/student response payload (section 6/11/16). */
export function sanitizeInstitutionEntitlementForNonAdmin<T extends { internalNotes?: string | null }>(entitlement: T): Omit<T, "internalNotes"> {
  const rest: Partial<T> = { ...entitlement };
  delete rest.internalNotes;
  return rest as Omit<T, "internalNotes">;
}
