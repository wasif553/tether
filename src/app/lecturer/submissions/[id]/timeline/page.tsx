"use client";

/**
 * Tether Integrity Evidence Timeline v1 — see
 * docs/integrity-evidence-timeline-v1.md.
 *
 * Chronological reconstruction of a single attempt from already-stored
 * facts. No cheating score, no misconduct conclusion, no evidence-
 * completeness percentage — see buildIntegrityEvidenceTimeline in
 * src/lib/integrityEvidenceTimeline.ts for the full source/dedup rules.
 */
import { useEffect, useState, use as usePromise } from "react";
import Link from "next/link";

type TimelineEventCategory = "LIFECYCLE" | "EXAM_ACTIVITY" | "SECURE_ENVIRONMENT" | "EVIDENCE" | "ALLOWED_RESOURCE";
type TimelineEventSeverity = "INFO" | "LOW" | "MEDIUM" | "HIGH";

type TimelineEvent = {
  id: string;
  timestamp: string;
  deviceReportedTimestamp?: string;
  category: TimelineEventCategory;
  label: string;
  detail?: string;
  severity: TimelineEventSeverity;
  questionId?: string;
  questionNumber?: number;
  source: string;
  technicalEventType?: string;
  reviewState: { status: string; label: string } | null;
  evidenceAssets: Array<{ id: string; kind: string; capturedAt: string }>;
  technicalDetails?: Array<{ label: string; value: string }>;
};

type IntegrityEvidenceTimeline = {
  submissionId: string;
  student: { name: string; email: string };
  exam: { id: string; title: string };
  summary: {
    totalEvents: number;
    evidenceAssetCount: number;
    needsReviewCount: number;
    attemptStatus: string;
    relatedSessionSignals: number;
    relatedTimingSignals: number;
  };
  events: TimelineEvent[];
};

type FilterValue = "ALL" | "REVIEW_SIGNALS" | "EXAM_ACTIVITY" | "EVIDENCE";

const FILTERS: { value: FilterValue; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "REVIEW_SIGNALS", label: "Review signals" },
  { value: "EXAM_ACTIVITY", label: "Exam activity" },
  { value: "EVIDENCE", label: "Evidence" },
];

function matchesFilter(event: TimelineEvent, filter: FilterValue): boolean {
  switch (filter) {
    case "ALL":
      return true;
    case "REVIEW_SIGNALS":
      return event.reviewState != null;
    case "EXAM_ACTIVITY":
      return event.category === "LIFECYCLE" || event.category === "EXAM_ACTIVITY" || event.category === "ALLOWED_RESOURCE";
    case "EVIDENCE":
      return event.evidenceAssets.length > 0;
  }
}

