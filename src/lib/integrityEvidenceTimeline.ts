/**
 * Tether Integrity Evidence Timeline v1 — see
 * docs/integrity-evidence-timeline-v1.md.
 *
 * Server-only (Prisma). RECONSTRUCTS one submission's attempt from
 * ALREADY-STORED facts across several existing tables — no new schema,
 * no new telemetry, no new capture of any kind. Tether does not
 * determine guilt here: there is no risk score, no misconduct
 * conclusion, and no evidence-completeness percentage anywhere in this
 * module or its output type.
 *
 * Same ownership + institution-scoping pattern as
 * src/lib/evidenceReport.ts (buildEvidenceReport) and
 * src/lib/aiAssistanceReview.ts (buildAiAssistanceReview) — a lecturer
 * may only build a timeline for a submission belonging to an exam THEY
 * created (or a platform admin, in the same institution).
 */
import { prisma } from "@/lib/prisma";
import { isPlatformAdmin, requireInstitutionId } from "@/lib/institutionScope";
import { labelForEventType } from "@/lib/integrityEventLabels";
import {
  EVIDENCE_REVIEW_STATUS_LABELS,
  isValidEvidenceReviewStatus,
  type EvidenceReviewStatus,
} from "@/lib/integrityReview";
import { isStaleReservation } from "@/lib/aiAssistancePolicy";
import type { Session } from "next-auth";

export class IntegrityEvidenceTimelineNotFoundError extends Error {}
export class IntegrityEvidenceTimelineForbiddenError extends Error {}

export type TimelineEventCategory =
  | "LIFECYCLE"
  | "EXAM_ACTIVITY"
  | "SECURE_ENVIRONMENT"
  | "EVIDENCE"
  | "ALLOWED_RESOURCE";

export type TimelineEventSeverity = "INFO" | "LOW" | "MEDIUM" | "HIGH";

export type TimelineEventSource = "SUBMISSION" | "ANSWER_ACTIVITY" | "INTEGRITY_EVENT" | "SECURE_CLIENT" | "AI_ASSISTANCE";

export type TimelineEvent = {
  id: string;
  timestamp: string;
  /** Client-reported time, shown only under progressive disclosure — NEVER used for ordering. Present only for IntegrityEvent rows whose occurredAt differs materially from the server-authoritative timestamp. */
  deviceReportedTimestamp?: string;
  category: TimelineEventCategory;
  label: string;
  detail?: string;
  severity: TimelineEventSeverity;
  questionId?: string;
  questionNumber?: number;
  source: TimelineEventSource;
  technicalEventType?: string;
  reviewState: { status: EvidenceReviewStatus; label: string } | null;
  evidenceAssets: Array<{ id: string; kind: string; capturedAt: string }>;
  technicalDetails?: Array<{ label: string; value: string }>;
};

export type IntegrityEvidenceTimelineSummary = {
  totalEvents: number;
  evidenceAssetCount: number;
  needsReviewCount: number;
  attemptStatus: string;
  /** Count of SessionIntegritySignal rows for this submission still NEEDS_REVIEW — not merged into `events` (see the "session/timing signals" note below). */
  relatedSessionSignals: number;
  /** Count of TimingIntegritySignal rows for this submission's TimingAnalysis still NEEDS_REVIEW. */
  relatedTimingSignals: number;
};

export type IntegrityEvidenceTimeline = {
  submissionId: string;
  student: { name: string; email: string };
  exam: { id: string; title: string };
  summary: IntegrityEvidenceTimelineSummary;
  events: TimelineEvent[];
};

// ---------------------------------------------------------------------------
// Deterministic source-rank tie-break — used only when two rows share the
// exact same server-authoritative timestamp (possible under concurrent
// writes). Never used to reorder rows with distinct timestamps.
// ---------------------------------------------------------------------------
const SOURCE_RANK: Record<TimelineEventSource, number> = {
  SUBMISSION: 0,
  INTEGRITY_EVENT: 1,
  SECURE_CLIENT: 2,
  ANSWER_ACTIVITY: 3,
  AI_ASSISTANCE: 4,
};

