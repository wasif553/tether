"use client";

import { useCallback, useEffect, useMemo, useState, use as usePromise, type ReactNode } from "react";
import Link from "next/link";
import { buildEvidenceFrameViewPath, isEvidenceCaptureEligibleEventType } from "@/lib/aiCameraEvidenceFrame";
import {
  categoryForEventType,
  labelForEventType,
  INTEGRITY_EVENT_CATEGORY_LABELS,
  type IntegrityEventCategory,
} from "@/lib/integrityEventLabels";
import { LecturerPageHeader, SecondaryLinkButton } from "@/components/lecturer/LecturerPageHeader";
import { MetricCard } from "@/components/lecturer/MetricCard";
import { SectionCard } from "@/components/lecturer/SectionCard";
import { StatusBadge, type StatusTone } from "@/components/lecturer/StatusBadge";
import { LoadingState, ErrorState } from "@/components/lecturer/EmptyState";
import type { TimelineEvent, IntegrityEvidenceTimeline } from "@/lib/integrityEvidenceTimeline";

// ---------------------------------------------------------------------------
// Data shapes — mirror exactly what the three existing backing routes
// return (GET .../evidence, GET .../integrity-review, GET .../timeline).
// Nothing here is invented; similarityCollusionSummary is the one new,
// additive field on EvidenceReport (see src/lib/evidenceReport.ts).
// ---------------------------------------------------------------------------

type EvidenceReport = {
  submissionId: string;
  student: { name: string; email: string };
  exam: { id: string; title: string };
  status: string;
  startedAt: string;
  submittedAt: string | null;
  gradedAt: string | null;
  totalScore: number | null;
  riskScore: number;
  riskLevel: "CLEAN" | "LOW" | "MEDIUM" | "HIGH";
  events: Array<{
    id: string;
    eventType: string;
    eventLabel: string;
    severity: string;
    message: string;
    occurredAt: string;
    resolvedAt: string | null;
    resolvedByName: string | null;
    resolutionNote: string | null;
    confidenceBand: string | null;
    remoteSessionDetail: {
      detectionSource: string | null;
      sessionType: string | null;
      checkConfidence: string | null;
      previousState: string | null;
      currentState: string | null;
      tetherVersion: string | null;
      secureClientSessionId: string | null;
    } | null;
    evidenceFrame: { id: string; kind: string; contentType: string; byteSize: number; capturedAt: string } | null;
    noEvidenceImageReason: "CAPTURE_DISABLED" | "CAPTURE_FAILED" | "UNKNOWN" | null;
  }>;
  evidenceFrames: Array<{
    id: string;
    kind: string;
    eventId: string;
    eventType: string;
    occurredAt: string;
    contentType: string;
    byteSize: number;
    capturedAt: string;
  }>;
  aiCameraIntegritySummary: {
    possiblePhoneCount: number;
    possibleSecondPersonCount: number;
    noPersonCount: number;
    cameraBlockedOrDarkCount: number;
    disclaimer: string;
  } | null;
  screenShareIntegritySummary: {
    startedCount: number;
    interruptedCount: number;
    restoredCount: number;
    surfaceRejectedCount: number;
    permissionDeniedCount: number;
    unavailableCount: number;
    evidenceFrameCount: number;
    evidenceCaptureFailedCount: number;
    policy: { mode: "OFF" | "REQUIRED"; captureEvidence: boolean; evidenceIntervalSeconds: number; maxEvidenceFrames: number };
    disclaimer: string;
  } | null;
  lockdownDetectionSummary: {
    remoteControlCount: number;
    screenCaptureCount: number;
    debuggingToolCount: number;
    prohibitedApplicationCount: number;
    closedCount: number;
    disclaimer: string;
  } | null;
  canvasPassback: { status: string; scoreGiven: number | null; sentAt: string | null; errorMessage: string | null } | null;
  aiMarking: { answeredEssayCount: number; aiDraftedCount: number } | null;
  networkEvidence: {
    start: {
      ipAddress: string | null;
      country: string | null;
      region: string | null;
      city: string | null;
      timezone: string | null;
      locationAccuracy: string;
      userAgent: string | null;
      browserName: string | null;
      osName: string | null;
      vpnOrProxySignal: boolean;
      capturedAt: string;
    } | null;
    submit: {
      ipAddress: string | null;
      country: string | null;
      region: string | null;
      city: string | null;
      timezone: string | null;
      locationAccuracy: string;
      userAgent: string | null;
      browserName: string | null;
      osName: string | null;
      vpnOrProxySignal: boolean;
      networkChanged: boolean;
      capturedAt: string;
    } | null;
    reviewSignal: "Normal" | "Needs review" | "High review signal";
    networkEvidenceDisclaimer: string;
  };
  // Evidence-provenance fix — the exam's CURRENT setting only, never used
  // to explain a past incident (no per-attempt snapshot exists). Shown
  // as present-tense configuration context.
  currentCaptureAiViolationEvidenceEnabled: boolean;
  // Evidence workspace v1 — additive (see src/lib/evidenceReport.ts).
  // Always present: eligibleSubmissionCount vs. minEligibleSubmissions
  // distinguishes "not enough eligible submissions yet" from
  // analysisHasRun distinguishing "never run for this exam" from "run,
  // but nothing for this student" from "run, with results" — see the
  // page's rendering below.
  similarityCollusionSummary: {
    eligibleSubmissionCount: number;
    minEligibleSubmissions: number;
    analysisHasRun: boolean;
    analysisStatus: "PENDING" | "PROCESSING" | "COMPLETE" | "FAILED" | null;
    analysisSubmissionsAnalysed: number | null;
    highestSimilarityScore: number | null;
    affectedQuestionCount: number;
    comparedStudentCount: number;
    matchReviewStatus: string | null;
    collusionConcernLevel: string | null;
    collusionReviewStatus: string | null;
    examId: string;
    disclaimer: string;
  };
  disclaimer: string;
};

type PolicyInterpretation = {
  applicable: boolean;
  policyAlignment: "PERMITTED" | "NOT_PERMITTED" | "NOT_APPLICABLE" | "UNKNOWN";
  adjustedReviewLevel: "NONE" | "LOW" | "MEDIUM" | "HIGH";
  reasonCode: string;
  explanation: string;
  limitation: string;
};

type ReviewComment = { id: string; comment: string; authorName: string; authorRole: string; commentType: string; createdAt: string };

type ReviewStatusHistoryEntry = {
  id: string;
  fromStatus: string | null;
  toStatus: string;
  changedByName: string;
  changedByRole: string;
  reason: string | null;
  createdAt: string;
};

type ReviewEvent = {
  id: string;
  eventType: string;
  eventLabel: string;
  severity: string;
  message: string;
  occurredAt: string;
  evidenceFrame: { id: string; contentType: string; byteSize: number; capturedAt: string } | null;
  policyInterpretation: PolicyInterpretation;
  reviewStatus: string;
  reviewStatusLabel: string;
  reviewedAt: string | null;
  reviewedByName: string | null;
  reviewNote: string | null;
  comments: ReviewComment[];
  statusHistory: ReviewStatusHistoryEntry[];
};

type IntegrityReview = {
  submissionId: string;
  status: string;
  policy:
    | {
        available: true;
        examMode: "CLOSED_BOOK" | "OPEN_BOOK" | "CUSTOM";
        calculatorAllowed: boolean;
        notesAllowed: boolean;
        internetAllowed: boolean;
        aiToolsAllowed: boolean;
        secureControls: string[];
      }
    | { available: false; message: string };
  events: ReviewEvent[];
  summary: {
    overallReviewStatus: string;
    needsReviewCount: number;
    reviewedNoConcernCount: number;
    concernRemainsCount: number;
    escalatedCount: number;
    resolvedCount: number;
    evidenceFrameCount: number;
    lastReviewActivityAt: string | null;
    lastReviewer: string | null;
  };
  recommendation: { recommendation: string; reasonCodes: string[]; summary: string };
};

// ---------------------------------------------------------------------------
// Presentation constants
// ---------------------------------------------------------------------------

const EXAM_MODE_LABELS_MAP: Record<string, string> = { CLOSED_BOOK: "Closed-book", OPEN_BOOK: "Open-book", CUSTOM: "Custom" };

const REVIEW_STATUS_TONES: Record<string, "success" | "warning" | "critical" | "info" | "neutral"> = {
  NEEDS_REVIEW: "neutral",
  REVIEWED_NO_CONCERN: "success",
  REVIEWED_CONCERN_REMAINS: "warning",
  ESCALATED: "critical",
  RESOLVED: "info",
};

const REVIEW_RECOMMENDATION_LABELS: Record<string, string> = {
  NO_IMMEDIATE_ACTION: "No immediate action",
  LECTURER_REVIEW_RECOMMENDED: "Lecturer review recommended",
  ORAL_VERIFICATION_RECOMMENDED: "Oral verification recommended",
  ESCALATION_RECOMMENDED: "Escalated",
};

const REVIEW_ACTIONS: Array<{ status: string; label: string }> = [
  { status: "REVIEWED_NO_CONCERN", label: "Reviewed — no concern" },
  { status: "REVIEWED_CONCERN_REMAINS", label: "Reviewed — concern remains" },
  { status: "ESCALATED", label: "Escalate" },
  { status: "RESOLVED", label: "Resolve" },
];