/** red only true high severity, amber only review attention, green only recovered/resolved, blue/neutral for normal activity. */
function markerStyle(event: TimelineEvent): { dot: string; label: string } {
  if (event.severity === "HIGH") return { dot: "bg-[#DC2626]", label: "bg-[#FEF2F2] text-[#DC2626]" };
  if (event.severity === "MEDIUM") return { dot: "bg-[#D97706]", label: "bg-[#FEF3C7] text-[#92400E]" };
  if (/restored|removed|recovered/i.test(event.label) || event.reviewState?.status === "RESOLVED" || event.reviewState?.status === "REVIEWED_NO_CONCERN") {
    return { dot: "bg-[#067647]", label: "bg-[#ECFDF3] text-[#067647]" };
  }
  return { dot: "bg-[#2563EB]", label: "bg-[#F2F4F7] text-[#667085]" };
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function TimelineRow({ event }: { event: TimelineEvent }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const style = markerStyle(event);

  return (
    <li className="relative border-b border-[#E4E7EC] py-3 pl-6 last:border-b-0">
      <span className={`absolute left-0 top-4 h-2.5 w-2.5 rounded-full ${style.dot}`} aria-hidden="true" />
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-xs font-medium text-[#667085]">{formatTime(event.timestamp)}</p>
      </div>
      <p className="mt-0.5 text-sm font-semibold text-[#101828]">{event.label}</p>
      {event.detail && <p className="mt-0.5 text-sm text-[#667085]">{event.detail}</p>}

      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
        {event.questionNumber != null && (
          <span className="rounded-full bg-[#F2F4F7] px-2 py-0.5 font-medium text-[#667085]">Question {event.questionNumber}</span>
        )}
        {event.reviewState && (
          <span className={`rounded-full px-2 py-0.5 font-medium ${style.label}`}>{event.reviewState.label}</span>
        )}
        {event.evidenceAssets.length > 0 && (
          <span className="rounded-full bg-[#F2F4F7] px-2 py-0.5 font-medium text-[#667085]">
            Evidence available ({event.evidenceAssets.length})
          </span>
        )}
      </div>

      {event.evidenceAssets.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-2">
          {event.evidenceAssets.map((asset) => (
            <a
              key={asset.id}
              href={`/api/integrity-evidence/${asset.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded text-xs font-medium text-[#2563EB] hover:text-[#1D4ED8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
            >
              View evidence frame →
            </a>
          ))}
        </div>
      )}

      {(event.technicalDetails?.length || event.deviceReportedTimestamp || event.technicalEventType) && (
        <div className="mt-1.5">
          <button
            type="button"
            onClick={() => setDetailsOpen((v) => !v)}
            className="text-xs font-medium text-[#98A2B3] hover:text-[#667085]"
          >
            Details {detailsOpen ? "▴" : "▾"}
          </button>
          {detailsOpen && (
            <dl className="mt-1 space-y-0.5 rounded-lg bg-[#F9FAFB] p-2 text-xs text-[#667085]">
              {event.technicalEventType && (
                <div className="flex gap-1">
                  <dt className="font-medium">Event code:</dt>
                  <dd>{event.technicalEventType}</dd>
                </div>
              )}
              {event.deviceReportedTimestamp && (
                <div className="flex gap-1">
                  <dt className="font-medium">Device-reported time:</dt>
                  <dd>{formatTime(event.deviceReportedTimestamp)}</dd>
                </div>
              )}
              {event.technicalDetails?.map((d) => (
                <div key={d.label} className="flex gap-1">
                  <dt className="font-medium">{d.label}:</dt>
                  <dd>{d.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
    </li>
  );
}

function SummaryChip({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <p className="text-xs font-medium text-[#667085]">{label}</p>
      <p className="mt-0.5 text-xl font-bold text-[#101828]">{value}</p>
    </div>
  );
}

export default function IntegrityEvidenceTimelinePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params);
  const [timeline, setTimeline] = useState<IntegrityEvidenceTimeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterValue>("ALL");

  useEffect(() => {
    fetch(`/api/lecturer/submissions/${id}/timeline`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error ?? "Failed to load");
        }
        return res.json();
      })
      .then(setTimeline)
      .catch((err) => setError(err.message));
  }, [id]);

  if (error) return <p className="mx-auto max-w-3xl text-sm text-[#B42318]">{error}</p>;
  if (!timeline) return <p className="mx-auto max-w-3xl text-sm text-[#667085]">Loading…</p>;

  const { summary } = timeline;
  const visibleEvents = timeline.events.filter((e) => matchesFilter(e, filter));
  const nonLifecycleCount = timeline.events.filter((e) => e.category !== "LIFECYCLE").length;

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href={`/lecturer/exams/${timeline.exam.id}/submissions/${timeline.submissionId}`}
        className="rounded text-sm font-medium text-[#2563EB] hover:text-[#1D4ED8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
      >
        &larr; Back to submission
      </Link>

      <h1 className="mt-3 text-[28px] font-bold text-lecturer-text-primary">Integrity evidence timeline</h1>
      <p className="mt-1 text-sm text-[#667085]">
        {timeline.student.name} · {timeline.exam.title}
      </p>
      <p className="mt-3 text-sm text-[#667085]">
        Chronological reconstruction of recorded assessment activity and integrity evidence. Events are shown for
        lecturer review and do not by themselves determine academic misconduct.
      </p>

      <div className="mt-4 rounded-xl border border-[#E4E7EC] bg-lecturer-surface p-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <SummaryChip label="Attempt status" value={summary.attemptStatus} />
          <SummaryChip label="Recorded events" value={summary.totalEvents} />
          <SummaryChip label="Evidence frames" value={summary.evidenceAssetCount} />
          <SummaryChip label="Items awaiting review" value={summary.needsReviewCount} />
        </div>
      </div>

      {(summary.relatedSessionSignals > 0 || summary.relatedTimingSignals > 0) && (
        <div className="mt-3 rounded-lg border border-[#E4E7EC] bg-[#F9FAFB] p-3 text-sm text-[#667085]">
          <p className="font-medium text-[#101828]">Related review signals</p>
          <p className="mt-0.5">Session review signals: {summary.relatedSessionSignals} awaiting review</p>
          <p>Timing review signals: {summary.relatedTimingSignals} awaiting review</p>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setFilter(f.value)}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              filter === f.value ? "bg-[#2563EB] text-white" : "bg-[#F2F4F7] text-[#667085]"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="mt-3 rounded-xl border border-[#E4E7EC] bg-lecturer-surface p-4">
        {visibleEvents.length === 0 ? (
          <p className="text-sm text-[#667085]">No events match this filter.</p>
        ) : (
          <ul>
            {visibleEvents.map((event) => (
              <TimelineRow key={event.id} event={event} />
            ))}
          </ul>
        )}
        {filter === "ALL" && nonLifecycleCount === 0 && (
          <p className="mt-3 text-sm text-[#667085]">No detailed integrity activity was recorded for this attempt.</p>
        )}
      </div>
    </div>
  );
}