// A lifecycle-timestamp pair is only shown as two rows once they differ by
// at least this much — otherwise "Attempt started" and "Exam content
// unlocked" would show as two near-identical rows for the (very common)
// case of a non-secure-client attempt, where both timestamps are set in
// the same database insert.
const MATERIAL_TIMESTAMP_GAP_MS = 5_000;

// Controlled AI dedup (Section 15) — the AI runner (aiAssistanceRunner.ts)
// always creates one of these four IntegrityEvent rows immediately after
// finalizing the SAME AiAssistanceInteraction it just wrote. Showing both
// would duplicate one physical fact. AI_ASSISTANCE_LIMIT_REACHED is NOT
// suppressed: it fires only when a prompt is rejected at the reservation
// stage, before any AiAssistanceInteraction row is ever created (see
// aiAssistanceRunner.ts's recordLimitReached, only called from the
// question_limit/attempt_limit reservation branch) — there is no
// interaction to prefer instead.
const AI_ASSISTANCE_MIRRORED_INTEGRITY_EVENT_TYPES = new Set([
  "AI_ASSISTANCE_USED",
  "AI_ASSISTANCE_REQUEST_BLOCKED",
  "AI_ASSISTANCE_RESPONSE_REGENERATED",
  "AI_ASSISTANCE_REQUEST_FAILED",
]);

// Navigation dedup (generalizing Section 12's dedup principle) — both
// src/app/api/submissions/[id]/save-and-navigate/route.ts and
// src/app/api/submissions/[id]/question-progress/route.ts create an
// AnswerActivityEvent(eventType: "QUESTION_NAVIGATED") ONLY inside the
// same `if (eventType)` branch that ALSO creates the richer
// QUESTION_NAVIGATED_NEXT/_PREVIOUS/_BACK_BLOCKED IntegrityEvent for the
// identical navigation action — confirmed by reading both call sites.
// AnswerActivityEvent's QUESTION_NAVIGATED is therefore always a bare
// duplicate of an IntegrityEvent row in this codebase; IntegrityEvent
// (richer message + severity + review state) is the canonical source for
// every navigation type, including the Question Navigator's
// QUESTION_NAVIGATED_DIRECT/_BLOCKED, which has no AnswerActivityEvent
// counterpart at all.
const INCLUDED_ANSWER_ACTIVITY_EVENT_TYPES = new Set(["QUESTION_OPENED", "ANSWER_SAVED"]);

// Secure-client event allowlist (Section 11/12) — an explicit INCLUDE
// list, not an exclude list, so every launch/preflight/key-negotiation/
// clipboard/print/navigation technical event stays out by construction.
// REMOTE_SESSION_SIGNAL / VIRTUAL_MACHINE_SIGNAL / PROHIBITED_PROCESS_SIGNAL
// are deliberately excluded here: when one of these native signals is
// actually observed during an ACTIVE exam it is promoted to the
// corresponding IntegrityEvent (REMOTE_CONTROL_SOFTWARE_DETECTED /
// SCREEN_CAPTURE_SOFTWARE_DETECTED / DEBUGGING_TOOL_DETECTED /
// PROHIBITED_APPLICATION_DETECTED, see lockdownEventClassification.ts),
// which carries lecturer review status and a safe message — that is the
// canonical row. The types below have NO IntegrityEvent equivalent at
// all (display/session-lifecycle facts) and are the reason SecureClientEvent
// is included as a source in the first place.
const INCLUDED_SECURE_CLIENT_EVENT_TYPES = new Set([
  "ADDITIONAL_DISPLAY_PRESENT",
  "DISPLAY_CONFIGURATION_CHANGED",
  "DISPLAY_POLICY_RESTORED",
  "SECURE_CLIENT_INTERRUPTED",
  "SECURE_CLIENT_RECOVERED",
  "CLIENT_TECHNICAL_FAILURE",
  "LECTURER_OVERRIDE_GRANTED",
]);

