"use client";

import { useCallback, useEffect, useMemo, useState, use as usePromise } from "react";
import Link from "next/link";
import { buildEvidenceFrameViewPath, hasEvidenceFrame } from "@/lib/aiCameraEvidenceFrame";
import { evidenceFrameSourceLabel } from "@/lib/screenShareEvidence";
import {
  categoryForEventType,
  labelForEventType,
  INTEGRITY_EVENT_CATEGORY_LABELS,
  type IntegrityEventCategory,
} from "@/lib/integrityEventLabels";

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
    evidenceFrame: {
      id: string;
      kind: string;
      contentType: string;
      byteSize: number;
      capturedAt: string;
    } | null;
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
    policy: {
      mode: "OFF" | "REQUIRED";
      captureEvidence: boolean;
      evidenceIntervalSeconds: number;
      maxEvidenceFrames: number;
    };
    disclaimer: string;
  } | null;
  canvasPassback: {
    status: string;
    scoreGiven: number | null;
    sentAt: string | null;
    errorMessage: string | null;
  } | null;
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
  disclaimer: string;
};

// Exam Design Policy + Evidence Review v1 — see
// docs/exam-design-policy-v1.md and docs/evidence-review-workflow-v1.md.
// Every signal shown below is a REVIEW SIGNAL, never an automatic
// misconduct finding — the lecturer/institution makes the final decision.
type PolicyInterpretation = {
  applicable: boolean;
  policyAlignment: "PERMITTED" | "NOT_PERMITTED" | "NOT_APPLICABLE" | "UNKNOWN";
  adjustedReviewLevel: "NONE" | "LOW" | "MEDIUM" | "HIGH";
  reasonCode: string;
  explanation: string;
  limitation: string;
};

type ReviewComment = {
  id: string;
  comment: string;
  authorName: string;
  authorRole: string;
  commentType: string;
  createdAt: string;
};

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

const EXAM_MODE_LABELS_MAP: Record<string, string> = { CLOSED_BOOK: "Closed-book", OPEN_BOOK: "Open-book", CUSTOM: "Custom" };