type ReviewLevel = "INFO" | "LOW" | "MEDIUM" | "HIGH";

const REVIEW_LEVEL_LABELS: Record<ReviewLevel, string> = {
  INFO: "Observation",
  LOW: "Low review signal",
  MEDIUM: "Medium review signal",
  HIGH: "High-priority review",
};

const REVIEW_LEVEL_TONES: Record<ReviewLevel, StatusTone> = {
  INFO: "neutral",
  LOW: "info",
  MEDIUM: "warning",
  HIGH: "critical",
};

function ReviewLevelBadge({ level }: { level: ReviewLevel }) {
  return <StatusBadge tone={REVIEW_LEVEL_TONES[level]}>{REVIEW_LEVEL_LABELS[level]}</StatusBadge>;
}

// Evidence-provenance fix — exact required wording, verbatim. Never
// makes a historical claim from mutable current configuration: this
// schema has no per-attempt snapshot of captureAiViolationEvidence, so
// evidenceReport.ts's noEvidenceImageReason never emits CAPTURE_DISABLED
// today (kept in the type/map only for forward-compatibility, if an
// attempt-time snapshot is ever added — see that field's own doc
// comment). CAPTURE_FAILED is similarly unreachable — this codebase has
// no durable record of a failed upload attempt. Only UNKNOWN is ever
// actually shown per-incident; see currentCaptureAiViolationEvidenceEnabled
// for the SEPARATE, clearly-labelled-as-current configuration note.
const NO_EVIDENCE_IMAGE_EXPLANATIONS: Record<"CAPTURE_DISABLED" | "CAPTURE_FAILED" | "UNKNOWN", string> = {
  CAPTURE_DISABLED: "Phone signal recorded. No image was saved because evidence-frame capture was disabled for this exam.",
  CAPTURE_FAILED: "Phone signal recorded, but the supporting evidence image could not be saved.",
  UNKNOWN: "Phone signal recorded. No supporting evidence image is available.",
};