const SECURE_CLIENT_EVENT_LABELS: Record<string, string> = {
  ADDITIONAL_DISPLAY_PRESENT: "Additional display detected",
  DISPLAY_CONFIGURATION_CHANGED: "Display configuration changed",
  DISPLAY_POLICY_RESTORED: "Additional display removed",
  SECURE_CLIENT_INTERRUPTED: "Secure session interrupted",
  SECURE_CLIENT_RECOVERED: "Secure session recovered",
  CLIENT_TECHNICAL_FAILURE: "Secure client technical failure",
  LECTURER_OVERRIDE_GRANTED: "Lecturer override granted",
};

const SECURE_CLIENT_EVENT_SEVERITY: Record<string, TimelineEventSeverity> = {
  ADDITIONAL_DISPLAY_PRESENT: "MEDIUM",
  DISPLAY_CONFIGURATION_CHANGED: "LOW",
  DISPLAY_POLICY_RESTORED: "INFO",
  SECURE_CLIENT_INTERRUPTED: "LOW",
  SECURE_CLIENT_RECOVERED: "INFO",
  CLIENT_TECHNICAL_FAILURE: "LOW",
  LECTURER_OVERRIDE_GRANTED: "MEDIUM",
};

// IntegrityEvent types that read as "exam activity" rather than "secure
// environment" — navigation/timer/autosave facts about the attempt
// itself, not a security condition.
const INTEGRITY_EVENT_EXAM_ACTIVITY_TYPES = new Set([
  "QUESTION_NAVIGATED_NEXT",
  "QUESTION_NAVIGATED_PREVIOUS",
  "QUESTION_BACK_NAVIGATION_BLOCKED",
  "QUESTION_NAVIGATED_DIRECT",
  "QUESTION_DIRECT_NAVIGATION_BLOCKED",
  "TIMER_EXPIRED",
  "SUBMIT_AFTER_DEADLINE",
  "AUTOSAVE_FAILED",
]);

function categoryForIntegrityEvent(eventType: string, hasEvidenceAsset: boolean): TimelineEventCategory {
  if (hasEvidenceAsset) return "EVIDENCE";
  if (eventType === "AI_ASSISTANCE_LIMIT_REACHED") return "ALLOWED_RESOURCE";
  if (INTEGRITY_EVENT_EXAM_ACTIVITY_TYPES.has(eventType)) return "EXAM_ACTIVITY";
  return "SECURE_ENVIRONMENT";
}

function toReviewState(reviewStatus: string): { status: EvidenceReviewStatus; label: string } | null {
  if (!isValidEvidenceReviewStatus(reviewStatus)) return null;
  return { status: reviewStatus, label: EVIDENCE_REVIEW_STATUS_LABELS[reviewStatus] };
}

function safeString(value: unknown, maxLen = 200): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maxLen ? value : null;
}

function safeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