const REVIEW_STATUS_STYLES: Record<string, string> = {
  NEEDS_REVIEW: "bg-gray-100 text-gray-600",
  REVIEWED_NO_CONCERN: "bg-green-100 text-green-700",
  REVIEWED_CONCERN_REMAINS: "bg-yellow-100 text-yellow-700",
  ESCALATED: "bg-red-100 text-red-700",
  RESOLVED: "bg-blue-100 text-blue-700",
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

const RISK_LEVEL_STYLES: Record<string, string> = {
  CLEAN: "bg-gray-100 text-gray-600",
  LOW: "bg-blue-100 text-blue-700",
  MEDIUM: "bg-yellow-100 text-yellow-700",
  HIGH: "bg-red-100 text-red-700",
};

const RISK_LEVEL_LABELS: Record<string, string> = {
  CLEAN: "Clean",
  LOW: "Low integrity risk",
  MEDIUM: "Medium integrity risk",
  HIGH: "High integrity risk",
};

function formatByteSize(byteSize: number): string {
  if (byteSize < 1024) return `${byteSize} B`;
  return `${(byteSize / 1024).toFixed(1)} KB`;
}

const CATEGORY_FILTER_ORDER: IntegrityEventCategory[] = ["evidence", "camera", "screen", "window", "info"];

function severityBadge(severity: string) {
  const styles: Record<string, string> = {
    HIGH: "bg-red-100 text-red-700",
    MEDIUM: "bg-yellow-100 text-yellow-700",
    LOW: "bg-blue-100 text-blue-700",
    INFO: "bg-gray-100 text-gray-600",
  };
  return (
    <span className={`rounded px-2 py-0.5 text-xs ${styles[severity] ?? styles.INFO}`}>
      {severity}
    </span>
  );
}

export default function EvidenceReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = usePromise(params);
  const [data, setData] = useState<EvidenceReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Timeline category filter — lets a lecturer collapse hundreds of rows
  // down to just the category they care about (e.g. "Evidence events")
  // instead of scrolling through the whole thing. "all" shows everything.
  const [categoryFilter, setCategoryFilter] = useState<IntegrityEventCategory | "all">("all");

  // On-Device AI Camera Integrity Detection v1 — Evidence Frames (additive,
  // opt-in). The modal only ever fetches the authenticated, audited
  // GET /api/integrity-evidence/[evidenceAssetId] route — never a raw
  // storage URL, which this page never even receives.
  const [viewingEvidence, setViewingEvidence] = useState<{
    evidenceAssetId: string;
    eventLabel: string;
    occurredAt: string;
    objectUrl: string | null;
    loading: boolean;
    error: string | null;
  } | null>(null);

  // Exam Design Policy + Evidence Review v1 — see
  // docs/evidence-review-workflow-v1.md.
  const [review, setReview] = useState<IntegrityReview | null>(null);
  const [reviewLoading, setReviewLoading] = useState(true);
  const [reviewNoteDrafts, setReviewNoteDrafts] = useState<Record<string, string>>({});
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [bulkSelection, setBulkSelection] = useState<Set<string>>(new Set());
  const [bulkConfirming, setBulkConfirming] = useState(false);

  const loadReview = useCallback(async () => {
    const res = await fetch(`/api/lecturer/submissions/${id}/integrity-review`);
    if (res.ok) setReview(await res.json());
    setReviewLoading(false);
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadReview();
  }, [loadReview]);

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

  useEffect(() => {
    fetch(`/api/lecturer/submissions/${id}/evidence`).then(async (res) => {
      if (!res.ok) {
        setError(
          res.status === 403
            ? "You don't have access to this submission's evidence report."
            : "Evidence report not found.",
        );
        setLoading(false);
        return;
      }
      setData(await res.json());
      setLoading(false);
    });
  }, [id]);

  async function openEvidenceFrame(evidenceAssetId: string, eventLabel: string, occurredAt: string) {
    setViewingEvidence({ evidenceAssetId, eventLabel, occurredAt, objectUrl: null, loading: true, error: null });
    const res = await fetch(buildEvidenceFrameViewPath(evidenceAssetId)).catch(() => null);
    if (!res || !res.ok) {
      setViewingEvidence((prev) =>
        prev ? { ...prev, loading: false, error: "Evidence frame could not be loaded." } : prev,
      );
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

  // Compact per-category counts for the timeline filter bar, and the
  // filtered row list — computed unconditionally (before the early
  // returns below) so hook order stays stable across renders.
  const events = useMemo(() => data?.events ?? [], [data]);
  const categoryCounts = useMemo(() => {
    const counts: Record<IntegrityEventCategory, number> = { evidence: 0, camera: 0, screen: 0, window: 0, info: 0 };
    for (const e of events) counts[categoryForEventType(e.eventType)]++;
    return counts;
  }, [events]);
  const filteredEvents = useMemo(() => {
    if (categoryFilter === "all") return events;
    return events.filter((e) => categoryForEventType(e.eventType) === categoryFilter);
  }, [events, categoryFilter]);

  if (loading) return <p className="text-gray-500">Loading evidence report...</p>;
  if (error) return <p className="text-red-600">{error}</p>;
  if (!data) return <p className="text-red-600">No data available.</p>;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Evidence report</h1>
        <div className="flex gap-2">
          <a
            href={`/api/lecturer/submissions/${id}/evidence.csv`}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm"
          >
            Export CSV
          </a>
          <Link
            href={`/lecturer/exams/${data.exam.id}/submissions/${data.submissionId}`}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm"
          >
            Back to grading
          </Link>
        </div>
      </div>

      <p className="mt-2 rounded border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700">
        {data.disclaimer}
      </p>

      {/* Exam Design Policy + Evidence Review v1 — see
          docs/exam-design-policy-v1.md and
          docs/evidence-review-workflow-v1.md. Every status/signal here is
          a review signal for a human lecturer, never an automatic
          misconduct finding — the lecturer/institution makes the final
          decision. */}
      <h2 className="mt-8 text-lg font-medium">Evidence review</h2>
      {reviewLoading && <p className="mt-2 text-sm text-gray-500">Loading evidence review...</p>}
      {!reviewLoading && review && (
        <>
          <div className="mt-3 grid grid-cols-2 gap-3 rounded border border-gray-200 p-4 text-sm sm:grid-cols-3">
            <div>
              <p className="text-xs uppercase text-gray-500">Overall review status</p>
              <p className="mt-1">
                <span className={`rounded px-2 py-0.5 text-xs ${REVIEW_STATUS_STYLES[review.summary.overallReviewStatus]}`}>
                  {review.summary.overallReviewStatus === "NEEDS_REVIEW" ? "Needs review" : review.summary.overallReviewStatus}
                </span>
              </p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-500">Items needing review</p>
              <p className="mt-1">{review.summary.needsReviewCount}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-500">Evidence frames</p>
              <p className="mt-1">{review.summary.evidenceFrameCount}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-500">Last reviewer activity</p>
              <p className="mt-1">
                {review.summary.lastReviewActivityAt
                  ? `${new Date(review.summary.lastReviewActivityAt).toLocaleString()}${review.summary.lastReviewer ? ` — ${review.summary.lastReviewer}` : ""}`
                  : "—"}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-500">Recommended next action</p>
              <p className="mt-1">
                <span className="rounded bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                  {REVIEW_RECOMMENDATION_LABELS[review.recommendation.recommendation] ?? review.recommendation.recommendation}
                </span>
              </p>
            </div>
          </div>

          <div className="mt-3 rounded border border-gray-200 p-4 text-sm">
            <p className="text-xs uppercase text-gray-500">Policy applied to this attempt</p>
            {review.policy.available ? (
              <>
                <p className="mt-1 font-medium">{EXAM_MODE_LABELS_MAP[review.policy.examMode]}</p>
                <p className="mt-1 text-xs text-gray-600">
                  Calculator {review.policy.calculatorAllowed ? "allowed" : "not allowed"} · Notes{" "}
                  {review.policy.notesAllowed ? "allowed" : "not allowed"} · Internet{" "}
                  {review.policy.internetAllowed ? "allowed" : "not allowed"} · AI tools{" "}
                  {review.policy.aiToolsAllowed ? "allowed" : "not allowed"}
                </p>
                {review.policy.secureControls.length > 0 && (
                  <p className="mt-1 text-xs text-gray-500">Secure controls: {review.policy.secureControls.join(", ")}</p>
                )}
              </>
            ) : (
              <p className="mt-1 text-gray-500">{review.policy.message}</p>
            )}
          </div>

          {bulkSelection.size > 0 && (
            <div className="mt-3 flex items-center gap-2 rounded border border-gray-200 bg-gray-50 p-3 text-sm">
              <span>{bulkSelection.size} event(s) selected</span>
              <button
                type="button"
                onClick={() => setBulkConfirming(true)}
                className="rounded bg-black px-3 py-1.5 text-xs text-white"
              >
                Mark selected as Reviewed — no concern
              </button>
            </div>
          )}
          {bulkConfirming && (
            <div className="mt-2 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <p>
                Mark {bulkSelection.size} selected event(s) as &quot;Reviewed — no concern&quot;? This creates an
                individual, immutable review record for each event.
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={confirmBulkNoConcern}
                  className="rounded bg-black px-3 py-1.5 text-xs text-white"
                >
                  Confirm
                </button>
                <button
                  type="button"
                  onClick={() => setBulkConfirming(false)}
                  className="rounded border border-gray-300 px-3 py-1.5 text-xs"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          <div className="mt-3 space-y-3">
            {review.events.length === 0 && (
              <p className="rounded border border-gray-200 bg-gray-50 p-4 text-sm text-gray-500">
                No reviewable integrity events for this submission.
              </p>
            )}
            {review.events.map((e) => (
              <div key={e.id} className="rounded border border-gray-200 p-4 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="checkbox"
                    checked={bulkSelection.has(e.id)}
                    onChange={() => toggleBulkSelection(e.id)}
                    aria-label="Select for bulk review"
                  />
                  <span className="font-medium">{e.eventLabel}</span>
                  <span className={`rounded px-2 py-0.5 text-xs ${REVIEW_STATUS_STYLES[e.reviewStatus] ?? REVIEW_STATUS_STYLES.NEEDS_REVIEW}`}>
                    {e.reviewStatusLabel}
                  </span>
                  <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">Signal: {e.severity}</span>
                  <span className="text-xs text-gray-400">{new Date(e.occurredAt).toLocaleString()}</span>
                </div>

                <p className="mt-2 text-xs font-medium text-gray-600">Policy interpretation:</p>
                <p className="text-gray-700">{e.policyInterpretation.explanation}</p>
                <p className="mt-1 text-xs text-amber-700">Limitation: {e.policyInterpretation.limitation}</p>

                {e.evidenceFrame && (
                  <button
                    type="button"
                    onClick={() => openEvidenceFrame(e.evidenceFrame!.id, e.eventLabel, e.occurredAt)}
                    className="mt-2 rounded border border-gray-300 px-2 py-1 text-xs"
                  >
                    View evidence frame
                  </button>
                )}

                {e.reviewedAt && (
                  <p className="mt-2 text-xs text-gray-500">
                    Decision: {e.reviewStatusLabel} by {e.reviewedByName ?? "—"} on {new Date(e.reviewedAt).toLocaleString()}
                    {e.reviewNote && ` — ${e.reviewNote}`}
                  </p>
                )}

                <div className="mt-3">
                  <input
                    type="text"
                    placeholder="Optional review note"
                    className="w-full rounded border border-gray-300 px-2 py-1 text-xs"
                    value={reviewNoteDrafts[e.id] ?? ""}
                    onChange={(ev) => setReviewNoteDrafts((prev) => ({ ...prev, [e.id]: ev.target.value }))}
                  />
                  <div className="mt-2 flex flex-wrap gap-2">
                    {REVIEW_ACTIONS.map((action) => (
                      <button
                        key={action.status}
                        onClick={() => submitEventReview(e.id, action.status)}
                        className="rounded border border-gray-300 px-2 py-1 text-xs"
                      >
                        {action.label}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => setExpandedEventId(expandedEventId === e.id ? null : e.id)}
                      className="rounded border border-gray-300 px-2 py-1 text-xs"
                    >
                      {expandedEventId === e.id ? "Hide comments" : `Comments (${e.comments.length})`}
                    </button>
                    <Link
                      href={`/lecturer/exams/${data.exam.id}/submissions/${data.submissionId}`}
                      className="rounded border border-gray-300 px-2 py-1 text-xs"
                    >
                      Require oral verification
                    </Link>
                  </div>
                </div>

                {expandedEventId === e.id && (
                  <div className="mt-3 border-t border-gray-200 pt-3">
                    {e.comments.length === 0 && <p className="text-xs text-gray-400">No comments yet.</p>}
                    {e.comments.map((c) => (
                      <div key={c.id} className="mt-2 text-xs">
                        <p className="font-medium text-gray-700">
                          {c.authorName} — {c.authorRole === "LECTURER" ? "Lecturer" : c.authorRole === "PLATFORM_ADMIN" ? "Platform admin" : c.authorRole}
                        </p>
                        <p className="text-gray-400">{new Date(c.createdAt).toLocaleString()}</p>
                        <p className="mt-0.5 text-gray-700">{c.comment}</p>
                      </div>
                    ))}
                    <div className="mt-2 flex gap-2">
                      <input
                        type="text"
                        placeholder="Add a comment"
                        className="w-full rounded border border-gray-300 px-2 py-1 text-xs"
                        value={commentDrafts[e.id] ?? ""}
                        onChange={(ev) => setCommentDrafts((prev) => ({ ...prev, [e.id]: ev.target.value }))}
                      />
                      <button
                        type="button"
                        onClick={() => submitComment(e.id)}
                        className="rounded border border-gray-300 px-2 py-1 text-xs"
                      >
                        Add comment
                      </button>
                    </div>
                    {e.statusHistory.length > 0 && (
                      <div className="mt-3">
                        <p className="text-xs font-medium text-gray-600">Status history</p>
                        {e.statusHistory.map((h) => (
                          <p key={h.id} className="mt-1 text-xs text-gray-500">
                            {h.fromStatus ?? "NEEDS_REVIEW"} → {h.toStatus} by {h.changedByName} (
                            {h.changedByRole === "LECTURER" ? "Lecturer" : "Platform admin"}) on{" "}
                            {new Date(h.createdAt).toLocaleString()}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      <div className="mt-6 grid grid-cols-2 gap-3 rounded border border-gray-200 p-4 text-sm sm:grid-cols-3">
        <div>
          <p className="text-xs uppercase text-gray-500">Student</p>
          <p>{data.student.name}</p>
          <p className="text-gray-500">{data.student.email}</p>
        </div>
        <div>
          <p className="text-xs uppercase text-gray-500">Exam</p>
          <p>{data.exam.title}</p>
        </div>
        <div>
          <p className="text-xs uppercase text-gray-500">Status</p>
          <p>{data.status}</p>
        </div>
        <div>
          <p className="text-xs uppercase text-gray-500">Started</p>
          <p>{new Date(data.startedAt).toLocaleString()}</p>
        </div>
        <div>
          <p className="text-xs uppercase text-gray-500">Submitted</p>
          <p>{data.submittedAt ? new Date(data.submittedAt).toLocaleString() : "—"}</p>
        </div>
        <div>
          <p className="text-xs uppercase text-gray-500">Score</p>
          <p>{data.totalScore != null ? data.totalScore : "—"}</p>
        </div>
        <div>
          <p className="text-xs uppercase text-gray-500">Integrity risk</p>
          <p>
            <span
              className={`rounded px-2 py-0.5 text-xs ${RISK_LEVEL_STYLES[data.riskLevel]}`}
            >
              {RISK_LEVEL_LABELS[data.riskLevel]}
            </span>{" "}
            <span className="text-gray-500">(score: {data.riskScore})</span>
          </p>
        </div>
      </div>

      {data.canvasPassback && (
        <div className="mt-4 rounded border border-gray-200 p-4 text-sm">
          <p className="text-xs uppercase text-gray-500">Canvas grade passback (optional module)</p>
          <p>Status: {data.canvasPassback.status}</p>
          {data.canvasPassback.scoreGiven != null && <p>Score sent: {data.canvasPassback.scoreGiven}</p>}
          {data.canvasPassback.errorMessage && (
            <p className="text-red-600">Error: {data.canvasPassback.errorMessage}</p>
          )}
        </div>
      )}

      {data.aiMarking && (
        <div className="mt-4 rounded border border-gray-200 p-4 text-sm">
          <p className="text-xs uppercase text-gray-500">AI draft marking (optional module)</p>
          <p>
            {data.aiMarking.aiDraftedCount} of {data.aiMarking.answeredEssayCount} answered essay
            answer(s) have an AI draft score. AI drafts are never final — a lecturer must approve
            them.
          </p>
        </div>
      )}

      <h2 className="mt-8 text-lg font-medium">Network evidence</h2>
      {(() => {
        const ne = data.networkEvidence;
        const signalStyle: Record<string, string> = {
          Normal: "bg-gray-100 text-gray-600",
          "Needs review": "bg-yellow-100 text-yellow-700",
          "High review signal": "bg-red-100 text-red-700",
        };
        const loc = (
          e: { country: string | null; region: string | null; city: string | null; locationAccuracy: string } | null,
        ) => {
          if (!e) return "—";
          if (e.locationAccuracy === "UNAVAILABLE") return "Not available (no geolocation provider configured)";
          const parts = [e.city, e.region, e.country].filter(Boolean);
          return parts.length ? `${parts.join(", ")} (approximate IP-based location)` : "—";
        };
        return (
          <div className="mt-3 space-y-4">
            <div className="flex items-center gap-2 rounded border border-gray-200 p-3">
              <span className="text-xs text-gray-500">Network review signal:</span>
              <span className={`rounded px-2 py-0.5 text-xs ${signalStyle[ne.reviewSignal] ?? signalStyle.Normal}`}>
                {ne.reviewSignal}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3 rounded border border-gray-200 p-4 text-sm">
              <div>
                <p className="text-xs font-medium uppercase text-gray-500">At exam open</p>
                {ne.start ? (
                  <>
                    <p className="mt-1">IP: {ne.start.ipAddress ?? "—"}</p>
                    <p>Approx. location: {loc(ne.start)}</p>
                    <p>Browser: {ne.start.browserName ?? "—"} / {ne.start.osName ?? "—"}</p>
                    {ne.start.vpnOrProxySignal && (
                      <p className="text-yellow-700">VPN/proxy signal detected</p>
                    )}
                    <p className="mt-1 text-xs text-gray-400">
                      Captured {new Date(ne.start.capturedAt).toLocaleString()}
                    </p>
                  </>
                ) : (
                  <p className="text-gray-400">Not recorded</p>
                )}
              </div>
              <div>
                <p className="text-xs font-medium uppercase text-gray-500">At submission</p>
                {ne.submit ? (
                  <>
                    <p className="mt-1">IP: {ne.submit.ipAddress ?? "—"}</p>
                    <p>Approx. location: {loc(ne.submit)}</p>
                    <p>Browser: {ne.submit.browserName ?? "—"} / {ne.submit.osName ?? "—"}</p>
                    {ne.submit.networkChanged && (
                      <p className="text-yellow-700">Network address changed since exam open</p>
                    )}
                    {ne.submit.vpnOrProxySignal && (
                      <p className="text-yellow-700">VPN/proxy signal detected</p>
                    )}
                    <p className="mt-1 text-xs text-gray-400">
                      Captured {new Date(ne.submit.capturedAt).toLocaleString()}
                    </p>
                  </>
                ) : (
                  <p className="text-gray-400">Not recorded</p>
                )}
              </div>
            </div>
            <p className="rounded border border-amber-100 bg-amber-50 p-3 text-xs text-amber-800">
              {ne.networkEvidenceDisclaimer}
            </p>
          </div>
        );
      })()}

      {data.aiCameraIntegritySummary && (
        <div className="mt-8">
          <h2 className="text-lg font-medium">AI-assisted camera integrity signals</h2>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded border border-gray-200 p-3 text-center">
              <p className="text-2xl font-semibold">
                {data.aiCameraIntegritySummary.possiblePhoneCount}
              </p>
              <p className="text-xs text-gray-500">Possible phone visible</p>
            </div>
            <div className="rounded border border-gray-200 p-3 text-center">
              <p className="text-2xl font-semibold">
                {data.aiCameraIntegritySummary.possibleSecondPersonCount}
              </p>
              <p className="text-xs text-gray-500">Possible additional person visible</p>
            </div>
            <div className="rounded border border-gray-200 p-3 text-center">
              <p className="text-2xl font-semibold">{data.aiCameraIntegritySummary.noPersonCount}</p>
              <p className="text-xs text-gray-500">No person visible</p>
            </div>
            <div className="rounded border border-gray-200 p-3 text-center">
              <p className="text-2xl font-semibold">
                {data.aiCameraIntegritySummary.cameraBlockedOrDarkCount}
              </p>
              <p className="text-xs text-gray-500">Camera blocked/dark</p>
            </div>
          </div>
          <p className="mt-3 rounded border border-amber-100 bg-amber-50 p-3 text-xs text-amber-800">
            {data.aiCameraIntegritySummary.disclaimer}
          </p>
        </div>
      )}

      {/* Screen-share Evidence Mode v1 — see docs/screen-share-evidence-v1.md.
          Shows the lifecycle timeline summary AND the policy actually in
          effect for THIS attempt (the immutable snapshot, never the
          exam's current settings). */}
      {data.screenShareIntegritySummary && (
        <div className="mt-8">
          <h2 className="text-lg font-medium">Screen-share integrity signals</h2>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded border border-gray-200 p-3 text-center">
              <p className="text-2xl font-semibold">{data.screenShareIntegritySummary.startedCount}</p>
              <p className="text-xs text-gray-500">Sharing started</p>
            </div>
            <div className="rounded border border-gray-200 p-3 text-center">
              <p className="text-2xl font-semibold">{data.screenShareIntegritySummary.interruptedCount}</p>
              <p className="text-xs text-gray-500">Interruptions</p>
            </div>
            <div className="rounded border border-gray-200 p-3 text-center">
              <p className="text-2xl font-semibold">{data.screenShareIntegritySummary.restoredCount}</p>
              <p className="text-xs text-gray-500">Restorations</p>
            </div>
            <div className="rounded border border-gray-200 p-3 text-center">
              <p className="text-2xl font-semibold">{data.screenShareIntegritySummary.surfaceRejectedCount}</p>
              <p className="text-xs text-gray-500">Non-monitor shares rejected</p>
            </div>
            <div className="rounded border border-gray-200 p-3 text-center">
              <p className="text-2xl font-semibold">{data.screenShareIntegritySummary.permissionDeniedCount}</p>
              <p className="text-xs text-gray-500">Permission denied</p>
            </div>
            <div className="rounded border border-gray-200 p-3 text-center">
              <p className="text-2xl font-semibold">{data.screenShareIntegritySummary.unavailableCount}</p>
              <p className="text-xs text-gray-500">Unavailable</p>
            </div>
            <div className="rounded border border-gray-200 p-3 text-center">
              <p className="text-2xl font-semibold">{data.screenShareIntegritySummary.evidenceFrameCount}</p>
              <p className="text-xs text-gray-500">Evidence frames captured</p>
            </div>
            <div className="rounded border border-gray-200 p-3 text-center">
              <p className="text-2xl font-semibold">{data.screenShareIntegritySummary.evidenceCaptureFailedCount}</p>
              <p className="text-xs text-gray-500">Capture failures</p>
            </div>
          </div>
          <div className="mt-3 rounded border border-gray-200 bg-gray-50 p-3 text-xs text-gray-700">
            <p className="font-medium">Policy at the time of this attempt</p>
            <p className="mt-1">
              Mode: {data.screenShareIntegritySummary.policy.mode} · Evidence capture:{" "}
              {data.screenShareIntegritySummary.policy.captureEvidence ? "Enabled" : "Disabled"}
              {data.screenShareIntegritySummary.policy.captureEvidence && (
                <>
                  {" "}
                  · Interval: {data.screenShareIntegritySummary.policy.evidenceIntervalSeconds}s · Max frames:{" "}
                  {data.screenShareIntegritySummary.policy.maxEvidenceFrames}
                </>
              )}
            </p>
          </div>
          <p className="mt-3 rounded border border-amber-100 bg-amber-50 p-3 text-xs text-amber-800">
            {data.screenShareIntegritySummary.disclaimer}
          </p>
        </div>
      )}

      {/* Main review area — surfaced above the (potentially long) timeline
          below so a lecturer never has to scroll through hundreds of rows
          to find a saved evidence frame. Covers BOTH camera and
          screen-share evidence, sourced from the same IntegrityEvidenceAsset
          table — distinguished per-frame by `kind` (see
          evidenceFrameSourceLabel in src/lib/screenShareEvidence.ts). */}
      <h2 className="mt-8 text-lg font-medium">Evidence frames</h2>
      <p className="mt-1 text-sm text-gray-600">
        Low-resolution camera and screen-share evidence frames saved for review. These are review
        signals, not automatic misconduct decisions.
      </p>
      {data.evidenceFrames.length === 0 ? (
        <p className="mt-3 rounded border border-gray-200 bg-gray-50 p-4 text-sm text-gray-500">
          No evidence frames were saved for this submission.
        </p>
      ) : (
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {data.evidenceFrames.map((frame) => (
            <div key={frame.id} className="rounded border border-gray-200 p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="rounded bg-purple-50 px-2 py-0.5 text-xs font-medium text-purple-700">
                  {evidenceFrameSourceLabel(frame.kind)}
                </span>
                <span className="rounded bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                  {labelForEventType(frame.eventType)}
                </span>
                <span className="text-xs text-gray-400">{formatByteSize(frame.byteSize)}</span>
              </div>
              <p className="mt-2 text-xs text-gray-500">{new Date(frame.occurredAt).toLocaleString()}</p>
              <p className="text-xs text-gray-400">{frame.contentType}</p>
              <button
                type="button"
                onClick={() =>
                  openEvidenceFrame(frame.id, `${evidenceFrameSourceLabel(frame.kind)} — ${labelForEventType(frame.eventType)}`, frame.occurredAt)
                }
                className="mt-3 rounded border border-gray-300 px-2 py-1 text-xs"
              >
                View evidence frame
              </button>
            </div>
          ))}
        </div>
      )}

      <h2 className="mt-8 text-lg font-medium">Integrity event timeline</h2>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <button
          type="button"
          onClick={() => setCategoryFilter("all")}
          className={`rounded px-2 py-1 ${
            categoryFilter === "all" ? "bg-black text-white" : "border border-gray-300 text-gray-600"
          }`}
        >
          All ({events.length})
        </button>
        {CATEGORY_FILTER_ORDER.map((category) => (
          <button
            key={category}
            type="button"
            onClick={() => setCategoryFilter(category)}
            className={`rounded px-2 py-1 ${
              categoryFilter === category ? "bg-black text-white" : "border border-gray-300 text-gray-600"
            }`}
          >
            {INTEGRITY_EVENT_CATEGORY_LABELS[category]} ({categoryCounts[category]})
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-gray-500">
        Showing {filteredEvents.length} of {events.length} event(s), newest first.
      </p>
      <div className="mt-3 overflow-x-auto rounded border border-gray-200">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50 text-left">
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
                <td colSpan={5} className="p-4 text-center text-gray-500">
                  {events.length === 0
                    ? "No integrity events recorded"
                    : "No events in this category"}
                </td>
              </tr>
            )}
            {filteredEvents.map((e, i) => (
              <tr key={i} className="border-b border-gray-100 align-top">
                <td className="whitespace-nowrap p-2">{new Date(e.occurredAt).toLocaleString()}</td>
                <td className="p-2">{e.eventLabel}</td>
                <td className="p-2">{severityBadge(e.severity)}</td>
                <td className="max-w-xs p-2">
                  {e.message}
                  {e.confidenceBand && (
                    <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
                      {e.confidenceBand} confidence
                    </span>
                  )}
                  {hasEvidenceFrame(e) && (
                    <div className="mt-1">
                      <span className="mr-2 rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-700">
                        Evidence frame available
                      </span>
                      <button
                        type="button"
                        onClick={() => openEvidenceFrame(e.evidenceFrame!.id, e.eventLabel, e.occurredAt)}
                        className="rounded border border-gray-300 px-1.5 py-0.5 text-xs"
                      >
                        View evidence frame
                      </button>
                    </div>
                  )}
                </td>
                <td className="p-2">
                  {e.resolvedAt ? (
                    <span className="text-green-700">
                      Reviewed{e.resolvedByName ? ` by ${e.resolvedByName}` : ""}
                    </span>
                  ) : (
                    <span className="text-gray-500">Review recommended</span>
                  )}
                  {e.resolutionNote && (
                    <p className="mt-1 text-xs text-gray-500">Note: {e.resolutionNote}</p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {viewingEvidence && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded border border-gray-300 bg-white p-5 shadow-lg">
            <div className="flex items-center justify-between">
              <p className="text-base font-semibold">Evidence frame</p>
              <button
                type="button"
                onClick={closeEvidenceFrame}
                className="rounded border border-gray-300 px-2 py-1 text-xs"
              >
                Close
              </button>
            </div>
            <p className="mt-1 text-sm text-gray-700">{viewingEvidence.eventLabel}</p>
            <p className="text-xs text-gray-500">
              {new Date(viewingEvidence.occurredAt).toLocaleString()}
            </p>
            <div className="mt-3 flex min-h-[120px] items-center justify-center rounded border border-gray-200 bg-gray-50">
              {viewingEvidence.loading && <p className="text-sm text-gray-500">Loading...</p>}
              {viewingEvidence.error && <p className="p-3 text-sm text-red-600">{viewingEvidence.error}</p>}
              {viewingEvidence.objectUrl && (
                // eslint-disable-next-line @next/next/no-img-element -- authenticated blob: URL, not a static asset
                <img
                  src={viewingEvidence.objectUrl}
                  alt="Camera evidence frame"
                  className="max-h-80 w-full rounded object-contain"
                />
              )}
            </div>
            <p className="mt-3 rounded border border-amber-100 bg-amber-50 p-3 text-xs text-amber-800">
              A single, low-resolution camera evidence frame — a review signal, not proof of
              misconduct. No video was recorded.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