function formatByteSize(byteSize: number): string {
  if (byteSize < 1024) return `${byteSize} B`;
  return `${(byteSize / 1024).toFixed(1)} KB`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function formatTimeRange(startIso: string, endIso: string | null): string {
  const start = new Date(startIso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (!endIso) return start;
  const end = new Date(endIso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${start} – ${end}`;
}

// ---------------------------------------------------------------------------
// Reviewability classification — mirrors the lecturer integrity review
// page (src/app/lecturer/exams/[id]/integrity/page.tsx): a signal is
// reviewable when its severity is not INFO and it is not one of the
// event types below that carry non-zero severity for reasons unrelated
// to suspicion (a positive control succeeding, or a context/navigation
// fact — see src/lib/secureExam.ts's severityFor for why each of these
// is INFO/LOW by design). Applied uniformly across BOTH IntegrityEvent-
// sourced and SecureClientEvent-sourced timeline rows.
// ---------------------------------------------------------------------------

const POSITIVE_CONTROL_EVENT_TYPES = new Set([
  "CAMERA_PERMISSION_GRANTED",
  "CAMERA_STARTED",
  "CAMERA_VISIBILITY_RESTORED",
  "SCREEN_SHARE_STARTED",
  "SCREEN_SHARE_RESTORED",
  "SCREEN_SHARE_EVIDENCE_CAPTURED",
  "WINDOW_FOCUS_RETURN",
  "FULLSCREEN_FORCED_RETURN",
  "STUDENT_VERIFICATION_CONFIRMED",
  "PROHIBITED_APPLICATION_CLOSED",
  "NETWORK_ONLINE",
  "SECURE_CLIENT_RECOVERED",
  "DISPLAY_POLICY_RESTORED",
]);

const CONTEXT_EVENT_TYPES = new Set([
  "QUESTION_NAVIGATED_NEXT",
  "QUESTION_NAVIGATED_PREVIOUS",
  "QUESTION_NAVIGATED_DIRECT",
  "QUESTION_BACK_NAVIGATION_BLOCKED",
  "QUESTION_DIRECT_NAVIGATION_BLOCKED",
]);

function isReviewableTimelineEvent(event: TimelineEvent): boolean {
  const type = event.technicalEventType ?? "";
  if (event.source === "AI_ASSISTANCE") return false;
  if (event.severity === "INFO") return false;
  if (POSITIVE_CONTROL_EVENT_TYPES.has(type)) return false;
  if (CONTEXT_EVENT_TYPES.has(type)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Incident derivation — groups sequential start/end technical-event-type
// pairs (window blur/focus, secure-client interruption/recovery, screen-
// share interruption/restoration, lockdown detection/closure, display
// present/restored) into one incident with a calculable duration. Only
// ever pairs events that are ALREADY in the timeline in chronological
// order (see integrityEvidenceTimeline.ts) — never reorders or infers a
// pairing across two different technical facts.
// ---------------------------------------------------------------------------

type Incident = {
  id: string;
  title: string;
  reviewLevel: ReviewLevel;
  occurredAt: string;
  endedAt: string | null;
  durationMs: number | null;
  observation: string;
  controlRestored: boolean;
  reviewable: boolean;
  evidenceAssetId: string | null;
  /** True only for POSSIBLE_PHONE_VISIBLE/POSSIBLE_SECOND_PERSON_VISIBLE — the only two event types evidence capture supports (see aiCameraEvidenceFrame.ts's EVIDENCE_CAPTURE_EVENT_TYPES). Other camera signals (no-person, blocked, dark) never have a frame by design, not by bug. */
  hasCameraEvidenceCapability: boolean;
  /** Present only when this incident maps to exactly one IntegrityEvent — SecureClientEvent-sourced incidents (display/continuity) have no equivalent review-action row. */
  reviewEventId: string | null;
};

function pairSequential(events: TimelineEvent[], startTypes: Set<string>, endTypes: Set<string>): Array<{ start: TimelineEvent; end: TimelineEvent | null }> {
  const pairs: Array<{ start: TimelineEvent; end: TimelineEvent | null }> = [];
  let open: TimelineEvent | null = null;
  for (const event of events) {
    const type = event.technicalEventType ?? "";
    if (startTypes.has(type)) {
      if (open) pairs.push({ start: open, end: null });
      open = event;
    } else if (endTypes.has(type) && open) {
      pairs.push({ start: open, end: event });
      open = null;
    }
  }
  if (open) pairs.push({ start: open, end: null });
  return pairs;
}

function integrityEventIdFromTimelineId(id: string): string | null {
  return id.startsWith("integrity-event-") ? id.slice("integrity-event-".length) : null;
}

const WINDOW_START = new Set(["WINDOW_BLUR"]);
const WINDOW_END = new Set(["WINDOW_FOCUS_RETURN"]);
const SECURE_CLIENT_START = new Set(["SECURE_CLIENT_INTERRUPTED"]);
const SECURE_CLIENT_END = new Set(["SECURE_CLIENT_RECOVERED"]);
const SCREEN_SHARE_START = new Set(["SCREEN_SHARE_INTERRUPTED"]);
const SCREEN_SHARE_END = new Set(["SCREEN_SHARE_RESTORED"]);
const LOCKDOWN_START = new Set([
  "REMOTE_CONTROL_SOFTWARE_DETECTED",
  "SCREEN_CAPTURE_SOFTWARE_DETECTED",
  "DEBUGGING_TOOL_DETECTED",
  "PROHIBITED_APPLICATION_DETECTED",
]);
const LOCKDOWN_END = new Set(["PROHIBITED_APPLICATION_CLOSED"]);
const DISPLAY_START = new Set(["ADDITIONAL_DISPLAY_PRESENT", "DISPLAY_CONFIGURATION_CHANGED"]);
const DISPLAY_END = new Set(["DISPLAY_POLICY_RESTORED"]);

const PAIRED_START_TYPES = new Set([...WINDOW_START, ...SECURE_CLIENT_START, ...SCREEN_SHARE_START, ...LOCKDOWN_START, ...DISPLAY_START]);
const PAIRED_END_TYPES = new Set([...WINDOW_END, ...SECURE_CLIENT_END, ...SCREEN_SHARE_END, ...LOCKDOWN_END, ...DISPLAY_END]);

function buildIncidents(timelineEvents: TimelineEvent[]): Incident[] {
  const incidents: Incident[] = [];

  const pairingGroups: Array<{ start: Set<string>; end: Set<string>; title: string; observation: (end: boolean) => string }> = [
    {
      start: WINDOW_START,
      end: WINDOW_END,
      title: "Window focus lost",
      observation: (restored) => (restored ? "Tether observed the exam window lose focus. Focus was subsequently restored." : "Tether observed the exam window lose focus. No return to focus was recorded."),
    },
    {
      start: SECURE_CLIENT_START,
      end: SECURE_CLIENT_END,
      title: "Secure exam session interruption",
      observation: (restored) => (restored ? "Tether lost confirmation of the required secure exam session. The session was subsequently restored." : "Tether lost confirmation of the required secure exam session. No restoration was recorded."),
    },
    {
      start: SCREEN_SHARE_START,
      end: SCREEN_SHARE_END,
      title: "Screen sharing interrupted",
      observation: (restored) => (restored ? "Tether lost confirmation of the required screen-share session. Screen sharing was subsequently restored." : "Tether lost confirmation of the required screen-share session. No restoration was recorded."),
    },
    {
      start: LOCKDOWN_START,
      end: LOCKDOWN_END,
      title: "Restricted application observed",
      observation: (restored) => (restored ? "Tether observed a restricted application running during the exam. It was subsequently closed." : "Tether observed a restricted application running during the exam. No closure was recorded."),
    },
    {
      start: DISPLAY_START,
      end: DISPLAY_END,
      title: "Additional display detected",
      observation: (restored) => (restored ? "Tether observed an additional or reconfigured display. Single-display policy was subsequently restored." : "Tether observed an additional or reconfigured display. No restoration to a single display was recorded."),
    },
  ];

  for (const group of pairingGroups) {
    for (const pair of pairSequential(timelineEvents, group.start, group.end)) {
      const durationMs = pair.end ? Date.parse(pair.end.timestamp) - Date.parse(pair.start.timestamp) : null;
      incidents.push({
        id: `incident-${pair.start.id}`,
        title: group.title,
        reviewLevel: pair.start.severity,
        occurredAt: pair.start.timestamp,
        endedAt: pair.end?.timestamp ?? null,
        durationMs,
        observation: group.observation(pair.end != null),
        controlRestored: pair.end != null,
        reviewable: isReviewableTimelineEvent(pair.start),
        evidenceAssetId: pair.start.evidenceAssets[0]?.id ?? null,
        hasCameraEvidenceCapability: isEvidenceCaptureEligibleEventType(pair.start.technicalEventType ?? ""),
        reviewEventId: integrityEventIdFromTimelineId(pair.start.id),
      });
    }
  }

  // Everything else that's individually reviewable and not part of a
  // start/end pair above (camera signals, verification-adjacent camera
  // failures, standalone screen-share denials, etc.) becomes its own
  // single-point incident.
  for (const event of timelineEvents) {
    const type = event.technicalEventType ?? "";
    if (PAIRED_START_TYPES.has(type) || PAIRED_END_TYPES.has(type)) continue;
    if (!isReviewableTimelineEvent(event)) continue;
    incidents.push({
      id: `incident-${event.id}`,
      title: event.label,
      reviewLevel: event.severity,
      occurredAt: event.timestamp,
      endedAt: null,
      durationMs: null,
      observation: event.detail ?? event.label,
      controlRestored: false,
      reviewable: true,
      evidenceAssetId: event.evidenceAssets[0]?.id ?? null,
      hasCameraEvidenceCapability: isEvidenceCaptureEligibleEventType(event.technicalEventType ?? ""),
      reviewEventId: integrityEventIdFromTimelineId(event.id),
    });
  }

  return incidents.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function EvidenceReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params);
  const [data, setData] = useState<EvidenceReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [timeline, setTimeline] = useState<IntegrityEvidenceTimeline | null>(null);

  const [viewingEvidence, setViewingEvidence] = useState<{
    evidenceAssetId: string;
    eventLabel: string;
    occurredAt: string;
    objectUrl: string | null;
    loading: boolean;
    error: string | null;
  } | null>(null);

  const [review, setReview] = useState<IntegrityReview | null>(null);
  const [reviewLoading, setReviewLoading] = useState(true);
  const [reviewNoteDrafts, setReviewNoteDrafts] = useState<Record<string, string>>({});
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [bulkSelection, setBulkSelection] = useState<Set<string>>(new Set());
  const [bulkConfirming, setBulkConfirming] = useState(false);
  const [showFullLog, setShowFullLog] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<IntegrityEventCategory | "all">("all");
  const [windowFocusGroupExpanded, setWindowFocusGroupExpanded] = useState(false);

  const loadReview = useCallback(async () => {
    const res = await fetch(`/api/lecturer/submissions/${id}/integrity-review`);
    if (res.ok) setReview(await res.json());
    setReviewLoading(false);
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadReview();
  }, [loadReview]);

  useEffect(() => {
    fetch(`/api/lecturer/submissions/${id}/timeline`).then(async (res) => {
      if (res.ok) setTimeline(await res.json());
    });
  }, [id]);

  useEffect(() => {
    fetch(`/api/lecturer/submissions/${id}/evidence`).then(async (res) => {
      if (!res.ok) {
        setError(res.status === 403 ? "You don't have access to this submission's evidence report." : "Evidence report not found.");
        setLoading(false);
        return;
      }
      setData(await res.json());
      setLoading(false);
    });
  }, [id]);

  async function submitEventReview(eventId: string, reviewStatus: string) {
    const reviewNote = reviewNoteDrafts[eventId];
    const res = await fetch(`/api/lecturer/integrity-events/${eventId}/review`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewStatus, reviewNote: reviewNote || undefined }),
    });
    if (res.ok) await loadReview();
  }

  async function submitComment(eventId: string) {
    const comment = commentDrafts[eventId]?.trim();
    if (!comment) return;
    const res = await fetch(`/api/lecturer/integrity-events/${eventId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comment }),
    });
    if (res.ok) {
      setCommentDrafts((prev) => ({ ...prev, [eventId]: "" }));
      await loadReview();
    }
  }

  function toggleBulkSelection(eventId: string) {
    setBulkSelection((prev) => {
      const next = new Set(prev);
      if (next.has(eventId)) next.delete(eventId);
      else next.add(eventId);
      return next;
    });
  }

  async function confirmBulkNoConcern() {
    const res = await fetch(`/api/lecturer/submissions/${id}/integrity-review/bulk-no-concern`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventIds: [...bulkSelection] }),
    });
    setBulkConfirming(false);
    if (res.ok) {
      setBulkSelection(new Set());
      await loadReview();
    }
  }

  async function openEvidenceFrame(evidenceAssetId: string, eventLabel: string, occurredAt: string) {
    setViewingEvidence({ evidenceAssetId, eventLabel, occurredAt, objectUrl: null, loading: true, error: null });
    const res = await fetch(buildEvidenceFrameViewPath(evidenceAssetId)).catch(() => null);
    if (!res || !res.ok) {
      setViewingEvidence((prev) => (prev ? { ...prev, loading: false, error: "Evidence frame could not be loaded." } : prev));
      return;
    }
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    setViewingEvidence((prev) => (prev ? { ...prev, objectUrl, loading: false } : prev));
  }

  function closeEvidenceFrame() {
    if (viewingEvidence?.objectUrl) URL.revokeObjectURL(viewingEvidence.objectUrl);
    setViewingEvidence(null);
  }

  const events = useMemo(() => data?.events ?? [], [data]);
  const reviewEventsById = useMemo(() => new Map((review?.events ?? []).map((e) => [e.id, e])), [review]);
  // Preview QA fix — noEvidenceImageReason lives on data.events (the
  // /evidence route), not on timeline events, so incident cards (built
  // from the /timeline route) look it up by the underlying IntegrityEvent
  // id, which matches incident.reviewEventId for camera-evidence-eligible
  // event types.
  const noEvidenceImageReasonById = useMemo(() => new Map(events.map((e) => [e.id, e.noEvidenceImageReason])), [events]);

  const incidents = useMemo(() => buildIncidents(timeline?.events ?? []), [timeline]);
  const reviewableIncidents = useMemo(() => incidents.filter((i) => i.reviewable), [incidents]);
  const highPriorityIncidents = useMemo(() => reviewableIncidents.filter((i) => i.reviewLevel === "HIGH"), [reviewableIncidents]);

  // Repeated window-focus grouping — only WINDOW_BLUR/WINDOW_FOCUS_RETURN
  // pairs are aggregated here; every other incident title (phone,
  // second-person, HDMI/display, secure-client, lockdown, etc.) keeps its
  // own individual card. Grouping only kicks in with >1 such incident so a
  // single focus-loss still reads as a normal incident.
  const windowFocusIncidents = useMemo(() => reviewableIncidents.filter((i) => i.title === "Window focus lost"), [reviewableIncidents]);
  const shouldGroupWindowFocus = windowFocusIncidents.length > 1;
  const incidentDisplayItems = useMemo(() => {
    if (!shouldGroupWindowFocus) return reviewableIncidents.map((incident) => ({ kind: "incident" as const, incident }));
    const items: Array<{ kind: "incident"; incident: Incident } | { kind: "windowFocusGroup"; incidents: Incident[] }> = [];
    let grouped = false;
    for (const incident of reviewableIncidents) {
      if (incident.title === "Window focus lost") {
        if (!grouped) {
          items.push({ kind: "windowFocusGroup", incidents: windowFocusIncidents });
          grouped = true;
        }
        continue;
      }
      items.push({ kind: "incident", incident });
    }
    return items;
  }, [reviewableIncidents, shouldGroupWindowFocus, windowFocusIncidents]);

  const categoryCounts = useMemo(() => {
    const counts: Record<IntegrityEventCategory, number> = { evidence: 0, camera: 0, screen: 0, lockdown: 0, window: 0, info: 0 };
    for (const e of events) counts[categoryForEventType(e.eventType)]++;
    return counts;
  }, [events]);
  const filteredEvents = useMemo(() => {
    if (categoryFilter === "all") return events;
    return events.filter((e) => categoryForEventType(e.eventType) === categoryFilter);
  }, [events, categoryFilter]);

  const positiveControlEvents = useMemo(
    () => events.filter((e) => POSITIVE_CONTROL_EVENT_TYPES.has(e.eventType)),
    [events],
  );

  const brainstormEvents = useMemo(() => (timeline?.events ?? []).filter((e) => e.source === "AI_ASSISTANCE"), [timeline]);

  if (loading) return <LoadingState label="Loading evidence report…" />;
  if (error) return <ErrorState message={error} />;
  if (!data) return <ErrorState message="No data available." />;

  return (
    <div className="mx-auto max-w-4xl">
      <LecturerPageHeader
        breadcrumbs={[
          { label: "Dashboard", href: "/lecturer" },
          { label: data.exam.title, href: `/lecturer/exams/${data.exam.id}` },
          { label: "Evidence" },
        ]}
        title="Evidence review"
        description={`${data.student.name} · ${data.student.email}`}
        actions={
          <>
            <a
              href={`/api/lecturer/submissions/${id}/evidence.csv`}
              className="rounded-lg border border-lecturer-border bg-lecturer-surface px-3 py-1.5 text-sm font-medium text-lecturer-text-primary hover:bg-lecturer-border-subtle"
            >
              Export CSV
            </a>
            <SecondaryLinkButton href={`/lecturer/exams/${data.exam.id}/submissions/${data.submissionId}`} className="px-3 py-1.5">
              Back to grading
            </SecondaryLinkButton>
          </>
        }
      />

      <p className="mt-3 rounded-xl border border-lecturer-border bg-lecturer-surface px-4 py-3 text-sm text-lecturer-text-secondary">
        {data.disclaimer}
      </p>

      {!reviewLoading && review && (
        <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-3">
          <MetricCard
            value={REVIEW_STATUS_TONES[review.summary.overallReviewStatus] ? review.summary.overallReviewStatus.replace(/_/g, " ") : review.summary.overallReviewStatus}
            label="Overall review status"
            accent={REVIEW_STATUS_TONES[review.summary.overallReviewStatus] ?? "neutral"}
          />
          <MetricCard value={reviewableIncidents.length} label="Reviewable incidents" accent={reviewableIncidents.length > 0 ? "warning" : "neutral"} />
          <MetricCard value={highPriorityIncidents.length} label="High-priority incidents" accent={highPriorityIncidents.length > 0 ? "critical" : "neutral"} />
          <MetricCard value={review.summary.evidenceFrameCount} label="Evidence frames" accent="info" />
          <MetricCard
            value={review.summary.lastReviewActivityAt ? new Date(review.summary.lastReviewActivityAt).toLocaleDateString() : "—"}
            label={review.summary.lastReviewer ? `Last activity — ${review.summary.lastReviewer}` : "Last reviewer activity"}
            accent="neutral"
          />
          <MetricCard
            value={REVIEW_RECOMMENDATION_LABELS[review.recommendation.recommendation] ?? review.recommendation.recommendation}
            label="Recommended next action"
            accent={review.recommendation.recommendation === "NO_IMMEDIATE_ACTION" ? "neutral" : "info"}
          />
        </div>
      )}

      <div className="mt-8 space-y-6">
        {/* Section 9 — Incidents requiring review (main section) */}
        <SectionCard
          title="Incidents requiring review"
          subtitle="Compact incidents derived from Tether's recorded signals. Signals support human review; they do not establish misconduct."
        >
          {reviewableIncidents.length === 0 && (
            <p className="rounded-lg border border-lecturer-border bg-lecturer-border-subtle p-4 text-sm text-lecturer-text-secondary">
              No incidents currently require review for this submission.
            </p>
          )}
          <div className="space-y-3">
            {incidentDisplayItems.map((item) =>
              item.kind === "windowFocusGroup" ? (
                <WindowFocusGroupCard
                  key="window-focus-group"
                  incidents={item.incidents}
                  expanded={windowFocusGroupExpanded}
                  onToggleExpanded={() => setWindowFocusGroupExpanded((prev) => !prev)}
                  renderIncident={(incident) => (
                    <IncidentCard
                      key={incident.id}
                      incident={incident}
                      reviewEvent={incident.reviewEventId ? (reviewEventsById.get(incident.reviewEventId) ?? null) : null}
                      noteText={reviewNoteDrafts[incident.reviewEventId ?? ""] ?? ""}
                      onNoteChange={(value) => incident.reviewEventId && setReviewNoteDrafts((prev) => ({ ...prev, [incident.reviewEventId!]: value }))}
                      onReviewAction={(status) => incident.reviewEventId && submitEventReview(incident.reviewEventId, status)}
                      onViewEvidence={() => incident.evidenceAssetId && openEvidenceFrame(incident.evidenceAssetId, incident.title, incident.occurredAt)}
                      expanded={expandedEventId === incident.reviewEventId}
                      onToggleExpanded={() => setExpandedEventId(expandedEventId === incident.reviewEventId ? null : incident.reviewEventId)}
                      commentDraft={commentDrafts[incident.reviewEventId ?? ""] ?? ""}
                      onCommentChange={(value) => incident.reviewEventId && setCommentDrafts((prev) => ({ ...prev, [incident.reviewEventId!]: value }))}
                      onSubmitComment={() => incident.reviewEventId && submitComment(incident.reviewEventId)}
                      bulkSelected={incident.reviewEventId ? bulkSelection.has(incident.reviewEventId) : false}
                      onToggleBulkSelected={() => incident.reviewEventId && toggleBulkSelection(incident.reviewEventId)}
                      noEvidenceImageReason={incident.reviewEventId ? (noEvidenceImageReasonById.get(incident.reviewEventId) ?? null) : null}
                    />
                  )}
                />
              ) : (
                <IncidentCard
                  key={item.incident.id}
                  incident={item.incident}
                  reviewEvent={item.incident.reviewEventId ? (reviewEventsById.get(item.incident.reviewEventId) ?? null) : null}
                  noteText={reviewNoteDrafts[item.incident.reviewEventId ?? ""] ?? ""}
                  onNoteChange={(value) => item.incident.reviewEventId && setReviewNoteDrafts((prev) => ({ ...prev, [item.incident.reviewEventId!]: value }))}
                  onReviewAction={(status) => item.incident.reviewEventId && submitEventReview(item.incident.reviewEventId, status)}
                  onViewEvidence={() => item.incident.evidenceAssetId && openEvidenceFrame(item.incident.evidenceAssetId, item.incident.title, item.incident.occurredAt)}
                  expanded={expandedEventId === item.incident.reviewEventId}
                  onToggleExpanded={() => setExpandedEventId(expandedEventId === item.incident.reviewEventId ? null : item.incident.reviewEventId)}
                  commentDraft={commentDrafts[item.incident.reviewEventId ?? ""] ?? ""}
                  onCommentChange={(value) => item.incident.reviewEventId && setCommentDrafts((prev) => ({ ...prev, [item.incident.reviewEventId!]: value }))}
                  onSubmitComment={() => item.incident.reviewEventId && submitComment(item.incident.reviewEventId)}
                  bulkSelected={item.incident.reviewEventId ? bulkSelection.has(item.incident.reviewEventId) : false}
                  onToggleBulkSelected={() => item.incident.reviewEventId && toggleBulkSelection(item.incident.reviewEventId)}
                  noEvidenceImageReason={item.incident.reviewEventId ? (noEvidenceImageReasonById.get(item.incident.reviewEventId) ?? null) : null}
                />
              ),
            )}
          </div>
        </SectionCard>

        {/* Bulk review, preserved from the existing workflow */}
        {review && bulkSelection.size > 0 && (
          <div className="flex items-center gap-2 rounded-xl border border-lecturer-border bg-lecturer-border-subtle p-3 text-sm">
            <span>{bulkSelection.size} event(s) selected</span>
            <button type="button" onClick={() => setBulkConfirming(true)} className="rounded-lg bg-lecturer-accent px-3 py-1.5 text-xs text-white hover:bg-lecturer-accent-hover">
              Mark selected as Reviewed — no concern
            </button>
          </div>
        )}
        {bulkConfirming && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <p>Mark {bulkSelection.size} selected event(s) as &quot;Reviewed — no concern&quot;? This creates an individual, immutable review record for each event.</p>
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={confirmBulkNoConcern} className="rounded-lg bg-lecturer-accent px-3 py-1.5 text-xs text-white hover:bg-lecturer-accent-hover">
                Confirm
              </button>
              <button type="button" onClick={() => setBulkConfirming(false)} className="rounded-lg border border-lecturer-border px-3 py-1.5 text-xs">
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Section 1 — Identity & presence */}
        <SectionCard title="Identity & presence" subtitle="Camera and identity-verification evidence.">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <CompactStat value={data.aiCameraIntegritySummary?.possiblePhoneCount ?? 0} label="Possible phone visible" />
            <CompactStat value={data.aiCameraIntegritySummary?.possibleSecondPersonCount ?? 0} label="Possible additional person" />
            <CompactStat value={data.aiCameraIntegritySummary?.noPersonCount ?? 0} label="No person visible" />
            <CompactStat value={data.aiCameraIntegritySummary?.cameraBlockedOrDarkCount ?? 0} label="Camera blocked/dark" />
          </div>
          {positiveControlEvents.some((e) => ["STUDENT_VERIFICATION_CONFIRMED", "CAMERA_PERMISSION_GRANTED", "CAMERA_STARTED", "CAMERA_VISIBILITY_RESTORED"].includes(e.eventType)) && (
            <p className="mt-3 flex flex-wrap gap-2">
              {positiveControlEvents.filter((e) => e.eventType === "STUDENT_VERIFICATION_CONFIRMED").length > 0 && (
                <StatusBadge tone="success">Identity verification: control active</StatusBadge>
              )}
              {positiveControlEvents.some((e) => e.eventType === "CAMERA_STARTED" || e.eventType === "CAMERA_PERMISSION_GRANTED") && (
                <StatusBadge tone="success">Camera: control active</StatusBadge>
              )}
              {positiveControlEvents.some((e) => e.eventType === "CAMERA_VISIBILITY_RESTORED") && <StatusBadge tone="success">Camera visibility: control restored</StatusBadge>}
            </p>
          )}
          {data.aiCameraIntegritySummary && (
            <p className="mt-3 rounded-lg border border-amber-100 bg-amber-50 p-3 text-xs text-amber-800">{data.aiCameraIntegritySummary.disclaimer}</p>
          )}
          {/* Evidence-provenance fix — present-tense configuration
              context only. This exam has no per-attempt snapshot of this
              setting, so it is deliberately never used to explain why any
              specific past incident above does or doesn't have an image —
              see noEvidenceImageReason on each incident instead. */}
          <p className="mt-3 text-xs text-lecturer-text-muted">
            Currently, evidence-frame capture for phone/second-person signals is{" "}
            <strong>{data.currentCaptureAiViolationEvidenceEnabled ? "enabled" : "disabled"}</strong> for this exam. This
            reflects the exam&apos;s present configuration only — it does not describe the setting at the time of this
            attempt.
          </p>
        </SectionCard>

        {/* Section 2 — Display / screen integrity */}
        <SectionCard title="Display & screen integrity" subtitle="Screen-share and additional-display evidence.">
          {data.screenShareIntegritySummary ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <CompactStat value={data.screenShareIntegritySummary.interruptedCount} label="Interruptions" />
              <CompactStat value={data.screenShareIntegritySummary.restoredCount} label="Restorations" />
              <CompactStat value={data.screenShareIntegritySummary.surfaceRejectedCount} label="Non-monitor shares rejected" />
              <CompactStat value={data.screenShareIntegritySummary.permissionDeniedCount} label="Permission denied" />
            </div>
          ) : (
            <p className="text-sm text-lecturer-text-secondary">Screen sharing was not required for this attempt.</p>
          )}
          {timeline && (
            <div className="mt-3">
              <p className="text-xs font-medium uppercase text-lecturer-text-secondary">Additional display detection</p>
              {timeline.events.some((e) => e.source === "SECURE_CLIENT" && ["ADDITIONAL_DISPLAY_PRESENT", "DISPLAY_CONFIGURATION_CHANGED", "DISPLAY_POLICY_RESTORED"].includes(e.technicalEventType ?? "")) ? (
                <p className="mt-1 text-sm text-lecturer-text-secondary">
                  See the corresponding incident above, sourced from the secure client&apos;s own display-topology reporting for this attempt.
                </p>
              ) : (
                <p className="mt-1 text-sm text-lecturer-text-secondary">No additional-display signal was recorded for this attempt.</p>
              )}
            </div>
          )}
          {data.screenShareIntegritySummary && (
            <p className="mt-3 rounded-lg border border-amber-100 bg-amber-50 p-3 text-xs text-amber-800">{data.screenShareIntegritySummary.disclaimer}</p>
          )}
        </SectionCard>

        {/* Section 5 — Lockdown / application evidence */}
        {data.lockdownDetectionSummary && (
          <SectionCard title="Lockdown & application evidence" subtitle="Restricted or monitoring-adjacent applications Tether observed.">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <CompactStat value={data.lockdownDetectionSummary.remoteControlCount} label="Remote-control software" />
              <CompactStat value={data.lockdownDetectionSummary.screenCaptureCount} label="Screen-capture software" />
              <CompactStat value={data.lockdownDetectionSummary.debuggingToolCount} label="Debugging tools" />
              <CompactStat value={data.lockdownDetectionSummary.prohibitedApplicationCount} label="Other prohibited applications" />
              <CompactStat value={data.lockdownDetectionSummary.closedCount} label="Closed by student" />
            </div>
            <p className="mt-3 rounded-lg border border-amber-100 bg-amber-50 p-3 text-xs text-amber-800">{data.lockdownDetectionSummary.disclaimer}</p>
          </SectionCard>
        )}

        {/* Section 6 — Network / location */}
        <SectionCard title="Network & location" subtitle="Start vs submission network context.">
          <NetworkEvidenceSection networkEvidence={data.networkEvidence} />
        </SectionCard>

        {/* Section 7 — Answer similarity / collusion */}
        <SimilarityCollusionSection
          summary={data.similarityCollusionSummary}
          examId={data.exam.id}
          onAnalysisRun={async () => {
            const res = await fetch(`/api/lecturer/submissions/${id}/evidence`);
            if (res.ok) setData(await res.json());
          }}
        />

        {/* Section 8 — Tether Brainstorm / AI safeguards */}
        {brainstormEvents.length > 0 && <BrainstormSafeguardsSection submissionId={id} />}

        {/* Score / grading context, kept compact */}
        <SectionCard title="Attempt summary">
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <p className="text-xs uppercase text-lecturer-text-secondary">Status</p>
              <p className="mt-0.5">{data.status}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-lecturer-text-secondary">Started</p>
              <p className="mt-0.5">{new Date(data.startedAt).toLocaleString()}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-lecturer-text-secondary">Submitted</p>
              <p className="mt-0.5">{data.submittedAt ? new Date(data.submittedAt).toLocaleString() : "—"}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-lecturer-text-secondary">Score</p>
              <p className="mt-0.5">{data.totalScore != null ? data.totalScore : "—"}</p>
            </div>
          </div>
          {data.canvasPassback && (
            <p className="mt-3 text-xs text-lecturer-text-secondary">
              Canvas grade passback: {data.canvasPassback.status}
              {data.canvasPassback.scoreGiven != null && ` · Score sent: ${data.canvasPassback.scoreGiven}`}
              {data.canvasPassback.errorMessage && ` · Error: ${data.canvasPassback.errorMessage}`}
            </p>
          )}
          {data.aiMarking && (
            <p className="mt-2 text-xs text-lecturer-text-secondary">
              {data.aiMarking.aiDraftedCount} of {data.aiMarking.answeredEssayCount} answered essay answer(s) have an AI draft score. AI drafts are never final.
            </p>
          )}
        </SectionCard>

        {/* Policy applied — preserved from the existing review workflow */}
        {review && (
          <SectionCard title="Policy applied to this attempt">
            {review.policy.available ? (
              <>
                <p className="text-sm font-medium">{EXAM_MODE_LABELS_MAP[review.policy.examMode]}</p>
                <p className="mt-1 text-xs text-lecturer-text-secondary">
                  Calculator {review.policy.calculatorAllowed ? "allowed" : "not allowed"} · Notes {review.policy.notesAllowed ? "allowed" : "not allowed"} · Internet{" "}
                  {review.policy.internetAllowed ? "allowed" : "not allowed"} · AI tools {review.policy.aiToolsAllowed ? "allowed" : "not allowed"}
                </p>
                {review.policy.secureControls.length > 0 && (
                  <p className="mt-1 text-xs text-lecturer-text-secondary">Secure controls: {review.policy.secureControls.join(", ")}</p>
                )}
              </>
            ) : (
              <p className="text-sm text-lecturer-text-secondary">{review.policy.message}</p>
            )}
          </SectionCard>
        )}

        {/* Section 11 — Full activity log, collapsed */}
        <details className="rounded-xl border border-lecturer-border bg-lecturer-surface" open={showFullLog} onToggle={(e) => setShowFullLog(e.currentTarget.open)}>
          <summary className="cursor-pointer list-none px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-lecturer-text-primary">Full activity log</p>
                <p className="mt-0.5 text-xs text-lecturer-text-secondary">{events.length.toLocaleString()} recorded event(s) · complete audit trail, most recent first</p>
              </div>
              <span className="text-sm font-semibold text-lecturer-accent">{showFullLog ? "Hide" : "Show"} audit log</span>
            </div>
          </summary>

          <div className="border-t border-lecturer-border px-5 pb-5">
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <button
                type="button"
                onClick={() => setCategoryFilter("all")}
                className={`rounded px-2 py-1 ${categoryFilter === "all" ? "bg-lecturer-accent text-white hover:bg-lecturer-accent-hover" : "border border-lecturer-border text-lecturer-text-secondary"}`}
              >
                All ({events.length})
              </button>
              {(["evidence", "camera", "screen", "lockdown", "window", "info"] as IntegrityEventCategory[]).map((category) => (
                <button
                  key={category}
                  type="button"
                  onClick={() => setCategoryFilter(category)}
                  className={`rounded px-2 py-1 ${categoryFilter === category ? "bg-lecturer-accent text-white hover:bg-lecturer-accent-hover" : "border border-lecturer-border text-lecturer-text-secondary"}`}
                >
                  {INTEGRITY_EVENT_CATEGORY_LABELS[category]} ({categoryCounts[category]})
                </button>
              ))}
            </div>

            <div className="mt-3 overflow-x-auto rounded-lg border border-lecturer-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-lecturer-border bg-lecturer-border-subtle text-left">
                    <th className="p-2">Time</th>
                    <th className="p-2">Event type</th>
                    <th className="p-2">Severity</th>
                    <th className="p-2">Message</th>
                    <th className="p-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEvents.length === 0 && (
                    <tr>
                      <td colSpan={5} className="p-4 text-center text-lecturer-text-secondary">
                        {events.length === 0 ? "No integrity events recorded" : "No events in this category"}
                      </td>
                    </tr>
                  )}
                  {filteredEvents.map((e) => (
                    <tr key={e.id} className="border-b border-lecturer-border-subtle align-top">
                      <td className="whitespace-nowrap p-2">{new Date(e.occurredAt).toLocaleString()}</td>
                      <td className="p-2">
                        {e.eventLabel}
                        <p className="mt-0.5 font-mono text-[10px] text-lecturer-text-muted">{e.eventType}</p>
                      </td>
                      <td className="p-2">
                        <StatusBadge
                          tone={e.severity === "HIGH" ? "critical" : e.severity === "MEDIUM" ? "warning" : e.severity === "LOW" ? "info" : "neutral"}
                        >
                          {e.severity}
                        </StatusBadge>
                      </td>
                      <td className="max-w-xs p-2">
                        {e.message}
                        {e.evidenceFrame && (
                          <div className="mt-1">
                            <button
                              type="button"
                              onClick={() => openEvidenceFrame(e.evidenceFrame!.id, e.eventLabel, e.occurredAt)}
                              className="rounded border border-lecturer-border px-1.5 py-0.5 text-xs"
                            >
                              View evidence frame
                            </button>
                          </div>
                        )}
                      </td>
                      <td className="p-2">
                        {e.resolvedAt ? (
                          <span className="text-green-700">Reviewed{e.resolvedByName ? ` by ${e.resolvedByName}` : ""}</span>
                        ) : (
                          <span className="text-lecturer-text-secondary">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {data.evidenceFrames.length > 0 && (
              <div className="mt-4">
                <p className="text-xs font-medium uppercase text-lecturer-text-secondary">All evidence frames</p>
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {data.evidenceFrames.map((frame) => (
                    <div key={frame.id} className="rounded-lg border border-lecturer-border p-3 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span>{labelForEventType(frame.eventType)}</span>
                        <span className="text-lecturer-text-muted">{formatByteSize(frame.byteSize)}</span>
                      </div>
                      <p className="mt-1 text-lecturer-text-secondary">{new Date(frame.occurredAt).toLocaleString()}</p>
                      <button
                        type="button"
                        onClick={() => openEvidenceFrame(frame.id, labelForEventType(frame.eventType), frame.occurredAt)}
                        className="mt-2 rounded border border-lecturer-border px-2 py-1"
                      >
                        View evidence frame
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </details>
      </div>

      {viewingEvidence && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-xl border border-lecturer-border bg-lecturer-surface p-5 shadow-lg">
            <div className="flex items-center justify-between">
              <p className="text-base font-semibold">Evidence frame</p>
              <button type="button" onClick={closeEvidenceFrame} className="rounded border border-lecturer-border px-2 py-1 text-xs">
                Close
              </button>
            </div>
            <p className="mt-1 text-sm text-lecturer-text-primary">{viewingEvidence.eventLabel}</p>
            <p className="text-xs text-lecturer-text-secondary">{new Date(viewingEvidence.occurredAt).toLocaleString()}</p>
            <div className="mt-3 flex min-h-[120px] items-center justify-center rounded-lg border border-lecturer-border bg-lecturer-border-subtle">
              {viewingEvidence.loading && <p className="text-sm text-lecturer-text-secondary">Loading...</p>}
              {viewingEvidence.error && <p className="p-3 text-sm text-[#B42318]">{viewingEvidence.error}</p>}
              {viewingEvidence.objectUrl && (
                // eslint-disable-next-line @next/next/no-img-element -- authenticated blob: URL, not a static asset
                <img src={viewingEvidence.objectUrl} alt="Camera evidence frame" className="max-h-80 w-full rounded object-contain" />
              )}
            </div>
            <p className="mt-3 rounded-lg border border-amber-100 bg-amber-50 p-3 text-xs text-amber-800">
              A single, low-resolution evidence frame — a review signal, not proof of misconduct. No video was recorded.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function CompactStat({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="rounded-lg border border-lecturer-border p-3 text-center">
      <p className="text-xl font-semibold text-lecturer-text-primary">{value}</p>
      <p className="mt-0.5 text-xs text-lecturer-text-secondary">{label}</p>
    </div>
  );
}

const ANALYSIS_STATUS_LABELS: Record<string, string> = {
  PENDING: "Pending",
  PROCESSING: "Running",
  COMPLETE: "Complete",
  FAILED: "Failed",
};

/**
 * Issue 2 (Preview QA) — the exam-wide similarity page previously
 * required a lecturer to leave student evidence review, open that
 * separate page, and manually check every student. This surfaces the
 * SAME already-computed data (SubmissionSimilarityMatch/
 * CollusionClusterMember, read via evidenceReport.ts's
 * similarityCollusionSummary — never a new computation) directly here,
 * distinguishing "never run" from "run, nothing for this student" from
 * "run, with results." "Run exam similarity analysis" POSTs to the
 * existing exam-wide endpoint (the same one the similarity page's own
 * button calls) — this is a real, full-cohort run, not a per-student
 * shortcut, so it can take a moment for a large cohort.
 */
function SimilarityCollusionSection({
  summary,
  examId,
  onAnalysisRun,
}: {
  summary: EvidenceReport["similarityCollusionSummary"];
  examId: string;
  onAnalysisRun: () => Promise<void>;
}) {
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  async function runAnalysis() {
    setRunning(true);
    setRunError(null);
    try {
      const res = await fetch(`/api/lecturer/exams/${examId}/similarity-analysis`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setRunError(body?.error ?? "Similarity analysis failed. Try again.");
        return;
      }
      await onAnalysisRun();
    } catch {
      setRunError("Could not reach the server. Try again.");
    } finally {
      setRunning(false);
    }
  }

  const notEnoughEligibleSubmissions = summary.eligibleSubmissionCount < summary.minEligibleSubmissions;

  if (!summary.analysisHasRun && notEnoughEligibleSubmissions) {
    return (
      <SectionCard
        title="Answer similarity & collusion"
        subtitle="Similarity analysis becomes available when at least two eligible submissions have been submitted or graded."
      >
        <p className="text-sm text-lecturer-text-secondary">Eligible submissions: {summary.eligibleSubmissionCount}</p>
      </SectionCard>
    );
  }

  if (!summary.analysisHasRun) {
    return (
      <SectionCard title="Answer similarity & collusion" subtitle="Similarity analysis has not yet been run for this exam.">
        <button
          type="button"
          onClick={runAnalysis}
          disabled={running}
          className="rounded-lg bg-lecturer-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-lecturer-accent-hover disabled:opacity-50"
        >
          {running ? "Running…" : "Run exam similarity analysis"}
        </button>
        {runError && <p className="mt-2 text-sm text-[#B42318]">{runError}</p>}
      </SectionCard>
    );
  }

  const hasResultsForStudent = summary.highestSimilarityScore != null || summary.collusionConcernLevel != null;
  const zeroEligibleSubmissions = summary.analysisStatus === "COMPLETE" && summary.analysisSubmissionsAnalysed === 0;

  return (
    <SectionCard
      title="Answer similarity & collusion"
      subtitle={
        hasResultsForStudent
          ? "Compact summary of already-computed cohort analysis for this student."
          : zeroEligibleSubmissions
            ? "The exam-wide analysis completed, but no submitted/graded attempts were eligible to compare yet."
            : "The exam-wide analysis has run and found no similarity or collusion signal for this student."
      }
    >
      {hasResultsForStudent && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <CompactStat value={summary.highestSimilarityScore != null ? `${Math.round(summary.highestSimilarityScore * 100)}%` : "—"} label="Highest similarity" />
          <CompactStat value={summary.affectedQuestionCount} label="Affected questions" />
          <CompactStat value={summary.comparedStudentCount} label="Compared students" />
          <CompactStat value={summary.collusionConcernLevel ?? summary.matchReviewStatus?.replace(/_/g, " ") ?? "—"} label="Review level" />
        </div>
      )}
      <p className="mt-3 text-xs text-lecturer-text-secondary">
        Analysis status: {summary.analysisStatus ? (ANALYSIS_STATUS_LABELS[summary.analysisStatus] ?? summary.analysisStatus) : "—"}
        {summary.analysisSubmissionsAnalysed != null && ` · ${summary.analysisSubmissionsAnalysed} submission(s) analysed`}
      </p>
      {hasResultsForStudent && (
        <p className="mt-2 rounded-lg border border-amber-100 bg-amber-50 p-3 text-xs text-amber-800">{summary.disclaimer}</p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Link href={`/lecturer/exams/${examId}/similarity`} className="text-sm font-semibold text-lecturer-accent hover:text-lecturer-accent-hover">
          Open similarity analysis →
        </Link>
        <button type="button" onClick={runAnalysis} disabled={running} className="rounded border border-lecturer-border px-2 py-1 text-xs disabled:opacity-50">
          {running ? "Running…" : "Re-run exam similarity analysis"}
        </button>
      </div>
      {runError && <p className="mt-2 text-sm text-[#B42318]">{runError}</p>}
    </SectionCard>
  );
}

const BRAINSTORM_OUTCOME_LABELS: Record<string, string> = {
  APPROVED: "Guidance allowed",
  FALLBACK: "Guidance allowed",
  BLOCKED: "Blocked by Tether safeguard",
  FAILED: "Could not be completed",
};

const BRAINSTORM_RESPONSE_COLLAPSE_THRESHOLD = 220;
const BRAINSTORM_COMPACT_HISTORY_LIMIT = 3;

type BrainstormInteraction = {
  id: string;
  studentPrompt: string;
  response: string | null;
  status: string;
  createdAt: string;
};

/**
 * Item 3 (Brainstorm question history) — reuses the SAME ownership-scoped
 * read-only endpoint (/api/lecturer/submissions/[id]/ai-assistance, backed
 * by src/lib/aiAssistanceReview.ts's buildAiAssistanceReview) that already
 * powers the dedicated full-transcript page at
 * /lecturer/submissions/[id]/ai-assistance — no new query logic, no
 * frozen-file changes, and the exact same institution/ownership check
 * already gates who can see a given submission's Brainstorm activity.
 * Shows the actual persisted student question and stored response (never
 * reconstructed or invented) so a lecturer can see what was asked, not
 * just that "guidance was shown."
 */
function BrainstormSafeguardsSection({ submissionId }: { submissionId: string }) {
  const [interactions, setInteractions] = useState<BrainstormInteraction[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/lecturer/submissions/${submissionId}/ai-assistance`)
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then((body: { interactions: BrainstormInteraction[] }) => {
        if (!cancelled) setInteractions(body.interactions);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [submissionId]);

  if (error || !interactions || interactions.length === 0) return null;

  const sorted = [...interactions].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const visible = sorted.slice(0, BRAINSTORM_COMPACT_HISTORY_LIMIT);

  return (
    <SectionCard title="Tether Brainstorm safeguards" subtitle="System/audit evidence — permitted Brainstorm use is not an integrity violation.">
      <div className="space-y-3">
        {visible.map((interaction) => {
          const outcome = BRAINSTORM_OUTCOME_LABELS[interaction.status] ?? interaction.status;
          const showResponse = interaction.response && (interaction.status === "APPROVED" || interaction.status === "FALLBACK");
          const responseIsLong = (interaction.response?.length ?? 0) > BRAINSTORM_RESPONSE_COLLAPSE_THRESHOLD;
          return (
            <div key={interaction.id} className="rounded-xl border border-lecturer-border p-4">
              <p className="text-xs font-medium uppercase text-lecturer-text-secondary">Student question</p>
              <p className="mt-1 text-sm text-lecturer-text-primary">&quot;{interaction.studentPrompt}&quot;</p>
              {showResponse && (
                <>
                  <p className="mt-3 text-xs font-medium uppercase text-lecturer-text-secondary">Tether response</p>
                  {responseIsLong ? (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-sm text-lecturer-accent">Show response</summary>
                      <p className="mt-1 text-sm text-lecturer-text-primary">{interaction.response}</p>
                    </details>
                  ) : (
                    <p className="mt-1 text-sm text-lecturer-text-primary">{interaction.response}</p>
                  )}
                </>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <StatusBadge tone={interaction.status === "BLOCKED" ? "warning" : interaction.status === "FAILED" ? "neutral" : "success"}>
                  {outcome}
                </StatusBadge>
                <span className="text-xs text-lecturer-text-secondary">
                  {new Date(interaction.createdAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex items-center justify-between">
        <p className="text-xs text-lecturer-text-secondary">
          Guidance shown, regenerated, or declined under this attempt&apos;s policy is expected, permitted behaviour.
        </p>
        <Link href={`/lecturer/submissions/${submissionId}/ai-assistance`} className="shrink-0 text-sm font-semibold text-lecturer-accent hover:text-lecturer-accent-hover">
          View all Brainstorm activity →
        </Link>
      </div>
    </SectionCard>
  );
}

function NetworkEvidenceSection({ networkEvidence: ne }: { networkEvidence: EvidenceReport["networkEvidence"] }) {
  const signalTone: Record<string, StatusTone> = { Normal: "neutral", "Needs review": "warning", "High review signal": "critical" };
  const loc = (e: { country: string | null; region: string | null; city: string | null; locationAccuracy: string } | null) => {
    if (!e) return "—";
    if (e.locationAccuracy === "UNAVAILABLE") return "Not available";
    const parts = [e.city, e.region, e.country].filter(Boolean);
    return parts.length ? `${parts.join(", ")} (approximate)` : "—";
  };
  return (
    <div className="space-y-3">
      <StatusBadge tone={signalTone[ne.reviewSignal] ?? "neutral"}>
        {ne.reviewSignal === "Normal" ? "Network unchanged" : `Network changed — ${ne.reviewSignal.toLowerCase()}`}
      </StatusBadge>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <p className="text-xs font-medium uppercase text-lecturer-text-secondary">Start</p>
          {ne.start ? (
            <div className="mt-1 space-y-0.5 text-sm">
              <p>IP: {ne.start.ipAddress ?? "—"}</p>
              <p className="text-lecturer-text-secondary">{loc(ne.start)}</p>
              <p className="text-lecturer-text-secondary">
                {ne.start.browserName ?? "—"} / {ne.start.osName ?? "—"}
              </p>
              <p className="text-xs text-lecturer-text-muted">{new Date(ne.start.capturedAt).toLocaleString()}</p>
              {ne.start.vpnOrProxySignal && <StatusBadge tone="warning">VPN/proxy signal</StatusBadge>}
            </div>
          ) : (
            <p className="mt-1 text-sm text-lecturer-text-muted">Not recorded</p>
          )}
        </div>
        <div>
          <p className="text-xs font-medium uppercase text-lecturer-text-secondary">Submission</p>
          {ne.submit ? (
            <div className="mt-1 space-y-0.5 text-sm">
              <p>IP: {ne.submit.ipAddress ?? "—"}</p>
              <p className="text-lecturer-text-secondary">{loc(ne.submit)}</p>
              <p className="text-lecturer-text-secondary">
                {ne.submit.browserName ?? "—"} / {ne.submit.osName ?? "—"}
              </p>
              <p className="text-xs text-lecturer-text-muted">{new Date(ne.submit.capturedAt).toLocaleString()}</p>
              {ne.submit.vpnOrProxySignal && <StatusBadge tone="warning">VPN/proxy signal</StatusBadge>}
            </div>
          ) : (
            <p className="mt-1 text-sm text-lecturer-text-muted">Not recorded</p>
          )}
        </div>
      </div>
      <p className="rounded-lg border border-amber-100 bg-amber-50 p-3 text-xs text-amber-800">{ne.networkEvidenceDisclaimer}</p>
    </div>
  );
}

/**
 * Issue 1 (Preview QA) — a reviewable camera incident's evidence frame
 * previously required an extra click ("View evidence" -> modal) before a
 * lecturer could see anything. Auto-loads a small preview using the
 * SAME authenticated route/audit trail as the full-size viewer
 * (GET /api/integrity-evidence/[id] — see that route's own doc comment:
 * every successful view is recorded) rather than a raw <img src>, so
 * this never bypasses the existing access control or audit logging.
 * Only ever rendered for POSSIBLE_PHONE_VISIBLE/POSSIBLE_SECOND_PERSON_VISIBLE
 * incidents that already have an evidenceAssetId — never fabricates an
 * image for event types evidence capture doesn't support (no-person,
 * blocked, dark — see aiCameraEvidenceFrame.ts's own doc comment on why
 * those are deliberately excluded from capture in v1).
 */
function IncidentEvidenceThumbnail({ evidenceAssetId, onOpenFull }: { evidenceAssetId: string; onOpenFull: () => void }) {
  const [state, setState] = useState<{ objectUrl: string | null; loading: boolean; error: boolean }>({
    objectUrl: null,
    loading: true,
    error: false,
  });

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({ objectUrl: null, loading: true, error: false });
    fetch(buildEvidenceFrameViewPath(evidenceAssetId))
      .then((res) => (res.ok ? res.blob() : Promise.reject(res)))
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ objectUrl, loading: false, error: false });
      })
      .catch(() => {
        if (!cancelled) setState({ objectUrl: null, loading: false, error: true });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [evidenceAssetId]);

  if (state.error) return null;

  return (
    <button type="button" onClick={onOpenFull} className="mt-2 block overflow-hidden rounded-lg border border-lecturer-border" aria-label="View full evidence frame">
      {state.loading && <div className="flex h-24 w-36 items-center justify-center bg-lecturer-border-subtle text-xs text-lecturer-text-secondary">Loading…</div>}
      {state.objectUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- authenticated blob: URL, not a static asset
        <img src={state.objectUrl} alt="Camera evidence frame preview" className="h-24 w-36 object-cover" />
      )}
    </button>
  );
}

/**
 * Item 2 (window-focus grouping) — WINDOW_BLUR/WINDOW_FOCUS_RETURN pairs
 * are the noisiest incident type on a long exam, so >1 of them collapses
 * into one compact summary card instead of a long stack of near-identical
 * cards. Expanding renders the EXACT same IncidentCard used everywhere
 * else (via renderIncident, supplied by the caller with all its existing
 * review-action/history wiring) — nothing about the underlying incidents,
 * their raw events, or reviewer history is summarized away or duplicated.
 */
function WindowFocusGroupCard({
  incidents,
  expanded,
  onToggleExpanded,
  renderIncident,
}: {
  incidents: Incident[];
  expanded: boolean;
  onToggleExpanded: () => void;
  renderIncident: (incident: Incident) => ReactNode;
}) {
  const restoredCount = incidents.filter((i) => i.controlRestored).length;
  const noReturnCount = incidents.length - restoredCount;
  const confirmedDurations = incidents.map((i) => i.durationMs).filter((d): d is number => d != null);
  const longestConfirmedAbsenceMs = confirmedDurations.length ? Math.max(...confirmedDurations) : null;

  return (
    <div className="rounded-xl border border-lecturer-border p-4">
      <p className="text-sm font-semibold text-lecturer-text-primary">Window focus interruptions</p>
      <p className="mt-1 text-sm text-lecturer-text-secondary">{incidents.length} incidents</p>
      <ul className="mt-2 space-y-0.5 text-xs text-lecturer-text-secondary">
        {longestConfirmedAbsenceMs != null && <li>Longest confirmed absence: {formatDuration(longestConfirmedAbsenceMs)}</li>}
        {restoredCount > 0 && <li>{restoredCount} restored normally</li>}
        {noReturnCount > 0 && <li>{noReturnCount} has no return event recorded</li>}
      </ul>
      <button type="button" onClick={onToggleExpanded} className="mt-3 rounded border border-lecturer-border px-2 py-1 text-xs">
        {expanded ? "Hide incidents" : "View incidents"}
      </button>
      {expanded && <div className="mt-3 space-y-3">{incidents.map(renderIncident)}</div>}
    </div>
  );
}

function IncidentCard({
  incident,
  reviewEvent,
  noteText,
  onNoteChange,
  onReviewAction,
  onViewEvidence,
  expanded,
  onToggleExpanded,
  commentDraft,
  onCommentChange,
  onSubmitComment,
  bulkSelected,
  onToggleBulkSelected,
  noEvidenceImageReason,
}: {
  incident: Incident;
  reviewEvent: ReviewEvent | null;
  noteText: string;
  onNoteChange: (value: string) => void;
  onReviewAction: (status: string) => void;
  onViewEvidence: () => void;
  expanded: boolean;
  onToggleExpanded: () => void;
  commentDraft: string;
  onCommentChange: (value: string) => void;
  onSubmitComment: () => void;
  bulkSelected: boolean;
  onToggleBulkSelected: () => void;
  noEvidenceImageReason: "CAPTURE_DISABLED" | "CAPTURE_FAILED" | "UNKNOWN" | null;
}) {
  const reviewed = reviewEvent && reviewEvent.reviewStatus !== "NEEDS_REVIEW";

  return (
    <div className="rounded-xl border border-lecturer-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        {reviewEvent && !reviewed && (
          <input type="checkbox" checked={bulkSelected} onChange={onToggleBulkSelected} aria-label="Select for bulk review" />
        )}
        <ReviewLevelBadge level={incident.reviewLevel} />
        {reviewed && reviewEvent && <StatusBadge tone={REVIEW_STATUS_TONES[reviewEvent.reviewStatus] ?? "success"}>{reviewEvent.reviewStatusLabel}</StatusBadge>}
        {!reviewEvent && <StatusBadge tone="neutral">Evidence only</StatusBadge>}
        <span className="text-xs text-lecturer-text-secondary">
          {formatTimeRange(incident.occurredAt, incident.endedAt)}
          {incident.durationMs != null && ` · ${formatDuration(incident.durationMs)}`}
        </span>
      </div>

      <p className="mt-2 text-sm font-semibold text-lecturer-text-primary">{incident.title}</p>
      <p className="mt-1 text-sm text-lecturer-text-secondary">{incident.observation}</p>
      {incident.controlRestored && <p className="mt-1 text-xs text-green-700">Control restored.</p>}

      {incident.hasCameraEvidenceCapability && incident.evidenceAssetId && (
        <IncidentEvidenceThumbnail evidenceAssetId={incident.evidenceAssetId} onOpenFull={onViewEvidence} />
      )}
      {incident.hasCameraEvidenceCapability && !incident.evidenceAssetId && noEvidenceImageReason && (
        <p className="mt-2 text-xs text-lecturer-text-secondary">{NO_EVIDENCE_IMAGE_EXPLANATIONS[noEvidenceImageReason]}</p>
      )}

      {reviewEvent?.policyInterpretation && (
        <p className="mt-2 text-xs text-lecturer-text-secondary">
          Policy interpretation: {reviewEvent.policyInterpretation.explanation}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {incident.evidenceAssetId && (
          <button type="button" onClick={onViewEvidence} className="rounded border border-lecturer-border px-2 py-1 text-xs">
            View evidence
          </button>
        )}
        {reviewEvent && (
          <button type="button" onClick={onToggleExpanded} className="rounded border border-lecturer-border px-2 py-1 text-xs">
            {expanded ? "Hide comments" : `Comments (${reviewEvent.comments.length})`}
          </button>
        )}
      </div>

      {reviewEvent && !reviewed && (
        <div className="mt-3 border-t border-lecturer-border pt-3">
          <input
            type="text"
            placeholder="Optional review note"
            className="w-full rounded border border-lecturer-border px-2 py-1 text-xs"
            value={noteText}
            onChange={(e) => onNoteChange(e.target.value)}
          />
          <div className="mt-2 flex flex-wrap gap-2">
            {REVIEW_ACTIONS.map((action) => (
              <button key={action.status} onClick={() => onReviewAction(action.status)} className="rounded border border-lecturer-border px-2 py-1 text-xs">
                {action.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {reviewEvent?.reviewedAt && (
        <p className="mt-2 text-xs text-lecturer-text-secondary">
          Decision: {reviewEvent.reviewStatusLabel} by {reviewEvent.reviewedByName ?? "—"} on {new Date(reviewEvent.reviewedAt).toLocaleString()}
          {reviewEvent.reviewNote && ` — ${reviewEvent.reviewNote}`}
        </p>
      )}

      {expanded && reviewEvent && (
        <div className="mt-3 border-t border-lecturer-border pt-3">
          {reviewEvent.comments.length === 0 && <p className="text-xs text-lecturer-text-muted">No comments yet.</p>}
          {reviewEvent.comments.map((c) => (
            <div key={c.id} className="mt-2 text-xs">
              <p className="font-medium text-lecturer-text-primary">
                {c.authorName} — {c.authorRole === "LECTURER" ? "Lecturer" : c.authorRole === "PLATFORM_ADMIN" ? "Platform admin" : c.authorRole}
              </p>
              <p className="text-lecturer-text-muted">{new Date(c.createdAt).toLocaleString()}</p>
              <p className="mt-0.5 text-lecturer-text-primary">{c.comment}</p>
            </div>
          ))}
          <div className="mt-2 flex gap-2">
            <input
              type="text"
              placeholder="Add a comment"
              className="w-full rounded border border-lecturer-border px-2 py-1 text-xs"
              value={commentDraft}
              onChange={(e) => onCommentChange(e.target.value)}
            />
            <button type="button" onClick={onSubmitComment} className="rounded border border-lecturer-border px-2 py-1 text-xs">
              Add comment
            </button>
          </div>
          {reviewEvent.statusHistory.length > 0 && (
            <div className="mt-3">
              <p className="text-xs font-medium text-lecturer-text-secondary">Status history</p>
              {reviewEvent.statusHistory.map((h) => (
                <p key={h.id} className="mt-1 text-xs text-lecturer-text-secondary">
                  {h.fromStatus ?? "NEEDS_REVIEW"} → {h.toStatus} by {h.changedByName} ({h.changedByRole === "LECTURER" ? "Lecturer" : "Platform admin"}) on{" "}
                  {new Date(h.createdAt).toLocaleString()}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