export async function buildIntegrityEvidenceTimeline(
  submissionId: string,
  session: Session,
): Promise<IntegrityEvidenceTimeline> {
  const lecturerId = session.user.id;

  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    include: {
      student: { select: { name: true, email: true } },
      exam: {
        select: {
          id: true,
          title: true,
          createdById: true,
          institutionId: true,
          questions: { select: { id: true, order: true }, orderBy: { order: "asc" } },
        },
      },
      integrityEvents: {
        include: { evidenceAsset: { select: { id: true, kind: true, capturedAt: true } } },
      },
      answerActivityEvents: true,
      secureClientEvents: true,
      aiAssistanceInteractions: true,
      timingAnalysis: {
        include: { signals: { select: { reviewStatus: true } } },
      },
      sessionIntegritySignals: { select: { reviewStatus: true } },
    },
  });
  if (!submission) throw new IntegrityEvidenceTimelineNotFoundError(`Submission ${submissionId} not found`);

  if (!isPlatformAdmin(session) && submission.exam.createdById !== lecturerId) {
    throw new IntegrityEvidenceTimelineForbiddenError("Not the owner of this exam");
  }
  if (!isPlatformAdmin(session) && requireInstitutionId(session) !== submission.exam.institutionId) {
    throw new IntegrityEvidenceTimelineForbiddenError("Submission belongs to a different institution");
  }

  const questionNumberByQuestionId = new Map<string, number>();
  submission.exam.questions.forEach((q, index) => questionNumberByQuestionId.set(q.id, index + 1));

  const events: TimelineEvent[] = [];

  // -------------------------------------------------------------------
  // Source: Submission lifecycle (Section 8) — real server-set
  // timestamps, never re-derived, never duplicating ATTEMPT_STARTED/
  // ATTEMPT_SUBMITTED telemetry (that AnswerActivityEvent type is
  // deliberately never queried at all — see INCLUDED_ANSWER_ACTIVITY_EVENT_TYPES).
  // -------------------------------------------------------------------
  events.push({
    id: `submission-started-${submission.id}`,
    timestamp: submission.startedAt.toISOString(),
    category: "LIFECYCLE",
    label: "Attempt started",
    severity: "INFO",
    source: "SUBMISSION",
    technicalEventType: "SUBMISSION_STARTED",
    reviewState: null,
    evidenceAssets: [],
  });

  if (
    submission.activatedAt &&
    Math.abs(submission.activatedAt.getTime() - submission.startedAt.getTime()) >= MATERIAL_TIMESTAMP_GAP_MS
  ) {
    events.push({
      id: `submission-activated-${submission.id}`,
      timestamp: submission.activatedAt.toISOString(),
      category: "LIFECYCLE",
      label: "Exam content unlocked in secure session",
      severity: "INFO",
      source: "SUBMISSION",
      technicalEventType: "SUBMISSION_ACTIVATED",
      reviewState: null,
      evidenceAssets: [],
    });
  }

  if (submission.submittedAt) {
    events.push({
      id: `submission-submitted-${submission.id}`,
      timestamp: submission.submittedAt.toISOString(),
      category: "LIFECYCLE",
      label: "Exam submitted",
      severity: "INFO",
      source: "SUBMISSION",
      technicalEventType: "SUBMISSION_SUBMITTED",
      reviewState: null,
      evidenceAssets: [],
    });
  }

  // -------------------------------------------------------------------
  // Source: IntegrityEvent (Section 10) — the primary integrity/evidence
  // backbone. createdAt (server-authoritative) drives ordering;
  // occurredAt is shown only as an optional device-reported time under
  // progressive disclosure, and only when it differs materially — see
  // Section 17 (occurredAt is client-suppliable for the ~45 client-
  // postable event types, with no server-side plausibility check).
  // -------------------------------------------------------------------
  for (const event of submission.integrityEvents) {
    if (AI_ASSISTANCE_MIRRORED_INTEGRITY_EVENT_TYPES.has(event.eventType)) continue;

    const metadata = event.metadataJson as Record<string, unknown> | null;
    const hasEvidenceAsset = event.evidenceAsset != null;
    const occurredAtMs = event.occurredAt.getTime();
    const createdAtMs = event.createdAt.getTime();
    const deviceReportedTimestamp =
      Math.abs(occurredAtMs - createdAtMs) >= MATERIAL_TIMESTAMP_GAP_MS ? event.occurredAt.toISOString() : undefined;

    const technicalDetails: Array<{ label: string; value: string }> = [
      { label: "Event code", value: event.eventType },
    ];
    if (deviceReportedTimestamp) {
      technicalDetails.push({ label: "Device-reported time", value: deviceReportedTimestamp });
    }
    const confidenceBand = safeString(metadata?.confidenceBand);
    if (confidenceBand) technicalDetails.push({ label: "Confidence", value: confidenceBand });

    events.push({
      id: `integrity-event-${event.id}`,
      timestamp: event.createdAt.toISOString(),
      deviceReportedTimestamp,
      category: categoryForIntegrityEvent(event.eventType, hasEvidenceAsset),
      label: labelForEventType(event.eventType, metadata),
      detail: event.message,
      severity: event.severity,
      source: "INTEGRITY_EVENT",
      technicalEventType: event.eventType,
      reviewState: toReviewState(event.reviewStatus),
      evidenceAssets: event.evidenceAsset
        ? [{ id: event.evidenceAsset.id, kind: event.evidenceAsset.kind, capturedAt: event.evidenceAsset.capturedAt.toISOString() }]
        : [],
      technicalDetails,
    });
  }

  // -------------------------------------------------------------------
  // Source: AnswerActivityEvent (Section 9) — QUESTION_OPENED and
  // ANSWER_SAVED only. HEARTBEAT/PAGE_HIDDEN/PAGE_VISIBLE are pure
  // connectivity telemetry noise (a 25s heartbeat alone produces ~280
  // rows over a 2-hour attempt); ATTEMPT_STARTED/ATTEMPT_SUBMITTED are
  // already represented by the Submission lifecycle rows above;
  // QUESTION_NAVIGATED is excluded as a confirmed duplicate of an
  // IntegrityEvent row (see INCLUDED_ANSWER_ACTIVITY_EVENT_TYPES's
  // comment). Never displays response content or responseHash.
  // -------------------------------------------------------------------
  for (const row of submission.answerActivityEvents) {
    if (!INCLUDED_ANSWER_ACTIVITY_EVENT_TYPES.has(row.eventType)) continue;

    const questionNumber = row.questionId ? questionNumberByQuestionId.get(row.questionId) : undefined;
    const label = row.eventType === "ANSWER_SAVED" ? "Answer saved" : "Question opened";
    const detail =
      row.eventType === "ANSWER_SAVED" && row.responseLength != null
        ? `Response length: ${row.responseLength} character${row.responseLength === 1 ? "" : "s"}`
        : undefined;

    events.push({
      id: `answer-activity-${row.id}`,
      timestamp: row.serverReceivedAt.toISOString(),
      category: "EXAM_ACTIVITY",
      label,
      detail,
      severity: "INFO",
      questionId: row.questionId ?? undefined,
      questionNumber,
      source: "ANSWER_ACTIVITY",
      technicalEventType: row.eventType,
      reviewState: null,
      evidenceAssets: [],
    });
  }

  // -------------------------------------------------------------------
  // Source: SecureClientEvent (Section 11) — allowlisted types only
  // (see INCLUDED_SECURE_CLIENT_EVENT_TYPES). serverReceivedAt drives
  // ordering.
  // -------------------------------------------------------------------
  for (const row of submission.secureClientEvents) {
    if (!INCLUDED_SECURE_CLIENT_EVENT_TYPES.has(row.eventType)) continue;

    const metadata = row.metadataJson as Record<string, unknown> | null;
    const technicalDetails: Array<{ label: string; value: string }> = [{ label: "Event code", value: row.eventType }];
    const displayCount = safeInt(metadata?.displayCount);
    if (displayCount != null) technicalDetails.push({ label: "Display count", value: String(displayCount) });

    events.push({
      id: `secure-client-event-${row.id}`,
      timestamp: row.serverReceivedAt.toISOString(),
      category: "SECURE_ENVIRONMENT",
      label: SECURE_CLIENT_EVENT_LABELS[row.eventType] ?? row.eventType,
      severity: SECURE_CLIENT_EVENT_SEVERITY[row.eventType] ?? "LOW",
      source: "SECURE_CLIENT",
      technicalEventType: row.eventType,
      reviewState: null,
      evidenceAssets: [],
      technicalDetails,
    });
  }

  // -------------------------------------------------------------------
  // Source: AiAssistanceInteraction (Section 15) — the canonical source
  // for Controlled AI outcomes; the mirrored IntegrityEvent rows are
  // suppressed above. A RESERVED row is either genuinely mid-flight
  // (never shown — not yet a completed fact) or a stale/abandoned
  // reservation, normalized to FAILED using the SAME isStaleReservation
  // rule aiAssistanceReview.ts uses for lecturer display, so the two
  // surfaces never disagree about the same interaction. Never exposes
  // the student prompt, the approved response text, provider details,
  // or risk scores — this is a status/label record only; the full
  // transcript already has its own dedicated review page.
  // -------------------------------------------------------------------
  for (const row of submission.aiAssistanceInteractions) {
    let status: string = row.status;
    if (status === "RESERVED") {
      if (!isStaleReservation(row.createdAt)) continue;
      status = "FAILED";
    }

    let label: string;
    let detail: string | undefined;
    switch (status) {
      case "APPROVED":
        label = "Tether Controlled AI guidance shown";
        detail = "Allowed under this attempt's policy";
        break;
      case "FALLBACK":
        label = "Tether Controlled AI safe fallback shown";
        detail = "Allowed under this attempt's policy";
        break;
      case "BLOCKED":
        label = "Tether Controlled AI request declined";
        break;
      case "FAILED":
      default:
        label = "Tether Controlled AI request could not be completed";
        break;
    }

    const technicalDetails: Array<{ label: string; value: string }> = [
      { label: "Prompt number (question)", value: String(row.promptNumberForQuestion) },
      { label: "Prompt number (attempt)", value: String(row.promptNumberForAttempt) },
      { label: "Policy version", value: row.policyVersion },
    ];
    if (row.wasRegenerated) {
      technicalDetails.push({ label: "Regenerated", value: "Guidance regenerated under stricter guidance before display" });
    }

    events.push({
      id: `ai-assistance-${row.id}`,
      timestamp: row.createdAt.toISOString(),
      category: "ALLOWED_RESOURCE",
      label,
      detail,
      // Permitted Controlled AI is never misconduct and never increases
      // Timeline severity — a declined/failed request is a routine,
      // expected outcome of an allowed resource, not a security signal.
      severity: "INFO",
      questionId: row.questionId,
      questionNumber: questionNumberByQuestionId.get(row.questionId),
      source: "AI_ASSISTANCE",
      technicalEventType: `AI_ASSISTANCE_INTERACTION_${status}`,
      reviewState: null,
      evidenceAssets: [],
      technicalDetails,
    });
  }

  // -------------------------------------------------------------------
  // Deterministic chronological sort — server-authoritative timestamp
  // first, then a fixed source rank, then id, so two rows sharing the
  // exact same timestamp always sort the same way on every read.
  // -------------------------------------------------------------------
  events.sort((a, b) => {
    const ta = Date.parse(a.timestamp);
    const tb = Date.parse(b.timestamp);
    if (ta !== tb) return ta - tb;
    const ra = SOURCE_RANK[a.source];
    const rb = SOURCE_RANK[b.source];
    if (ra !== rb) return ra - rb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // -------------------------------------------------------------------
  // Section 18 — Session/Timing review signals are explicitly NOT merged
  // into the chronological stream: SessionIntegritySignal.createdAt and
  // TimingIntegritySignal.createdAt are when the analysis row was
  // written (often well after, or via a lecturer-triggered re-run long
  // after, the underlying behaviour occurred), not a validated
  // occurrence time. Surfaced only as an aggregate "awaiting review"
  // count, matching Section 18's own compact-summary example.
  // -------------------------------------------------------------------
  const relatedSessionSignals = submission.sessionIntegritySignals.filter((s) => s.reviewStatus === "NEEDS_REVIEW").length;
  const relatedTimingSignals = (submission.timingAnalysis?.signals ?? []).filter((s) => s.reviewStatus === "NEEDS_REVIEW").length;

  const summary: IntegrityEvidenceTimelineSummary = {
    totalEvents: events.length,
    evidenceAssetCount: events.filter((e) => e.evidenceAssets.length > 0).length,
    needsReviewCount: events.filter((e) => e.reviewState?.status === "NEEDS_REVIEW").length,
    attemptStatus: submission.status,
    relatedSessionSignals,
    relatedTimingSignals,
  };

  return {
    submissionId: submission.id,
    student: { name: submission.student.name, email: submission.student.email },
    exam: { id: submission.exam.id, title: submission.exam.title },
    summary,
    events,
  };
}
